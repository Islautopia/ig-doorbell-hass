"""Short-lived TURN credentials for the card, so the live view works from OUTSIDE the home (1.4.4).

Iñaki, 2026-09-30: "a Home Assistant user who opens the card does it from outside the network, and
the local connection therefore fails. Restore remote access in the card, working the same as the
apps."

WHY TURN AND NOTHING ELSE. The card's signalling already goes through Home Assistant
(signal_proxy.py), and a browser that loaded the card has, by definition, reached Home Assistant -
from home or through Nabu Casa / a reverse proxy. What fails from outside is the MEDIA: the doorbell
is ICE-Lite and its host candidate is a LAN address. The apps solve that half with the TURN
credentials of API_CONTRACT §3.1-bis, and so does the card now. The relay's signalling WebSocket
(§3.2) is NOT used: it would need the long-lived pairing credential in the browser, and it would
add nothing, because Home Assistant is the rendezvous the browser already reached.

WHAT THE BROWSER GETS, AND WHAT IT NEVER GETS.
  - It gets the TURN REST credential the VPS mints (`username = <expiry>:app-<instance>`, TTL
    3600 s): short-lived, and scoped to relaying packets on our coturn. It opens nothing else.
  - It never gets the pairing credential. That one only travels from Home Assistant to the VPS, in
    the Authorization header of `GET /device/<id>/app_turn_credentials` (tests pin it).

PRINCIPLE 1 (the local path survives without internet or VPS). Nothing local waits on this:
  - a fresh credential is served from memory with no network at all (cache, same 50 min the
    Android app uses for a 60 min TTL);
  - a cold fetch has a hard deadline (`FETCH_DEADLINE_S`), and a failure is remembered for
    `FAILURE_BACKOFF_S`, so a card retrying in a loop with the VPS down never pays it twice;
  - the answer is then an empty list, and the card connects exactly as it did before 1.4.4 - host
    candidates on the LAN.

PRINCIPLE 2 (nothing stored off the device). TURN relays DTLS-SRTP datagrams it cannot decrypt;
the VPS keeps no media. Signalling does not touch the VPS at all on this path.

MULTI-REGION (1.8.0, firmware 1.2.0, API_CONTRACT 3.7 / 3.0-ha). The cloud has several regions and
a doorbell lives on one of them. Credentials minted by ANY region are valid on every region's
coturn (shared secret), but their `urls` name the minting region's own TURN - so a region that is
down gives nothing, and asking only the bootstrap host (Germany, as until 1.7) left the card
without TURN whenever Germany was down, even with the doorbell connected to the US region. Now the
hosts are tried in the order regions.py gives: the region the DOORBELL says it is on
(`cloud_region`, read over the LAN), its home, the other regions of the signed list, the bootstrap.
A cached answer is dropped as soon as the doorbell's region changes (failover or move home), so the
card never keeps pointing at the TURN of a region the doorbell just left. The region list is
refreshed on the back of a successful fetch from the public `GET /regions` (no credential, at most
every 6 h) and is verified with the firmware's keys before use. The relay's `redirect` + close 4307 (3.3) does not
apply here: Home Assistant never opens the relay's WebSocket, only these two HTTP routes, which
every region serves.

THE VPS SERVES OFFICIAL DOORBELLS ONLY: the route answers 403 `device_not_authorized` for a doorbell
without an operator record or banned, and 401 for a revoked pairing. Both end in "no TURN", never
in an exception that could take anything local down.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store

from . import regions

_LOGGER = logging.getLogger(__name__)

# The bootstrap host, kept as a name for whoever imports it (tests, diagnostics). The hosts actually
# tried come from regions.RegionBook.
RELAY_BASE = f"https://{regions.BOOTSTRAP_HOST}"

# The VPS mints 3600 s credentials. Reuse them for 50 min, the Android app's figure
# (live_view_body.dart, `_cachedIceServers`), so a session started at minute 49 still has 10 min
# of validity for its allocation refreshes.
CACHE_S = 50 * 60
# How long the card's request may wait on a cold fetch: enough for a slow link, and the most a VPS
# outage can ever cost a card (once per FAILURE_BACKOFF_S).
FETCH_DEADLINE_S = 2.5
# Per host: a region that is down must not eat the whole budget of the next one.
PER_HOST_S = 4.0
# After a failure, answer "no TURN" at once for this long instead of trying again.
FAILURE_BACKOFF_S = 60
# The region list is refreshed on the back of a successful TURN fetch, at most this often.
LIST_REFRESH_S = 6 * 3600

_KEY = "ig_doorbell_turn"
_BOOK_KEY = "ig_doorbell_regions"


class _State:
    """Per-doorbell cache: last good answer, last failure, and the fetch in flight (deduplicated)."""

    def __init__(self) -> None:
        self.ice_servers: list[dict[str, Any]] = []
        self.fetched_at: float = 0.0
        self.failed_at: float = 0.0
        self.last_error: str | None = None
        self.task: asyncio.Task | None = None
        # 1.8.0: the region the doorbell was on when the cache was filled, its home, who answered.
        self.region: str | None = None
        self.home: str | None = None
        self.host: str | None = None
        self.list_checked_at: float = 0.0


class _Book:
    """The integration-wide region list (regions.RegionBook) and its storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.book = regions.RegionBook()
        self.store: Store = Store(hass, regions.STORAGE_VERSION, regions.STORAGE_KEY)
        self.loaded = False
        self.lock = asyncio.Lock()

    async def async_load(self) -> None:
        async with self.lock:
            if self.loaded:
                return
            self.loaded = True
            try:
                data = await self.store.async_load()
            except Exception:  # noqa: BLE001 - a broken file is "nothing stored", never a failure
                data = None
            if isinstance(data, dict) and isinstance(data.get("envelope"), str):
                if self.book.learn(data["envelope"]):
                    self.book.source = "stored"

    async def async_offer(self, envelope: object) -> None:
        if self.book.learn(envelope):
            _LOGGER.info("Region list updated to serial %s", self.book.current.serial)
            self.store.async_delay_save(lambda: {"envelope": self.book.current.envelope}, 1)


def _states(hass: HomeAssistant) -> dict[str, _State]:
    return hass.data.setdefault(_KEY, {})


def region_book(hass: HomeAssistant) -> _Book:
    """The shared region list (created on first use)."""
    b = hass.data.get(_BOOK_KEY)
    if b is None:
        b = hass.data[_BOOK_KEY] = _Book(hass)
    return b


def ice_servers_from(payload: dict) -> list[dict[str, Any]]:
    """The VPS's §3.1-bis answer -> RTCIceServer dicts. `turn:` URLs carry the credential; `stun:`
    ones never do. Anything that is not a stun/turn URL is dropped rather than handed to a browser.
    """
    urls = payload.get("urls") if isinstance(payload, dict) else None
    user = payload.get("username") if isinstance(payload, dict) else None
    password = payload.get("password") if isinstance(payload, dict) else None
    if not isinstance(urls, list):
        raise ValueError("no urls in the TURN answer")
    out: list[dict[str, Any]] = []
    for url in urls:
        if not isinstance(url, str):
            continue
        if url.startswith(("turn:", "turns:")):
            if not user or not password:
                continue
            out.append({"urls": url, "username": str(user), "credential": str(password)})
        elif url.startswith("stun:"):
            out.append({"urls": url})
    if not any(s["urls"].startswith(("turn:", "turns:")) for s in out):
        raise ValueError("the TURN answer has no usable turn: URL")
    return out


async def async_fetch(
    session: aiohttp.ClientSession, device_id: str, credential: str,
    host: str = regions.BOOTSTRAP_HOST,
) -> list[dict]:
    """GET /device/<id>/app_turn_credentials (API_CONTRACT §3.1-bis) on ONE region, pairing
    credential in the Authorization header - never in the URL, never towards anything but this
    route, and only towards a host of our zone (regions.py verified the list it came from)."""
    url = f"https://{host}/device/{device_id.lower()}/app_turn_credentials"
    async with session.get(
        url,
        headers={"Authorization": f"Bearer {credential}"},
        timeout=aiohttp.ClientTimeout(total=PER_HOST_S),
    ) as resp:
        if resp.status != 200:
            raise RuntimeError(f"app_turn_credentials on {host} -> HTTP {resp.status}")
        return ice_servers_from(await resp.json(content_type=None))


async def async_fetch_region_list(session: aiohttp.ClientSession, host: str) -> str | None:
    """GET https://<host>/regions (3.0-ha, PUBLIC, no credential) -> the signed envelope text, or None.

    The public route on purpose, not `GET /device/<id>/regions`: the list is the same for everybody,
    so there is no reason to send the pairing credential for it. NOT trusted here: the caller hands
    it to regions.RegionBook.learn, which verifies signature and serial before anything uses it."""
    async with session.get(
        f"https://{host}/regions", timeout=aiohttp.ClientTimeout(total=PER_HOST_S)
    ) as resp:
        if resp.status != 200:
            return None
        body = await resp.json(content_type=None)
    return json.dumps(body, separators=(",", ":")) if isinstance(body, dict) else None


async def async_get_ice_servers(
    hass: HomeAssistant, device_id: str, credential: str,
    region: str | None = None, home: str | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """(ice_servers, source) for the card. `region` / `home` are the doorbell's own `cloud_region`
    / `cloud_home` (get_states, over the LAN); None on a firmware without them. `source` is
    "cache", "vps", "none" (backing off after a failure) or "pending" (the fetch outlived the
    deadline; it keeps going and fills the cache for the card's next attempt). Never raises."""
    st = _states(hass).setdefault(device_id, _State())
    now = time.monotonic()
    if region != st.region:
        # The doorbell changed region (failover / move home): what is cached names the TURN of the
        # region it left, and a backoff earned against that region says nothing about the new one.
        st.region = region
        st.ice_servers = []
        st.fetched_at = 0.0
        st.failed_at = 0.0
    st.home = home
    if st.ice_servers and now - st.fetched_at < CACHE_S:
        return st.ice_servers, "cache"
    if st.failed_at and now - st.failed_at < FAILURE_BACKOFF_S:
        return [], "none"

    if st.task is None or st.task.done():
        st.task = hass.async_create_background_task(
            _async_refresh(hass, st, device_id, credential), f"ig_doorbell TURN {device_id}"
        )
    try:
        await asyncio.wait_for(asyncio.shield(st.task), FETCH_DEADLINE_S)
    except asyncio.TimeoutError:
        return [], "pending"
    if st.ice_servers and time.monotonic() - st.fetched_at < CACHE_S:
        return st.ice_servers, "vps"
    return [], "none"


async def _async_refresh(hass: HomeAssistant, st: _State, device_id: str, credential: str) -> None:
    book = region_book(hass)
    await book.async_load()
    session = async_get_clientsession(hass)
    errors: list[str] = []
    for host in book.book.hosts_for(st.region, st.home):
        try:
            servers = await async_fetch(session, device_id, credential, host)
        except Exception as err:  # noqa: BLE001 - any failure means "try the next region"
            errors.append(str(err) or f"{host}: {type(err).__name__}")
            continue
        st.ice_servers = servers
        st.fetched_at = time.monotonic()
        st.failed_at = 0.0
        st.last_error = None
        st.host = host
        if not st.list_checked_at or time.monotonic() - st.list_checked_at > LIST_REFRESH_S:
            st.list_checked_at = time.monotonic()
            try:
                manifest = await async_fetch_region_list(session, host)
            except Exception:  # noqa: BLE001 - the list is a bonus, never a reason to fail
                manifest = None
            if manifest is not None:
                await book.async_offer(manifest)
        return
    st.failed_at = time.monotonic()
    st.last_error = "; ".join(errors) or "no region to ask"
    _LOGGER.info("No TURN credentials for %s (remote viewing unavailable): %s",
                 device_id, st.last_error)


def forget(hass: HomeAssistant, device_id: str) -> None:
    """Drop a doorbell's cached credential (entry unloaded or re-paired)."""
    st = _states(hass).pop(device_id, None)
    if st is not None and st.task is not None and not st.task.done():
        st.task.cancel()

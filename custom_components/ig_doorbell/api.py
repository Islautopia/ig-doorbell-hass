"""Thin async HTTP client for the doorbell's own API, over the LAN only.

Every function here takes the per-entry session built by net.crear_sesion(), whose resolver maps
the doorbell's certificate name to its stored LAN address and to nothing else (no DNS, no relay —
Phase 0 of the parity plan, 2026-09-25). The URLs carry `<device_id>.doorbell.islautopia.com`
only so that TLS validates against the name the certificate is issued for.

⚠️ The pairing credential NEVER leaves Home Assistant's server side. Nothing in this module builds a
URL that is handed to a browser; recordings reach the browser through recordings_view.py, which
adds the credential server-side.

See API_CONTRACT.md (IG_Doorbell repo): §0 (device_id), §1.1 (login), §1.5 (pair_app/unpair_app),
§1.2 (get_states/save_states/open), §1.3-bis (recordings), §4 (hass).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import quote

import aiohttp

from .const import DOORBELL_HOSTNAME_SUFFIX, REQUEST_TIMEOUT

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
_OPEN_TIMEOUT = aiohttp.ClientTimeout(total=15)


class DoorbellApiError(Exception):
    """Base error talking to a doorbell."""


class AuthenticationError(DoorbellApiError):
    """Wrong email/password, or the pairing credential was rejected."""


class DeviceNotPairedError(DoorbellApiError):
    """The doorbell itself is not registered with the cloud yet (409 device_not_paired)."""


class LabelInUseError(DoorbellApiError):
    """409 label_already_used: another user of this doorbell already has a client with that name."""


class CloudAuthorizeFailedError(DoorbellApiError):
    """The cloud rejected registering the new app instance (502 cloud_authorize_failed)."""


@dataclass
class PairResult:
    device_id: str
    credential: str


def doorbell_hostname(device_id: str) -> str:
    """The name the doorbell's certificate is issued for. Used for TLS only, never resolved."""
    return f"{device_id}.{DOORBELL_HOSTNAME_SUFFIX}"


async def async_get_device_id(session: aiohttp.ClientSession, host_or_ip: str) -> str:
    """GET /api/device_id (plain HTTP, port 80, no session needed) - first contact only.

    Deliberately the ONLY call in this module against a raw IP/host instead of the real
    `<device_id>.doorbell.islautopia.com` hostname - API_CONTRACT.md §0 documents this route as
    existing exactly for this: safe, read-only, no credentials involved. Never call
    async_login/async_pair_app against a raw IP - both of those always target the real
    hostname on purpose (see the contract's explicit warning against relaxing TLS hostname
    verification for anything sensitive).
    """
    url = f"http://{host_or_ip}/api/device_id"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                raise DoorbellApiError(f"GET /api/device_id -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except aiohttp.ContentTypeError as err:
        raise DoorbellApiError("Response from /api/device_id is not valid JSON") from err
    device_id = data.get("device_id") if isinstance(data, dict) else None
    if not device_id:
        raise DoorbellApiError("Response from /api/device_id has no 'device_id'")
    return device_id


async def async_login(
    session: aiohttp.ClientSession, device_id: str, email: str, password: str
) -> None:
    """POST /api/login against the real hostname (HTTPS 8443) - sets a cookie on `session`.

    Transitory by design: the caller (config_flow.py) uses this session only long enough to
    call async_pair_app, then discards it and never persists email/password to disk.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/login"
    async with session.post(
        url,
        data={"email": email, "password": password},
        timeout=_TIMEOUT,
        allow_redirects=False,
    ) as resp:
        # Contract §1.1: 302 to "/" on success, 302 to "/login?error=1" on failure - there is
        # no JSON error body to parse, only the status/Location tell success from failure.
        location = resp.headers.get("Location", "")
        if resp.status != 302 or "error=1" in location:
            raise AuthenticationError("Wrong administrator email or password")


async def async_pair_app(
    session: aiohttp.ClientSession, device_id: str, label: str
) -> PairResult:
    """POST /api/pair_app - requires the session cookie async_login just set on `session`."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/pair_app"
    async with session.post(url, data={"label": label}, timeout=_TIMEOUT) as resp:
        if resp.status == 409:
            body = await resp.json(content_type=None)
            if isinstance(body, dict) and body.get("error") == "label_already_used":
                raise LabelInUseError(body.get("label") or label)
            raise DeviceNotPairedError(
                "The doorbell is not paired with the cloud yet - wait for it to finish its own "
                "registration and try again"
            )
        if resp.status == 502:
            raise CloudAuthorizeFailedError(
                "The cloud rejected registering this app - try again later"
            )
        if resp.status != 200:
            raise DoorbellApiError(f"POST /api/pair_app -> HTTP {resp.status}")
        data = await resp.json(content_type=None)
    return PairResult(device_id=data["device_id"], credential=data["credential"])


async def async_logout(session: aiohttp.ClientSession, device_id: str) -> None:
    """POST /api/logout - best effort, frees one of the doorbell's 8 concurrent session slots."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/logout"
    try:
        async with session.post(url, timeout=_TIMEOUT):
            pass
    except (aiohttp.ClientError, TimeoutError):
        _LOGGER.debug("Best-effort logout failed for %s (non-blocking)", device_id)


async def async_unpair_app(session: aiohttp.ClientSession, device_id: str, label: str) -> bool:
    """Undo a pairing (§1.5) with the admin session cookie on `session`, found by its label.

    Used to undo a pairing when a later setup step fails, so a failed setup leaves nothing
    configured on the doorbell. Best effort: returns False instead of raising.

    ⚠️ By SLOT, looked up in `paired_apps`, and not `unpair_app?label=`: on firmware 0.100.0 an
    unpair by label that contains a space answers 404 whatever the encoding ('+' or '%20'),
    measured 2026-09-25 -- and every Home Assistant label has a space. The label route would have
    reported "not found" and left the pairing alive, which is exactly what this exists to prevent.
    """
    base = f"https://{doorbell_hostname(device_id)}:8443"
    try:
        async with session.get(f"{base}/api/paired_apps", timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                return False
            data = await resp.json(content_type=None)
        apps = data.get("apps", []) if isinstance(data, dict) else []
        slots = [a.get("slot") for a in apps if isinstance(a, dict) and a.get("label") == label]
        if len(slots) != 1 or not isinstance(slots[0], int):
            return False
        async with session.post(
            f"{base}/api/unpair_app", data={"slot": str(slots[0])}, timeout=_TIMEOUT
        ) as resp:
            return resp.status == 200
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
        return False


async def async_check_tls(session: aiohttp.ClientSession, device_id: str) -> None:
    """GET https://<name>:8443/api/device_id through the LAN mapping, certificate validated.

    §0: this route exists on both ports, needs no session and has no side effect. Raises
    DoorbellApiError if the doorbell cannot be reached over TLS at its LAN address, or answers
    with another id.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/device_id"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                raise DoorbellApiError(f"GET :8443/api/device_id -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError) as err:
        raise DoorbellApiError(f"No TLS connection to the doorbell on the LAN: {err}") from err
    if not isinstance(data, dict) or data.get("device_id") != device_id:
        raise DoorbellApiError("Another device answered at that address")


def recording_url(device_id: str, credential: str, filename: str) -> str:
    """Doorbell URL of a recording's MP4. SERVER SIDE ONLY (recordings_view.py fetches it).

    ⚠️ Never hand this to a browser: it carries the pairing credential in the query string. Until
    0.6.x it was handed to the media player, which put the credential in every HA user's browser.
    """
    return (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/recording?file={quote(filename)}&token={quote(credential)}"
    )


def thumbnail_url(device_id: str, credential: str, filename: str) -> str:
    """Doorbell URL of a recording's thumbnail. SERVER SIDE ONLY, like recording_url()."""
    return (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/recording_thumb?file={quote(filename)}&token={quote(credential)}"
    )


async def async_list_recordings(
    session: aiohttp.ClientSession,
    device_id: str,
    credential: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """GET /api/list_recordings (contract §1.3-bis), authenticated with the pairing credential.

    Returns the firmware's own object as-is: {"total", "offset", "limit", "capped", "items"}.
    Deliberately not flattened to a bare list - `total` is what makes paging possible at all, and
    `capped` is the difference between "these are all your recordings" and "these are the 2000
    most recent of N", which a UI must not paper over.

    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/list_recordings?limit={limit}&offset={offset}&token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET list_recordings -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as err:
        # Almost always "the doorbell is not reachable from this Home Assistant" - a different
        # VLAN, or simply powered off. Said plainly so it does not read as a credential problem.
        raise DoorbellApiError(f"Could not reach the doorbell to list recordings: {err}") from err


async def async_list_quick_replies(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> list[dict]:
    """GET /api/sequences?quick=1 (contract §1.18.8): the reduced list any user may read.

    Only `id`, `label` and `steps` per entry - never the full `/api/sequences` (admin-only, and
    it carries HA `entity_id`s and, in `recipients`, every housemate's email). This is the ONLY
    quick-reply source: `/api/list_audios` is the retired ten-slot mechanism (Android once read it
    and reported "no quick replies" on a doorbell that had some under the new one - do not repeat
    that here).
    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/sequences?quick=1&token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET sequences?quick=1 -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err
    items = data.get("quick_replies") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


class NotAllowedError(DoorbellApiError):
    """The credential is valid but this role may not do that (403 admin_required).

    Distinct from AuthenticationError on purpose, and the firmware makes the same distinction for
    the same reason: a client needs to tell "I don't know who you are" from "I know who you are
    and you can't" - one means ask for credentials, the other means hide the button.
    """


async def async_check_recording_playable(
    session: aiohttp.ClientSession, device_id: str, credential: str, filename: str
) -> None:
    """Probe the recording so a failure surfaces as a sentence instead of a dead player.

    ⚠️ A one-byte ranged GET, not HEAD: the doorbell answers HEAD on /api/recording with 405
    (measured on 0.100.0, 2026-09-25), which made every recording "unplayable".

    Costs one LAN round trip and turns the commonest failure - a pairing made from a non-admin
    session, which may list and watch but not download - into something the user can act on.
    Returns None if playable; raises otherwise.
    """
    url = recording_url(device_id, credential, filename)
    try:
        async with session.get(url, headers={"Range": "bytes=0-0"}, timeout=_TIMEOUT) as resp:
            if resp.status == 403:
                raise NotAllowedError("admin_required")
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 404:
                raise DoorbellApiError("That recording no longer exists on the doorbell")
            if resp.status not in (200, 206):
                raise DoorbellApiError(f"GET recording -> HTTP {resp.status}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


# ==================================================================================================
# STATE AND CONTROL -- what feeds the entities (2026-08-24)
#
# These five calls did not exist because until then `get_states`, `save_states` and `/open` only
# accepted a SESSION COOKIE, and this integration stores a `pair_app` credential and never the
# administrator password - which is exactly what pairing exists to avoid. It was the asymmetry of
# contract hole 9, the same one that already bit with `firmware_info` and the four DVR routes. The
# firmware closed it on 2026-08-24, and that is why this integration can finally have entities.
# ==================================================================================================


async def async_get_states(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> dict:
    """GET /api/get_states (contract §1.2). Cookie **or** `?token=`, no role filter.

    It is all of the doorbell's configurable state in a single call, so it is what feeds almost
    every entity. No role filter because it is read-only and returns no password whatsoever -
    `wifi_pass` never comes out through any route.
    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/get_states?token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET get_states -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_get_role(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> str:
    """GET /api/whoami?token=... (contract §1.6) - this pairing's role, straight from the doorbell.

    ⚠️ Iñaki, 2026-09-25: what a client shows must be decided by the role the doorbell gave THIS
    integration's credential when it was paired (admin/user), never by whichever Home Assistant
    user happens to be looking at a dashboard - the Kiosko tablet's account is not an HA admin and
    used to hide REC for that reason alone, even when the integration itself was paired as an
    admin. `hass.user.is_admin` answers a different question and must not gate a doorbell control.

    `/api/whoami` normally answers from the dashboard session cookie, but it ALSO resolves the
    role straight from a bare `?token=` with no session at all (the contract's §1.6 note on why
    that route does not belong on the token-only-fails list) - the same `paired_app_role[]` lookup
    the doorbell already does to fill `session_info.role` for a live signalling session
    (§3.3-ter). `email` comes back empty over `?token=` (whoami cannot resolve identity from a
    token, only role); irrelevant here; the card never sees accounts, only a role.

    Never raises for a role the doorbell does not recognise - matches the contract's own
    `"unknown"` (an older pairing made before roles existed) by falling back to it, so a stale or
    unexpected response degrades to "hide the control" rather than to an exception that would take
    down the whole coordinator refresh over a single optional field.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/whoami?token={quote(credential)}"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                return "unknown"
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, ValueError):
        return "unknown"
    role = data.get("role") if isinstance(data, dict) else None
    return role if role in ("admin", "user") else "unknown"


async def async_get_firmware_info(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> dict:
    """GET /api/firmware_info (contract §1.2-ter). Version, hardware, and the street panel if any."""
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/firmware_info?token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET firmware_info -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_save_states(
    session: aiohttp.ClientSession, device_id: str, credential: str, fields: dict[str, str]
) -> dict:
    """POST /api/save_states (contract §1.2). **Requires the admin role.**

    Returns the doorbell's answer (`{"status":"ok"}`, plus `refused` when a field did not go in).

    PARTIAL save: only what is in the body gets written, and leaving a field out keeps it intact -
    never resets it. That is why a dict is sent here and not the whole state: sending everything
    would turn any stale reading into a write that stomps what someone else just changed.
    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/save_states?token={quote(credential)}"
    )
    try:
        async with session.post(url, data=fields, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError("This pairing is not an admin of that doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"POST save_states -> HTTP {resp.status}")
            try:
                body = await resp.json(content_type=None)
            except (ValueError, aiohttp.ClientError):
                body = None
            return body if isinstance(body, dict) else {}
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_open_door(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> None:
    """GET /open (contract §1.2). Cookie **or** `?token=`, **no role filter**.

    No role on purpose: the signalling `open` message has never checked it, so requiring it here
    would allow the same action through one path and deny it through the other.

    `409 no_lock_configured` is NOT a failure of the request: it means that doorbell has no lock
    (`door_m=2`). Distinguished on purpose so a client can **not draw the button** instead of
    offering one that disappoints.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/open?token={quote(credential)}"
    try:
        # ⚠️ NOT the usual 8 s: with `door_m=1` the doorbell WAITS for Home Assistant to confirm the
        # lock entity moved (up to ~9 s, 0.100.4) before answering. 8 s would report a failure for
        # a door that did open.
        async with session.get(url, timeout=_OPEN_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 409:
                raise NoLockConfiguredError("That doorbell has no lock configured (door_m=2)")
            if resp.status != 200:
                # The doorbell's own code (`ha_refused`, `ha_unreachable`, ... §4) says WHY; a bare
                # "HTTP 502" sent people looking at the network (measured on the bench, 1.3.0).
                raise DoorbellApiError(f"GET /open -> {await _error_code(resp)}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell to open: {err}") from err


async def async_set_hass_config(
    session: aiohttp.ClientSession,
    device_id: str,
    credential: str,
    *,
    webhook_url: str,
    entities: list[dict[str, str]],
) -> None:
    """POST /api/hass (contract §4). **HTTPS 8443 only**, and requires the admin role.

    Tells the doorbell **where to send its notices** and **which Home Assistant entities it may
    act on**. An empty `webhook_url` unconfigures it, which is how Home Assistant gets unpaired.

    ⚠️ THE URL MUST BE THE INTERNAL ONE. `get_url(hass)` can return the external one, and then the
    doorbell would go out to the internet to talk to a machine right next to it on the LAN -
    breaking principle 1 without giving any error, just stopping working the day the line drops.
    On Inaki's installation that would already happen: his `internal_url` is a public hostname.
    """
    api_url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/hass?token={quote(credential)}"
    )
    body = {"url": webhook_url, "entities": entities}
    try:
        async with session.post(api_url, json=body, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError("This pairing is not an admin of that doorbell")
            if resp.status != 200:
                error_body = await resp.text()
                raise DoorbellApiError(f"POST /api/hass -> HTTP {resp.status}: {error_body[:120]}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell to configure it: {err}") from err


class NoLockConfiguredError(DoorbellApiError):
    """`door_m=2`: that doorbell has no lock. NOT a failure of the request.

    Distinct from a generic error on purpose, for the same reason the firmware distinguishes it: a
    client needs to be able to **not draw the open button** instead of offering one that
    disappoints (§1.4-ter). Before `door_m` was carried, the only way to know was to fail once.
    """


class SnapshotDisabledError(DoorbellApiError):
    """`403 call_snapshot_disabled`: the owner said ring notices carry no picture (`call_snap`=0).

    Not a failure: a decision. The notice goes out without a picture and it is NOT retried (§3.5).
    """


async def async_get_alert_snapshot(
    session: aiohttp.ClientSession, device_id: str, credential: str, timeout_s: float
) -> bytes | None:
    """`GET /api/snapshot?for=alert` (§3.5): the picture for a ring notification.

    ⚠️ `for=alert` is REQUIRED here, not decoration: it is what lets the owner's `call_snap`
    setting refuse it. Without the marker this request would ignore the owner's decision.

    Returns the JPEG, or None when the doorbell could not capture one right now (`503`) - never
    retried: the ring must not wait for a picture. Raises `SnapshotDisabledError` on the owner's
    `403`.
    """
    url = (f"https://{doorbell_hostname(device_id)}:8443/api/snapshot"
           f"?for=alert&token={quote(credential)}")
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout_s)) as resp:
            if resp.status == 403:
                raise SnapshotDisabledError("call_snapshot_disabled")
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                _LOGGER.info("No snapshot for the ring: HTTP %s", resp.status)
                return None
            return await resp.read()
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not fetch the snapshot: {err}") from err


# ==================================================================================================
# PHASE 1 OF THE PARITY PLAN (1.3.0): the extra readings and settings the apps already have
#
# ONE generic reader instead of one function per route: every one of these is "GET <path>?token=,
# answer JSON", and the coordinator decides WHEN each is read (coordinator.py, `SOURCES`) - never an
# entity on its own, so adding an entity never adds a request.
# ==================================================================================================


def _url(device_id: str, path: str, credential: str, query: str = "") -> str:
    sep = "&" if query else ""
    return (f"https://{doorbell_hostname(device_id)}:8443{path}"
            f"?{query}{sep}token={quote(credential)}")


async def _error_code(resp: aiohttp.ClientResponse) -> str:
    """The doorbell's own `{"error": "..."}`, or the status. Said in errors, never swallowed."""
    try:
        body = await resp.json(content_type=None)
    except (ValueError, aiohttp.ClientError):
        body = None
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    return f"HTTP {resp.status}"


async def async_get_json(
    session: aiohttp.ClientSession, device_id: str, credential: str, path: str
) -> dict:
    """GET <path>?token=<credential> -> the doorbell's JSON object.

    401 -> AuthenticationError, 403 -> NotAllowedError (this pairing is not an admin: the source
    is simply not readable, which is different from "the doorbell is down").
    """
    route, _, query = path.partition("?")
    try:
        async with session.get(_url(device_id, route, credential, query), timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError(await _error_code(resp))
            if resp.status != 200:
                raise DoorbellApiError(f"GET {path} -> {await _error_code(resp)}")
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, ValueError) as err:
        raise DoorbellApiError(f"Could not read {path}: {err}") from err
    if not isinstance(data, dict):
        raise DoorbellApiError(f"GET {path}: not a JSON object")
    return data


async def async_post_detect_config(
    session: aiohttp.ClientSession, device_id: str, credential: str, fields: dict[str, str]
) -> None:
    """POST /api/detect_config (§1.14-bis). Admin.

    ⚠️ THE FIELDS GO IN THE QUERY STRING, NEVER IN THE BODY: the firmware reads only the query, and
    a body answers 200 having saved nothing - a silent no-op, the worst way to fail.
    """
    query = "&".join(f"{k}={quote(str(v))}" for k, v in fields.items())
    url = _url(device_id, "/api/detect_config", credential, query)
    try:
        async with session.post(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError(await _error_code(resp))
            if resp.status != 200:
                raise DoorbellApiError(f"POST detect_config -> {await _error_code(resp)}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_post_img_settings(
    session: aiohttp.ClientSession, device_id: str, credential: str, fields: dict[str, str]
) -> None:
    """POST /api/img_settings (exposure, §1.9-quater). Admin. Form body.

    `exposure_us` and `gain_idx` always travel TOGETHER (the firmware answers
    `400 manual_incomplete` otherwise) - the caller sends both.
    """
    url = _url(device_id, "/api/img_settings", credential)
    try:
        async with session.post(url, data=fields, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError(await _error_code(resp))
            if resp.status != 200:
                raise DoorbellApiError(f"POST img_settings -> {await _error_code(resp)}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_reboot(session: aiohttp.ClientSession, device_id: str, credential: str) -> None:
    """POST /api/reboot with `confirm=REBOOT` (admin). `409 ota_in_progress` is refused and said.

    The doorbell answers BEFORE restarting (2 s later) and closes a running recording first.
    """
    url = _url(device_id, "/api/reboot", credential)
    try:
        async with session.post(url, data={"confirm": "REBOOT"}, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError(await _error_code(resp))
            if resp.status != 200:
                raise DoorbellApiError(await _error_code(resp))
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_get_snapshot(
    session: aiohttp.ClientSession, device_id: str, credential: str, timeout_s: float
) -> bytes | None:
    """GET /api/snapshot WITHOUT `for=alert`: the camera entity's still (camera.py).

    Not the ring's picture - that one is `async_get_alert_snapshot`, which the owner's `call_snap`
    can refuse. Returns None on `503 snapshot_unavailable` (not retried: camera.py rate-limits).
    """
    url = _url(device_id, "/api/snapshot", credential)
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout_s)) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                return None
            return await resp.read()
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not fetch the snapshot: {err}") from err


# ==================================================================================================
# PHASE 2 (1.4.0): call actions and the firmware update, all over the LAN, never through the VPS
# ==================================================================================================


class CallActionError(DoorbellApiError):
    """`POST /api/call_action` refused the action: `code` is the doorbell's own error word (§1.4-quinquies).

    `firmware_too_old` is ours, not the doorbell's: the route does not exist before firmware 0.103.1, and a
    bare "HTTP 404" would send someone looking for a missing sequence instead of an old firmware.
    """

    def __init__(self, code: str, status: int = 0) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


async def async_call_action(
    session: aiohttp.ClientSession, device_id: str, credential: str, action: str,
    params: dict[str, str] | None = None,
) -> dict:
    """POST /api/call_action (§1.4-quinquies): `play_sequence`, `play_audio`, `rec_start`, `rec_stop`.

    One URI, the verb inside. The fields go in the form body (the doorbell also reads the query; the query
    carries only the token). Returns the doorbell's JSON answer (`status`, and `rec` for REC).

    ⚠️ No verb opens the microphone, and none may be added here: talking needs a live session (§1.11-ter).
    """
    body = {"action": action, **(params or {})}
    url = _url(device_id, "/api/call_action", credential)
    try:
        async with session.post(url, data=body, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            try:
                answer = await resp.json(content_type=None)
            except (ValueError, aiohttp.ClientError):
                answer = None
            code = answer.get("error") if isinstance(answer, dict) else None
            if resp.status == 403:
                raise NotAllowedError(code or "admin_required")
            if resp.status == 200 and isinstance(answer, dict):
                return answer
            if resp.status in (404, 405) and not code:
                raise CallActionError("firmware_too_old", resp.status)
            raise CallActionError(str(code or f"HTTP {resp.status}"), resp.status)
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_ota_install(
    session: aiohttp.ClientSession, device_id: str, credential: str, version: str
) -> None:
    """POST /api/ota_install `version=` (admin). The DOORBELL downloads from its own VPS with its own secret
    and, with no `sha256` sent, verifies against the hash of its own catalog check (§1.2-sexies).

    `409 ota_in_progress` is raised as-is: the caller treats it as "already installing", not a failure.
    """
    url = _url(device_id, "/api/ota_install", credential)
    try:
        async with session.post(url, data={"version": version}, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError(await _error_code(resp))
            if resp.status != 200:
                raise DoorbellApiError(await _error_code(resp))
    except (aiohttp.ClientError, TimeoutError) as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err

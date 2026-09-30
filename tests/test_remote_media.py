"""1.4.4: remote viewing from the card (Iñaki, 2026-09-30) - TURN for the media, and nothing else.

What is pinned here:
  - the browser gets STUN + the VPS-minted TURN credential, NEVER the pairing credential;
  - the pairing credential goes to exactly one place: the Authorization header of
    `GET https://relay.../device/<id>/app_turn_credentials` (API_CONTRACT §3.1-bis);
  - principle 1: with the VPS down or slow the command still answers, fast, with an empty list, and
    a failure is not paid again on every retry; nothing local waits on it;
  - a fresh credential is served from memory (no second trip to the VPS).
"""
from __future__ import annotations

import asyncio
import pathlib
import re
import time
from unittest.mock import patch

from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import turn_cloud, websocket_api
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

VPS_ANSWER = {
    "username": "1790000000:app-42",
    "password": "short-lived-turn-password",
    "ttl": 3600,
    "urls": ["stun:turn.example.invalid:3478", "turn:turn.example.invalid:3478?transport=udp"],
}


def _entry(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {**entry.data, "session": object()}
    return entry


class _Resp:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def json(self, content_type=None):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeVps:
    """Records every request; answers `status`/`body`, optionally after `delay` seconds."""

    def __init__(self, status=200, body=VPS_ANSWER, delay=0.0, exc=None):
        self.calls = []
        self.status, self.body, self.delay, self.exc = status, body, delay, exc

    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append((url, dict(headers or {}), kw))
        fake = self

        class _Ctx:
            async def __aenter__(self_inner):
                if fake.delay:
                    await asyncio.sleep(fake.delay)
                if fake.exc:
                    raise fake.exc
                return _Resp(fake.status, fake.body)

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()


async def _ask(hass, hass_ws_client, n=1):
    ws = await hass_ws_client(hass)
    out = []
    for i in range(n):
        await ws.send_json({"id": i + 1, "type": "ig_doorbell/get_ice_servers", "device_id": DEVICE_ID})
        out.append(await ws.receive_json())
    return out


async def _setup(hass):
    await async_setup_component(hass, "http", {})
    _entry(hass)
    websocket_api.async_register_websocket_commands(hass)


async def test_browser_gets_turn_but_never_the_pairing_credential(hass, hass_ws_client):
    await _setup(hass)
    vps = _FakeVps()
    with patch.object(turn_cloud, "async_get_clientsession", return_value=vps):
        [msg] = await _ask(hass, hass_ws_client)
    assert msg["success"], msg
    servers = msg["result"]["ice_servers"]
    assert CREDENTIAL not in str(msg["result"])
    turn = [s for s in servers if s["urls"].startswith("turn:")]
    stun = [s for s in servers if s["urls"].startswith("stun:")]
    assert turn == [{"urls": VPS_ANSWER["urls"][1], "username": VPS_ANSWER["username"],
                     "credential": VPS_ANSWER["password"]}]
    assert stun == [{"urls": VPS_ANSWER["urls"][0]}]        # a STUN entry never carries a credential
    assert msg["result"]["source"] == "vps"


async def test_the_pairing_credential_goes_only_to_app_turn_credentials_in_a_header(hass, hass_ws_client):
    await _setup(hass)
    vps = _FakeVps()
    with patch.object(turn_cloud, "async_get_clientsession", return_value=vps):
        await _ask(hass, hass_ws_client)
    assert len(vps.calls) == 1
    url, headers, _ = vps.calls[0]
    assert url == f"https://relay.doorbell.islautopia.com/device/{DEVICE_ID}/app_turn_credentials"
    assert CREDENTIAL not in url                                   # never in a URL (logs, proxies)
    assert headers == {"Authorization": f"Bearer {CREDENTIAL}"}


async def test_fresh_credentials_are_served_from_memory(hass, hass_ws_client):
    await _setup(hass)
    vps = _FakeVps()
    with patch.object(turn_cloud, "async_get_clientsession", return_value=vps):
        a, b = await _ask(hass, hass_ws_client, n=2)
    assert a["result"]["source"] == "vps" and b["result"]["source"] == "cache"
    assert a["result"]["ice_servers"] == b["result"]["ice_servers"]
    assert len(vps.calls) == 1


async def test_vps_down_answers_empty_and_does_not_retry_every_time(hass, hass_ws_client):
    """Principle 1: the card goes on with LAN only; the second ask (a card in its reconnect loop)
    must not pay the VPS again inside FAILURE_BACKOFF_S."""
    await _setup(hass)
    vps = _FakeVps(exc=OSError("network unreachable"))
    with patch.object(turn_cloud, "async_get_clientsession", return_value=vps):
        a, b = await _ask(hass, hass_ws_client, n=2)
    assert a["success"] and a["result"] == {"ice_servers": [], "source": "none"}
    assert b["success"] and b["result"] == {"ice_servers": [], "source": "none"}
    assert len(vps.calls) == 1


async def test_rejected_or_banned_means_no_turn_not_an_error(hass, hass_ws_client):
    """401 (revoked pairing) and 403 (doorbell not official / banned): no TURN, never a failure the
    card would read as 'the doorbell is gone' - the LAN path must keep working."""
    await _setup(hass)
    for status in (401, 403, 503):
        turn_cloud._states(hass).clear()
        vps = _FakeVps(status=status, body={"error": "x"})
        with patch.object(turn_cloud, "async_get_clientsession", return_value=vps):
            [msg] = await _ask(hass, hass_ws_client)
        assert msg["success"] and msg["result"]["ice_servers"] == [], (status, msg)


async def test_a_slow_vps_costs_at_most_the_deadline_and_fills_the_cache_later(hass, hass_ws_client):
    await _setup(hass)
    vps = _FakeVps(delay=0.4)
    with patch.object(turn_cloud, "async_get_clientsession", return_value=vps), \
         patch.object(turn_cloud, "FETCH_DEADLINE_S", 0.1):
        t0 = time.monotonic()
        [a] = await _ask(hass, hass_ws_client)
        took = time.monotonic() - t0
        assert a["result"] == {"ice_servers": [], "source": "pending"}
        assert took < 0.35, took
        await asyncio.sleep(0.5)                     # the fetch finishes in the background
        [b] = await _ask(hass, hass_ws_client)
    assert b["result"]["source"] == "cache" and b["result"]["ice_servers"]
    assert len(vps.calls) == 1


async def test_unknown_doorbell_is_not_found(hass, hass_ws_client):
    await async_setup_component(hass, "http", {})
    websocket_api.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "ig_doorbell/get_ice_servers", "device_id": "nope"})
    msg = await ws.receive_json()
    assert not msg["success"] and msg["error"]["code"] == "not_found"


async def test_nothing_local_calls_the_turn_fetch():
    """The signalling proxy, connection info and every entity must work with the VPS gone: only the
    get_ice_servers command may call into turn_cloud."""
    root = pathlib.Path(turn_cloud.__file__).parent
    users = sorted(
        p.name for p in root.glob("*.py")
        if p.name != "turn_cloud.py" and re.search(r"turn_cloud\.async_", p.read_text(encoding="utf-8"))
    )
    assert users == ["websocket_api.py"], users
    ws_src = (root / "websocket_api.py").read_text(encoding="utf-8")
    assert ws_src.count("turn_cloud.async_get_ice_servers(") == 1

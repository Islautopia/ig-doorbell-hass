"""1.8.0 - the multi-region cloud (firmware 1.2.0) and the er10v2 hardware, as Home Assistant sees them.

Rules pinned here, each with its positive AND negative control:
  - the region list is accepted only when it verifies with the firmware's keys (tampered payload,
    other key, host outside our zone, older serial: refused) - the pairing credential is sent to
    hosts from that list, so a forgeable list would be a way to steal it;
  - the card's TURN is asked of the region the DOORBELL is on, then home, then the rest; a region that
    is down is skipped; a region change drops the cache; the list refresh carries no credential;
  - region / home / away entities come from get_states, unavailable when the firmware does not say;
  - er10v2 entities exist only where the doorbell has the route (404 -> no entity), and a write shows
    what the doorbell answered;
  - the update entity says the doorbell's OTA verdicts in words.
"""
from __future__ import annotations

import base64
import json
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from homeassistant.setup import async_setup_component

from custom_components.ig_doorbell import api, regions, turn_cloud, update, websocket_api

from .conftest import CREDENTIAL, DEVICE_ID
from .test_phase1_entities import DETECT, IMG, MODE_RULES, STORAGE, FakeDoorbell, _eid, _setup
from .test_remote_media import VPS_ANSWER, _entry, _Resp

US = "ha-poc-us.doorbell.islautopia.com"
DE = "relay.doorbell.islautopia.com"


# --- a test signing key (never the real one: that lives on the operator PC only) ------------------


@pytest.fixture
def test_key(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint).hex()
    monkeypatch.setitem(regions.PUBKEYS, "test-key", pub)
    return key


def _sign(key, manifest: dict, key_id: str = "test-key") -> str:
    payload = json.dumps(manifest, separators=(",", ":")).encode()
    r, s = decode_dss_signature(key.sign(payload, ec.ECDSA(hashes.SHA256())))
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return json.dumps({"v": 1, "alg": "ES256", "key_id": key_id,
                       "payload": base64.b64encode(payload).decode(),
                       "sig": base64.b64encode(sig).decode()})


def _manifest(serial=2, regions_=None, bootstrap=DE):
    return {"format": 1, "serial": serial, "bootstrap": bootstrap, "regions": regions_ or [
        {"id": "de", "host": DE, "state": "active"},
        {"id": "us", "host": US, "state": "active"},
        {"id": "sg", "host": "sg.doorbell.islautopia.com", "state": "standby"},
    ]}


# --- the list: verification ---------------------------------------------------------------------


def test_the_compiled_snapshot_is_the_firmwares_and_verifies():
    rl = regions.verify(regions.SNAPSHOT)
    assert rl.serial == 1 and [r.id for r in rl.regions] == ["de", "us"]
    assert rl.host_of("us") == US


def test_a_list_signed_with_a_known_key_is_accepted(test_key):
    rl = regions.verify(_sign(test_key, _manifest()))
    assert rl.serial == 2 and rl.host_of("sg") == "sg.doorbell.islautopia.com"


@pytest.mark.parametrize("tamper, reason", [
    ("payload", "bad_signature"),
    ("key_id", "unknown_key"),
    ("sig_len", "bad_sig_len"),
    ("alg", "bad_envelope"),
])
def test_a_tampered_list_is_refused(test_key, tamper, reason):
    env = json.loads(_sign(test_key, _manifest()))
    if tamper == "payload":
        p = bytearray(base64.b64decode(env["payload"]))
        p[12] ^= 1
        env["payload"] = base64.b64encode(bytes(p)).decode()
    elif tamper == "key_id":
        env["key_id"] = "someone-else"
    elif tamper == "sig_len":
        env["sig"] = base64.b64encode(b"\0" * 63).decode()
    else:
        env["alg"] = "HS256"
    with pytest.raises(regions.RegionListError, match=reason):
        regions.verify(json.dumps(env))


@pytest.mark.parametrize("host", ["evil.example.com", "relay.doorbell.islautopia.com.evil.com",
                                  "Relay.Doorbell.Islautopia.com", "x.doorbell.islautopia.com:443"])
def test_a_validly_signed_list_with_a_host_outside_our_zone_is_refused(test_key, host):
    m = _manifest(regions_=[{"id": "de", "host": DE}, {"id": "xx", "host": host}])
    with pytest.raises(regions.RegionListError, match="bad_region"):
        regions.verify(_sign(test_key, m))


def test_serial_rules_newer_wins_older_and_conflicting_are_refused(test_key):
    book = regions.RegionBook()
    assert book.current.serial == 1 and book.source == "compiled"
    assert book.learn(_sign(test_key, _manifest(serial=3)))          # positive: newer
    assert book.current.serial == 3 and book.source == "fetched"
    assert not book.learn(_sign(test_key, _manifest(serial=2)))      # older
    assert book.last_reject == "serial_rollback"
    other = _manifest(serial=3, regions_=[{"id": "de", "host": DE}])
    assert not book.learn(_sign(test_key, other))                    # same serial, other bytes
    assert book.last_reject == "serial_conflict"
    assert book.current.host_of("us") == US                          # still the good one


def test_order_is_doorbell_region_then_home_then_the_rest_and_never_draining(test_key):
    book = regions.RegionBook()
    assert book.hosts_for("us", "de") == [US, DE]
    assert book.hosts_for("de", "us") == [DE, US]
    assert book.hosts_for(None, None) == [DE, US]                      # old firmware: list order
    m = _manifest(serial=4, regions_=[{"id": "de", "host": DE, "state": "draining"},
                                      {"id": "us", "host": US, "state": "active"},
                                      {"id": "sg", "host": "sg.doorbell.islautopia.com", "state": "standby"}],
                  bootstrap=US)
    assert book.learn(_sign(test_key, m))
    # the doorbell is not on de: de (draining) is never asked; standby after active
    assert book.hosts_for("us", "de") == [US, "sg.doorbell.islautopia.com"]
    # ... but a doorbell that IS on the draining region is still asked there first
    assert book.hosts_for("de", "us")[0] == DE


# --- the card's TURN, region by region ----------------------------------------------------------


class _Cloud:
    """A fake cloud: per host, an answer (dict), an HTTP status (int) or an exception."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append((url, dict(headers or {})))
        host = url.split("/")[2]
        path = "/" + url.split("/", 3)[3]
        answer = self.answers.get((host, path.split("/")[-1]), self.answers.get(host))

        class _Ctx:
            async def __aenter__(self_inner):
                if isinstance(answer, Exception):
                    raise answer
                if isinstance(answer, int):
                    return _Resp(answer, {"error": "x"})
                if answer is None:
                    raise OSError("unreachable")
                return _Resp(200, answer)

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()


class _Coord:
    def __init__(self, data):
        self.data = data


def _us_answer():
    return {**VPS_ANSWER, "urls": ["stun:34.73.9.81:3478", "turn:34.73.9.81:3478?transport=udp"]}


def _de_answer():
    return {**VPS_ANSWER, "urls": ["stun:46.225.57.138:3478", "turn:46.225.57.138:3478?transport=udp"]}


async def _ws_setup(hass, data):
    await async_setup_component(hass, "http", {})
    entry = _entry(hass)
    hass.data["ig_doorbell"][entry.entry_id]["coordinator"] = _Coord(data)
    websocket_api.async_register_websocket_commands(hass)
    return entry


async def _ask(hass, hass_ws_client, n=1, start=1):
    ws = await hass_ws_client(hass)
    out = []
    for i in range(n):
        await ws.send_json({"id": start + i, "type": "ig_doorbell/get_ice_servers", "device_id": DEVICE_ID})
        out.append(await ws.receive_json())
    return out


def _turn_hosts(cloud):
    return [u.split("/")[2] for u, _ in cloud.calls if u.endswith("/app_turn_credentials")]


async def test_turn_is_asked_of_the_region_the_doorbell_is_on(hass, hass_ws_client):
    await _ws_setup(hass, {"cloud_region": "us", "cloud_home": "us"})
    cloud = _Cloud({US: _us_answer(), DE: _de_answer(), (US, "regions"): 404})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        [msg] = await _ask(hass, hass_ws_client)
    assert msg["result"]["source"] == "vps"
    assert _turn_hosts(cloud) == [US]
    assert "34.73.9.81" in msg["result"]["ice_servers"][1]["urls"]


async def test_control_an_old_firmware_without_regions_asks_the_bootstrap_first(hass, hass_ws_client):
    await _ws_setup(hass, {})
    cloud = _Cloud({US: _us_answer(), DE: _de_answer(), (DE, "regions"): 404})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        await _ask(hass, hass_ws_client)
    assert _turn_hosts(cloud) == [DE]


async def test_a_region_that_is_down_is_skipped(hass, hass_ws_client):
    await _ws_setup(hass, {"cloud_region": "de", "cloud_home": "de"})
    cloud = _Cloud({DE: OSError("connection refused"), US: _us_answer(), (US, "regions"): 404})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        [msg] = await _ask(hass, hass_ws_client)
    assert _turn_hosts(cloud) == [DE, US]
    assert msg["result"]["source"] == "vps" and msg["result"]["ice_servers"]


async def test_every_region_down_is_an_empty_answer_not_an_error(hass, hass_ws_client):
    await _ws_setup(hass, {"cloud_region": "de", "cloud_home": "de"})
    cloud = _Cloud({DE: 502, US: OSError("down")})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        [msg] = await _ask(hass, hass_ws_client)
    assert msg["success"] and msg["result"] == {"ice_servers": [], "source": "none"}


async def test_a_region_change_drops_the_cache_and_asks_the_new_region(hass, hass_ws_client):
    entry = await _ws_setup(hass, {"cloud_region": "us", "cloud_home": "us"})
    cloud = _Cloud({US: _us_answer(), DE: _de_answer(), (US, "regions"): 404})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        [a] = await _ask(hass, hass_ws_client)
        [b] = await _ask(hass, hass_ws_client, start=10)                    # same region: cache
        hass.data["ig_doorbell"][entry.entry_id]["coordinator"].data = {"cloud_region": "de",
                                                                       "cloud_home": "us"}
        [c] = await _ask(hass, hass_ws_client, start=20)                    # failed over: refetch
    assert (a["result"]["source"], b["result"]["source"], c["result"]["source"]) == ("vps", "cache", "vps")
    assert _turn_hosts(cloud) == [US, DE]
    assert "46.225.57.138" in c["result"]["ice_servers"][1]["urls"]


async def test_the_list_refresh_is_public_and_carries_no_credential(hass, hass_ws_client, test_key):
    await _ws_setup(hass, {"cloud_region": "de", "cloud_home": "de"})
    newer = json.loads(_sign(test_key, _manifest(serial=7)))
    cloud = _Cloud({DE: _de_answer(), (DE, "regions"): newer})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        await _ask(hass, hass_ws_client)
        await hass.async_block_till_done()
    lists = [(u, h) for u, h in cloud.calls if u.endswith("/regions")]
    assert lists == [(f"https://{DE}/regions", {})]                     # public route, no header
    for url, headers in cloud.calls:
        assert CREDENTIAL not in url
        if headers:
            assert url.endswith("/app_turn_credentials")
    assert turn_cloud.region_book(hass).book.current.serial == 7        # positive: it was learned


async def test_a_forged_list_from_the_cloud_is_not_learned(hass, hass_ws_client, test_key):
    await _ws_setup(hass, {"cloud_region": "de", "cloud_home": "de"})
    forged = json.loads(_sign(test_key, _manifest(serial=9)))
    forged["key_id"] = "not-a-firmware-key"
    cloud = _Cloud({DE: _de_answer(), (DE, "regions"): forged})
    with patch.object(turn_cloud, "async_get_clientsession", return_value=cloud):
        await _ask(hass, hass_ws_client)
        await hass.async_block_till_done()
    book = turn_cloud.region_book(hass).book
    assert book.current.serial == 1 and book.last_reject == "unknown_key"


# --- entities ------------------------------------------------------------------------------------


class FakeEr10v2(FakeDoorbell):
    def __init__(self) -> None:
        super().__init__("admin")
        self.state.update({"cloud": 1, "cloud_s": 500, "cloud_region": "us", "cloud_home": "us"})
        self.night = {"mode": "auto", "state": "day", "ir_pct": 100}
        self.chime = {"state": "running", "melody": 0, "volume": 70, "selftest": "ok", "rings": 0}
        self.posts: list[tuple[str, dict]] = []
        self.ignore: set[str] = set()

    async def post_form(self, _s, _d, _c, path, fields):
        self.posts.append((path, dict(fields)))
        target = self.night if path == "/api/night" else self.chime
        for k, v in fields.items():
            if k in self.ignore or k == "action":
                continue
            target[k] = v if k == "mode" else int(v)
        return dict(target)


BOOT = {"reset_txt": "sw", "relay": {"connected": True, "region": {
    "id": "us", "home": "us", "host": US, "turn": f"{US}:3478", "turn_state": 4, "serial": 2,
    "source": "nvs", "expired": False, "sig_selftest": "ok 1/1 accepted, 3/3 refused", "regions": 2,
    "failovers": 1, "fast_failovers": 1, "moves_home": 2, "last_switch": "home de->us"}},
    "arranque_vigilado": {"state": "disarmed", "mode": "normal", "boot_ms": 4874, "fired_total": 3},
    "video_heal": {"ladder": {"state": "idle"}, "rungs": {"boot": [0, 0, 0], "total": [89, 2, 1]}}}


def _patches(fake, json_answers):
    async def get_json(session, device_id, credential, path):
        if path == "/api/night":
            return dict(fake.night)
        if path == "/api/chime":
            return dict(fake.chime)
        answer = json_answers.get(path)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            raise api.DoorbellApiError(f"no canned answer for {path}")
        return dict(answer)

    from custom_components.ig_doorbell import net
    return [patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)),
            patch.object(api, "async_get_json", get_json),
            patch.object(api, "async_get_states", AsyncMock(side_effect=fake.get_states)),
            patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "1.2.0",
                                                                                 "hw_version": "1.1.0"})),
            patch.object(api, "async_get_role", AsyncMock(side_effect=lambda *a, **k: fake.role)),
            patch.object(api, "async_set_hass_config", AsyncMock()),
            patch.object(api, "async_post_form", AsyncMock(side_effect=fake.post_form))]


@pytest.fixture
def er10v2(doorbell_json):
    fake = FakeEr10v2()
    doorbell_json.update({
        "/api/img_settings": IMG, "/api/detect_config": DETECT, "/api/storage_info": STORAGE,
        "/api/mode_rules": MODE_RULES, "/api/sequences?quick=1": {"quick_replies": []},
        "/api/mem_stats": {"uptime_s": 100, "interna": {"libre": 1, "mayor": 1}},
        "/api/debug/boot": BOOT,
        "/api/keypad": {"present": False, "state": "not_present"},
        "/api/fingerprint": api.NotSupportedError("GET /api/fingerprint: not on this doorbell"),
    })
    ps = _patches(fake, doorbell_json)
    for p in ps:
        p.start()
    yield fake
    for p in ps:
        p.stop()


async def test_region_entities_follow_the_doorbell(hass, er10v2):
    entry = await _setup(hass, er10v2)
    assert hass.states.get(_eid(hass, "sensor", "cloud_region")).state == "us"
    # the details read /api/debug/boot: disabled by default, and right once enabled
    reg = er.async_get(hass)
    lst = _eid(hass, "sensor", "region_list")
    assert reg.async_get(lst).disabled_by is not None
    reg.async_update_entity(lst, disabled_by=None)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))
    await hass.async_block_till_done()
    details = hass.states.get(lst)
    assert details.state == "2"
    assert details.attributes["turn_allocated"] is True
    assert details.attributes["last_switch"] == "home de->us"
    assert details.attributes["signature_selftest"].startswith("ok")
    assert hass.states.get(_eid(hass, "sensor", "cloud_home_region")).state == "us"
    assert hass.states.get(_eid(hass, "binary_sensor", "cloud_away_from_home")).state == "off"
    er10v2.state["cloud_region"] = "de"                                   # failed over
    coord = hass.data["ig_doorbell"][next(iter(hass.data["ig_doorbell"]))]["coordinator"]
    await coord.async_refresh()
    await hass.async_block_till_done()
    away = hass.states.get(_eid(hass, "binary_sensor", "cloud_away_from_home"))
    assert away.state == "on" and away.attributes == {**away.attributes, "region": "de", "home": "us"}


async def test_control_a_firmware_without_regions_leaves_them_unavailable(hass, er10v2):
    for k in ("cloud_region", "cloud_home"):
        er10v2.state.pop(k)
    await _setup(hass, er10v2)
    assert hass.states.get(_eid(hass, "sensor", "cloud_region")).state == "unavailable"
    assert hass.states.get(_eid(hass, "sensor", "cloud_home_region")).state == "unavailable"
    assert hass.states.get(_eid(hass, "binary_sensor", "cloud_away_from_home")).state == "unavailable"


async def test_er10v2_entities_exist_only_where_the_doorbell_has_the_route(hass, er10v2):
    await _setup(hass, er10v2)
    assert hass.states.get(_eid(hass, "select", "night_mode")).state == "auto"
    assert hass.states.get(_eid(hass, "number", "ir_intensity")).state == "100.0"
    assert hass.states.get(_eid(hass, "binary_sensor", "night_vision")).state == "off"
    assert hass.states.get(_eid(hass, "number", "chime_volume")).state == "70.0"
    assert hass.states.get(_eid(hass, "sensor", "chime_transmitter")).state == "running"
    assert _eid(hass, "button", "chime_test") is not None
    # keypad route present but part not fitted, reader route absent (404): no entity at all
    assert _eid(hass, "sensor", "keypad_state") is None
    assert _eid(hass, "sensor", "fingerprint_state") is None


async def test_control_a_board_without_the_routes_gets_no_er10v2_entity(hass, doorbell_json):
    fake = FakeEr10v2()
    doorbell_json.update({"/api/debug/boot": BOOT})
    ps = _patches(fake, doorbell_json)
    nf = api.NotSupportedError("not on this doorbell")

    async def get_json(session, device_id, credential, path):
        if path in ("/api/night", "/api/chime", "/api/keypad", "/api/fingerprint"):
            raise nf
        answer = doorbell_json.get(path)
        if answer is None:
            raise api.DoorbellApiError("x")
        return dict(answer)

    ps[1] = patch.object(api, "async_get_json", get_json)
    for p in ps:
        p.start()
    try:
        await _setup(hass, fake)
        for domain, key in (("select", "night_mode"), ("number", "ir_intensity"),
                            ("binary_sensor", "night_vision"), ("number", "chime_volume"),
                            ("sensor", "chime_transmitter"), ("button", "chime_test")):
            assert _eid(hass, domain, key) is None, key
        assert _eid(hass, "sensor", "cloud_region") is not None             # the generic ones stay
    finally:
        for p in ps:
            p.stop()


async def test_a_write_shows_what_the_doorbell_answered(hass, er10v2):
    await _setup(hass, er10v2)
    sel = _eid(hass, "select", "night_mode")
    await hass.services.async_call("select", "select_option", {"entity_id": sel, "option": "night"},
                                   blocking=True)
    assert er10v2.posts[-1] == ("/api/night", {"mode": "night"})
    assert hass.states.get(sel).state == "night"
    vol = _eid(hass, "number", "chime_volume")
    await hass.services.async_call("number", "set_value", {"entity_id": vol, "value": 40}, blocking=True)
    assert er10v2.posts[-1] == ("/api/chime", {"volume": "40"})
    assert hass.states.get(vol).state == "40.0"


async def test_control_a_write_the_doorbell_ignored_fails_loudly(hass, er10v2):
    await _setup(hass, er10v2)
    er10v2.ignore.add("ir_pct")
    with pytest.raises(HomeAssistantError, match="did not apply"):
        await hass.services.async_call("number", "set_value",
                                       {"entity_id": _eid(hass, "number", "ir_intensity"), "value": 50},
                                       blocking=True)
    assert hass.states.get(_eid(hass, "number", "ir_intensity")).state == "100.0"


# --- the update entity's words -------------------------------------------------------------------


def test_ota_verdicts_are_said_in_words():
    assert update.ota_words("rejected_board").startswith("rejected_board: the image is for another board")
    assert update.ota_words("something_new") == "something_new"         # unknown: the code, untouched
    assert update.ota_words(None) == "unknown error"

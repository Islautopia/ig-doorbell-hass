"""1.3.0 - Phase 1 of the parity plan: the entities the apps' settings and "About" screens have.

One fake doorbell for the whole test (every api call patched while the test runs, so a poll or a
write in the middle of a test is served by it too). Each family has a test for its RULE, and
tools/mutants.py breaks each rule once to prove the test can see it.
"""
from __future__ import annotations

import time
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.ig_doorbell import api, camera, net, webhook
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_ENTITIES, CONF_HOST_HINT, DOMAIN, SIGNAL_EVENT,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

JPEG_A = b"\xff\xd8A"
JPEG_RING = b"\xff\xd8RING"

IMG = {"sensor_soportado": True, "mode": "auto", "ev": 0.0, "ev_min": -2.0, "ev_max": 2.0,
       "ev_step": 0.333333, "exposure_us": 222, "gain_idx": 0, "exposure_us_min": 3,
       "exposure_us_max": 398, "gain_idx_min": 0, "gain_idx_max": 192,
       "manual_exposure_us": 298, "manual_gain_idx": 7, "measured": 93}
DETECT = {"person_on": 1, "pkg_on": 1, "conf_person": 30, "conf_pkg": 45, "min_area": 10}
STORAGE = {"sd_present": True, "sd_mounted": True, "sd_state": "mounted",
           "total_bytes": 63860375552, "free_bytes": 63114444800}
MODE_RULES = {"state": {"m": 0, "why": "manual", "clock": True}, "rules": []}


class FakeDoorbell:
    def __init__(self, role: str = "admin", door_m: int = 0) -> None:
        self.role = role
        self.state = {
            "m": 0, "door_m": door_m, "ha_e": "", "dur": 2, "br": 0, "sat": 15, "con": 0,
            "hue": 0, "awb": 1, "night": 0, "flip_v": 1, "flip_h": 0, "ts": 1, "tspos": 0,
            "dname": "Test", "rc": 0, "mfps": 15, "mkbps": 2000, "sen": 0, "sfps": 10,
            "skbps": 500, "call_snap": 1, "car_open": 1, "wifi_ssid": "", "ip": LAN_IP,
            "mgain": 1.0, "webrtc_clients": 0, "panel": 0, "reader": 0,
        }
        self.saved: list[dict] = []
        self.drop: set[str] = set()
        self.opens = 0
        self.open_error: Exception | None = None
        self.snapshots = 0
        self.alert_snapshots = 0
        self.detect_posts: list[dict] = []
        self.img_posts: list[dict] = []
        self.reboots = 0

    async def get_states(self, *_a, **_k):
        return dict(self.state)

    async def save_states(self, _s, _d, _c, fields):
        if self.role != "admin":
            raise api.NotAllowedError("admin_required")
        self.saved.append(dict(fields))
        for k, v in fields.items():
            if k in self.drop:
                continue
            self.state[k] = v if k == "dname" else int(v)
        return {"status": "ok"}

    async def open_door(self, *_a, **_k):
        if self.open_error:
            raise self.open_error
        self.opens += 1

    async def snapshot(self, *_a, **_k):
        self.snapshots += 1
        return JPEG_A

    async def alert_snapshot(self, *_a, **_k):
        self.alert_snapshots += 1
        return JPEG_RING

    async def post_detect(self, _s, _d, _c, fields):
        self.detect_posts.append(dict(fields))

    async def post_img(self, _s, _d, _c, fields):
        self.img_posts.append(dict(fields))

    async def reboot(self, *_a, **_k):
        self.reboots += 1


@pytest.fixture
def doorbell(doorbell_json):
    fake = FakeDoorbell()
    doorbell_json.update({
        "/api/img_settings": IMG, "/api/detect_config": DETECT, "/api/storage_info": STORAGE,
        "/api/mode_rules": MODE_RULES, "/api/sequences?quick=1": {"quick_replies": []},   # 1.4.0 source
        "/api/mem_stats": {"uptime_s": 100, "interna": {"libre": 1, "mayor": 1}},
        "/api/debug/boot": {"reset_txt": "poweron"},
    })
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(side_effect=fake.get_states)), \
         patch.object(api, "async_save_states", AsyncMock(side_effect=fake.save_states)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.102.2"})), \
         patch.object(api, "async_get_role", AsyncMock(side_effect=lambda *a, **k: fake.role)), \
         patch.object(api, "async_set_hass_config", AsyncMock()), \
         patch.object(api, "async_open_door", AsyncMock(side_effect=fake.open_door)), \
         patch.object(api, "async_get_snapshot", AsyncMock(side_effect=fake.snapshot)), \
         patch.object(api, "async_get_alert_snapshot", AsyncMock(side_effect=fake.alert_snapshot)), \
         patch.object(api, "async_post_detect_config", AsyncMock(side_effect=fake.post_detect)), \
         patch.object(api, "async_post_img_settings", AsyncMock(side_effect=fake.post_img)), \
         patch.object(api, "async_reboot", AsyncMock(side_effect=fake.reboot)):
        fake.json = doorbell_json
        yield fake


async def _setup(hass, fake: FakeDoorbell, options: dict | None = None):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID, options=options or {},
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    # The first read of the slow sources waits 0.2 s to gather every entity being added.
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))
    await hass.async_block_till_done()
    return entry


def _eid(hass, domain, key):
    return er.async_get(hass).async_get_entity_id(domain, DOMAIN, f"{DEVICE_ID}_{key}")


def _event(hass, ev, **fields):
    async_dispatcher_send(hass, SIGNAL_EVENT.format(device_id=DEVICE_ID),
                          {"ev": ev, "device_id": DEVICE_ID, **fields})


# --- the lock (replaces the "Open door" button) -------------------------------------------------


async def test_unlock_opens_once_and_relocks_after_dur(hass, doorbell):
    await _setup(hass, doorbell)
    lock = _eid(hass, "lock", "door")
    assert hass.states.get(lock).state == "locked"
    await hass.services.async_call("lock", "unlock", {"entity_id": lock}, blocking=True)
    assert doorbell.opens == 1
    assert hass.states.get(lock).state == "unlocked"
    # `lock` does not command anything and does not pretend the door is held again.
    await hass.services.async_call("lock", "lock", {"entity_id": lock}, blocking=True)
    assert doorbell.opens == 1
    assert hass.states.get(lock).state == "unlocked"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=3))
    await hass.async_block_till_done()
    assert hass.states.get(lock).state == "locked"


async def test_a_failed_open_is_an_error_not_an_unlocked_door(hass, doorbell):
    await _setup(hass, doorbell)
    lock = _eid(hass, "lock", "door")
    doorbell.open_error = api.DoorbellApiError("ha_unreachable")
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("lock", "open", {"entity_id": lock}, blocking=True)
    assert hass.states.get(lock).state == "locked"


async def test_no_lock_entity_without_a_lock_and_the_old_button_is_gone(hass, doorbell):
    doorbell.state["door_m"] = 2
    reg = er.async_get(hass)
    old = reg.async_get_or_create("button", DOMAIN, f"{DEVICE_ID}_open")
    stale = reg.async_get_or_create("lock", DOMAIN, f"{DEVICE_ID}_door")
    await _setup(hass, doorbell)
    assert reg.async_get(old.entity_id) is None
    assert reg.async_get(stale.entity_id) is None
    assert _eid(hass, "lock", "door") is None


async def test_the_lock_opens_for_a_user_pairing_too(hass, doorbell):
    doorbell.role = "user"     # /open has no role filter on the doorbell (§1.2)
    await _setup(hass, doorbell)
    await hass.services.async_call("lock", "unlock", {"entity_id": _eid(hass, "lock", "door")},
                                   blocking=True)
    assert doorbell.opens == 1


async def test_the_doorbell_may_not_act_on_this_integrations_own_lock(hass, doorbell):
    await _setup(hass, doorbell, options={CONF_ENTITIES: [f"lock.test_door"]})
    lock = _eid(hass, "lock", "door")
    assert lock == "lock.test_door"
    done, error = await webhook._act_on_entity(hass, webhook.webhook_id_for(DEVICE_ID), lock, True)
    assert (done, error) == (False, "own_entity")
    assert doorbell.opens == 0


# --- admin gating ---------------------------------------------------------------------------------


async def test_settings_are_unavailable_not_failing_for_a_user_pairing(hass, doorbell):
    doorbell.role = "user"
    await _setup(hass, doorbell)
    for domain, key in [("number", "brightness"), ("switch", "night_mode"), ("select", "lock_type"),
                        ("text", "device_name"), ("button", "reboot"), ("switch", "car_open"),
                        ("switch", "person_detection")]:
        assert hass.states.get(_eid(hass, domain, key)).state == "unavailable", key
    # ...while what anyone may read stays readable.
    assert hass.states.get(_eid(hass, "sensor", "pairing_role")).state == "user"
    assert hass.states.get(_eid(hass, "sensor", "sd_state")).state == "mounted"
    # An admin-only source is not even asked for: the doorbell would answer 403 every time.
    assert "/api/img_settings" not in doorbell.json["_calls"]
    assert "/api/mode_rules" not in doorbell.json["_calls"]


async def test_settings_are_available_for_an_admin_pairing(hass, doorbell):
    await _setup(hass, doorbell)
    assert hass.states.get(_eid(hass, "number", "brightness")).state == "0.0"
    assert hass.states.get(_eid(hass, "switch", "car_open")).state == "on"
    assert hass.states.get(_eid(hass, "select", "exposure_mode")).state == "auto"


# --- writes: only the field, read back, refused loudly ---------------------------------------------


async def test_a_number_writes_only_its_field_and_shows_what_the_doorbell_has(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "number", "brightness")
    await hass.services.async_call("number", "set_value", {"entity_id": ent, "value": 25},
                                   blocking=True)
    assert doorbell.saved == [{"br": "25"}]
    assert hass.states.get(ent).state == "25.0"


async def test_a_write_the_doorbell_dropped_fails_loudly(hass, doorbell):
    await _setup(hass, doorbell)
    doorbell.drop.add("night")
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("switch", "turn_on",
                                       {"entity_id": _eid(hass, "switch", "night_mode")},
                                       blocking=True)
    assert hass.states.get(_eid(hass, "switch", "night_mode")).state == "off"


async def test_lock_type_home_assistant_needs_an_entity_first(hass, doorbell):
    await _setup(hass, doorbell)
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("select", "select_option",
                                       {"entity_id": _eid(hass, "select", "lock_type"),
                                        "option": "home_assistant"}, blocking=True)
    assert doorbell.saved == []


async def test_device_name_is_limited_in_bytes_not_characters(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "text", "device_name")
    # 16 characters, 32 bytes: fits HA's 31-character limit and NOT the doorbell's 31 bytes.
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("text", "set_value",
                                       {"entity_id": ent, "value": "ñ" * 16}, blocking=True)
    assert doorbell.saved == []
    await hass.services.async_call("text", "set_value", {"entity_id": ent, "value": "Puerta"},
                                   blocking=True)
    assert doorbell.saved == [{"dname": "Puerta"}]


async def test_detection_writes_go_to_detect_config_and_are_read_back(hass, doorbell):
    await _setup(hass, doorbell)
    doorbell.json["/api/detect_config"] = {**DETECT, "person_on": 0}
    await hass.services.async_call("switch", "turn_off",
                                   {"entity_id": _eid(hass, "switch", "person_detection")},
                                   blocking=True)
    assert doorbell.detect_posts == [{"person_on": "0"}]
    assert hass.states.get(_eid(hass, "switch", "person_detection")).state == "off"
    await hass.services.async_call("number", "set_value",
                                   {"entity_id": _eid(hass, "number", "person_threshold"),
                                    "value": 55}, blocking=True)
    assert doorbell.detect_posts[-1] == {"conf_person": "55"}


async def test_manual_exposure_sends_both_fields_in_the_sensors_unit(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "number", "manual_exposure")
    assert hass.states.get(ent).state == "29.8"            # 298 x 100 us = 29.8 ms
    await hass.services.async_call("number", "set_value", {"entity_id": ent, "value": 10.0},
                                   blocking=True)
    assert doorbell.img_posts == [{"exposure_us": "100", "gain_idx": "7"}]


async def test_reboot_asks_the_doorbell_once(hass, doorbell):
    await _setup(hass, doorbell)
    await hass.services.async_call("button", "press", {"entity_id": _eid(hass, "button", "reboot")},
                                   blocking=True)
    assert doorbell.reboots == 1


# --- read-only on purpose -------------------------------------------------------------------------


async def test_flips_are_read_only(hass, doorbell):
    await _setup(hass, doorbell)
    assert hass.states.get(_eid(hass, "binary_sensor", "flip_vertical")).state == "on"
    assert _eid(hass, "switch", "flip_vertical") is None
    assert _eid(hass, "switch", "white_balance") is None     # awb=0 does nothing yet (§1.2)
    reg = er.async_get(hass)
    assert reg.async_get(_eid(hass, "sensor", "mic_gain")).disabled_by is not None


# --- the slow sources -----------------------------------------------------------------------------


async def test_disabled_diagnostics_cost_the_doorbell_nothing(hass, doorbell):
    await _setup(hass, doorbell)
    calls = doorbell.json["_calls"]
    assert "/api/storage_info" in calls and "/api/detect_config" in calls
    # Memory / boot sensors are disabled by default: never read.
    assert "/api/mem_stats" not in calls
    assert "/api/debug/boot" not in calls
    before = len(calls)
    # A poll inside the 5-minute window reads no slow source again.
    await hass.data[DOMAIN][next(iter(hass.data[DOMAIN]))]["coordinator"].async_refresh()
    assert len(calls) == before


async def test_mode_changed_rereads_the_reason_at_once(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "sensor", "mode_reason")
    assert hass.states.get(ent).state == "manual"
    doorbell.json["/api/mode_rules"] = {"state": {"m": 2, "why": "schedule", "until": 1790000000}}
    _event(hass, "mode_changed", d={"mode": 2, "auto": True})
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.state == "schedule"
    assert st.attributes["until"].startswith("2026-")


# --- ringing --------------------------------------------------------------------------------------


async def test_ringing_follows_the_call_it_belongs_to(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "binary_sensor", "ringing")
    assert hass.states.get(ent).state == "off"
    _event(hass, "ring", call_id="A")
    await hass.async_block_till_done()
    assert hass.states.get(ent).state == "on"
    # A late resolution of ANOTHER call does not end this ring.
    _event(hass, "call_missed", call_id="OLD")
    await hass.async_block_till_done()
    assert hass.states.get(ent).state == "on"
    _event(hass, "call_answered", call_id="A", by="iPhone")
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.state == "off"
    assert st.attributes["last_outcome"] == "answered"
    assert st.attributes["answered_by"] == "iPhone"


async def test_a_ring_nobody_resolved_asks_the_doorbell(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "binary_sensor", "ringing")
    doorbell.json["/api/call_status?call_id=B"] = {"call_id": "B", "state": "ended",
                                                    "reason": "timeout"}
    _event(hass, "ring", call_id="B")
    await hass.async_block_till_done()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=200))
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.state == "off"
    assert st.attributes["last_outcome"] == "missed"


# --- the snapshot camera --------------------------------------------------------------------------


async def _image(hass, ent):
    from homeassistant.components.camera import async_get_image
    return (await async_get_image(hass, ent)).content


async def test_camera_shares_one_capture_between_viewers(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "camera", "snapshot")
    assert await _image(hass, ent) == JPEG_A
    assert await _image(hass, ent) == JPEG_A
    assert doorbell.snapshots == 1


async def test_camera_captures_again_after_the_window(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "camera", "snapshot")
    await _image(hass, ent)
    with patch.object(camera.time, "monotonic",
                      return_value=time.monotonic() + camera.SNAPSHOT_MIN_INTERVAL_S + 1):
        await _image(hass, ent)
    assert doorbell.snapshots == 2


async def test_camera_takes_no_picture_while_it_rings(hass, doorbell):
    await _setup(hass, doorbell)
    ent = _eid(hass, "camera", "snapshot")
    _event(hass, "ring", call_id="C")
    await hass.async_block_till_done()
    # The ring's own picture (for=alert, the ring flow), never a new capture.
    assert await _image(hass, ent) == JPEG_RING
    assert doorbell.snapshots == 0


async def test_camera_obeys_call_snap_during_a_ring(hass, doorbell):
    doorbell.state["call_snap"] = 0
    await _setup(hass, doorbell)
    ent = _eid(hass, "camera", "snapshot")
    _event(hass, "ring", call_id="D")
    await hass.async_block_till_done()
    from homeassistant.exceptions import HomeAssistantError as HAErr
    with pytest.raises(HAErr):
        await _image(hass, ent)      # no picture of the caller: nothing, not a capture
    assert doorbell.snapshots == 0
    assert doorbell.alert_snapshots == 0


async def test_camera_features_are_a_flag_not_an_int(hass, doorbell):
    # Home Assistant 2026 tests `STREAM in supported_features`: a bare 0 made the camera fail to be
    # added on 2026.9.3, while this 2025.1 harness accepted it. Pinned here so it does not come back.
    from homeassistant.components.camera import CameraEntityFeature

    await _setup(hass, doorbell)
    entity = hass.data["camera"].get_entity(_eid(hass, "camera", "snapshot"))
    assert isinstance(entity.supported_features, CameraEntityFeature)

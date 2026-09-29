"""1.4.0 - Phase 2 of the parity plan: quick replies, REC, the firmware update and "In call".

Same fake doorbell as Phase 1 (test_phase1_entities.FakeDoorbell) plus the two new routes: `POST /api/call_action`
(§1.4-quinquies) and `POST /api/ota_install` + `GET /api/ota_from_url` (§1.2-sexies). Each family has a test for
its RULE, and tools/mutants.py breaks each rule once to prove the test can see it.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from custom_components.ig_doorbell import api, net, update
from custom_components.ig_doorbell.const import DOMAIN

from .conftest import DEVICE_ID
from .test_phase1_entities import DETECT, IMG, MODE_RULES, STORAGE, FakeDoorbell, _event, _setup

QUICK = {"quick_replies": [
    {"id": 3, "label": "Leave it at the door", "steps": 2},
    {"id": 7, "label": "Coming!", "steps": 1},
    {"id": 9, "label": "Coming!", "steps": 1},
]}
REC_OFF = {"recording": False, "kind": None, "origin": None, "sd_available": True}


class Fake2(FakeDoorbell):
    def __init__(self, role: str = "admin") -> None:
        super().__init__(role)
        self.state["rec"] = dict(REC_OFF)
        self.state["in_call"] = {"active": False}
        self.actions: list[tuple[str, dict]] = []
        self.action_error: Exception | None = None
        self.firmware = {"fw_version": "0.103.2", "hw_version": "1.0.1",
                         "available": {"status": "up_to_date", "checked_at": 1790000000}}
        self.installs: list[str] = []
        self.ota_script: list = []           # what GET /api/ota_from_url answers, one per read
        self.after_reboot_version: str | None = None

    async def call_action(self, _s, _d, _c, action, params=None):
        if self.action_error:
            raise self.action_error
        self.actions.append((action, dict(params or {})))
        if action in ("rec_start", "rec_stop"):
            if self.role != "admin":
                raise api.NotAllowedError("admin_required")
            if action == "rec_start" and not self.state["rec"]["sd_available"]:
                raise api.CallActionError("no_sd", 409)
            was = self.state["rec"]["recording"]
            on = action == "rec_start"
            self.state["rec"] = {"recording": on or (was and action != "rec_stop"),
                                 "kind": "manual" if on else None, "origin": "manual" if on else None,
                                 "sd_available": True}
            status = ("already_recording" if was else "recording") if on else ("stopped" if was else "not_recording")
            return {"status": status, "rec": dict(self.state["rec"])}
        return {"status": "playing"}

    async def firmware_info(self, *_a, **_k):
        return dict(self.firmware)

    async def ota_install(self, _s, _d, _c, version):
        if self.role != "admin":
            raise api.NotAllowedError("admin_required")
        self.installs.append(version)


@pytest.fixture
def doorbell2(doorbell_json):
    fake = Fake2()
    doorbell_json.update({
        "/api/img_settings": IMG, "/api/detect_config": DETECT, "/api/storage_info": STORAGE,
        "/api/mode_rules": MODE_RULES, "/api/sequences?quick=1": QUICK,
        "/api/mem_stats": {"uptime_s": 100, "interna": {"libre": 1, "mayor": 1}},
        "/api/debug/boot": {"reset_txt": "poweron"},
    })

    async def get_json(session, device_id, credential, path):
        if path == "/api/ota_from_url":
            if not fake.ota_script:
                return {"fase": "idle", "activa": False}
            step = fake.ota_script.pop(0)
            if isinstance(step, Exception):
                raise step
            if step == "REBOOTED":
                if fake.after_reboot_version:
                    fake.firmware = {**fake.firmware, "fw_version": fake.after_reboot_version}
                return {"fase": "idle", "activa": False, "last_ota": {"result": "installed"}}
            return step
        answer = doorbell_json.get(path)
        if answer is None:
            raise api.DoorbellApiError(f"no canned answer for {path}")
        return dict(answer)

    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_json", get_json), \
         patch.object(api, "async_get_states", AsyncMock(side_effect=fake.get_states)), \
         patch.object(api, "async_save_states", AsyncMock(side_effect=fake.save_states)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(side_effect=fake.firmware_info)), \
         patch.object(api, "async_get_role", AsyncMock(side_effect=lambda *a, **k: fake.role)), \
         patch.object(api, "async_set_hass_config", AsyncMock()), \
         patch.object(api, "async_get_snapshot", AsyncMock(side_effect=fake.snapshot)), \
         patch.object(api, "async_call_action", AsyncMock(side_effect=fake.call_action)), \
         patch.object(api, "async_ota_install", AsyncMock(side_effect=fake.ota_install)), \
         patch.object(update, "PROGRESS_EVERY_S", 0):
        fake.json = doorbell_json
        yield fake


def _eid(hass, domain, key):
    return er.async_get(hass).async_get_entity_id(domain, DOMAIN, f"{DEVICE_ID}_{key}")


def _coordinator(hass, entry):
    return hass.data[DOMAIN][entry.entry_id]["coordinator"]


# --- quick replies: select + button + actions -----------------------------------------------------


async def test_quick_reply_select_lists_the_doorbells_labels_and_picking_plays_nothing(hass, doorbell2):
    await _setup(hass, doorbell2)
    sel = _eid(hass, "select", "quick_reply")
    st = hass.states.get(sel)
    # two quick replies with the same label are told apart by their id: a label must never play another one
    assert st.attributes["options"] == ["Leave it at the door", "Coming! (7)", "Coming! (9)"]
    assert st.state == "Leave it at the door"
    await hass.services.async_call("select", "select_option", {"entity_id": sel, "option": "Coming! (9)"},
                                   blocking=True)
    assert hass.states.get(sel).state == "Coming! (9)"
    assert hass.states.get(sel).attributes["seq_id"] == 9
    assert doorbell2.actions == []


async def test_the_button_plays_the_selected_quick_reply(hass, doorbell2):
    await _setup(hass, doorbell2)
    await hass.services.async_call("select", "select_option",
                                   {"entity_id": _eid(hass, "select", "quick_reply"), "option": "Coming! (9)"},
                                   blocking=True)
    await hass.services.async_call("button", "press", {"entity_id": _eid(hass, "button", "play_quick_reply")},
                                   blocking=True)
    assert doorbell2.actions == [("play_sequence", {"seq_id": "9"})]


async def test_no_quick_replies_no_usable_button(hass, doorbell2):
    doorbell2.json["/api/sequences?quick=1"] = {"quick_replies": []}
    await _setup(hass, doorbell2)
    assert hass.states.get(_eid(hass, "button", "play_quick_reply")).state == "unavailable"


async def test_play_sequence_by_name_by_id_and_its_errors(hass, doorbell2):
    entry = await _setup(hass, doorbell2)
    await hass.services.async_call(DOMAIN, "play_sequence",
                                   {"device_id": DEVICE_ID, "sequence": "  leave IT at the door "}, blocking=True)
    await hass.services.async_call(DOMAIN, "play_sequence", {"device_id": DEVICE_ID, "seq_id": 12}, blocking=True)
    await hass.services.async_call(DOMAIN, "play_audio", {"device_id": DEVICE_ID, "audio_slot": 2}, blocking=True)
    assert doorbell2.actions == [("play_sequence", {"seq_id": "3"}), ("play_sequence", {"seq_id": "12"}),
                                 ("play_audio", {"audio_slot": "2"})]
    with pytest.raises(HomeAssistantError, match="no quick reply called"):
        await hass.services.async_call(DOMAIN, "play_sequence", {"device_id": DEVICE_ID, "sequence": "Nope"},
                                       blocking=True)
    with pytest.raises(HomeAssistantError, match="Several quick replies"):
        await hass.services.async_call(DOMAIN, "play_sequence", {"device_id": DEVICE_ID, "sequence": "coming!"},
                                       blocking=True)
    doorbell2.action_error = api.CallActionError("firmware_too_old", 404)
    with pytest.raises(HomeAssistantError, match="firmware is too old"):
        await hass.services.async_call(DOMAIN, "play_sequence", {"device_id": DEVICE_ID, "seq_id": 3}, blocking=True)
    doorbell2.action_error = api.CallActionError("busy", 409)
    with pytest.raises(HomeAssistantError, match="already playing"):
        await hass.services.async_call(DOMAIN, "play_audio", {"device_id": DEVICE_ID, "audio_slot": 1},
                                       blocking=True)
    assert _coordinator(hass, entry) is not None


# --- REC -----------------------------------------------------------------------------------------


async def test_rec_switch_is_the_doorbells_rec_and_turns_off_by_itself(hass, doorbell2):
    entry = await _setup(hass, doorbell2)
    rec = _eid(hass, "switch", "rec")
    assert hass.states.get(rec).state == "off"
    await hass.services.async_call("switch", "turn_on", {"entity_id": rec}, blocking=True)
    assert doorbell2.actions[-1] == ("rec_start", {})
    # the doorbell's ANSWER is the state, at once - not the next poll
    assert hass.states.get(rec).state == "on"
    assert hass.states.get(rec).attributes["origin"] == "manual"
    # the doorbell stops on its own (10-minute limit, a ring taking over): the next poll says so
    doorbell2.state["rec"] = dict(REC_OFF)
    await _coordinator(hass, entry).async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(rec).state == "off"
    await hass.services.async_call("switch", "turn_off", {"entity_id": rec}, blocking=True)
    assert doorbell2.actions[-1] == ("rec_stop", {})


async def test_rec_already_recording_shows_the_recording_that_runs(hass, doorbell2):
    doorbell2.state["rec"] = {"recording": True, "kind": "call", "origin": "auto", "sd_available": True}
    await _setup(hass, doorbell2)
    rec = _eid(hass, "switch", "rec")
    assert hass.states.get(rec).state == "on"
    assert hass.states.get(rec).attributes["kind"] == "call"


async def test_rec_refused_for_no_card_stays_off_with_a_reason(hass, doorbell2):
    doorbell2.state["rec"] = {**REC_OFF, "sd_available": False}
    await _setup(hass, doorbell2)
    rec = _eid(hass, "switch", "rec")
    with pytest.raises(HomeAssistantError, match="no usable SD card"):
        await hass.services.async_call("switch", "turn_on", {"entity_id": rec}, blocking=True)
    assert hass.states.get(rec).state == "off"


async def test_rec_unavailable_for_a_user_pairing_and_for_an_old_firmware(hass, doorbell2):
    doorbell2.role = "user"
    await _setup(hass, doorbell2)
    assert hass.states.get(_eid(hass, "switch", "rec")).state == "unavailable"


async def test_rec_unavailable_without_rec_in_get_states(hass, doorbell2):
    del doorbell2.state["rec"]
    await _setup(hass, doorbell2)
    assert hass.states.get(_eid(hass, "switch", "rec")).state == "unavailable"


# --- the firmware update -------------------------------------------------------------------------


async def test_update_states_never_say_up_to_date_without_a_check(hass, doorbell2):
    entry = await _setup(hass, doorbell2)
    fw = _eid(hass, "update", "firmware")
    st = hass.states.get(fw)
    assert st.state == "off" and st.attributes["latest_version"] == "0.103.2"
    c = _coordinator(hass, entry)
    doorbell2.firmware["available"] = {"status": "not_checked", "reason": "unreachable"}
    await c.async_refresh_firmware()
    await hass.async_block_till_done()
    st = hass.states.get(fw)
    assert st.attributes["latest_version"] is None and st.state == "unknown"
    assert st.attributes["check_reason"] == "unreachable"
    doorbell2.firmware["available"] = {"status": "update_available", "version": "0.104.0",
                                       "notes": "Fix " + "x" * 400, "checked_at": 1790000000}
    await c.async_refresh_firmware()
    await hass.async_block_till_done()
    st = hass.states.get(fw)
    assert st.state == "on" and st.attributes["latest_version"] == "0.104.0"
    assert len(st.attributes["release_summary"]) <= 255


async def test_update_installs_through_the_doorbell_and_waits_for_the_new_version(hass, doorbell2):
    doorbell2.firmware["available"] = {"status": "update_available", "version": "0.104.0", "notes": "n"}
    await _setup(hass, doorbell2)
    fw = _eid(hass, "update", "firmware")
    doorbell2.ota_script = [{"fase": "downloading", "activa": True, "pct": 40},
                            {"fase": "restarting", "activa": True, "pct": 100},
                            api.DoorbellApiError("rebooting"), "REBOOTED"]
    doorbell2.after_reboot_version = "0.104.0"
    await hass.services.async_call("update", "install", {"entity_id": fw}, blocking=True)
    assert doorbell2.installs == ["0.104.0"]
    st = hass.states.get(fw)
    assert st.attributes["installed_version"] == "0.104.0" and st.attributes["in_progress"] is False


async def test_update_that_came_back_on_the_old_version_is_an_error(hass, doorbell2):
    doorbell2.firmware["available"] = {"status": "update_available", "version": "0.104.0", "notes": "n"}
    await _setup(hass, doorbell2)
    doorbell2.ota_script = [{"fase": "restarting", "activa": True}, api.DoorbellApiError("rebooting"),
                            "REBOOTED"]
    doorbell2.after_reboot_version = None      # rolled back: still 0.103.2
    with pytest.raises(HomeAssistantError, match="still on 0.103.2"):
        await hass.services.async_call("update", "install", {"entity_id": _eid(hass, "update", "firmware")},
                                       blocking=True)


async def test_update_install_is_not_offered_to_a_user_pairing(hass, doorbell2):
    doorbell2.role = "user"
    doorbell2.firmware["available"] = {"status": "update_available", "version": "0.104.0", "notes": "n"}
    await _setup(hass, doorbell2)
    st = hass.states.get(_eid(hass, "update", "firmware"))
    assert st.state == "on"
    assert not st.attributes["supported_features"] & 1      # UpdateEntityFeature.INSTALL


# --- In call -------------------------------------------------------------------------------------


async def test_in_call_from_the_answer_to_the_end_of_the_conversation(hass, doorbell2):
    await _setup(hass, doorbell2)
    ic = _eid(hass, "binary_sensor", "in_call")
    assert hass.states.get(ic).state == "off"
    _event(hass, "ring", call_id="c1")
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "off"            # ringing is not in call
    _event(hass, "call_answered", call_id="c1", d={"by": "iPhone"})
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "on"
    assert hass.states.get(ic).attributes["answered_by"] == "iPhone"
    _event(hass, "call_finished", call_id="c1", d={"duration_s": 42, "reason": "mic_closed"})
    await hass.async_block_till_done()
    st = hass.states.get(ic)
    assert st.state == "off" and st.attributes["last_duration_s"] == 42 and st.attributes["last_end"] == "mic_closed"


async def test_a_quick_reply_answers_the_ring_but_is_not_a_conversation(hass, doorbell2):
    await _setup(hass, doorbell2)
    _event(hass, "ring", call_id="c2")
    _event(hass, "call_answered", call_id="c2", d={"reason": "quick_reply", "by": "HA"})
    await hass.async_block_till_done()
    assert hass.states.get(_eid(hass, "binary_sensor", "in_call")).state == "off"


async def test_the_end_of_an_earlier_conversation_does_not_end_this_one(hass, doorbell2):
    await _setup(hass, doorbell2)
    _event(hass, "ring", call_id="c3")
    _event(hass, "call_answered", call_id="c3")
    _event(hass, "call_finished", call_id="c-old", d={"duration_s": 5, "reason": "hung_up"})
    await hass.async_block_till_done()
    assert hass.states.get(_eid(hass, "binary_sensor", "in_call")).state == "on"


async def test_a_lost_webhook_is_corrected_by_the_poll_but_a_fresh_one_is_not_overruled(hass, doorbell2):
    entry = await _setup(hass, doorbell2)
    ic = _eid(hass, "binary_sensor", "in_call")
    c = _coordinator(hass, entry)
    call = hass.data[DOMAIN][entry.entry_id]["call_state"]
    _event(hass, "ring", call_id="c4")
    _event(hass, "call_answered", call_id="c4")
    await hass.async_block_till_done()
    # a poll answered before the answer happened says "not in call": NOT trusted (the webhook is newer)
    await c.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "on"
    # the call_finished webhook was lost; later polls say it is over: corrected
    call._in_call_changed -= 60
    await c.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "off"
    # and the other way: the doorbell says in call, the webhook never came
    doorbell2.state["in_call"] = {"active": True, "call_id": "c5", "by": "Pixel", "since": 1, "talking": True}
    await c.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "on"
    assert hass.states.get(ic).attributes["call_id"] == "c5"


async def test_in_call_unavailable_with_a_firmware_that_cannot_tell_the_end(hass, doorbell2):
    del doorbell2.state["in_call"]
    await _setup(hass, doorbell2)
    ic = _eid(hass, "binary_sensor", "in_call")
    assert hass.states.get(ic).state == "unavailable"
    _event(hass, "ring", call_id="c6")
    _event(hass, "call_answered", call_id="c6")
    await hass.async_block_till_done()
    assert hass.states.get(ic).state == "unavailable"


# --- the route itself: an old firmware's 404 is "too old", a doorbell's 404 is its own word -------


class _Resp:
    def __init__(self, status, body):
        self.status, self._body = status, body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def json(self, content_type=None):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class _Session:
    def __init__(self, status, body):
        self.status, self.body, self.posts = status, body, []

    def post(self, url, data=None, **kw):
        self.posts.append((url, data))
        return _Resp(self.status, self.body)


async def test_call_action_route_answers():
    s = _Session(200, {"status": "playing"})
    assert (await api.async_call_action(s, DEVICE_ID, "c" * 64, "play_sequence", {"seq_id": "3"}))["status"] == "playing"
    url, data = s.posts[0]
    assert "/api/call_action?token=" in url and data == {"action": "play_sequence", "seq_id": "3"}
    with pytest.raises(api.CallActionError) as e:
        await api.async_call_action(_Session(404, None), DEVICE_ID, "c" * 64, "play_sequence", {"seq_id": "3"})
    assert e.value.code == "firmware_too_old"
    with pytest.raises(api.CallActionError) as e:
        await api.async_call_action(_Session(404, {"error": "not_found"}), DEVICE_ID, "c" * 64, "play_sequence")
    assert e.value.code == "not_found"
    with pytest.raises(api.NotAllowedError):
        await api.async_call_action(_Session(403, {"error": "admin_required"}), DEVICE_ID, "c" * 64, "rec_start")

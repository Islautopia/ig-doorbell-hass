"""1.7.0 - the doorbell's link to our relay (cloud_link.py), as the doorbell reports it.

The rules each test pins (tools/mutants.py breaks each one once):
- the grace: a link down for less than 90 s is not an outage;
- the stability window: back for less than 60 s is still the same outage (flapping = one pair);
- the pairing: "restored" only closes an outage this integration knew about;
- an outage already open at Home Assistant's first reading fires no "lost", but its end IS told;
- older firmware (no `cloud`/`cloud_s`): unavailable, and never an event.
"""
from __future__ import annotations

from custom_components.ig_doorbell.cloud_link import (
    EV_LOST, EV_RESTORED, LOST_AFTER_S, RESTORED_AFTER_S, CloudLinkTracker,
)
from custom_components.ig_doorbell.const import DOMAIN

from .test_phase1_entities import _eid, _setup, doorbell  # noqa: F401 - fixture


def _s(cloud, cloud_s):
    return {"cloud": cloud, "cloud_s": cloud_s}


def test_grace_a_short_drop_is_nothing():
    t = CloudLinkTracker()
    assert t.update(_s(1, 500), 1000) is None and t.connected is True
    assert t.update(_s(0, LOST_AFTER_S - 1), 1030) is None
    assert t.connected is True and not t.lost
    assert t.update(_s(1, 5), 1060) is None and t.connected is True


def test_lost_then_restored_with_the_whole_outage():
    t = CloudLinkTracker()
    t.update(_s(1, 500), 1000)
    assert t.update(_s(0, 30), 1030) is None                     # drop at 1000, in grace
    assert t.update(_s(0, 120), 1120) == (EV_LOST, {"offline_s": 120})
    assert t.connected is False
    assert t.update(_s(0, 150), 1150) is None                    # announced once
    assert t.update(_s(1, 10), 1400) is None and t.connected is False   # back at 1390: window
    assert t.update(_s(1, RESTORED_AFTER_S), 1450) == (EV_RESTORED, {"offline_s": 390})
    assert t.connected is True and not t.lost


def test_flapping_is_one_outage():
    t = CloudLinkTracker()
    t.update(_s(1, 500), 1000)
    assert t.update(_s(0, 100), 1100)[0] == EV_LOST              # drop at 1000
    assert t.update(_s(1, 20), 1200) is None                     # back at 1180, too short
    assert t.update(_s(0, 10), 1230) is None                     # dropped again: same outage
    ev = t.update(_s(1, 70), 1400)                               # back at 1330, held
    assert ev == (EV_RESTORED, {"offline_s": 330})


def test_ha_restarted_during_an_outage_says_only_the_end():
    t = CloudLinkTracker()
    assert t.update(_s(0, 600), 1000) is None                    # first reading: no "lost"
    assert t.connected is False and t.lost
    assert t.update(_s(1, 60), 1100) == (EV_RESTORED, {"offline_s": 640})


def test_restored_never_without_an_outage():
    t = CloudLinkTracker()
    assert t.update(_s(1, 5), 1000) is None
    assert t.update(_s(1, 500), 1500) is None


def test_older_firmware_is_unsupported_and_silent():
    t = CloudLinkTracker()
    for st in ({}, {"cloud": 1}, {"cloud": True, "cloud_s": 5}, {"cloud": 2, "cloud_s": 5},
               {"cloud": 0, "cloud_s": "100"}):
        assert t.update(st, 1000) is None
        assert t.supported is False


# --- through Home Assistant -----------------------------------------------------------------------


async def test_entity_and_events_in_home_assistant(hass, doorbell):  # noqa: F811
    doorbell.state.update(_s(1, 500))
    entry = await _setup(hass, doorbell)
    coord = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    sensor = _eid(hass, "binary_sensor", "cloud_connection")
    events = _eid(hass, "event", "events")
    assert hass.states.get(sensor).state == "on"
    assert hass.states.get(sensor).attributes.get("device_class") == "connectivity"

    before = hass.states.get(events).state

    doorbell.state.update(_s(0, 100))
    await coord.async_refresh(); await hass.async_block_till_done()
    assert hass.states.get(sensor).state == "off"
    ev = hass.states.get(events)
    assert ev.state != before and ev.attributes["event_type"] == "cloud_link_lost"
    assert ev.attributes["offline_s"] == 100

    doorbell.state.update(_s(1, 61))
    await coord.async_refresh(); await hass.async_block_till_done()
    assert hass.states.get(sensor).state == "on"
    ev = hass.states.get(events)
    assert ev.attributes["event_type"] == "cloud_link_restored"
    assert 38 <= ev.attributes["offline_s"] <= 40                # down 100 s ago, up 61 s ago


async def test_older_firmware_entity_unavailable(hass, doorbell):  # noqa: F811
    await _setup(hass, doorbell)                                 # no cloud / cloud_s
    assert hass.states.get(_eid(hass, "binary_sensor", "cloud_connection")).state == "unavailable"

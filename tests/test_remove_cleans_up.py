"""Deleting a doorbell's entry cleans up after itself on the doorbell (1.4.6, removal.py).

One doorbell belongs to ONE Home Assistant; moving it = deleting its entry in the old one. The
deletion must (a) clear the doorbell's webhook only if it still points HERE, (b) revoke this Home
Assistant's own pairing, and never hang or fail because the doorbell is off - then a Repairs
notice names the pairing to revoke from the app.

The doorbell is a stateful fake behind the three api functions the clean-up uses: it keeps ONE
webhook and a set of live credentials, and it answers the way the firmware does (401 for a dead
credential). The wire format of those calls is checked separately, against a fake session.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

import aiohttp
import pytest
from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import api, removal
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_HOST_HINT,
    CONF_LABEL,
    DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

# Documentation-range addresses only (RFC 5737): this repository is public.
OURS = f"http://198.51.100.7:8123/api/webhook/ig_doorbell_{DEVICE_ID}"
OTHER_HA = f"http://192.0.2.50:8123/api/webhook/ig_doorbell_{DEVICE_ID}"
LABEL = "Home Assistant Test abc123"
OTHER_CREDENTIAL = "d" * 64  # another app paired to the same doorbell: must survive


class FakeDoorbell:
    def __init__(self, webhook: str, *, reachable: bool = True, hang: bool = False) -> None:
        self.webhook = webhook
        self.entities = [{"id": "lock.front"}]
        self.live = {CREDENTIAL, OTHER_CREDENTIAL}
        self.reachable = reachable
        self.hang = hang
        self.calls: list[str] = []

    async def _net(self, name: str) -> None:
        self.calls.append(name)
        if self.hang:
            await asyncio.sleep(3600)
        if not self.reachable:
            raise aiohttp.ClientConnectionError("Cannot connect to host")

    async def get_hass(self, session, device_id, credential=None):
        await self._net("get_hass")
        if credential not in self.live:
            raise api.AuthenticationError("401")
        return self.webhook

    async def set_hass(self, session, device_id, credential, *, webhook_url, entities):
        await self._net("set_hass")
        if credential not in self.live:
            raise api.AuthenticationError("401")
        self.webhook, self.entities = webhook_url, entities

    async def unpair_self(self, session, device_id, credential):
        await self._net("unpair_self")
        if credential not in self.live:
            raise api.AuthenticationError("401")
        self.live.discard(credential)
        return True

    def patches(self):
        return (
            patch.object(api, "async_get_hass_webhook_url", self.get_hass),
            patch.object(api, "async_set_hass_config", self.set_hass),
            patch.object(api, "async_unpair_self", self.unpair_self),
            patch.object(removal, "_our_webhook_url", _ours),
        )


async def _ours(hass, device_id, hint):
    return OURS


def _entry(hass) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Front door",
        unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL,
              CONF_HOST_HINT: LAN_IP, CONF_LABEL: LABEL},
    )
    entry.add_to_hass(hass)
    return entry


async def _delete(hass, doorbell: FakeDoorbell) -> None:
    entry = _entry(hass)
    ps = doorbell.patches()
    for p in ps:
        p.start()
    try:
        await hass.config_entries.async_remove(entry.entry_id)
    finally:
        for p in ps:
            p.stop()
    assert hass.config_entries.async_entries(DOMAIN) == [], "the entry must go whatever happened"


def _issue(hass):
    return ir.async_get(hass).async_get_issue(DOMAIN, removal.issue_id_for(DEVICE_ID))


async def test_reachable_doorbell_clears_our_webhook_and_revokes_our_pairing(hass):
    doorbell = FakeDoorbell(OURS)
    await _delete(hass, doorbell)
    assert doorbell.webhook == ""
    assert doorbell.entities == []
    assert CREDENTIAL not in doorbell.live
    assert OTHER_CREDENTIAL in doorbell.live, "only OUR pairing is revoked"
    # The order matters: the webhook needs the credential that the unpair kills.
    assert doorbell.calls == ["get_hass", "set_hass", "unpair_self"]
    assert _issue(hass) is None


async def test_webhook_of_another_home_assistant_is_not_touched(hass):
    doorbell = FakeDoorbell(OTHER_HA)
    await _delete(hass, doorbell)
    assert doorbell.webhook == OTHER_HA, "the Home Assistant it moved to keeps its notices"
    assert doorbell.entities == [{"id": "lock.front"}]
    assert "set_hass" not in doorbell.calls
    assert CREDENTIAL not in doorbell.live, "our pairing is revoked anyway"
    assert _issue(hass) is None


async def test_no_webhook_at_all_still_revokes(hass):
    doorbell = FakeDoorbell("")
    await _delete(hass, doorbell)
    assert "set_hass" not in doorbell.calls
    assert CREDENTIAL not in doorbell.live


async def test_unreachable_doorbell_entry_removed_and_notice_created(hass):
    doorbell = FakeDoorbell(OURS, reachable=False)
    await _delete(hass, doorbell)
    issue = _issue(hass)
    assert issue is not None
    assert issue.translation_key == removal.ISSUE_PAIRING_LEFT
    assert issue.translation_placeholders == {"name": "Front door", "label": LABEL}
    assert issue.is_persistent and not issue.is_fixable
    assert CREDENTIAL in doorbell.live and doorbell.webhook == OURS  # nothing reached it


async def test_hanging_doorbell_never_holds_the_deletion(hass):
    doorbell = FakeDoorbell(OURS, hang=True)
    with patch.object(removal, "REMOVE_TIMEOUT", 0.2):
        started = time.monotonic()
        await _delete(hass, doorbell)
    assert time.monotonic() - started < 3
    assert _issue(hass) is not None


def test_the_real_budget_is_at_most_five_seconds():
    assert 0 < removal.REMOVE_TIMEOUT <= 5


async def test_already_revoked_pairing_is_not_a_notice(hass):
    doorbell = FakeDoorbell(OURS)
    doorbell.live.discard(CREDENTIAL)  # revoked from the app before the entry was deleted
    await _delete(hass, doorbell)
    assert _issue(hass) is None


async def test_the_notice_is_translated_in_all_six_languages():
    import json
    from pathlib import Path

    base = Path(removal.__file__).parent
    for lang in ("en", "es", "fr", "it", "de", "pt"):
        d = json.loads((base / "translations" / f"{lang}.json").read_text(encoding="utf-8"))
        issue = d["issues"][removal.ISSUE_PAIRING_LEFT]
        assert "{name}" in issue["title"], lang
        assert "{label}" in issue["description"] and "{name}" in issue["description"], lang


# ---------------------------------------------------------------------------------------------
# The wire format: what the doorbell's firmware actually needs to see (contract §1.5-ter, §4)
# ---------------------------------------------------------------------------------------------

class _Resp:
    def __init__(self, status, body=None):
        self.status, self._body = status, body or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self, content_type=None):
        return self._body


class _Session:
    def __init__(self, status=200, body=None):
        self.status, self.body, self.seen = status, body, []

    def get(self, url, **kw):
        self.seen.append(("GET", url, kw.get("data")))
        return _Resp(self.status, self.body)

    def post(self, url, **kw):
        self.seen.append(("POST", url, kw.get("data")))
        return _Resp(self.status, self.body)


async def test_unpair_self_sends_only_the_token_no_slot_no_label():
    s = _Session(200, {"status": "unpaired", "slot": 3})
    assert await api.async_unpair_self(s, DEVICE_ID, CREDENTIAL) is True
    method, url, data = s.seen[0]
    assert method == "POST"
    assert url.endswith(f":8443/api/unpair_app?token={CREDENTIAL}")
    assert not data, "a slot or a label would make it an admin operation on another pairing"


async def test_unpair_self_answers():
    assert await api.async_unpair_self(_Session(404), DEVICE_ID, CREDENTIAL) is False
    with pytest.raises(api.AuthenticationError):
        await api.async_unpair_self(_Session(401), DEVICE_ID, CREDENTIAL)
    with pytest.raises(api.DoorbellApiError):
        await api.async_unpair_self(_Session(500), DEVICE_ID, CREDENTIAL)


async def test_reading_the_webhook_with_the_pairing_token():
    s = _Session(200, {"url": OURS + " "})
    assert await api.async_get_hass_webhook_url(s, DEVICE_ID, CREDENTIAL) == OURS
    assert s.seen[0][1].endswith(f":8443/api/hass?token={CREDENTIAL}")
    with pytest.raises(api.AuthenticationError):
        await api.async_get_hass_webhook_url(_Session(401), DEVICE_ID, CREDENTIAL)
    # The config flow's cookie read is unchanged: no token in the URL.
    s = _Session(200, {"url": ""})
    await api.async_get_hass_webhook_url(s, DEVICE_ID)
    assert s.seen[0][1].endswith(":8443/api/hass")

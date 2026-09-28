"""1.2.1: the card is also a Lovelace resource, kept at the current URL.

Why (card.py, docs/card.md): the extra module lives in the page's HTML, and Home Assistant's service
worker can keep serving an HTML saved before the integration added its module - for the installed
app's start page, for good. Lovelace resources come over the websocket on every dashboard load, so
a resource at the current URL loads the card whatever HTML the browser was given.

Checked on the REAL Lovelace resource collection (storage mode) that Home Assistant's own setup
creates: one resource, at the current URL; an old URL is updated, a duplicate removed, other
resources untouched; YAML mode is left alone without failing the setup; the last doorbell's removal
takes the resource away and an earlier one does not. tools/mutants.py breaks each of these.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import card
from custom_components.ig_doorbell.const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

OTHER = "/hacsfiles/some-card/some-card.js?hacstag=1"


class _FakeUrlManager:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def add(self, url: str) -> None:
        self.urls.append(url)


async def _lovelace(hass, config: dict | None = None):
    """Home Assistant's real lovelace setup, with the frontend's extra-module list stubbed."""
    from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

    await async_setup_component(hass, "http", {})
    hass.data[DATA_EXTRA_MODULE_URL] = _FakeUrlManager()
    hass.config.components.add("frontend")
    # lovelace registers its built-in panel through the frontend: stubbed, not what is measured.
    with patch("homeassistant.components.frontend.async_register_built_in_panel"):
        assert await async_setup_component(hass, "lovelace", config or {})
    resources = card._lovelace_resources(hass)  # noqa: SLF001
    return resources


def _items(resources) -> list[tuple[str, str]]:
    return sorted((i["url"], i["type"]) for i in resources.async_items())


async def test_setup_adds_the_card_as_one_module_resource(hass):
    resources = await _lovelace(hass)
    assert resources is not None, "storage-mode resources must be writable"
    url = await card.async_register_card(hass)
    assert _items(resources) == [(url, "module")]
    # A second setup (integration reload) neither duplicates nor changes it.
    hass.data.pop(card.DATA_CARD_URL)
    await card.async_sync_lovelace_resource(hass, url)
    assert _items(resources) == [(url, "module")]


async def test_an_old_url_is_updated_a_duplicate_removed_others_untouched(hass):
    resources = await _lovelace(hass)
    await resources.async_load()
    resources.loaded = True
    await resources.async_create_item({"res_type": "module", "url": OTHER})
    await resources.async_create_item({"res_type": "js", "url": f"{card.CARD_URL}?v=000000000000"})
    await resources.async_create_item({"res_type": "module", "url": f"{card.CARD_URL}?v=111111111111"})
    url = await card.async_register_card(hass)
    assert _items(resources) == sorted([(OTHER, "module"), (url, "module")])


async def test_yaml_mode_is_left_alone_and_setup_still_works(hass):
    await _lovelace(hass, {"lovelace": {"mode": "yaml", "resources": [{"url": OTHER, "type": "module"}]}})
    assert card._lovelace_resources(hass) is None  # noqa: SLF001
    url = await card.async_register_card(hass)
    assert url is not None
    data = hass.data["lovelace"]
    yaml_resources = data["resources"] if isinstance(data, dict) else data.resources
    assert [i["url"] for i in yaml_resources.async_items()] == [OTHER]


async def test_a_failing_collection_never_fails_the_setup(hass, caplog):
    resources = await _lovelace(hass)
    with patch.object(type(resources), "async_create_item", AsyncMock(side_effect=RuntimeError("boom"))):
        url = await card.async_register_card(hass)
    assert url is not None
    assert "Could not update the card's Lovelace resource" in caplog.text


def _entry(hass, device_id: str) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_DEVICE_ID: device_id, CONF_CREDENTIAL: "x"})
    entry.add_to_hass(hass)
    return entry


async def test_the_last_doorbell_removed_takes_the_resource_away(hass):
    resources = await _lovelace(hass)
    url = await card.async_register_card(hass)
    first, second = _entry(hass, "aaaa000000000001"), _entry(hass, "aaaa000000000002")
    # The real removal path: Home Assistant calls async_remove_entry while the entry is still listed.
    with patch("custom_components.ig_doorbell.api.async_set_hass_config", AsyncMock()):
        await hass.config_entries.async_remove(first.entry_id)
        assert _items(resources) == [(url, "module")], "another doorbell still uses the card"
        await hass.config_entries.async_remove(second.entry_id)
    assert _items(resources) == []


async def test_the_call_page_is_told_the_current_card_url(hass):
    """The call page imports the card itself when its document did not (frontend/ig-doorbell-panel.js)."""
    from custom_components.ig_doorbell import panel

    hass.config.components.add("frontend")
    await async_setup_component(hass, "http", {})
    hass.data[card.DATA_CARD_URL] = f"{card.CARD_URL}?v=abcdefabcdef"
    with patch("homeassistant.components.frontend.async_remove_panel"), \
         patch("homeassistant.components.panel_custom.async_register_panel", AsyncMock()) as reg:
        await panel.async_register_call_page(hass)
    assert reg.await_args.kwargs["config"]["card_url"] == f"{card.CARD_URL}?v=abcdefabcdef"
    js = panel.PANEL_PATH.read_text(encoding="utf-8")
    assert "import(cardUrl)" in js and "config.card_url" in js

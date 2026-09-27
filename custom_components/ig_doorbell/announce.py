"""Home Assistant announces the call on the house's speakers (1.2.0), no automation needed.

Picked in the same options step as the phones and panels ("configure in one place"). Off until a
speaker is picked. It coexists with a user's own automation that announces on the same speakers:
the options text says so - if you already announce by automation, you do not need this (or remove
that part of your automation), otherwise the speaker announces twice.

## Two kinds of speaker, because they are not driven the same way

- **Alexa (the official `alexa_devices` integration)**: an Echo cannot play an arbitrary audio URL
  from Home Assistant. It gets Amazon's own doorbell chime (`alexa_devices.send_sound`), and the
  spoken sentence through its `announce` notify entity.
- **Every other media player** (Google/Nest, Sonos, HA Voice, VLC...): our own chime
  (`sounds/ig-doorbell-chime.mp3`, synthesized for this product - tools/make_chime.py) through
  `media_player.play_media` with `announce: true`, so the player resumes whatever it was playing.
  The sentence through `tts.speak`, if the installation has a TTS engine.

What it never does: wait for a speaker. A speaker that fails is logged and the ring goes on.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SOUND_FILENAME = "ig-doorbell-chime.mp3"
SOUND_PATH = Path(__file__).parent / "sounds" / SOUND_FILENAME
SOUND_URL = f"/{DOMAIN}/sounds/{SOUND_FILENAME}"
DATA_SOUND = f"{DOMAIN}_sound_served"

ALEXA_PLATFORM = "alexa_devices"
ALEXA_CHIME = "amzn_sfx_doorbell_chime_01"


async def async_serve_sound(hass: HomeAssistant) -> None:
    """Serve the chime WITHOUT authentication: a speaker fetches it with no Home Assistant token.

    It is a public, product-wide sound - nothing about the house is in it - so an open URL costs
    nothing, and it is the only way a Cast or Sonos speaker can play it.
    """
    if hass.data.get(DATA_SOUND):
        return
    hass.data[DATA_SOUND] = True
    await hass.http.async_register_static_paths(
        [StaticPathConfig(SOUND_URL, str(SOUND_PATH), True)]
    )


def _sound_url(hass: HomeAssistant) -> str | None:
    """An absolute URL the speakers on the LAN can reach: Home Assistant's INTERNAL address."""
    from homeassistant.helpers.network import NoURLAvailableError, get_url

    try:
        base = get_url(hass, allow_internal=True, allow_external=False, allow_cloud=False,
                       allow_ip=True, prefer_external=False)
    except NoURLAvailableError:
        _LOGGER.warning("Announce on speakers: Home Assistant has no internal URL the speakers "
                        "can reach; set one in Settings > System > Network")
        return None
    return f"{base.rstrip('/')}{SOUND_URL}"


def _alexa_announce_entity(reg: er.EntityRegistry, device_id: str) -> str | None:
    """The `announce` notify entity of that Echo (alexa_devices has `speak` and `announce`)."""
    for e in er.async_entries_for_device(reg, device_id):
        if e.domain == "notify" and e.platform == ALEXA_PLATFORM and (
            e.translation_key == "announce" or (e.unique_id or "").endswith("announce")
        ):
            return e.entity_id
    return None


def _tts_entity(hass: HomeAssistant) -> str | None:
    states = sorted(s.entity_id for s in hass.states.async_all("tts"))
    return states[0] if states else None


async def async_announce(hass: HomeAssistant, players: list[str], voice: bool, message: str) -> None:
    """Announce one ring on every picked speaker, all at once. Never raises."""
    reg = er.async_get(hass)
    url = _sound_url(hass) if any(
        (e := reg.async_get(p)) is None or e.platform != ALEXA_PLATFORM for p in players or []
    ) else None
    await asyncio.gather(*(_one(hass, reg, p, voice, message, url) for p in players or []),
                         return_exceptions=True)


async def _one(hass: HomeAssistant, reg: er.EntityRegistry, player: str, voice: bool,
               message: str, url: str | None) -> None:
    entry = reg.async_get(player)
    try:
        if entry is not None and entry.platform == ALEXA_PLATFORM and entry.device_id:
            await hass.services.async_call(
                ALEXA_PLATFORM, "send_sound",
                {"device_id": entry.device_id, "sound": ALEXA_CHIME}, blocking=True)
            if voice and (target := _alexa_announce_entity(reg, entry.device_id)):
                await hass.services.async_call(
                    "notify", "send_message", {"entity_id": target, "message": message},
                    blocking=True)
            return
        if url:
            data: dict[str, Any] = {"entity_id": player, "media_content_id": url,
                                    "media_content_type": "music", "announce": True}
            await hass.services.async_call("media_player", "play_media", data, blocking=True)
        if voice and (engine := _tts_entity(hass)):
            await hass.services.async_call(
                "tts", "speak", {"entity_id": engine, "media_player_entity_id": player,
                                 "message": message}, blocking=True)
    except Exception as err:  # noqa: BLE001 - one speaker failing must not stop the others
        _LOGGER.warning("Announce on %s failed: %s", player, err)

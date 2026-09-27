"""Ring notifications sent by the integration itself (1.2.0).

The whole design, and why this is built in instead of a blueprint, is in
docs/design/ha-only-ringing.md. In one paragraph: the owner picks companion-app phones and panels
in the options, and on every ring this module rings them; when the doorbell says the call was
resolved (`call_answered` / `call_declined` / `call_missed`, firmware 0.101.3) it clears the
notification everywhere and sends the panels back to their dashboard.

## ⚠️ WHAT KEEPS THE CALL'S NOTICES TOGETHER IS THE TAG, one per call

`igd_<device_id>_<call_id>`. The ring, the "missed" that replaces it and the `clear_notification`
all carry the SAME tag - that is what lets the companion app replace or remove exactly that
notification. A tag per doorbell would make a late resolution of call A clear call B's ring; a tag
without the call would let a new ring silently replace a missed-call notice. `_tag()` is the only
place it is built: change it there or nowhere.

## What it never does

- Wait for the picture before ringing (§3.5). The picture is fetched by image.py; the phone asks for
  it a moment later.
- Talk to the VPS. Everything here is Home Assistant -> companion (Home Assistant's own push) and
  Home Assistant -> doorbell over the LAN (open door).
- Invent an outcome. With no resolution (a firmware before 0.101.3), phones keep their notice and
  only the panels go home after RING_SAFETY_S.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util
from homeassistant.util import slugify

from . import api
from .const import (
    CALL_PAGE_PATH,
    CONF_NOTIFY_CRITICAL,
    CONF_NOTIFY_OPEN_DOOR,
    CONF_NOTIFY_PANELS,
    CONF_NOTIFY_PHONES,
    CONF_PANEL_RETURN_PATH,
    OPEN_DOOR_WINDOW_S,
    RING_SAFETY_S,
    SIGNAL_EVENT,
)
from .coordinator import DoorbellCoordinator

_LOGGER = logging.getLogger(__name__)

ACTION_EVENT = "mobile_app_notification_action"
OPEN_ACTION_PREFIX = "IGD_OPEN_"
RESOLUTIONS = ("call_answered", "call_declined", "call_missed")

# Android channels. A channel's sound and importance are fixed by Android the first time it is
# used, so their NAMES are part of the interface: renaming one creates a new channel on every phone.
CH_ALARM = "alarm_stream"                 # the companion's special channel: rings on the alarm stream
CH_RING = "IG Doorbell"                   # high importance, normal ringer stream
CH_QUIET = "IG Doorbell - missed calls"   # low importance: a replacement that must not ring again

# ⚠️ EVERY message to an Android phone goes as a HIGH-priority push, including the ones that only
# CLEAR or quietly REPLACE the ring - not just the ring itself. Measured on a real Android 14 phone
# (2026-09-27): lying still, the phone was in Doze (`deviceidle` mState=IDLE); the high-priority ring
# arrived at once, and the normal-priority clear and "missed call" replacement did not arrive for
# minutes - two stale ring notifications still up a minute after the call was answered. Firebase
# holds normal-priority messages for a Doze maintenance window. `ttl: 0` = deliver now or drop.
ANDROID_NOW = {"priority": "high", "ttl": 0}

# What the family reads, in the doorbell owner's language (the envelope's `lang`), English fallback.
# Six languages: the product's set (CLAUDE.md language rule - what the owner reads is translated).
TEXTS: dict[str, dict[str, str]] = {
    "en": {"door_expired": "This call is over: open the door from the doorbell page", "ring": "Someone is at the door", "open_call": "Open", "open_door": "Open door",
           "missed": "Missed call at {time}", "door_opened": "Door opened",
           "door_failed": "Could not open the door: {why}"},
    "es": {"door_expired": "Esta llamada ya terminó: abre la puerta desde la página del portero", "ring": "Están llamando a la puerta", "open_call": "Abrir", "open_door": "Abrir puerta",
           "missed": "Llamada perdida a las {time}", "door_opened": "Puerta abierta",
           "door_failed": "No se pudo abrir la puerta: {why}"},
    "fr": {"door_expired": "Cet appel est terminé : ouvrez la porte depuis la page de la sonnette", "ring": "Quelqu'un sonne à la porte", "open_call": "Ouvrir", "open_door": "Ouvrir la porte",
           "missed": "Appel manqué à {time}", "door_opened": "Porte ouverte",
           "door_failed": "Impossible d'ouvrir la porte : {why}"},
    "it": {"door_expired": "Questa chiamata è terminata: apri la porta dalla pagina del videocitofono", "ring": "Qualcuno suona alla porta", "open_call": "Apri", "open_door": "Apri la porta",
           "missed": "Chiamata persa alle {time}", "door_opened": "Porta aperta",
           "door_failed": "Impossibile aprire la porta: {why}"},
    "de": {"door_expired": "Dieser Anruf ist vorbei: Öffne die Tür über die Seite der Türklingel", "ring": "Es klingelt an der Tür", "open_call": "Öffnen", "open_door": "Tür öffnen",
           "missed": "Verpasster Anruf um {time}", "door_opened": "Tür geöffnet",
           "door_failed": "Die Tür konnte nicht geöffnet werden: {why}"},
    "pt": {"door_expired": "Esta chamada já terminou: abra a porta na página da campainha", "ring": "Estão a tocar à porta", "open_call": "Abrir", "open_door": "Abrir a porta",
           "missed": "Chamada perdida às {time}", "door_opened": "Porta aberta",
           "door_failed": "Não foi possível abrir a porta: {why}"},
}


def text(lang: str | None, key: str, **kw: Any) -> str:
    table = TEXTS.get((lang or "")[:2].lower()) or TEXTS["en"]
    return table[key].format(**kw)


def call_page_url(device_id: str) -> str:
    """The call page (panel.py): the card full-screen for one doorbell."""
    return f"/{CALL_PAGE_PATH}?device={device_id}"


def _tag(device_id: str, call_id: str) -> str:
    return f"igd_{device_id}_{call_id}"


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", s or "")


@dataclass
class Target:
    """One companion app to notify."""

    service: str        # `mobile_app_<slug>` in the `notify` domain
    platform: str       # "ios" / "android"
    role: str           # "phone" / "panel"
    name: str


@dataclass
class Call:
    call_id: str
    tag: str
    lang: str | None
    dname: str
    started: float
    targets: list[Target]
    outcome: str | None = None
    cancel_safety: Callable[[], None] | None = None
    panels_home: bool = False
    extra: dict = field(default_factory=dict)


def resolve_targets(hass: HomeAssistant, device_ids: list[str], role: str) -> list[Target]:
    """Registry device ids of companion apps -> their notify services, resolved NOW.

    Resolved at send time and not at configuration time: renaming the phone in the companion app
    renames its notify service, and a stored service name would go silent without telling anyone.
    """
    registry = dr.async_get(hass)
    found: list[Target] = []
    for did in device_ids or []:
        device = registry.async_get(did)
        if device is None:
            _LOGGER.warning("Ring notifications: a picked device no longer exists (%s)", did)
            continue
        entry = None
        for eid in device.config_entries:
            e = hass.config_entries.async_get_entry(eid)
            if e is not None and e.domain == "mobile_app":
                entry = e
                break
        if entry is None:
            _LOGGER.warning("Ring notifications: %s is not a companion-app device", device.name)
            continue
        name = entry.data.get("device_name") or device.name or ""
        # The same rule the notify integration applies to mobile_app targets (legacy notify:
        # slugify(f"{prefix}_{name}")).
        service = slugify(f"mobile_app_{name}")
        ident = f"{entry.data.get('app_id', '')} {entry.data.get('os_name', '')}".lower()
        platform = "android" if "android" in ident else "ios"
        found.append(Target(service=service, platform=platform, role=role, name=name))
    return found


class RingNotifier:
    """Rings the picked phones and panels for one doorbell, and cleans up after the call."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator,
                 has_picture: Callable[[], bool], image_entity_id: Callable[[], str | None]) -> None:
        self.hass = hass
        self.entry = entry
        self.coordinator = coordinator
        self._has_picture = has_picture
        self._image_entity_id = image_entity_id
        self.calls: dict[str, Call] = {}

    # -- wiring -----------------------------------------------------------------------------------

    @callback
    def async_start(self) -> Callable[[], None]:
        unsubs = [
            async_dispatcher_connect(
                self.hass, SIGNAL_EVENT.format(device_id=self.coordinator.device_id), self._received
            ),
            self.hass.bus.async_listen(ACTION_EVENT, self._on_action),
        ]

        def _stop() -> None:
            for u in unsubs:
                u()
            for call in self.calls.values():
                if call.cancel_safety:
                    call.cancel_safety()
            self.calls.clear()

        return _stop

    @property
    def enabled(self) -> bool:
        o = self.entry.options
        return bool(o.get(CONF_NOTIFY_PHONES) or o.get(CONF_NOTIFY_PANELS))

    def targets(self) -> list[Target]:
        o = self.entry.options
        panels = resolve_targets(self.hass, o.get(CONF_NOTIFY_PANELS) or [], "panel")
        # A device picked in both lists is a panel: it would otherwise get two rings.
        panel_services = {t.service for t in panels}
        phones = [t for t in resolve_targets(self.hass, o.get(CONF_NOTIFY_PHONES) or [], "phone")
                  if t.service not in panel_services]
        return phones + panels

    @callback
    def _received(self, envelope: dict) -> None:
        if not self.enabled:
            return
        ev = envelope.get("ev")
        if ev == "ring":
            self.hass.async_create_task(self.async_ring(envelope), eager_start=False)
        elif ev in RESOLUTIONS:
            self.hass.async_create_task(self.async_resolved(envelope), eager_start=False)

    # -- sending ----------------------------------------------------------------------------------

    async def _send(self, target: Target, message: str, data: dict | None = None,
                    title: str | None = None) -> bool:
        payload: dict[str, Any] = {"message": message}
        if title is not None:
            payload["title"] = title
        if data:
            payload["data"] = data
        try:
            await self.hass.services.async_call("notify", target.service, payload, blocking=True)
            return True
        except Exception as err:  # noqa: BLE001 - one phone failing must not stop the others
            _LOGGER.warning("Ring notification to %s (notify.%s) failed: %s",
                            target.name, target.service, err)
            return False

    async def _each(self, coros) -> None:
        await asyncio.gather(*coros, return_exceptions=True)

    # -- the ring ---------------------------------------------------------------------------------

    async def async_ring(self, envelope: dict) -> None:
        device_id = self.coordinator.device_id
        # A ring without call_id (a very old firmware) still rings; it just can never be resolved.
        call_id = str(envelope.get("call_id") or f"t{envelope.get('ts') or int(time.time())}")
        if call_id in self.calls:
            return      # the same ring delivered twice (a webhook retry): ring once
        targets = self.targets()
        if not targets:
            return
        call = Call(call_id=call_id, tag=_tag(device_id, call_id), lang=envelope.get("lang"),
                    dname=envelope.get("dname") or self.coordinator.doorbell_name,
                    started=time.monotonic(), targets=targets)
        self.calls[call_id] = call
        self._forget_old()
        call.cancel_safety = async_call_later(self.hass, RING_SAFETY_S, self._safety(call_id))
        await self._each(self._ring_one(call, t) for t in targets)

    def _ring_data(self, call: Call, target: Target) -> dict:
        o = self.entry.options
        critical = o.get(CONF_NOTIFY_CRITICAL, True)
        url = call_page_url(self.coordinator.device_id)
        data: dict[str, Any] = {"tag": call.tag, "group": f"igd_{self.coordinator.device_id}"}
        image = self._image_entity_id()
        if image and self._has_picture():
            data["image"] = f"/api/image_proxy/{image}"
        actions = [{"action": "URI", "title": text(call.lang, "open_call"), "uri": url}]
        if (target.role == "phone" and o.get(CONF_NOTIFY_OPEN_DOOR, False)
                and self.coordinator.has_lock):
            actions.append({
                "action": f"{OPEN_ACTION_PREFIX}{self.coordinator.device_id}_{_safe(call.call_id)}",
                "title": text(call.lang, "open_door"),
                # iOS asks for Face ID / the passcode before running it. Android: see the design
                # note - not measured, which is why this action is off by default.
                "authenticationRequired": True,
            })
        data["actions"] = actions
        if target.platform == "ios":
            data["url"] = url
            data["push"] = (
                {"interruption-level": "critical",
                 "sound": {"name": "default", "critical": 1, "volume": 1.0}}
                if critical else {"interruption-level": "time-sensitive"}
            )
        else:
            data.update({
                "clickAction": url,
                "ttl": 0,
                "priority": "high",
                "channel": CH_ALARM if critical else CH_RING,
                "importance": "high",
                "visibility": "public",
                "car_ui": True,
            })
        return data

    async def _ring_one(self, call: Call, target: Target) -> None:
        await self._send(target, text(call.lang, "ring"), self._ring_data(call, target),
                         title=call.dname)
        if target.role == "panel" and target.platform == "android":
            # Wake the screen, then put the call page in front. Commands go with high priority so
            # Android delivers them at once. ⚠️ command_webview needs the companion's "Display over
            # other apps" permission; without it Android shows a plain notification instead, in
            # silence (lived on the salon panel) - the options page says so.
            high = {"ttl": 0, "priority": "high"}
            await self._send(target, "command_screen_on", dict(high))
            await self._send(target, "command_webview",
                             {**high, "command": call_page_url(self.coordinator.device_id)})

    # -- the resolution ---------------------------------------------------------------------------

    async def async_resolved(self, envelope: dict) -> None:
        call = self.calls.get(str(envelope.get("call_id") or ""))
        if call is None or call.outcome is not None:
            return      # not a call we rang, or already resolved (first resolution wins)
        call.outcome = envelope.get("ev")
        if call.cancel_safety:
            call.cancel_safety()
            call.cancel_safety = None
        coros = []
        for t in call.targets:
            if call.outcome == "call_missed" and t.role == "phone":
                coros.append(self._missed(call, t, envelope.get("ts"), envelope.get("tz_name")))
            else:
                coros.append(self._clear(call, t))
        await self._each(coros)
        await self._panels_home(call)

    async def _clear(self, call: Call, target: Target) -> None:
        data: dict[str, Any] = {"tag": call.tag}
        if target.platform == "android":
            data.update(ANDROID_NOW)
        await self._send(target, "clear_notification", data)

    async def _replace_quiet(self, call: Call, target: Target, message: str) -> None:
        data: dict[str, Any] = {"tag": call.tag, "group": f"igd_{self.coordinator.device_id}"}
        url = call_page_url(self.coordinator.device_id)
        if target.platform == "ios":
            data["url"] = url
            data["push"] = {"interruption-level": "passive", "sound": "none"}
        else:
            data.update({"clickAction": url, "channel": CH_QUIET, "importance": "low",
                         "alert_once": True, **ANDROID_NOW})
        await self._send(target, message, data, title=call.dname)

    async def _missed(self, call: Call, target: Target, ts: Any, tz_name: Any = None) -> None:
        # The doorbell's own clock and zone (the envelope's `ts` / `tz_name`): the time the family
        # reads is the one at the door. `ts` 0 = the doorbell had no clock yet -> now.
        when = dt_util.utc_from_timestamp(int(ts)) if ts else dt_util.utcnow()
        tz = dt_util.get_time_zone(tz_name) if isinstance(tz_name, str) and tz_name else None
        when = when.astimezone(tz) if tz else dt_util.as_local(when)
        await self._replace_quiet(call, target, text(call.lang, "missed", time=when.strftime("%H:%M")))

    async def _panels_home(self, call: Call) -> None:
        if call.panels_home:
            return
        call.panels_home = True
        ret = (self.entry.options.get(CONF_PANEL_RETURN_PATH) or "").strip()
        data: dict[str, Any] = {"ttl": 0, "priority": "high"}
        if ret:
            data["command"] = ret
        await self._each(
            self._send(t, "command_webview", dict(data))
            for t in call.targets if t.role == "panel" and t.platform == "android"
        )

    def _safety(self, call_id: str):
        async def _fire(_now) -> None:
            call = self.calls.get(call_id)
            if call is None or call.outcome is not None:
                return
            call.cancel_safety = None
            _LOGGER.info("No resolution for call %s after %d s: panels go home, phones keep "
                         "their notice (the outcome is unknown)", call_id, RING_SAFETY_S)
            await self._each(self._clear(call, t) for t in call.targets if t.role == "panel")
            await self._panels_home(call)
        return _fire

    def _forget_old(self) -> None:
        now = time.monotonic()
        for cid in [c for c, v in self.calls.items() if now - v.started > 3600]:
            call = self.calls.pop(cid)
            if call.cancel_safety:
                call.cancel_safety()

    # -- "Open door" from the notification --------------------------------------------------------

    def open_allowed(self, call: Call | None) -> str | None:
        """None if the door may be opened for this call, else the reason it may not."""
        if call is None:
            return "unknown_call"
        if time.monotonic() - call.started > OPEN_DOOR_WINDOW_S:
            return "too_late"
        if call.outcome in ("call_missed", "call_declined"):
            return "call_over"
        if not self.entry.options.get(CONF_NOTIFY_OPEN_DOOR, False):
            return "disabled"
        return None

    async def _on_action(self, event: Event) -> None:
        action = str(event.data.get("action") or "")
        prefix = f"{OPEN_ACTION_PREFIX}{self.coordinator.device_id}_"
        if not action.startswith(prefix):
            return
        wanted = action[len(prefix):]
        call = next((c for c in self.calls.values() if _safe(c.call_id) == wanted), None)
        why = self.open_allowed(call)
        if why is not None:
            # Refused and said: a notification left in the shade must never open the door later.
            _LOGGER.warning("Open door from a notification REFUSED (%s), call %s", why, wanted)
            if call is not None:
                await self._each(self._replace_quiet(call, t, text(call.lang, "door_expired"))
                                 for t in call.targets if t.role == "phone")
            return
        c = self.coordinator
        try:
            await api.async_open_door(c.session, c.device_id, c.credential)
        except api.DoorbellApiError as err:
            # §1.8: never swallowed. Someone is waiting outside and a silent failure reads as open.
            _LOGGER.warning("Open door from a notification failed: %s", err)
            await self._each(self._replace_quiet(call, t, text(call.lang, "door_failed", why=str(err)))
                             for t in call.targets if t.role == "phone")
            return
        _LOGGER.info("Door opened from a ring notification (call %s)", call.call_id)
        await self._each(self._replace_quiet(call, t, text(call.lang, "door_opened"))
                         for t in call.targets if t.role == "phone")

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
from .announce import async_announce
from . import call_page_nav, panel_identity, panel_roles
from .const import (
    CALL_PAGE_PATH,
    CONF_ANNOUNCE_PLAYERS,
    CONF_ANNOUNCE_VOICE,
    CONF_NOTIFY_CRITICAL,
    CONF_NOTIFY_OPEN_DOOR,
    CONF_NOTIFY_PANELS,
    CONF_NOTIFY_PHONES,
    CONF_NOTIFY_PRIMARY_PANEL,
    OPEN_DOOR_WINDOW_S,
    RING_SAFETY_S,
    SIGNAL_EVENT,
    SNAPSHOT_TIMEOUT_S,
)

# How long the ring may wait for its picture (see async_ring). Never more: the ring comes first.
RING_PICTURE_WAIT_S = 1.5
assert RING_PICTURE_WAIT_S < SNAPSHOT_TIMEOUT_S
from .coordinator import DoorbellCoordinator

_LOGGER = logging.getLogger(__name__)

ACTION_EVENT = "mobile_app_notification_action"
OPEN_ACTION_PREFIX = "IGD_OPEN_"
RESOLUTIONS = ("call_answered", "call_declined", "call_missed")
# (1.6.0) What a panel's page is told about the call: the phase, in the card's own words.
PHASES = {"call_answered": "answered", "call_declined": "declined", "call_missed": "missed"}
# A panel whose page turns up this long after the call was resolved is still told about THAT call
# (it shows "answered on another device" / "missed call", never the live video by itself). Later
# than this the page is just a page somebody opened: no call, the card behaves as always.
RESOLVED_RECENT_S = 30.0

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
    "en": {"voice": "{dname}: someone is at the door", "door_expired": "This call is over: open the door from the doorbell page", "ring": "Someone is at the door", "open_call": "Open", "open_door": "Open door",
           "missed": "Missed call at {time}", "door_opened": "Door opened",
           "door_failed": "Could not open the door: {why}"},
    "es": {"voice": "{dname}: están llamando a la puerta", "door_expired": "Esta llamada ya terminó: abre la puerta desde la página del portero", "ring": "Están llamando a la puerta", "open_call": "Abrir", "open_door": "Abrir puerta",
           "missed": "Llamada perdida a las {time}", "door_opened": "Puerta abierta",
           "door_failed": "No se pudo abrir la puerta: {why}"},
    "fr": {"voice": "{dname} : quelqu'un sonne à la porte", "door_expired": "Cet appel est terminé : ouvrez la porte depuis la page de la sonnette", "ring": "Quelqu'un sonne à la porte", "open_call": "Ouvrir", "open_door": "Ouvrir la porte",
           "missed": "Appel manqué à {time}", "door_opened": "Porte ouverte",
           "door_failed": "Impossible d'ouvrir la porte : {why}"},
    "it": {"voice": "{dname}: qualcuno suona alla porta", "door_expired": "Questa chiamata è terminata: apri la porta dalla pagina del videocitofono", "ring": "Qualcuno suona alla porta", "open_call": "Apri", "open_door": "Apri la porta",
           "missed": "Chiamata persa alle {time}", "door_opened": "Porta aperta",
           "door_failed": "Impossibile aprire la porta: {why}"},
    "de": {"voice": "{dname}: Es klingelt an der Tür", "door_expired": "Dieser Anruf ist vorbei: Öffne die Tür über die Seite der Türklingel", "ring": "Es klingelt an der Tür", "open_call": "Öffnen", "open_door": "Tür öffnen",
           "missed": "Verpasster Anruf um {time}", "door_opened": "Tür geöffnet",
           "door_failed": "Die Tür konnte nicht geöffnet werden: {why}"},
    "pt": {"voice": "{dname}: estão a tocar à porta", "door_expired": "Esta chamada já terminou: abra a porta na página da campainha", "ring": "Estão a tocar à porta", "open_call": "Abrir", "open_door": "Abrir a porta",
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
    user_id: str | None = None   # the HA user the companion registered as
    model: str | None = None     # the device model it registered with
    device_id: str | None = None  # its registry device id: a panel's identity (panel_identity.py)


@dataclass
class Call:
    call_id: str
    tag: str
    lang: str | None
    dname: str
    started: float
    targets: list[Target]
    outcome: str | None = None
    picture: bool = False
    cancel_safety: Callable[[], None] | None = None
    extra: dict = field(default_factory=dict)
    # (1.6.0) Which panel loads the live video by itself (panel_roles.py). None = no panel.
    roles: panel_roles.CallRoles | None = None
    resolved_at: float | None = None
    cancel_grace: Callable[[], None] | None = None


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
        found.append(Target(service=service, platform=platform, role=role, name=name,
                            user_id=entry.data.get("user_id"), model=entry.data.get("model"),
                            device_id=device.id))
    return found


class RingNotifier:
    """Rings the picked phones and panels for one doorbell, and cleans up after the call."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator,
                 has_picture: Callable[[], bool], image_entity_id: Callable[[], str | None],
                 image: Callable[[], Any] | None = None) -> None:
        self.hass = hass
        self.entry = entry
        self.coordinator = coordinator
        self._has_picture = has_picture
        self._image_entity_id = image_entity_id
        self._image = image or (lambda: None)
        self.calls: dict[str, Call] = {}
        # (1.6.0) Pages of picked panels listening for what to do: key -> (panel device id, send).
        self.panel_subs: dict[int, tuple[str, Callable[[dict], None]]] = {}
        self._next_sub = 0

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
                if call.cancel_grace:
                    call.cancel_grace()
            self.calls.clear()

        return _stop

    @property
    def enabled(self) -> bool:
        o = self.entry.options
        return bool(o.get(CONF_NOTIFY_PHONES) or o.get(CONF_NOTIFY_PANELS)
                    or o.get(CONF_ANNOUNCE_PLAYERS))

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
        dname = envelope.get("dname") or self.coordinator.doorbell_name
        players = self.entry.options.get(CONF_ANNOUNCE_PLAYERS) or []
        if players:
            # The speakers do not wait for anything - not the picture, not the phones.
            self.hass.async_create_task(
                async_announce(self.hass, players, bool(self.entry.options.get(CONF_ANNOUNCE_VOICE)),
                               text(envelope.get("lang"), "voice", dname=dname)),
                eager_start=False)
        targets = self.targets()
        if not targets:
            self.calls[call_id] = Call(call_id=call_id, tag=_tag(device_id, call_id),
                                       lang=envelope.get("lang"), dname=dname,
                                       started=time.monotonic(), targets=[])
            return
        call = Call(call_id=call_id, tag=_tag(device_id, call_id), lang=envelope.get("lang"),
                    dname=envelope.get("dname") or self.coordinator.doorbell_name,
                    started=time.monotonic(), targets=targets)
        call.roles = self._roles_for(targets, call.started)
        self.calls[call_id] = call
        self._forget_old()
        # (1.6.0) A panel page that is ALREADY listening is there: it reports in now, in the
        # declared order, so a primary whose card was on screen before the ring keeps the role.
        self._tell_listening_panels(call, claim=True)
        call.cancel_safety = async_call_later(self.hass, RING_SAFETY_S, self._safety(call_id))
        # ⚠️ iOS downloads the attachment ONCE, when the notification arrives, and a picture not
        # there yet is simply missing. So wait for it - BOUNDED (§3.5: never delay the ring for a
        # picture; measured ~0.8 s on the bench doorbell). A doorbell that refused it (call_snap=0,
        # a 503) gets a notice without the picture instead of an empty frame.
        call.picture = False
        if self._has_picture() and (img := self._image()) is not None:
            call.picture = await img.async_wait_picture(RING_PICTURE_WAIT_S)
        if call.roles is not None and not call.roles.legacy and call.outcome is None:
            # The grace counts from the moment the panels are actually called, not from the wait
            # for the picture above.
            call.roles.ring_at = time.monotonic()
            call.cancel_grace = async_call_later(self.hass, call.roles.grace_s, self._grace(call_id))
        await self._each(self._ring_one(call, t) for t in targets)

    def _page_url(self, call: Call, target: Target) -> str:
        """The call page; for a PANEL, with the nonce that identifies its companion (1.2.4).

        ⚠️ Only this device's push carries this nonce, so the page that opens the URL and presents
        it (get_connection_info) is this device's app: panel_identity.py binds its login to it. That
        is how an iPad panel - no model in its user agent - is recognised at all. Do not drop it
        from any URL sent to a panel.
        """
        url = call_page_url(self.coordinator.device_id)
        if target.role != "panel" or not target.device_id:
            return url
        nonces = call.extra.setdefault("panel_nonce", {})
        if target.device_id not in nonces:
            nonces[target.device_id] = panel_identity.async_get(self.hass).issue(target.device_id)
        return panel_identity.with_nonce(url, nonces[target.device_id])

    def _ring_data(self, call: Call, target: Target) -> dict:
        o = self.entry.options
        critical = o.get(CONF_NOTIFY_CRITICAL, True)
        url = self._page_url(call, target)
        data: dict[str, Any] = {"tag": call.tag, "group": f"igd_{self.coordinator.device_id}"}
        image = self._image_entity_id()
        if image and call.picture:
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
        if target.role == "panel":
            # Wake the screen, then put the call page in front. Commands go with high priority so
            # Android delivers them at once. ⚠️ command_webview needs the companion's "Display over
            # other apps" permission; without it Android shows a plain notification instead, in
            # silence (lived on the salon panel) - the options page says so.
            #
            # (1.6.0) iPad: there is no command to wake it or to open a page (iOS has none), but
            # the IN-PLACE navigation below is done by the panel's own page, not by the system,
            # and nothing in call_page_nav / panel_identity is Android-only. So an iPad that keeps
            # Home Assistant on screen is taken to the call page the same way; one that is asleep
            # or elsewhere only has its notification, as before.
            android = target.platform == "android"
            high = {"ttl": 0, "priority": "high"}
            if android:
                await self._send(target, "command_screen_on", dict(high))
            url = call_page_url(self.coordinator.device_id)
            # ⚠️ (1.2.2) FIRST IN PLACE: command_webview opens a NEW companion window on every ring
            # (measured: four stacked on the salon panel, each with its own page and card) - see
            # call_page_nav.py. It stays only as the fallback when no page of the panel answers.
            if await call_page_nav.async_get(self.hass).async_show(target.device_id, url):
                _LOGGER.debug("Call page shown in place on %s", target.name)
                return
            if android:
                await self._send(target, "command_webview",
                                 {**high, "command": self._page_url(call, target)})

    # -- which panel loads the live video (1.6.0, panel_roles.py) ---------------------------------

    def _roles_for(self, targets: list[Target], now: float) -> panel_roles.CallRoles | None:
        """The roles of a new call: the declared order, minus the panels known to be gone.

        `targets` already leaves out a picked device that no longer exists or is not a companion
        app (resolve_targets); a DISABLED device is left out here. That is everything Home
        Assistant knows before the ring: the companion app has no "online" state, and a panel
        with its screen off has no page connected yet is perfectly reachable. Whether a panel is
        really there is learnt from its page reporting in (panel_roles rule 3).
        """
        o = self.entry.options
        registry = dr.async_get(self.hass)
        reachable = []
        for t in targets:
            if t.role != "panel" or not t.device_id:
                continue
            device = registry.async_get(t.device_id)
            if device is None or device.disabled_by is not None:
                continue
            reachable.append(t.device_id)
        if not reachable:
            return None
        stored = o.get(CONF_NOTIFY_PANELS) or []
        primary = panel_roles.effective_primary(stored, o.get(CONF_NOTIFY_PRIMARY_PANEL))
        order = [p for p in panel_roles.declared_order(stored, o.get(CONF_NOTIFY_PRIMARY_PANEL))
                 if p in reachable]
        return panel_roles.CallRoles(order=order, ring_at=now, legacy=primary is None)

    def current_call(self) -> Call | None:
        """The call a panel page is told about: the LATEST ring, never an earlier one."""
        with_roles = [c for c in self.calls.values() if c.roles is not None]
        return max(with_roles, key=lambda c: c.started) if with_roles else None

    def roles_configured(self, panel_id: str | None) -> bool:
        """Is `panel_id` a picked panel of this doorbell, with the roles on (a primary stored)?"""
        o = self.entry.options
        stored = o.get(CONF_NOTIFY_PANELS) or []
        return bool(panel_id) and panel_id in stored and panel_roles.effective_primary(
            stored, o.get(CONF_NOTIFY_PRIMARY_PANEL)) is not None

    def panel_instruction(self, panel_id: str | None, claim: bool = True) -> dict | None:
        """What the page of `panel_id` must do about the current call, or None (no call for it).

        `claim`: the page itself is asking, so it reports in (panel_roles rule 3).
        ⚠️ This is the ONLY place the answer is built: get_connection_info, the subscription and
        every push send exactly this, so a page can never hold two different instructions.
        """
        call = self.current_call()
        if call is None or not panel_id:
            return None
        return self._instruction(call, panel_id, claim)

    def _instruction(self, call: Call, panel_id: str, claim: bool) -> dict | None:
        roles = call.roles
        if roles is None or roles.legacy or panel_id not in roles.order:
            return None
        now = time.monotonic()
        if call.outcome is None:
            if call.extra.get("expired"):
                return None
            before = roles.holder
            stream = roles.claim(panel_id, now) if claim else roles.role(panel_id)
            if roles.holder is not None and roles.holder != before and roles.holder != panel_id:
                self._tell_panel(call, roles.holder)
            phase = "ringing"
        else:
            if call.resolved_at is None or now - call.resolved_at > RESOLVED_RECENT_S:
                return None
            phase = PHASES.get(call.outcome, "ended")
            # ANSWERED: whoever did not answer gives the stream back, so the one talking has the
            # slot. The integration cannot know WHICH page answered (the doorbell names the
            # pairing, not the browser), so the page with the microphone keeps it: "release"
            # means "unless you are the one talking". Declined / missed: as before, a panel that
            # holds the video keeps it until its own back-home deadline.
            stream = "release" if phase == "answered" else "keep"
        image = self._image_entity_id() if self._has_picture() else None
        return {"call_id": call.call_id, "phase": phase, "stream": stream, "still_entity": image}

    @callback
    def async_panel_subscribe(self, panel_id: str, send: Callable[[dict], None]) -> Callable[[], None]:
        """A page of a picked panel listens for what to do. It is told the current call at once."""
        self._next_sub += 1
        key = self._next_sub
        self.panel_subs[key] = (panel_id, send)
        now = self.panel_instruction(panel_id, claim=True)
        if now is not None:
            send(now)

        @callback
        def _unsub() -> None:
            self.panel_subs.pop(key, None)
        return _unsub

    def _tell_panel(self, call: Call, panel_id: str, claim: bool = False,
                    payload: dict | None = None) -> None:
        sends = [send for (pid, send) in list(self.panel_subs.values()) if pid == panel_id]
        if not sends:
            return
        what = payload or self._instruction(call, panel_id, claim)
        if what is None:
            return
        for send in sends:
            try:
                send(dict(what))
            except Exception as err:  # noqa: BLE001 - one closed page must not stop the others
                _LOGGER.debug("Panel page not told (%s)", err)

    def _tell_listening_panels(self, call: Call, claim: bool = False,
                               payload: dict | None = None) -> None:
        """Every listening page of this call's panels, in the declared order."""
        if call.roles is None or call.roles.legacy or call is not self.current_call():
            return      # legacy: nothing is told; an earlier call: never over the current one
        listening = {pid for (pid, _send) in self.panel_subs.values()}
        for panel_id in call.roles.order:
            if panel_id in listening:
                self._tell_panel(call, panel_id, claim, payload)

    def _grace(self, call_id: str):
        @callback
        def _fire(_now) -> None:
            call = self.calls.get(call_id)
            if call is None:
                return
            call.cancel_grace = None
            if call.roles is None or call.outcome is not None:
                return
            # The timer fired: the grace IS over, whatever the monotonic clock of a test says.
            promoted = call.roles.tick(max(time.monotonic(), call.roles.ring_at + call.roles.grace_s))
            if promoted is not None:
                _LOGGER.info("The primary panel did not show up in %.0f s: another panel loads "
                             "the live video for call %s", call.roles.grace_s, call_id)
                self._tell_panel(call, promoted)
        return _fire

    # -- the resolution ---------------------------------------------------------------------------

    async def async_resolved(self, envelope: dict) -> None:
        call = self.calls.get(str(envelope.get("call_id") or ""))
        if call is None or call.outcome is not None:
            return      # not a call we rang, or already resolved (first resolution wins)
        call.outcome = envelope.get("ev")
        call.resolved_at = time.monotonic()
        if call.cancel_safety:
            call.cancel_safety()
            call.cancel_safety = None
        if call.cancel_grace:
            call.cancel_grace()
            call.cancel_grace = None
        # (1.6.0) The panels' pages first: it is a websocket message, not a push through a cloud.
        self._tell_listening_panels(call)
        coros = []
        for t in call.targets:
            if call.outcome == "call_missed" and t.role == "phone":
                coros.append(self._missed(call, t, envelope.get("ts"), envelope.get("tz_name")))
            else:
                coros.append(self._clear(call, t))
        await self._each(coros)

    async def _clear(self, call: Call, target: Target) -> None:
        data: dict[str, Any] = {"tag": call.tag}
        if target.platform == "android":
            data.update(ANDROID_NOW)
        await self._send(target, "clear_notification", data)

    async def _replace_quiet(self, call: Call, target: Target, message: str) -> None:
        data: dict[str, Any] = {"tag": call.tag, "group": f"igd_{self.coordinator.device_id}"}
        # The replacement keeps the visitor's picture - measured on an iPhone: a "missed call" that
        # replaced the ring WITHOUT it left the owner with no picture at all. Only if the picture
        # held now is still THIS call's: after a later ring it would be somebody else's face.
        img = self._image()
        image_id = self._image_entity_id()
        if img is not None and image_id and img.picture_of(call.call_id):
            data["image"] = f"/api/image_proxy/{image_id}"
        url = self._page_url(call, target)
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

    def _safety(self, call_id: str):
        async def _fire(_now) -> None:
            call = self.calls.get(call_id)
            if call is None or call.outcome is not None:
                return
            call.cancel_safety = None
            _LOGGER.info("No resolution for call %s after %d s: the panels' chime notice is "
                         "cleared, phones keep theirs (the outcome is unknown)", call_id, RING_SAFETY_S)
            # (1.6.0) The panels' pages are told the ring is over (outcome unknown, never
            # invented): a page showing the still picture goes home; one with the video keeps it.
            self._tell_listening_panels(call, payload={
                "call_id": call.call_id, "phase": "ended", "stream": "keep", "still_entity": None})
            call.extra["expired"] = True
            await self._each(self._clear(call, t) for t in call.targets if t.role == "panel")
        return _fire

    def _forget_old(self) -> None:
        now = time.monotonic()
        for cid in [c for c, v in self.calls.items() if now - v.started > 3600]:
            call = self.calls.pop(cid)
            if call.cancel_safety:
                call.cancel_safety()
            if call.cancel_grace:
                call.cancel_grace()

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

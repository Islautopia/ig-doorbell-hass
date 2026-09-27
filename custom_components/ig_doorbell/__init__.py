"""The IG Doorbell integration.

Four runtime responsibilities - see ARCHITECTURE.md §3 for the reasoning behind what this
integration does NOT do:

  1. Receive what the doorbell has to say, over a webhook, and turn it into entities and events -
     webhook.py plus the entity platforms. This replaced MQTT on 2026-08-24.
  2. Ask the doorbell how it is, so those entities have state - coordinator.py.
  3. Server side of the Lovelace card: relays its signalling (signal_proxy.py) and its recordings
     (recordings_view.py) so the pairing credential never reaches a browser, and tells it which
     entities to read (websocket_api.py). LAN only: nothing here talks to the VPS (net.py).
  4. Config flow itself (Zeroconf discovery + manual entry, no YAML) - config_flow.py.

## Why this integration owns the entities now

It did not use to. Every entity a user saw - mode, doorbell, door, presence - was published by the
firmware's own MQTT discovery, and this integration set up no platforms at all. MQTT is gone
(API_CONTRACT.md §4), and the reason is not technical: a broker is a prerequisite half the audience
does not meet, and this has to work on a Home Assistant somebody installed this morning, exactly
the way the apps do.

What unblocked it is smaller than it sounds. `get_states` took a session cookie and nothing else,
and this integration holds a pairing credential and never the administrator's password - which is
precisely what pairing exists to avoid. So it could not read the doorbell's own state to build a
single entity. The firmware fixed that the same day (§1.2); see api.py.

IMPORTANT (found via real-hardware testing 2026-07-09): the device registered here still carries
the identifier the firmware's old MQTT discovery used, alongside our own. There is nothing left to
merge with today - but a Home Assistant that still carries the old MQTT-published entities would
otherwise end up with two disconnected devices for one physical doorbell.
"""
from __future__ import annotations

import asyncio
import logging
import socket
from ipaddress import ip_address, ip_network
from urllib.parse import urlparse


from homeassistant.components import network, persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import api, net, webhook
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_ENTITIES,
    CONF_HOST_HINT,
    DOMAIN,
    ALLOWED_DOMAINS,
    DOORBELL_HOSTNAME_SUFFIX,
    MAX_ENTITIES,
)
from .card import async_register_card
from .https_manager import async_setup_manager, get_manager
from .https_views import async_register_https_views
from .coordinator import DoorbellCoordinator
from .notify_ring import RingNotifier
from .panel import async_register_call_page
from .recordings_view import async_register_recordings_view
from .services import async_register_services
from .signal_proxy import async_register_signal_proxy
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[str] = [
    "binary_sensor", "button", "event", "image", "number", "select", "sensor", "switch",
]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register integration-wide resources once, regardless of how many entries get added."""
    await async_register_card(hass)
    async_register_websocket_commands(hass)
    async_register_signal_proxy(hass)
    async_register_recordings_view(hass)
    async_register_services(hass)
    # Local HTTPS for Home Assistant (off by default; https_manager.py). Views first: the install
    # page also explains how to turn it on when it is off.
    async_register_https_views(hass)
    mgr = await async_setup_manager(hass)

    async def _stop(_event: Event) -> None:
        await mgr.async_shutdown()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _stop)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one paired doorbell."""
    hass.data.setdefault(DOMAIN, {})

    # Register a device purely so this doorbell shows up in HA's own device registry - the
    # Lovelace card's editor uses the native `ha-selector` device picker (filtered to this
    # integration) to let the user pick a doorbell without ever typing/copying a device_id by
    # hand, and that picker only lists devices that actually exist in the registry.
    #
    # ONE identifier: our own. The card editor's device picker looks up exactly this pair in
    # `device.identifiers`, which is why the device is registered here at all.
    #
    # ⚠️ IT USED TO CARRY A SECOND ONE - the identifier the firmware's old MQTT discovery used -
    # so that Home Assistant would MERGE our device with the one the `mqtt` integration created for
    # the same physical doorbell. That was right while both existed, and it is removed now, because
    # it turned out to cost something I had written down as costing nothing.
    #
    # Measured on 2026-08-24, on a real installation: deleting the doorbell's MQTT device took THIS
    # INTEGRATION'S CONFIG ENTRY with it - the two shared a device, so removing the device removed
    # the entry attached to it. The webhook went with it, the doorbell carried on writing to an
    # address nobody was listening at, and the door stopped opening. Nothing said why; the only
    # trace was `async_remove_entry` logging that it could not unconfigure the webhook.
    #
    # And a second half that only got away with it by luck: that same removal path TELLS THE
    # DOORBELL TO STOP WRITING. It failed today because the removed entry's credential was already
    # dead. With a live one it would have succeeded - and the doorbell would have gone quiet
    # because of a deletion the user never aimed at us.
    #
    # The merge bought nothing any more: the firmware stopped speaking MQTT that same morning. An
    # installation upgrading from before will keep its old MQTT entities as a separate, unavailable
    # device, which is honest - they are not ours and nothing feeds them.
    #
    # Deliberately do NOT pass `name=` here (found via real-hardware testing 2026-07-09):
    # `async_get_or_create` only overwrites the stored device name when `name` is explicitly
    # passed, and passing our own entry.title on EVERY setup/reload would stomp the real
    # user-configured `device_name` (§0-bis) - which the entities publish from `dname`, the actual
    # source of truth (see entity.py). Omitting it means HA still names a brand-new device from
    # this entry's title, and our reloads never overwrite it again.
    device_registry = dr.async_get(hass)
    device_registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.data[CONF_DEVICE_ID])},
        manufacturer="Islautopia Garage",
        model="IG Doorbell",
    )

    device_id = entry.data[CONF_DEVICE_ID]

    # WHERE this doorbell lives: its LAN address, and nothing else (net.py). There is no longer a
    # public-DNS fallback to "learn" a new address from (Phase 0, 2026-09-25): a moved doorbell is
    # found again by zeroconf, or the user sets the address in the options flow.
    hostname = api.doorbell_hostname(device_id)
    address = await _lan_address(hass, entry)

    address_map = {hostname: address} if address else {}
    if not address:
        _LOGGER.error(
            "No LAN address stored for doorbell %s. Home Assistant only talks to the doorbell over "
            "the local network: set its address in the integration options (Doorbell address).",
            device_id,
        )
    else:
        probe_session = net.create_session(hass, {})
        try:
            if not await net.is_this_doorbell(probe_session, address, device_id):
                # Not an error by itself: the doorbell may be powered off. Said at INFO so a moved
                # doorbell is diagnosable; the entities go unavailable, which is what it means.
                _LOGGER.info(
                    "Doorbell %s does not answer at %s right now (off, or moved: zeroconf or the "
                    "options flow will update the address).", device_id, address,
                )
        finally:
            await probe_session.close()

    session = net.create_session(hass, address_map)

    coordinator = DoorbellCoordinator(
        hass, entry, device_id, entry.data[CONF_CREDENTIAL], session, address
    )

    # ⚠️ `async_refresh()` and NOT `async_config_entry_first_refresh()`, and it is deliberate.
    #
    # The second one ABORTS the entry's startup if the doorbell does not answer. And this entry
    # also acts as the card's credential broker (websocket_api.py), so a doorbell that is off for
    # a moment would take **the card down too** - a regression from how this worked with MQTT,
    # where startup always went through.
    #
    # With `async_refresh()` the entry always starts up: if the doorbell is not there, its
    # entities come up unavailable (entity.py), which is exactly what that means, and the card
    # keeps working.
    await coordinator.async_refresh()

    # ⚠️ HERE and not further down: the update listener (line further below,
    # `entry.add_update_listener`) is not registered yet, so this first correction does NOT
    # trigger a reload (Inaki, 2026-09-26: "the doorbell's name is actually useful, the id throws
    # you off"). Fixes on its own any old entry named by its device_id - Ermita's among them - the
    # moment this version starts, without waiting for the doorbell's name to change. See
    # `_sync_name`.
    _sync_name(hass, entry, coordinator)

    webhook_id = await webhook.async_register(hass, device_id, coordinator.doorbell_name)

    hass.data[DOMAIN][entry.entry_id] = {
        **dict(entry.data),
        "coordinator": coordinator,
        "webhook_id": webhook_id,
        "session": session,
    }

    _adopt_door_entity(hass, entry, coordinator)
    if not await _async_configure_doorbell(hass, entry, coordinator, first_time=True):
        _schedule_retry(hass, entry, coordinator)
    _watch_entities(hass, entry, coordinator)
    _watch_name(hass, entry, coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Ring notifications sent by the integration itself (1.2.0, docs/design/ha-only-ringing.md).
    # Always wired, but it does nothing until phones or panels are picked in the options.
    data = hass.data[DOMAIN][entry.entry_id]
    notifier = RingNotifier(
        hass, entry, coordinator,
        has_picture=lambda: (img := data.get("visitor_image")) is not None and img.has_picture,
        image_entity_id=lambda: (img := data.get("visitor_image")) and img.entity_id,
    )
    data["ring_notifier"] = notifier
    if (img := data.get("visitor_image")) is not None:
        img._wanted_at_ring = lambda: notifier.enabled  # noqa: SLF001 - wired here on purpose
    entry.async_on_unload(notifier.async_start())
    await async_register_call_page(hass)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    if (mgr := get_manager(hass)) is not None:
        # The first doorbell added at runtime starts HTTPS if it was left enabled.
        hass.async_create_task(mgr.async_apply(), eager_start=False)
    return True


async def _lan_address(hass: HomeAssistant, entry: ConfigEntry) -> str | None:
    """The stored LAN address as a literal IP.

    Entries created before 0.7.0 may hold a NAME the user typed. A LOCAL name is resolved once
    through the system resolver (the home's own DNS), and the address is stored so the next setup
    needs no lookup. A name under our cloud's domain is refused: resolving it is asking the VPS.
    """
    stored = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    if not stored or net.is_address(stored):
        return stored or None
    if stored.lower().rstrip(".").endswith(DOORBELL_HOSTNAME_SUFFIX):
        _LOGGER.error(
            "The stored address of %s is the cloud hostname %s. Home Assistant no longer resolves "
            "it (LAN only): set the doorbell's IP in the integration options.",
            entry.data[CONF_DEVICE_ID], stored,
        )
        return None
    try:
        info = await asyncio.get_running_loop().getaddrinfo(
            stored, 80, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except OSError:
        return None
    if not info:
        return None
    address = info[0][4][0]
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_HOST_HINT: address})
    return address


async def _async_configure_doorbell(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: DoorbellCoordinator,
    *,
    first_time: bool = False,
) -> bool:
    """Tells the doorbell where to send its notices and which entities it may act on (§4).

    The address given to it has to be reachable **without DNS**. See `_local_base`, which is
    where that problem lives and why `get_url()` alone is not enough to solve it.
    """
    base = await _local_base(hass, entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT))
    if base is None:
        _LOGGER.error(
            "Home Assistant does not know its own address on the local network, so it cannot "
            "tell the doorbell where to write. Set it in Settings > System > Network > "
            "\"Home Assistant address\" and reload this integration."
        )
        # No retry is scheduled: this is not fixed by the doorbell answering, it is fixed when
        # someone configures that address - and that already reloads the integration.
        return True

    webhook_url = f"{base.rstrip('/')}/api/webhook/{webhook.webhook_id_for(coordinator.device_id)}"
    entities = _valid_entities(entry.options.get(CONF_ENTITIES) or [], coordinator.device_id)
    # `domain` travels even though the doorbell could derive it from the id: it checks it against
    # the id, so a mismatch is visible instead of silently picking one (contract 4).
    entity_list = [
        {"id": e, "name": _friendly_name(hass, e), "domain": e.split(".", 1)[0]}
        for e in entities
    ]

    try:
        await api.async_set_hass_config(
            coordinator.session,
            coordinator.device_id,
            entry.data[CONF_CREDENTIAL],
            webhook_url=webhook_url,
            entities=entity_list,
        )
    except api.NotAllowedError:
        # Stated and NOT retried: re-pairing from an administrator session is the only thing that
        # fixes it, and a retry loop would only fill the log with something that will not change
        # on its own.
        _LOGGER.error(
            "This pairing is not an administrator of %s, so it cannot configure the webhook. "
            "Re-pair it from an administrator session.",
            coordinator.device_id,
        )
        return True
    except api.DoorbellApiError as err:
        # Not fatal: the entities keep working by polling. What is lost is what arrives PUSHED -
        # the ring, the package - so it is stated clearly instead of leaving the user wondering
        # why nothing fires, and it is retried as soon as the doorbell comes back.
        if first_time:
            _LOGGER.warning(
                "Could not configure the webhook on %s (%s). It will be retried as soon as the "
                "doorbell answers again; until then the entities work by polling but live "
                "notices will not arrive.",
                coordinator.device_id, err,
            )
        return False

    _PUSHED_NAMES[entry.entry_id] = {e["id"]: e["name"] for e in entity_list}
    _LOGGER.info(
        "Webhook configured on %s: %s (%d actionable entity/entities)",
        coordinator.device_id, webhook_url, len(entity_list),
    )
    return True


# The last thing said to each doorbell about each entity: its friendly name. Used to avoid
# re-pushing the list on every light's STATE change - only when what the doorbell stores changes.
_PUSHED_NAMES: dict[str, dict[str, str]] = {}


def _valid_entities(entities: list[str], device_id: str) -> list[str]:
    """The list as it can be given to the doorbell: allowed domains, no repeats, up to 5.

    ⚠️ A list saved by 0.7.5 may carry 24 entities, or a `button`: the doorbell would refuse it
    WHOLE (`too_many_entities`, `bad_entity_domain`) and with it the webhook URL, which travels in
    the same request - so updating the integration would leave the house without notices. The
    valid part is sent and it IS STATED in the log; the options form already only lets you pick
    what is valid.
    """
    valid: list[str] = []
    for e in entities:
        if e.split(".", 1)[0] in ALLOWED_DOMAINS and e not in valid:
            valid.append(e)
    rejected = [e for e in entities if e not in valid]
    if len(valid) > MAX_ENTITIES:
        rejected += valid[MAX_ENTITIES:]
        valid = valid[:MAX_ENTITIES]
    if rejected:
        _LOGGER.warning(
            "%s: these entities are NOT given to the doorbell (only %s are accepted, and %d at "
            "most): %s. Check the integration's options.",
            device_id, ", ".join(ALLOWED_DOMAINS), MAX_ENTITIES, ", ".join(rejected),
        )
    return valid


def _adopt_door_entity(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Once, on upgrade: the entity that ALREADY opens the door joins the list.

    ⚠️ WITHOUT THIS, UPGRADING TO 0.7.6 LEAVES THE DOOR UNABLE TO OPEN. Up to 0.7.5 `ha_e` was
    written by hand on the doorbell and had no need to be in this integration's list (which on
    many installations is empty). Since 0.7.6 this integration only acts on entities from its
    list, so the open command would be refused (`not_listed`) without the owner having touched
    anything.

    Adopting it does not widen anything: it is the entity the administrator already picked for
    the door. Done BEFORE registering the options listener (which is why it does not reload) and
    stated in the log. If its domain is no longer accepted, it is NOT adopted: a persistent
    notification warns instead, because the door is about to stop opening and the owner needs to
    know before standing in front of it.

    Same fate as the options listener: removed the day no installation comes from 0.7.5 any more.
    """
    data = coordinator.data or {}
    ha_e = data.get("ha_e") or ""
    if data.get("door_m") != 1 or not ha_e:
        return
    current = list(entry.options.get(CONF_ENTITIES) or [])
    if ha_e in current:
        return
    if ha_e.split(".", 1)[0] not in ALLOWED_DOMAINS:
        _LOGGER.error(
            "The door of %s opens with %s, and that kind of entity is no longer accepted "
            "(only %s). The door will NOT open through Home Assistant until another is picked.",
            coordinator.device_id, ha_e, ", ".join(ALLOWED_DOMAINS),
        )
        persistent_notification.async_create(
            hass,
            f"The door of doorbell {coordinator.device_id} opens with `{ha_e}`, and that kind of "
            f"entity is no longer accepted (only {', '.join(ALLOWED_DOMAINS)}). The door will "
            "NOT open through Home Assistant until another entity is picked in the integration "
            "options and then in the doorbell's door settings.",
            title="IG Doorbell: door entity not accepted",
            notification_id=f"{DOMAIN}_{coordinator.device_id}_ha_e",
        )
        return
    valid = [e for e in current if e.split(".", 1)[0] in ALLOWED_DOMAINS]
    if len(valid) >= MAX_ENTITIES:
        _LOGGER.error(
            "The door of %s opens with %s, which is not in the entity list and the list already "
            "has %d: the door will NOT open through Home Assistant until it is added.",
            coordinator.device_id, ha_e, MAX_ENTITIES,
        )
        return
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_ENTITIES: [*current, ha_e]}
    )
    _LOGGER.warning(
        "%s: the entity that opens the door (%s) has been added to the list of entities the "
        "doorbell may act on, so it keeps opening on 0.7.6.",
        coordinator.device_id, ha_e,
    )


def _sync_name(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """The entry's title and the device's name follow the doorbell's name (`dname`).

    Iñaki, 2026-09-26: *"the doorbell's name is actually useful, the id throws you off"* -
    looking for where to configure its entities, he did not recognise Ermita's entry because in
    Settings > Devices & services it was called `0123456789abcdef` (its `device_id`), not "Ermita"
    or anything like it. `coordinator.doorbell_name` already resolves `dname` (or the firmware's
    generic one if there is none, never the bare id - const.py), so it only needs pushing to the
    two places Home Assistant shows separately.

    Only touches `name` on the device registry, NEVER `name_by_user`: if Iñaki himself renames the
    device by hand in Home Assistant, that is stored separately and HA keeps showing it over this
    (it is the native mechanism for "the user already said so, do not stomp it"). And it does not
    touch any `entity_id`: only the device's friendly name changes, which is what entities with
    `has_entity_name` compose their friendly name from on every read - no need to touch them one
    by one.
    """
    name = coordinator.doorbell_name
    if entry.title != name:
        hass.config_entries.async_update_entry(entry, title=name)

    registry = dr.async_get(hass)
    device = registry.async_get_device(identifiers={(DOMAIN, coordinator.device_id)})
    if device is not None and device.name != name:
        registry.async_update_device(device.id, name=name)


def _watch_name(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Checks the doorbell's name again on every poll, to catch a later change.

    ⚠️ This is called AFTER registering `entry.add_update_listener` (further below in
    `async_setup_entry`), so here a real name change DOES reload the entry - same as a change of
    options. Not a side effect to avoid: it is the same pattern `_watch_entities` already uses for
    the entities, and `async_update_entry` does nothing (nor triggers a reload) if the name has
    not changed since last time.
    """

    @callback
    def _on_update() -> None:
        _sync_name(hass, entry, coordinator)

    entry.async_on_unload(coordinator.async_add_listener(_on_update))


def _watch_entities(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Keeps the doorbell's list current when entities change IN Home Assistant.

    - **Friendly name changes** (the user renames it, or renames the device): the list is pushed
      again, so the apps' dropdown says the same as HA.
    - **`entity_id` changes**: replaced in the options, and the reload pushes it.
    - **It is deleted**: removed from the options, and the reload pushes it. The doorbell then
      flags whatever used it (`ha_e_ok: false`, `not_listed` in the step) instead of failing
      silently.
    """
    entities = _valid_entities(entry.options.get(CONF_ENTITIES) or [], coordinator.device_id)
    pending: list = []

    @callback
    def _repush_soon() -> None:
        # Renaming a device changes several entities at once: grouped into one push.
        if pending:
            return

        async def _now(_when) -> None:
            pending.clear()
            if not await _async_configure_doorbell(hass, entry, coordinator):
                _schedule_retry(hass, entry, coordinator)

        pending.append(async_call_later(hass, 2, _now))

    @callback
    def _on_state_change(event: Event) -> None:
        eid = event.data["entity_id"]
        new_entity_state = event.data.get("new_state")
        name = (new_entity_state.attributes.get("friendly_name") if new_entity_state else None) or eid
        if name != _PUSHED_NAMES.get(entry.entry_id, {}).get(eid):
            _repush_soon()

    @callback
    def _on_registry_update(event: Event) -> None:
        action = event.data.get("action")
        eid = event.data.get("entity_id")
        current = list(entry.options.get(CONF_ENTITIES) or [])
        if action == "remove" and eid in current:
            current.remove(eid)
            _LOGGER.warning("%s was deleted from Home Assistant: removed from doorbell %s's list",
                            eid, coordinator.device_id)
        elif action == "update" and event.data.get("old_entity_id") in current:
            current[current.index(event.data["old_entity_id"])] = eid
        else:
            return
        # Changing the options triggers the reload (`_async_update_listener`), which pushes the
        # list again and watches the new entities. One path, not two.
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, CONF_ENTITIES: current}
        )

    if entities:
        entry.async_on_unload(async_track_state_change_event(hass, entities, _on_state_change))
    entry.async_on_unload(hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, _on_registry_update))
    entry.async_on_unload(lambda: pending and pending.pop()())


# Internal container networks Home Assistant OS / Supervised creates for itself. An address from
# here is valid INSIDE the machine and unreachable from the LAN (see `_local_base`).
_CONTAINER_NETWORKS = (ip_network("172.30.32.0/23"), ip_network("172.17.0.0/16"))


def _is_container_network(ip: str) -> bool:
    try:
        address = ip_address(ip)
    except ValueError:
        return False
    return any(address in network_ for network_ in _CONTAINER_NETWORKS)


async def _local_base(hass: HomeAssistant, target_host: str | None = None) -> str | None:
    """Home Assistant's own address the doorbell can reach WITHOUT DNS.

    ⚠️ `get_url(allow_external=False)` does NOT guarantee that, and taking it for granted was a
    mistake of mine. That flag only says *do not use the external one*: if the configured
    `internal_url` is itself a public name, it returns it as is. **On Inaki's Home Assistant that
    is exactly the case** - `internal_url` and `external_url` are both
    `https://hass.islautopia.com` - so the first real installation would have sent the doorbell
    out to the internet, DNS at least, to talk to a machine right next to it on the LAN. That
    breaks principle 1 **without giving any error**: it just stops working the day the line drops.

    That is why **the IP** this machine uses to reach the network is preferred, since it is the
    only thing that needs nothing to resolve a name. `get_url` stays as the fallback, with its
    warning.
    """
    # 1) The IP this machine uses to REACH THE DOORBELL.
    #
    # ⚠️ The route towards the doorbell is asked for, not towards the internet. Until 2026-09-16
    # `PUBLIC_TARGET_IP` was used, and on 09-15 Home Assistant started up with the line down
    # (PPPoE down at the same time it restarted): with no route to the internet, the outgoing IP
    # was the Supervisor's internal Docker bridge (172.30.32.1). That got sent to the doorbell,
    # and the door stopped opening - with no visible error - until someone noticed the next day.
    # An address from those bridges is never reachable from the LAN, so it is also explicitly
    # rejected.
    ip = None
    for target in (target_host, network.PUBLIC_TARGET_IP):
        if not target:
            continue
        try:
            candidate = await network.async_get_source_ip(hass, target)
        except Exception:  # noqa: BLE001 - any failure here just means "try the next one"
            candidate = None
        if candidate and not _is_container_network(candidate):
            ip = candidate
            break
        if candidate:
            _LOGGER.warning(
                "The outgoing IP towards %s is %s, from an internal container network: the "
                "doorbell cannot reach it, so it is not given to it.", target, candidate)
    if ip:
        scheme = "https" if getattr(hass.http, "use_ssl", False) else "http"
        return f"{scheme}://{ip}:{hass.http.server_port}"

    # 2) Fallback: what Home Assistant believes its own internal address is.
    try:
        base = get_url(hass, allow_external=False, allow_cloud=False,
                       allow_ip=True, prefer_external=False)
    except NoURLAvailableError:
        return None

    host = urlparse(base).hostname or ""
    try:
        ip_address(host)
    except ValueError:
        # It is a NAME, not an address. It can work perfectly well - its local DNS may resolve it
        # inside the house - so it is not rejected. But it is stated, because that is the
        # difference between "it works" and "it works while someone is around to resolve that
        # name".
        _LOGGER.warning(
            "The address Home Assistant reports for itself is a NAME (%s), not a local-network "
            "IP. The video doorbell will have to resolve it to send notices, so if that name only "
            "exists on the internet, notices will stop arriving the moment the line drops - "
            "inside the house, and with no error. Set a local address in Settings > System > "
            "Network.",
            host,
        )
    return base


def _schedule_retry(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Tries the configuration again as soon as the doorbell answers.

    Needed because the normal failure case is **the doorbell being off when Home Assistant
    starts up**, and there is nothing there to trigger a second attempt: polling recovers on its
    own, but configuring the webhook is a one-shot write. Without this, an overnight power cut
    leaves the doorbell not knowing where to write until someone reloads the integration by hand -
    and the symptom would be "notices stopped arriving", which nobody connects to a power cut.
    """
    cancel_listeners: list = []

    @callback
    def _when_answered() -> None:
        if not coordinator.last_update_success:
            return
        # The hook is released BEFORE retrying: otherwise a failed retry would come back in here
        # on the next poll and overlapping attempts would pile up.
        if cancel_listeners:
            cancel_listeners.pop()()
        hass.async_create_task(_retry(hass, entry, coordinator))

    cancel_listeners.append(coordinator.async_add_listener(_when_answered))
    entry.async_on_unload(lambda: cancel_listeners and cancel_listeners.pop()())


async def _retry(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    if not await _async_configure_doorbell(hass, entry, coordinator):
        _schedule_retry(hass, entry, coordinator)


def _friendly_name(hass: HomeAssistant, entity_id: str) -> str:
    """The name a person recognises, for the apps' dropdown.

    `light.porche_2` says nothing to anyone, and that dropdown reads it **from the doorbell**, not
    from Home Assistant - the apps do not talk to HA and have no need to (§4). If the entity does
    not exist yet its own `entity_id` is sent: a dropdown with a blank entry cannot be picked, and
    that is worse than one with an ugly name.
    """
    state = hass.states.get(entity_id)
    if state is None:
        return entity_id
    return state.attributes.get("friendly_name") or entity_id


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        webhook.unregister(hass, entry.data[CONF_DEVICE_ID])
        data = hass.data[DOMAIN].pop(entry.entry_id, None)
        # The session belongs to THIS entry and has no automatic cleanup on purpose (net.py): the
        # one Home Assistant brings closes on STOP, and an integration gets unloaded and reloaded
        # many times before that. Without this close, every reload leaves behind a connector and
        # its resolution thread.
        if data and (session := data.get("session")):
            await session.close()
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """On UNINSTALL: tells the doorbell to stop writing here.

    ⚠️ THIS IS NOT A COURTESY: it is the other half of the marker the webhook returns. Home
    Assistant answers `200` to a webhook that no longer exists - on purpose, so nobody can
    enumerate them - so a doorbell told nothing would keep firing into the void forever. The
    marker turns that invisible failure into a visible one; this is what prevents it from
    existing.

    Best-effort: if the doorbell is not reachable right now, it is stated and moved on. Preventing
    someone from uninstalling an integration because a device is off would be worse.
    """
    address_map = {}
    hint = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    if net.is_address(hint):
        address_map[api.doorbell_hostname(entry.data[CONF_DEVICE_ID])] = hint
    session = net.create_session(hass, address_map)
    try:
        await api.async_set_hass_config(
            session,
            entry.data[CONF_DEVICE_ID],
            entry.data[CONF_CREDENTIAL],
            webhook_url="",
            entities=[],
        )
        _LOGGER.info("Webhook unconfigured on %s", entry.data[CONF_DEVICE_ID])
    except api.DoorbellApiError as err:
        _LOGGER.warning(
            "Could not unconfigure the webhook on %s (%s). That doorbell will keep sending "
            "notices to an address nobody is listening at any more until it is configured again.",
            entry.data[CONF_DEVICE_ID], err,
        )
    finally:
        # This session is throw-away and NOBODY cleans it up: by `async_remove_entry` there is no
        # entry in `hass.data` any more, because unloading runs before this. Without this close,
        # every uninstall leaves behind an open connector and its resolution thread.
        await session.close()
    # The last doorbell gone: HTTPS stops (the setting is kept for a doorbell added later).
    if (mgr := get_manager(hass)) is not None:
        await mgr.async_apply()


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reloads the entry when its data or its options change.

    Reloading whole and not patching by hand: changing the entity list means pushing it to the
    doorbell again, and the webhook has to be re-registered with the new name. Doing it in parts
    is how you end up with half the old configuration and half the new one.
    """
    await hass.config_entries.async_reload(entry.entry_id)

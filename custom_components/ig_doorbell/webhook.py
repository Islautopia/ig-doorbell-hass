"""The doorbell notifies Home Assistant over a webhook (API_CONTRACT.md §4).

Replaces MQTT, and the reason is not technical but a product one: MQTT required the user to have a
broker installed, and this integration has to work on a freshly installed Home Assistant, the same
way the apps do. A prerequisite half the audience does not meet is not an integration: it is a
manual.

What arrives is **the §3.6.1 envelope without changing a comma**, the same one the doorbell already
builds for the relay. A format of our own for Home Assistant would be a fifth dialect to maintain.

## ⚠️ WHY THIS HANDLER RETURNS A BODY, AND IT IS NOT A COURTESY

Measured 2026-08-24 against a real Home Assistant: **it answers `200` to a webhook that does NOT
exist**, with an empty body. That is deliberate on its part - so nobody can enumerate an
installation's webhooks by probing them.

Consequence: by status code alone the doorbell **cannot tell** "delivered" from "Home Assistant
forgot about me". A doorbell whose integration was removed would keep firing into the void forever
with its failure counter at zero - both extremes saying everything is fine and nothing happening,
which is the failure family this project keeps hunting.

**The body's marker is the only thing that breaks that tie.** And a Home Assistant handler that
returns `None` **also** produces an empty 200, so returning it is a REQUIREMENT: forgetting the
body makes the doorbell pronounce a perfectly alive integration dead.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    CONF_DEVICE_ID,
    CONF_ENTITIES,
    DOMAIN,
    DOMAIN_CLOSE_SERVICE,
    DOMAIN_OPEN_SERVICE,
    ALLOWED_DOMAINS,
    SIGNAL_EVENT,
    WEBHOOK_MARKER,
)

_LOGGER = logging.getLogger(__name__)


def webhook_id_for(device_id: str) -> str:
    """The webhook's identifier, derived from the `device_id`.

    Derived and not random on purpose: it makes the operation **idempotent**. Reloading the
    config entry registers the same identifier again, so the URL the doorbell already has stored
    stays valid and there is no need to reconfigure it on every Home Assistant restart.

    ⚠️ And that means **this identifier is not a strong secret**: it can be derived from the
    `device_id`, which is public (§0). What protects it is `local_only=True` below - it is only
    accepted from the local network. A random identifier would be more secret and would force
    reconfiguring the doorbell every time it got lost, which is a worse trade for what is at stake
    here: what can be done through this is telling Home Assistant things, never sending anything
    to the doorbell.
    """
    return f"ig_doorbell_{device_id}"


def _entity_list_for(hass: HomeAssistant, webhook_id: str) -> list[str] | None:
    """The entity list of the entry that OWNS this webhook, or None if there is no entry.

    ⚠️ Looked up by the webhook the order arrived on, NOT by the envelope's `device_id`: the
    envelope is written by whoever calls, the webhook is registered by us. So a doorbell can only
    move the entities that were given TO IT.
    """
    for entry in hass.config_entries.async_entries(DOMAIN):
        if webhook_id_for(entry.data.get(CONF_DEVICE_ID, "")) == webhook_id:
            return list(entry.options.get(CONF_ENTITIES) or [])
    return None


async def _act_on_entity(
    hass: HomeAssistant, webhook_id: str, entity_id: str, turn_on: bool
) -> tuple[bool, str | None]:
    """`hass_action`: the doorbell asks to turn an entity on or off (contract 4).

    Returns `(done, error)`, and that travels back in the webhook's response: the doorbell reads
    it to say whether the door REALLY opened (0.100.4). That is why the service call is BLOCKING
    and happens BEFORE answering.

    ⚠️ DEFENCE ON BOTH SIDES: the doorbell no longer sends an entity that is not in its list, and
    this checks it again against THIS integration's list. An old firmware, a buggy one, or someone
    on the LAN who knows the webhook URL cannot move anything else.
    """
    domain = entity_id.split(".", 1)[0] if "." in entity_id else ""
    entity_list = _entity_list_for(hass, webhook_id)
    if entity_list is None or entity_id not in entity_list:
        _LOGGER.warning(
            "The doorbell asks to %s %s, which is NOT in this integration's entity list: "
            "doing nothing", "turn on" if turn_on else "turn off", entity_id,
        )
        return False, "not_listed"
    if domain not in ALLOWED_DOMAINS:
        _LOGGER.warning("%s is not from a domain that turns on and off: doing nothing",
                        entity_id)
        return False, "bad_domain"

    # ⚠️ NEVER ONE OF THIS INTEGRATION'S OWN ENTITIES (1.3.0). The doorbell's own `lock` opens the
    # door through `/open`; if that same lock were the door's HA entity (`door_m=1`), `/open` would
    # ask Home Assistant to unlock it, which calls `/open` again: a loop that ends only when the
    # doorbell's 9 s wait gives up, with the relay clicking - or not - somewhere in between.
    registered = er.async_get(hass).async_get(entity_id)
    if registered is not None and registered.platform == DOMAIN:
        _LOGGER.warning("The doorbell asks for %s, which is one of this integration's own "
                        "entities: refused (it would loop back to the doorbell)", entity_id)
        return False, "own_entity"

    state = hass.states.get(entity_id)
    if state is None:
        _LOGGER.warning("The doorbell asks for %s, which does not exist in Home Assistant", entity_id)
        return False, "entity_missing"
    if state.state == "unavailable":
        # Calling the service on an unavailable entity does not error: it simply does nothing.
        # Answering "done" there is the false success this exists to prevent.
        _LOGGER.warning("The doorbell asks for %s, which is unavailable right now", entity_id)
        return False, "entity_unavailable"

    service_domain, service = (DOMAIN_OPEN_SERVICE if turn_on else DOMAIN_CLOSE_SERVICE)[domain]
    _LOGGER.info("The doorbell asks to %s %s -> %s.%s",
                 "turn on" if turn_on else "turn off", entity_id, service_domain, service)
    try:
        await hass.services.async_call(
            service_domain, service, {"entity_id": entity_id},
            # ⚠️ BLOCKING ON PURPOSE: the response's `ok` means "done", not "received".
            blocking=True,
        )
    except Exception:  # noqa: BLE001 - the reason goes to the log; the doorbell only gets "failed"
        _LOGGER.exception("Could not act on %s", entity_id)
        return False, "service_failed"
    return True, None


async def _handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
    """One envelope from the doorbell. ALWAYS returns a body with the marker - see the header."""
    try:
        envelope: dict[str, Any] = await request.json()
    except (ValueError, json.JSONDecodeError):
        # Answered with the marker anyway: the doorbell needs to know **the integration is still
        # alive**, which is a different question from whether this particular envelope was
        # understood.
        _LOGGER.warning("Unreadable envelope on %s", webhook_id)
        return web.json_response({WEBHOOK_MARKER: 1, "error": "bad_json"})

    device_id = envelope.get("device_id", "")
    msg_type = envelope.get("type")

    if msg_type == "action" and envelope.get("ev") == "hass_action":
        # The response to a COMMAND says whether it happened (contract 4): `ok` and, if not,
        # `error`. Firmware before 0.100.4 does not read it and the marker is enough for it; the
        # newer one uses it to answer `open_result` truthfully.
        d = envelope.get("d") or {}
        entity = d.get("entity")
        if not entity or not isinstance(entity, str):
            _LOGGER.warning("hass_action with no entity, ignored")
            return web.json_response({WEBHOOK_MARKER: 1, "ok": False, "error": "no_entity"})
        done, error = await _act_on_entity(hass, webhook_id, entity, bool(d.get("on")))
        body: dict[str, Any] = {WEBHOOK_MARKER: 1, "ok": done}
        if error:
            body["error"] = error
        return web.json_response(body)

    # An event from §1.16. Distributed through the internal dispatcher and picked up by the
    # entities.
    #
    # NOT filtered by `ev` here on purpose: an event this firmware does not know about yet must
    # still reach the events entity, which is where the user will see it. Filtering here would
    # mean a new doorbell feature is invisible until this integration is updated, and that is
    # exactly what leaves an integration stale on its own.
    async_dispatcher_send(hass, SIGNAL_EVENT.format(device_id=device_id), envelope)
    return web.json_response({WEBHOOK_MARKER: 1})


async def async_register(hass: HomeAssistant, device_id: str, name: str) -> str:
    """Registers this doorbell's webhook and returns its identifier.

    Idempotent: registering the same identifier again is ignored quietly, which is what is needed
    so reloading the entry does not break anything.
    """
    wid = webhook_id_for(device_id)

    async def _handler(hass_: HomeAssistant, wid_: str, request: web.Request) -> web.Response:
        return await _handle(hass_, wid_, request)

    try:
        webhook.async_register(
            hass, DOMAIN, f"IG Doorbell {name}", wid, _handler,
            allowed_methods=["POST"],
            # Only from the local network. This is what compensates for the identifier being
            # derivable from the `device_id`, which is public - see `webhook_id_for`.
            local_only=True,
        )
    except ValueError:
        _LOGGER.debug("Webhook %s was already registered", wid)
    return wid


def unregister(hass: HomeAssistant, device_id: str) -> None:
    """Releases the webhook. Called when the entry is unloaded."""
    webhook.async_unregister(hass, webhook_id_for(device_id))

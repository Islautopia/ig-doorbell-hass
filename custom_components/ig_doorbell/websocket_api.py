"""WebSocket API bridge between this integration and the Lovelace card.

The card asks Home Assistant for what it needs over the authenticated WebSocket the frontend
already uses (`hass.connection.sendMessagePromise(...)`), gated by the normal HA user session.

⚠️ WHAT THE CARD NEVER GETS (Phase 0, 2026-09-25): the pairing credential, the relay URL, TURN
credentials. Until 0.6.x `get_connection_info` returned the credential to the browser of every HA
user who opened a dashboard, and the card used it to talk to the doorbell's public hostname and to
the cloud relay. The card now talks ONLY to this Home Assistant (signal_proxy.py,
recordings_view.py), which adds the credential server-side and reaches the doorbell over the LAN.

Four commands:
  - ig_doorbell/get_connection_info: the device id and the entity ids the card reads
    (the live-view timeout `number` and the events `event`, so a ring can wake a paused card).
  - ig_doorbell/get_local_signal_url: a short-lived signed URL for the signalling proxy.
  - ig_doorbell/get_quick_replies: the doorbell's quick-reply list (id + label), read
    fresh over the LAN each time - same "the card shows, the integration exposes" rule as the
    other two. The card plays one with the existing `play_sequence` service (services.py); this
    command only supplies the list, never a credential.
  - ig_doorbell/https_status: whether local HTTPS is on and where its install page is, so the
    card can explain a blocked microphone instead of failing silently.
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from . import api
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN
from .signal_proxy import async_signed_signal_url

_LOGGER = logging.getLogger(__name__)


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the WS commands. Safe to call more than once (HA dedupes by name)."""
    websocket_api.async_register_command(hass, websocket_get_connection_info)
    websocket_api.async_register_command(hass, websocket_get_local_signal_url)
    websocket_api.async_register_command(hass, websocket_get_quick_replies)
    websocket_api.async_register_command(hass, websocket_https_status)


def _find_entry_data(hass: HomeAssistant, device_id: str) -> dict | None:
    """Find the stored data for a paired doorbell, by its device id.

    This asks Home Assistant which config entries actually exist and looks each one up by id,
    instead of walking everything stored under our domain key and accepting whatever happens to
    look like a config entry.

    And the distinction matters. The dict under each `entry_id` is not just `entry.data`: it also
    carries live objects (the coordinator, the webhook id). Walking the VALUES of
    `hass.data[DOMAIN]` looking for a `device_id` would work today by coincidence, and would
    silently match anything anyone stores there tomorrow with that field inside. Asking Home
    Assistant which entries exist does not have that property.

    This was written earlier by MQTT's own shared listener, which lived under that same key and
    only escaped colliding because it carried no `device_id` at all - luck, not design. MQTT was
    removed (contract §4) and the argument holds entirely, now against the coordinator itself.
    """
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        entry_data = stored.get(entry.entry_id)
        if isinstance(entry_data, dict) and entry_data.get(CONF_DEVICE_ID) == device_id:
            return entry_data
    return None


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ig_doorbell/get_connection_info",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_connection_info(hass: HomeAssistant, connection, msg) -> None:
    """What the card needs besides signalling: which entities to read, and this pairing's role.

    ⚠️ No credential and no relay URL here, on purpose (module docstring). A test asserts it.

    `role` (Iñaki, 2026-09-25): "admin"/"user"/"unknown", the SAME value the doorbell resolves for
    `session_info.role` (API_CONTRACT.md §3.3-ter) - what the role the doorbell gave THIS
    integration's pairing credential, not whichever Home Assistant user is looking at the
    dashboard right now. Falls back to "unknown" (never drawn as admin) when the coordinator has
    not been set up yet, e.g. in a test that stubs entry_data without one.
    """
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    device_id = entry_data[CONF_DEVICE_ID]
    coordinator = entry_data.get("coordinator")
    registry = er.async_get(hass)
    connection.send_result(
        msg["id"],
        {
            "device_id": device_id,
            "role": coordinator.role if coordinator is not None else "unknown",
            "live_timeout_entity": registry.async_get_entity_id(
                "number", DOMAIN, f"{device_id}_live_timeout"
            ),
            "events_entity": registry.async_get_entity_id("event", DOMAIN, f"{device_id}_events"),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ig_doorbell/get_local_signal_url",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_local_signal_url(hass: HomeAssistant, connection, msg) -> None:
    """Return a short-lived signed URL for the local signalling proxy (see signal_proxy.py).

    Signed rather than plain because `EventSource` cannot send an Authorization header - the same
    limitation that made the firmware accept `?token=` in its query string. This is how Home
    Assistant's own camera streams solve it.

    Since Phase 0 this is the card's only signalling path (no public hostname, no relay).

    Only signalling goes through the proxy. Media stays peer-to-peer over UDP straight to the
    doorbell's LAN address, which Private Relay does not touch.
    """
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    connection.send_result(
        msg["id"],
        {
            "device_id": entry_data[CONF_DEVICE_ID],
            "signal_url": async_signed_signal_url(hass, entry_data[CONF_DEVICE_ID]),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ig_doorbell/get_quick_replies",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_quick_replies(hass: HomeAssistant, connection, msg) -> None:
    """The doorbell's quick-reply list (`GET /api/sequences?quick=1`, api.py), read fresh.

    Read straight from the doorbell over the LAN on every call, never from the VPS and never
    cached here - the doorbell is the only place this list can change (§1.18.2), and Home
    Assistant already has an authenticated LAN session open (`session`). No credential reaches the
    card: only `id`/`label`/`steps` per item, same as the doorbell already restricts `?quick=1` to.
    """
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    session = entry_data.get("session")
    if session is None:
        connection.send_error(msg["id"], "unreachable", "Doorbell still being set up")
        return

    try:
        quick_replies = await api.async_list_quick_replies(
            session, entry_data[CONF_DEVICE_ID], entry_data[CONF_CREDENTIAL]
        )
    except api.AuthenticationError as err:
        connection.send_error(msg["id"], "auth_error", str(err))
        return
    except api.DoorbellApiError as err:
        connection.send_error(msg["id"], "unreachable", str(err))
        return

    connection.send_result(msg["id"], {"quick_replies": quick_replies})


@websocket_api.websocket_command({vol.Required("type"): "ig_doorbell/https_status"})
@callback
def websocket_https_status(hass: HomeAssistant, connection, msg) -> None:
    """Whether the local HTTPS port is on, and where its install page is.

    Asked by the card when the user taps the microphone on a page that is NOT a secure context:
    instead of failing silently, the card explains why and points to the install page (or, if
    HTTPS is off, to the integration's option). Nothing secret: no key, no credential.
    """
    from .https_manager import INSTALL_PATH, get_manager  # noqa: PLC0415

    mgr = get_manager(hass)
    status = mgr.status() if mgr is not None else {"enabled": False, "running": False}
    connection.send_result(
        msg["id"],
        {
            "enabled": bool(status.get("enabled")),
            "running": bool(status.get("running")),
            "port": status.get("port"),
            "install_path": INSTALL_PATH,
            "install_url": status.get("install_url"),
            "public_url": (status.get("public") or {}).get("url"),
        },
    )

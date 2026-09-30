"""Config flow for the IG Doorbell integration.

Two ways in:
  - Zeroconf discovery (`_igdoorbell._tcp.local.`, the same service the app/dashboard already
    use - API_CONTRACT.md §0-bis): automatic, shows up as a "Discovered" card in HA.
  - Manual entry (IP): for networks without mDNS, or a doorbell on another (routed) VLAN.

## LAN only, and nothing half-configured (Phase 0, 2026-09-25)

Home Assistant is a LOCAL client: it reaches the doorbell at its LAN address and never through the
VPS or public DNS (net.py). So setup first checks that the doorbell answers **at that address** on
port 80 (`/api/device_id`) **and** on 8443 with a certificate valid for its name. If either fails,
setup stops with one message — Home Assistant must be on the same network as the doorbell — and
creates nothing. If pairing succeeds but the new credential then fails to work over the LAN, the
pairing is undone on the doorbell (`unpair_app`) before reporting the error.

Pairing itself happens exactly once: ask for the admin email/password already created via the
doorbell's own /api/setup, use them only long enough to call login + pair_app, then discard them -
only the resulting 64-hex pair_app credential is persisted (in the config entry's data).
"""
from __future__ import annotations

import asyncio
import errno
import logging
import socket
from typing import Any
from urllib.parse import urlsplit

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import instance_id, selector
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from . import api, net, webhook
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_ENTITIES,
    CONF_HOST_HINT,
    CONF_ANNOUNCE_PLAYERS,
    CONF_ANNOUNCE_VOICE,
    CONF_LABEL,
    CONF_NOTIFY_CRITICAL,
    CONF_NOTIFY_OPEN_DOOR,
    CONF_NOTIFY_PANELS,
    CONF_NOTIFY_PHONES,
    DEFAULT_PAIR_LABEL,
    DOMAIN,
    ALLOWED_DOMAINS,
    DOORBELL_HOSTNAME_SUFFIX,
    MAX_ENTITIES,
    generic_name,
)
from .https_manager import DEFAULT_PORT, INSTALL_PATH, get_manager

_LOGGER = logging.getLogger(__name__)

HTTPS_DOCS_URL = "https://github.com/Islautopia/ig-doorbell-hass/blob/main/docs/https.md"


async def _check_port(hass: HomeAssistant, mgr, port: int) -> dict[str, str]:
    """A clear error in the form itself when the port cannot be used, instead of a silent
    listener that never came up. Our own running listener on that port is not a conflict."""
    if port == getattr(hass.http, "server_port", None):
        return {"port": "port_is_ha"}
    if mgr.port_is_ours(port):
        return {}

    def _try_bind() -> bool:
        for family, addr in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
            try:
                sock = socket.socket(family, socket.SOCK_STREAM)
            except OSError:
                continue
            try:
                # SO_REUSEADDR like asyncio's own listener: a port in TIME_WAIT is not "taken",
                # a port with a LISTENING socket still is.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                if family == socket.AF_INET6:
                    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                sock.bind((addr, port))
            except OSError as err:
                if family == socket.AF_INET6 and err.errno == errno.EADDRNOTAVAIL:
                    continue
                return False
            finally:
                sock.close()
        return True

    if not await hass.async_add_executor_job(_try_bind):
        return {"port": "port_in_use"}
    return {}


async def _address_for(host: str) -> str | None:
    """A literal IP for what the user typed.

    A LOCAL name goes through the home's resolver once and the address is what gets stored. Our
    cloud's name is refused: resolving it is asking the VPS where the doorbell is.
    """
    host = (host or "").strip()
    if net.is_address(host):
        return host
    if not host or host.lower().rstrip(".").endswith(DOORBELL_HOSTNAME_SUFFIX):
        return None
    try:
        info = await asyncio.get_running_loop().getaddrinfo(
            host, 80, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except OSError:
        return None
    return info[0][4][0] if info else None


async def _check_lan(
    hass: HomeAssistant, ip: str, device_id: str | None = None
) -> tuple[str | None, str | None]:
    """Is THIS doorbell reachable directly at `ip`, on both ports? Returns (device_id, error_key).

    Port 80 `/api/device_id` says which doorbell it is; 8443 must then answer with a certificate
    valid for that doorbell's name, through the LAN mapping only (net.py). Nothing is written.
    """
    session = net.create_session(hass, {})
    try:
        found = await asyncio.wait_for(api.async_get_device_id(session, ip), 6)
    except (aiohttp.ClientError, OSError, TimeoutError, api.DoorbellApiError):
        return None, "not_on_lan"
    finally:
        await session.close()
    if device_id is not None and found != device_id:
        return None, "other_device"
    session = net.create_session(hass, {api.doorbell_hostname(found): ip})
    try:
        await api.async_check_tls(session, found)
    except api.DoorbellApiError:
        return found, "no_tls"
    finally:
        await session.close()
    return found, None


# The label budget, in UTF-8 BYTES. The firmware keeps `email|label` as "%.39s|%.39s" (app_pairing.c)
# and the remote session's label is cut to 39 bytes too, so anything past 39 bytes is lost; 32 leaves
# margin and is what the label was already cut to before 1.4.5.
_LABEL_MAX_BYTES = 32
_ID_CHARS = 6


def _clean_label_part(text: str) -> str:
    """Characters the firmware would rewrite (`"`, backslash, control) are dropped here instead, so
    the label stored in the entry is byte-for-byte the one the doorbell keeps."""
    kept = "".join(c for c in text if c not in '"\\' and ord(c) >= 0x20 and c != "\x7f")
    return " ".join(kept.split())


def _cut_utf8(text: str, max_bytes: int) -> str:
    """At most `max_bytes` of UTF-8, never splitting a character."""
    out = text.encode("utf-8")[:max(max_bytes, 0)].decode("utf-8", errors="ignore")
    return out.rstrip()


async def _new_label(hass: HomeAssistant) -> str:
    """The pairing label for a NEW entry: "Home Assistant <location name> <6 chars of the instance id>".

    ⚠️ THE INSTANCE ID IS WHAT MAKES IT UNIQUE, and the name alone never was (1.4.5). The doorbell
    identifies a pairing by `email|label` and REUSES the slot when both repeat (§1.5). 0.7.0 added
    the location name, which fixed "Home Assistant" vs "Home Assistant", but two installations are
    very often both called "Casa"/"Home": measured 2026-09-30, a second Home Assistant named like
    the first, paired by the same admin, silently took the first one's credential and the first
    started getting 401 with nothing explaining why. `instance_id` is stored by Home Assistant
    itself (`.storage/core.uuid`), so the label is stable across restarts and differs between
    installations. The id goes LAST and is never cut: when the name is long, the NAME is trimmed.

    Existing entries keep their stored label (re-pairing must reuse their slot, not open a new
    one), so this only applies to new entries.
    """
    iid = await instance_id.async_get(hass)
    suffix = "".join(c for c in iid.lower() if c in "0123456789abcdef")[:_ID_CHARS] or "000000"
    name = _clean_label_part(getattr(hass.config, "location_name", "") or "")
    budget = _LABEL_MAX_BYTES - len(f"{DEFAULT_PAIR_LABEL}  {suffix}".encode("utf-8"))
    name = _cut_utf8(name, budget)
    return " ".join(p for p in (DEFAULT_PAIR_LABEL, name, suffix) if p)


async def _our_webhook_url(hass: HomeAssistant, device_id: str, ip: str) -> str | None:
    """The webhook URL THIS Home Assistant would give the doorbell, or None if it cannot tell
    (same computation as `_async_configure_doorbell` in __init__.py)."""
    from . import _local_base  # noqa: PLC0415 - the package is loaded before its config flow

    base = await _local_base(hass, ip)
    if not base:
        return None
    return f"{base.rstrip('/')}/api/webhook/{webhook.webhook_id_for(device_id)}"


async def _webhook_elsewhere(
    hass: HomeAssistant, device_id: str, ip: str, email: str, password: str
) -> tuple[str | None, str | None]:
    """Does the doorbell already send its notices to ANOTHER Home Assistant? (other, error_code)

    `other` is the address of that Home Assistant (host:port of the webhook URL; the doorbell does
    not store which pairing configured it, so the address is what identifies it), or None.

    ⚠️ The doorbell stores ONE webhook and the last Home Assistant to pair takes it (§4). That is
    accepted for now, but it must never be SILENT: before 1.4.5 the first Home Assistant just stopped
    getting rings. A read that fails (not admin, older firmware) does not block pairing: a
    non-admin pairing cannot configure the webhook either, so nothing would move.
    """
    if not net.is_address(ip):
        return None, "not_on_lan"
    session = net.create_session(hass, {api.doorbell_hostname(device_id): ip})
    try:
        await api.async_login(session, device_id, email, password)
        try:
            current = await api.async_get_hass_webhook_url(session, device_id)
        except api.DoorbellApiError as err:
            _LOGGER.warning("Could not read which Home Assistant %s notifies (%s)", device_id, err)
            current = ""
        await api.async_logout(session, device_id)
    except api.AuthenticationError:
        return None, "invalid_auth"
    except (aiohttp.ClientError, OSError, TimeoutError, api.DoorbellApiError):
        return None, "not_on_lan"
    finally:
        if not session.closed:
            await session.close()
    if not current:
        return None, None
    if current == await _our_webhook_url(hass, device_id, ip):
        return None, None
    return (urlsplit(current).netloc or current[:64]), None


async def _async_pair(
    hass: HomeAssistant, device_id: str, ip: str, email: str, password: str, label: str
) -> tuple[api.PairResult | None, str | None]:
    """login + pair_app + verify + logout, in a private, throwaway LAN session.

    Returns (result, error_code). The session cookie from /api/login never leaves this function.

    ⚠️ NOTHING HALF-CONFIGURED: if pair_app succeeded but the new credential does not work over
    the LAN (get_states), the pairing is undone with unpair_app — still inside the admin session —
    before the error is reported. Otherwise a failed setup would leave a live credential on the
    doorbell that no Home Assistant entry knows about, eating one of its pairing slots.
    """
    if not net.is_address(ip):
        return None, "not_on_lan"
    session = net.create_session(hass, {api.doorbell_hostname(device_id): ip})
    try:
        await api.async_login(session, device_id, email, password)
        result = await api.async_pair_app(session, device_id, label)
        try:
            await api.async_get_states(session, device_id, result.credential)
        except api.DoorbellApiError:
            undone = await api.async_unpair_app(session, device_id, label)
            _LOGGER.warning(
                "Pairing with %s succeeded but the credential does not work over the LAN; "
                "pairing undone on the doorbell: %s", device_id, undone,
            )
            return None, "pair_verify_failed"
    except api.AuthenticationError:
        return None, "invalid_auth"
    except api.LabelInUseError:
        return None, "label_in_use"
    except api.DeviceNotPairedError:
        return None, "device_not_paired"
    except api.CloudAuthorizeFailedError:
        return None, "cloud_authorize_failed"
    except (aiohttp.ClientError, OSError, TimeoutError, api.DoorbellApiError):
        return None, "not_on_lan"
    else:
        await api.async_logout(session, device_id)
        return result, None
    finally:
        if not session.closed:
            await session.close()


class IgDoorbellConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for a single IG Doorbell."""

    VERSION = 1

    def __init__(self) -> None:
        self._device_id: str | None = None
        self._host_hint: str | None = None
        self._name_hint: str | None = None
        self._pending_login: tuple[str, str] | None = None
        self._other_ha: str | None = None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Manual entry: the doorbell's LAN IP."""
        errors: dict[str, str] = {}
        host = ""
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            ip = await _address_for(host)
            if ip is None:
                errors["base"] = "not_on_lan"
            else:
                device_id, error = await _check_lan(self.hass, ip)
                if error:
                    errors["base"] = error
                else:
                    await self.async_set_unique_id(device_id)
                    self._abort_if_unique_id_configured(updates={CONF_HOST_HINT: ip})
                    self._device_id = device_id
                    self._host_hint = ip
                    return await self.async_step_pair()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=host): str}),
            errors=errors,
            description_placeholders={"host": host},
        )

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> FlowResult:
        """Handle discovery via `_igdoorbell._tcp.local.`.

        Match by the `device_id` TXT record, never by the mDNS instance name. For an existing entry
        this is also how a doorbell that DHCP moved is found again: the new address is stored and
        the entry reloads (there is no cloud-DNS fallback any more, net.py).
        """
        device_id = discovery_info.properties.get("device_id")
        if not device_id:
            return self.async_abort(reason="no_device_id")

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST_HINT: discovery_info.host})

        _, error = await _check_lan(self.hass, discovery_info.host, device_id)
        if error:
            return self.async_abort(
                reason=error, description_placeholders={"host": discovery_info.host}
            )

        self._device_id = device_id
        self._host_hint = discovery_info.host
        # The TXT `name` may come empty (§0-bis, the doorbell with no `dname` configured): never
        # the bare id as a fallback (Inaki, 2026-09-26) - the same generic name the firmware itself uses.
        self._name_hint = discovery_info.properties.get("name") or generic_name(device_id)

        self.context["title_placeholders"] = {"name": self._name_hint}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            return await self.async_step_pair()
        return self.async_show_form(
            step_id="zeroconf_confirm",
            description_placeholders={
                "name": self._name_hint or generic_name(self._device_id or ""),
            },
        )

    async def async_step_pair(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Log in once, call pair_app once, keep only the resulting credential.

        Before pairing, the doorbell is asked whether it already notifies ANOTHER Home Assistant.
        If so, the user must confirm moving it here (`move_notifications`): it holds ONE webhook,
        and taking it over used to be silent (1.4.5).
        """
        errors: dict[str, str] = {}
        if user_input is not None:
            assert self._device_id is not None
            other, error = await _webhook_elsewhere(
                self.hass, self._device_id, self._host_hint or "",
                user_input["email"], user_input["password"],
            )
            if error:
                errors["base"] = error
            elif other:
                # Kept in memory only, for the one confirm step; never in the entry.
                self._pending_login = (user_input["email"], user_input["password"])
                self._other_ha = other
                return await self.async_step_move_notifications()
            else:
                result = await self._async_pair_and_create(user_input["email"], user_input["password"])
                if isinstance(result, str):
                    errors["base"] = result
                else:
                    return result
        return self._pair_form(errors)

    async def async_step_move_notifications(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Explicit confirm: this doorbell already notifies another Home Assistant."""
        if user_input is None or self._pending_login is None:
            return self.async_show_form(
                step_id="move_notifications",
                data_schema=vol.Schema({}),
                description_placeholders={"other": self._other_ha or "?"},
            )
        email, password = self._pending_login
        self._pending_login = None
        result = await self._async_pair_and_create(email, password)
        if isinstance(result, str):
            return self._pair_form({"base": result})
        return result

    async def _async_pair_and_create(self, email: str, password: str) -> FlowResult | str:
        """Pair and create the entry; an error code (str) if it failed."""
        assert self._device_id is not None
        label = await _new_label(self.hass)
        result, error = await _async_pair(
            self.hass, self._device_id, self._host_hint or "", email, password, label,
        )
        if error:
            return error
        assert result is not None
        # The real title (if the doorbell has a `dname`) is corrected by `_sync_name`
        # in __init__.py the moment the entry starts up, with the first `get_states`. This
        # is only the starting title - and never the bare id (Inaki, 2026-09-26), in case
        # it is seen before that first correction (manual setup, no zeroconf hint).
        return self.async_create_entry(
            title=self._name_hint or generic_name(result.device_id),
            data={
                CONF_DEVICE_ID: result.device_id,
                CONF_CREDENTIAL: result.credential,
                CONF_HOST_HINT: self._host_hint,
                CONF_LABEL: label,
            },
        )

    def _pair_form(self, errors: dict[str, str]) -> FlowResult:
        return self.async_show_form(
            step_id="pair",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
            description_placeholders={
                "name": self._name_hint or self._device_id or "",
                "host": self._host_hint or "",
            },
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> "IgDoorbellOptionsFlow":
        return IgDoorbellOptionsFlow(config_entry)


class IgDoorbellOptionsFlow(config_entries.OptionsFlow):
    """Entities the doorbell may act on, the doorbell's LAN address, and re-pairing."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=["notifications", "entities", "address", "https", "repair"],
        )

    async def async_step_notifications(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Ring notifications sent by the integration itself (1.2.0).

        ONE place to configure (product rule): pick the companion-app phones and wall panels, and
        the integration rings them, clears them when the call is resolved and sends the panels
        back home. Nothing picked = off, which is the default (docs/design/ha-only-ringing.md).
        """
        if user_input is not None:
            # ⚠️ The other options are kept: an options flow REPLACES the whole dict.
            options = dict(self._entry.options)
            options[CONF_NOTIFY_PHONES] = list(user_input.get(CONF_NOTIFY_PHONES) or [])
            options[CONF_NOTIFY_PANELS] = list(user_input.get(CONF_NOTIFY_PANELS) or [])
            options[CONF_NOTIFY_CRITICAL] = bool(user_input.get(CONF_NOTIFY_CRITICAL, True))
            options[CONF_NOTIFY_OPEN_DOOR] = bool(user_input.get(CONF_NOTIFY_OPEN_DOOR, False))
            options.pop("panel_return_path", None)     # 1.2.0 dev builds only: the card goes home now
            options[CONF_ANNOUNCE_PLAYERS] = list(user_input.get(CONF_ANNOUNCE_PLAYERS) or [])
            options[CONF_ANNOUNCE_VOICE] = bool(user_input.get(CONF_ANNOUNCE_VOICE, False))
            return self.async_create_entry(title="", data=options)

        o = self._entry.options
        companion = selector.DeviceSelector(
            selector.DeviceSelectorConfig(integration="mobile_app", multiple=True)
        )
        return self.async_show_form(
            step_id="notifications",
            data_schema=vol.Schema({
                vol.Optional(CONF_NOTIFY_PHONES, default=list(o.get(CONF_NOTIFY_PHONES) or [])): companion,
                vol.Optional(CONF_NOTIFY_PANELS, default=list(o.get(CONF_NOTIFY_PANELS) or [])): companion,
                vol.Optional(CONF_NOTIFY_CRITICAL, default=o.get(CONF_NOTIFY_CRITICAL, True)): bool,
                vol.Optional(CONF_NOTIFY_OPEN_DOOR, default=o.get(CONF_NOTIFY_OPEN_DOOR, False)): bool,
                vol.Optional(CONF_ANNOUNCE_PLAYERS,
                             default=list(o.get(CONF_ANNOUNCE_PLAYERS) or [])): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="media_player", multiple=True)),
                vol.Optional(CONF_ANNOUNCE_VOICE, default=o.get(CONF_ANNOUNCE_VOICE, False)): bool,
            }),
        )

    async def async_step_entities(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Which Home Assistant entities the doorbell may act on (contract §4).

        Chosen HERE, in Home Assistant, and they travel to the doorbell. The dropdown the user
        sees in the app reads it **from the doorbell**, not from Home Assistant. That is why each
        one's friendly name travels too: `light.porche_2` says nothing to anyone.

        ⚠️ And that is why whole domains do NOT travel: a normal house has hundreds of `light.*`.
        """
        errors: dict[str, str] = {}
        if user_input is not None:
            chosen = user_input.get(CONF_ENTITIES) or []
            if len(chosen) > MAX_ENTITIES:
                # Refused and stated, never silently trimmed.
                errors["base"] = "too_many"
            else:
                # ⚠️ The other options are kept: an options flow REPLACES the whole dict, so
                # returning only this step's value would silently wipe out the rest.
                options = dict(self._entry.options)
                options[CONF_ENTITIES] = chosen
                return self.async_create_entry(title="", data=options)

        # Only the ones that are still valid: a list saved by 0.7.5 may carry a `button` or a
        # `scene`, which are no longer propagated (const.py, ALLOWED_DOMAINS). Showing them
        # checked would suggest the doorbell has them.
        current = [
            e for e in (self._entry.options.get(CONF_ENTITIES) or [])
            if e.split(".", 1)[0] in ALLOWED_DOMAINS
        ][:MAX_ENTITIES]
        return self.async_show_form(
            step_id="entities",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_ENTITIES, default=current): selector.EntitySelector(
                        selector.EntitySelectorConfig(
                            # Only things that turn on and off (const.py, ALLOWED_DOMAINS).
                            # The user types part of the name and picks it: the native selector.
                            domain=list(ALLOWED_DOMAINS),
                            # Never this integration's own entities (1.3.0): the doorbell's own
                            # lock as the door's HA entity would loop /open -> HA -> /open. The
                            # webhook refuses it too (webhook._act_on_entity).
                            exclude_entities=_own_entities(self.hass),
                            multiple=True,
                        )
                    )
                }
            ),
            errors=errors,
            description_placeholders={"max": str(MAX_ENTITIES)},
        )

    async def async_step_address(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Change the doorbell's LAN address (DHCP moved it, or it changed VLAN).

        There is no cloud-DNS fallback any more (net.py), so this and zeroconf are how a moved
        doorbell is found again. The new address must answer as THIS doorbell on both ports.
        """
        errors: dict[str, str] = {}
        current_address = self._entry.data.get(CONF_HOST_HINT) or ""
        requested_address = current_address
        if user_input is not None:
            requested_address = user_input[CONF_HOST].strip()
            ip = await _address_for(requested_address)
            if ip is None:
                errors["base"] = "not_on_lan"
            else:
                _, error = await _check_lan(self.hass, ip, self._entry.data[CONF_DEVICE_ID])
                if error:
                    errors["base"] = error
                else:
                    self.hass.config_entries.async_update_entry(
                        self._entry, data={**self._entry.data, CONF_HOST_HINT: ip}
                    )
                    return self.async_create_entry(title="", data=dict(self._entry.options))
        return self.async_show_form(
            step_id="address",
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=requested_address): str}),
            errors=errors,
            description_placeholders={"host": requested_address},
        )

    async def async_step_https(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Secure local connection (HTTPS) for this Home Assistant (https_manager.py).

        ⚠️ One setting for the whole Home Assistant, not per doorbell: it is one port. It is
        stored by the manager, not in this entry's options, and applied at once - no reload of
        the entry. The doorbell of THIS entry is the one asked to vouch for the public name.
        """
        mgr = get_manager(self.hass)
        if mgr is None:
            return self.async_abort(reason="https_unavailable")
        errors: dict[str, str] = {}
        enabled, port = mgr.enabled, mgr.port
        if user_input is None:
            self._https_shown = mgr.enabled
        else:
            enabled = bool(user_input.get("enabled"))
            port = int(user_input.get("port") or DEFAULT_PORT)
            # ⚠️ A form opened BEFORE the setting changed elsewhere (another browser, another
            # doorbell's options, a tab left open) still carries the old toggle as its default,
            # and submitting it would silently undo that change - e.g. turn HTTPS off seconds
            # after someone else turned it on, cancelling the certificate request in flight.
            # Only a choice made against the CURRENT value may change it: show the form again.
            shown = getattr(self, "_https_shown", mgr.enabled)
            if mgr.enabled != shown and enabled != mgr.enabled:
                self._https_shown = mgr.enabled
                enabled = mgr.enabled
                errors = {"base": "https_changed_elsewhere"}
            elif enabled:
                errors = await _check_port(self.hass, mgr, port)
            if not errors:
                await mgr.async_configure(
                    enabled=enabled, port=port, device_id=self._entry.data[CONF_DEVICE_ID]
                )
                # Same dict back: an options flow REPLACES the whole options (see entities).
                return self.async_create_entry(title="", data=dict(self._entry.options))

        status = mgr.status()
        return self.async_show_form(
            step_id="https",
            data_schema=vol.Schema(
                {
                    vol.Required("enabled", default=enabled): selector.BooleanSelector(),
                    vol.Required("port", default=port): selector.NumberSelector(
                        selector.NumberSelectorConfig(
                            min=1024, max=65535, step=1, mode=selector.NumberSelectorMode.BOX
                        )
                    ),
                }
            ),
            errors=errors,
            description_placeholders={
                "port": str(port),
                "install_url": status.get("install_url") or INSTALL_PATH,
                "docs_url": HTTPS_DOCS_URL,
            },
        )

    async def async_step_repair(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Re-pair - e.g. after revoking the credential from the cloud panel.

        Same question as a new pairing: if the doorbell notifies ANOTHER Home Assistant, re-pairing
        (and the reload that follows) moves it here, so the user confirms it first (1.4.5).
        """
        errors: dict[str, str] = {}
        if user_input is not None:
            other, error = await _webhook_elsewhere(
                self.hass, self._entry.data[CONF_DEVICE_ID],
                self._entry.data.get(CONF_HOST_HINT) or "",
                user_input["email"], user_input["password"],
            )
            if error:
                errors["base"] = error
            elif other:
                self._pending_login = (user_input["email"], user_input["password"])
                self._other_ha = other
                return await self.async_step_repair_move_notifications()
            else:
                result = await self._async_repair(user_input["email"], user_input["password"])
                if isinstance(result, str):
                    errors["base"] = result
                else:
                    return result
        return self._repair_form(errors)

    async def async_step_repair_move_notifications(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Explicit confirm before re-pairing takes the notifications from another Home Assistant."""
        pending = getattr(self, "_pending_login", None)
        if user_input is None or pending is None:
            return self.async_show_form(
                step_id="repair_move_notifications",
                data_schema=vol.Schema({}),
                description_placeholders={"other": getattr(self, "_other_ha", None) or "?"},
            )
        self._pending_login = None
        result = await self._async_repair(*pending)
        if isinstance(result, str):
            return self._repair_form({"base": result})
        return result

    async def _async_repair(self, email: str, password: str) -> FlowResult | str:
        device_id = self._entry.data[CONF_DEVICE_ID]
        # The STORED label, never a new one: re-pairing must reuse this entry's slot (§1.5).
        result, error = await _async_pair(
            self.hass, device_id, self._entry.data.get(CONF_HOST_HINT) or "",
            email, password,
            self._entry.data.get(CONF_LABEL) or DEFAULT_PAIR_LABEL,
        )
        if error:
            return error
        assert result is not None
        new_data = dict(self._entry.data)
        new_data[CONF_CREDENTIAL] = result.credential
        self.hass.config_entries.async_update_entry(self._entry, data=new_data)
        # ⚠️ `data=dict(self._entry.options)` and NOT `data={}`: an options flow REPLACES
        # the whole dict and would take the entity list down with it.
        return self.async_create_entry(title="", data=dict(self._entry.options))

    def _repair_form(self, errors: dict[str, str]) -> FlowResult:
        return self.async_show_form(
            step_id="repair",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
            description_placeholders={"host": self._entry.data.get(CONF_HOST_HINT) or ""},
        )

def _own_entities(hass) -> list[str]:
    """Every entity this integration provides (for any doorbell)."""
    from homeassistant.helpers import entity_registry as er  # noqa: PLC0415

    return [e.entity_id for e in er.async_get(hass).entities.values() if e.platform == DOMAIN]

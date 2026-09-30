"""What deleting a doorbell's entry leaves behind on the doorbell, and how it is cleaned up (1.4.6).

One doorbell belongs to ONE Home Assistant. Moving it to another means deleting its entry here,
and that deletion cleans up after itself on the doorbell:

  (a) the doorbell's Home Assistant webhook is cleared - ONLY if it still points to THIS Home
      Assistant. If another one already took it over (the move question of 1.4.5), clearing it
      would silence the new owner: the doorbell stores ONE webhook, not one per pairing.
  (b) THIS Home Assistant's own pairing credential is revoked (`unpair_app?token=` with no slot:
      the pairing revokes itself, contract §1.5-ter). Without this the slot stays taken and - what
      matters - the doorbell keeps accepting a credential that now lives nowhere but in a deleted
      entry's history.

In THAT order, and it is not a preference: (a) authenticates with the credential that (b) kills.

⚠️ BEST-EFFORT, BOUNDED, AND NEVER BLOCKING. The whole thing runs under REMOVE_TIMEOUT. A doorbell
that is off, moved or unplugged must not stop anyone from deleting an entry - the entry goes
anyway, and when the pairing could not be confirmed revoked a Repairs notice says so and names the
pairing to revoke from the app. The notice is the part that must not be lost: a pairing nobody
knows is alive is the one nobody revokes.
"""
from __future__ import annotations

import asyncio
import logging

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from . import api, net, webhook
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_HOST_HINT,
    CONF_LABEL,
    DEFAULT_PAIR_LABEL,
    DOMAIN,
    REMOVE_TIMEOUT,
)

_LOGGER = logging.getLogger(__name__)

ISSUE_PAIRING_LEFT = "pairing_left_on_doorbell"


def issue_id_for(device_id: str) -> str:
    """One notice per doorbell: deleting it twice does not stack two."""
    return f"{ISSUE_PAIRING_LEFT}_{device_id}"


async def _our_webhook_url(hass: HomeAssistant, device_id: str, hint: str | None) -> str | None:
    """The webhook URL THIS Home Assistant gives the doorbell (same computation as
    `_async_configure_doorbell`, which re-sends it on every load - so what the doorbell holds, if it
    is ours, is exactly this). None if Home Assistant cannot tell its own address."""
    from . import _local_base  # noqa: PLC0415 - the package is loaded before this runs

    base = await _local_base(hass, hint)
    if not base:
        return None
    return f"{base.rstrip('/')}/api/webhook/{webhook.webhook_id_for(device_id)}"


async def _async_clean_up(
    hass: HomeAssistant, session: aiohttp.ClientSession, device_id: str, credential: str,
    hint: str | None,
) -> bool:
    """(a) then (b). True when the pairing is confirmed gone (revoked now, or already dead)."""
    try:
        current = await api.async_get_hass_webhook_url(session, device_id, credential)
    except api.AuthenticationError:
        # The credential is already dead (revoked from the app, or the doorbell was reset): there
        # is nothing of ours left to revoke, and no way to read the webhook with it.
        _LOGGER.info(
            "%s no longer accepts this Home Assistant's pairing: nothing to revoke. Its webhook "
            "could not be checked with a dead credential.", device_id,
        )
        return True
    except api.NotAllowedError:
        # A guest (user) pairing: it could never have configured the webhook, so it has none to
        # clear. It can still revoke itself below - that part needs no admin role.
        current = None

    if current:
        ours = await _our_webhook_url(hass, device_id, hint)
        if ours is not None and current == ours:
            await api.async_set_hass_config(
                session, device_id, credential, webhook_url="", entities=[]
            )
            _LOGGER.info("Webhook cleared on %s", device_id)
        else:
            # ⚠️ NOT TOUCHED, and that is the point: it belongs to the Home Assistant the doorbell
            # moved to (or this one cannot tell its own address, and then it cannot claim it).
            _LOGGER.info(
                "The webhook of %s points to another Home Assistant (%s): left as it is.",
                device_id, current,
            )

    released = await api.async_unpair_self(session, device_id, credential)
    _LOGGER.info(
        "This Home Assistant's pairing %s on %s",
        "revoked" if released else "was already gone", device_id,
    )
    return True


async def async_clean_up_doorbell(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Run the clean-up for a deleted entry. Never raises; True when the pairing is confirmed gone.

    When it is NOT confirmed (unreachable, timed out, an unexpected answer), a Repairs notice names
    the pairing to revoke from the app.
    """
    device_id = entry.data[CONF_DEVICE_ID]
    hint = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    address_map = {}
    if net.is_address(hint):
        address_map[api.doorbell_hostname(device_id)] = hint
    session = net.create_session(hass, address_map)
    done = False
    reason = ""
    try:
        async with asyncio.timeout(REMOVE_TIMEOUT):
            done = await _async_clean_up(
                hass, session, device_id, entry.data[CONF_CREDENTIAL], hint
            )
    except TimeoutError:
        reason = f"no answer within {REMOVE_TIMEOUT} s"
    except (api.DoorbellApiError, aiohttp.ClientError, OSError, ValueError) as err:
        reason = str(err) or type(err).__name__
    finally:
        # Throw-away session that NOBODY else closes: by `async_remove_entry` the entry's data is
        # gone from `hass.data`, because unloading runs first.
        await session.close()

    if done:
        ir.async_delete_issue(hass, DOMAIN, issue_id_for(device_id))
        return True

    label = entry.data.get(CONF_LABEL) or DEFAULT_PAIR_LABEL
    _LOGGER.warning(
        "Could not clean up %s while deleting it (%s). The entry is deleted anyway. Its pairing "
        "\"%s\" is still valid on the doorbell until it is revoked from the app, and if its "
        "webhook still points here it keeps sending notices nobody receives.",
        device_id, reason, label,
    )
    ir.async_create_issue(
        hass,
        DOMAIN,
        issue_id_for(device_id),
        is_fixable=False,
        is_persistent=True,
        severity=ir.IssueSeverity.WARNING,
        translation_key=ISSUE_PAIRING_LEFT,
        translation_placeholders={"name": entry.title or device_id, "label": label},
    )
    return False

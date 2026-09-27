"""Repair flows. Only one issue is fixable from here: the doorbell's public name belongs to another
Home Assistant (API_CONTRACT §4-ter.2, `409 doorbell_has_ha_name`).

One public name per doorbell, and moving it is the OWNER's decision - that is why the doorbell
only hands a voucher to an administrator pairing. Confirming here asks the VPS to move the name to
this Home Assistant (`replace: true`); the other Home Assistant keeps its certificate until it
expires but cannot renew it. Everything else about HTTPS is fixed in the integration's options.
"""
from __future__ import annotations

from homeassistant import data_entry_flow
from homeassistant.components.repairs import ConfirmRepairFlow, RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN
from .https_manager import ISSUE_NAME_TAKEN, get_manager


class TakeOverNameFlow(ConfirmRepairFlow):
    """Confirm, then move the doorbell's public name here."""

    async def async_step_confirm(
        self, user_input: dict[str, str] | None = None
    ) -> data_entry_flow.FlowResult:
        if user_input is not None:
            if (mgr := get_manager(self.hass)) is not None:
                mgr.request_replace()
            return self.async_create_entry(data={})
        issue = ir.async_get(self.hass).async_get_issue(DOMAIN, ISSUE_NAME_TAKEN)
        return self.async_show_form(
            step_id="confirm",
            data_schema=None,
            description_placeholders=dict(issue.translation_placeholders or {}) if issue else {"hostname": ""},
        )


async def async_create_fix_flow(
    hass: HomeAssistant, issue_id: str, data: dict[str, str | int | float | None] | None
) -> RepairsFlow:
    if issue_id == ISSUE_NAME_TAKEN:
        return TakeOverNameFlow()
    return ConfirmRepairFlow()

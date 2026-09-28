"""The doorbell's firmware as an `update` entity (1.4.0, parity plan §4, API_CONTRACT §1.2-sexies).

## The doorbell checks; Home Assistant asks the doorbell - never the VPS

Decided by Iñaki (2026-09-25): *"it is right that the doorbell itself checks whether a firmware is available."*
The doorbell asks its catalog with its own secret (~90 s after boot, then every ~6 h) and says the answer in
`GET /api/firmware_info` -> `available`, one of four explicit states. This entity reads ONLY that, over the LAN,
and installs with `POST /api/ota_install version=` - the doorbell downloads and verifies against the hash of its
own check. With the VPS down the doorbell says `not_checked`, and nothing here reaches out to find out otherwise.

## Four states, and "could not check" is never "up to date"

| `available.status` | latest_version | what the owner sees |
|---|---|---|
| `update_available` | `available.version` | an update, with the release notes |
| `up_to_date` | the installed version | up to date |
| `unknown_hardware` / `not_checked` | None | unknown - never a reassuring "up to date" |

## Installing (admin pairings only)

A `user` pairing sees the versions and the notes but gets no Install (the doorbell refuses `ota_install` to it,
§1.2-sexies). Progress is `GET /api/ota_from_url` (`fase`, `pct`), polled every 2 s while it runs; the doorbell
then reboots, and the install is reported done only when it answers again WITH THE NEW `fw_version` - the
contract's own verdict. Otherwise the doorbell's `last_ota.result` (rolled_back, not_booted, ...) is the error.

## Why there is no second `update` for the street panel

`/api/panel_ota` is local but takes the panel's image BYTES from the client: there is no catalog the doorbell
checks for the panel and no "latest version" to compare with (the panel reports a commit hash, not a version).
The doorbell brings its panel up to the minimum it needs by itself at every boot (`panel_sync`). An `update`
entity there could show nothing true and install nothing, so there is none; the panel's firmware stays a sensor.
"""
from __future__ import annotations

import asyncio
import logging
import time

from homeassistant.components.update import (
    UpdateDeviceClass,
    UpdateEntity,
    UpdateEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)

SUMMARY_MAX = 255                 # Home Assistant refuses a longer release_summary
PROGRESS_EVERY_S = 2
INSTALL_TIMEOUT_S = 15 * 60       # the contract measures ~5.5 min; generous for a slow line
BACK_TIMEOUT_S = 5 * 60           # from "restarting" until it must answer again


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([DoorbellFirmwareUpdate(c)])


class DoorbellFirmwareUpdate(DoorbellEntity, UpdateEntity):
    _attr_translation_key = "firmware"
    _attr_device_class = UpdateDeviceClass.FIRMWARE
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "firmware")
        self._installing = False
        self._pct: int | None = None

    def _available_info(self) -> dict:
        a = (self.coordinator.data or {}).get("available")
        return a if isinstance(a, dict) else {}

    @property
    def available(self) -> bool:
        return super().available and bool((self.coordinator.data or {}).get("fw_version"))

    @property
    def supported_features(self) -> UpdateEntityFeature:
        f = UpdateEntityFeature.RELEASE_NOTES | UpdateEntityFeature.PROGRESS
        if self.coordinator.role == "admin":
            f |= UpdateEntityFeature.INSTALL
        return f

    @property
    def installed_version(self) -> str | None:
        return (self.coordinator.data or {}).get("fw_version")

    @property
    def latest_version(self) -> str | None:
        a = self._available_info()
        status = a.get("status")
        if status == "update_available" and a.get("version"):
            return str(a["version"])
        if status == "up_to_date":
            return self.installed_version
        # unknown_hardware / not_checked / an older firmware without `available`: unknown, never "up to date".
        return None

    @property
    def release_summary(self) -> str | None:
        notes = self._notes()
        if not notes:
            return None
        return notes if len(notes) <= SUMMARY_MAX else notes[: SUMMARY_MAX - 1].rstrip() + "…"

    def _notes(self) -> str | None:
        a = self._available_info()
        if a.get("status") != "update_available":
            return None
        return str(a.get("notes") or "") or None

    async def async_release_notes(self) -> str | None:
        return self._notes()

    @property
    def in_progress(self) -> bool:
        return self._installing

    @property
    def update_percentage(self) -> int | None:
        return self._pct if self._installing else None

    @property
    def extra_state_attributes(self) -> dict:
        # The doorbell's own words (technical, English): WHY the latest version is unknown when it is.
        a = self._available_info()
        attrs = {"check_status": a.get("status")}
        if a.get("reason"):
            attrs["check_reason"] = a.get("reason")
        if a.get("checked_at"):
            attrs["checked_at"] = a.get("checked_at")
        return attrs

    async def async_install(self, version: str | None, backup: bool, **kwargs) -> None:
        c = self.coordinator
        target = version or self.latest_version
        if not target or target == self.installed_version:
            raise HomeAssistantError("The doorbell does not offer a newer firmware right now.")
        if self._available_info().get("status") != "update_available" or target != self.latest_version:
            # Only what the doorbell's own check offered: that is the version it holds a verified hash for.
            raise HomeAssistantError(f"The doorbell does not offer version {target}.")
        old = self.installed_version
        try:
            await api.async_ota_install(c.session, c.device_id, c.credential, target)
        except api.NotAllowedError as err:
            raise HomeAssistantError(
                "This pairing is not an administrator of the doorbell, so it cannot update it."
            ) from err
        except api.DoorbellApiError as err:
            if "ota_in_progress" not in str(err):
                raise HomeAssistantError(f"The doorbell did not start the update: {err}") from err
            # already installing: follow that one
        self._installing, self._pct = True, 0
        self.async_write_ha_state()
        try:
            await self._follow(target, old)
        finally:
            self._installing, self._pct = False, None
            self.async_write_ha_state()

    async def _follow(self, target: str, old: str | None) -> None:
        c = self.coordinator
        deadline = time.monotonic() + INSTALL_TIMEOUT_S
        restarting_since: float | None = None
        while time.monotonic() < deadline:
            await asyncio.sleep(PROGRESS_EVERY_S)
            try:
                p = await api.async_get_json(c.session, c.device_id, c.credential, "/api/ota_from_url")
            except api.DoorbellApiError:
                # Not answering: it is rebooting into the new image (or on the way back).
                restarting_since = restarting_since or time.monotonic()
                if time.monotonic() - restarting_since > BACK_TIMEOUT_S:
                    break
                continue
            fase = p.get("fase")
            if isinstance(p.get("pct"), (int, float)):
                self._pct = max(0, min(100, int(p["pct"])))
                self.async_write_ha_state()
            if fase == "failed":
                raise HomeAssistantError(f"The doorbell's update failed: {p.get('error') or 'unknown error'}")
            if fase == "restarting":
                restarting_since = restarting_since or time.monotonic()
                continue
            if restarting_since is not None or (fase == "idle" and not p.get("activa")):
                # Back (or never went): the verdict is the version it RUNS, never our intention.
                c.firmware_due_now()
                try:
                    await c.async_refresh_firmware()
                except api.DoorbellApiError:
                    continue
                if self.installed_version == target:
                    return
                result = (p.get("last_ota") or {}).get("result")
                if restarting_since is not None or result:
                    raise HomeAssistantError(
                        f"The doorbell is still on {self.installed_version or old} after the update"
                        + (f" ({result})." if result else ".")
                    )
        raise HomeAssistantError("The doorbell's update did not finish in time; check its firmware version.")

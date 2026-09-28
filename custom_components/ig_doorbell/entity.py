"""Common base for the entities: identity, availability, and the hook into the webhook."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo

# ⚠️ The callback a platform uses to register its entities CHANGED NAME: Home Assistant
# introduced `AddConfigEntryEntitiesCallback` and deprecated `AddEntitiesCallback`. The new one is
# imported and falls back to the old one, re-exported from here so the five platforms do not
# repeat the same block - a defence spread across five places falls the moment one of them falls
# behind, and here the failure mode is that the integration **does not load**, with nothing to
# explain why.
try:  # HA >= 2025.2
    from homeassistant.helpers.entity_platform import (
        AddConfigEntryEntitiesCallback as AddEntities,
    )
except ImportError:  # pragma: no cover - older HA
    from homeassistant.helpers.entity_platform import AddEntitiesCallback as AddEntities
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import DoorbellCoordinator


class DoorbellEntity(CoordinatorEntity[DoorbellCoordinator]):
    """Every entity of a doorbell hangs off this."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: DoorbellCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._key = key
        self._attr_unique_id = f"{coordinator.device_id}_{key}"

    @property
    def device_info(self) -> DeviceInfo:
        """Hooks into the SAME device __init__.py already registers.

        A single identifier, our own, same as in `__init__.py`. There used to be a second one -
        the one from MQTT auto-discovery - so that Home Assistant would merge the two devices; it
        was removed on 2026-08-24 once what it cost was measured: deleting the MQTT device took our
        config entry down with it. The whole reasoning lives in `__init__.py`.
        """
        data = self.coordinator.data or {}
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.device_id)},
            manufacturer="Islautopia Garage",
            model=f"IG Doorbell {data.get('hw_version', '')}".strip(),
            name=self.coordinator.doorbell_name,
            sw_version=data.get("fw_version"),
            # The doorbell's own dashboard at its LAN address. Not the cloud hostname: following
            # that link would make the browser ask our cloud's DNS where a device in the house is.
            configuration_url=(
                f"http://{self.coordinator.address}/" if self.coordinator.address else None
            ),
        )

    @property
    def available(self) -> bool:
        """Available = the last poll answered.

        This is what replaces MQTT's LWT, and it comes for free: with the broker you had to
        configure a last-will message, one more piece that could be left unconfigured and leave
        entities reporting a state from hours ago.
        """
        return self.coordinator.last_update_success


class SourceEntity(DoorbellEntity):
    """An entity that reads one of the coordinator's slow sources (coordinator.SOURCES).

    Unavailable until that source has been read - never a made-up value in the meantime - and
    unavailable when this pairing may not read it.
    """

    _source: str | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self._source:
            self.async_on_remove(self.coordinator.want(self._source))

    @property
    def source(self) -> dict | None:
        return self.coordinator.extra.get(self._source) if self._source else None

    @property
    def available(self) -> bool:
        if not super().available:
            return False
        return self._source is None or self.source is not None


class AdminEntity(SourceEntity):
    """A control that WRITES a doorbell setting. Admin only (§1.16-bis: anyone reads, admin writes).

    ⚠️ UNAVAILABLE, not failing, with a `user` pairing (Iñaki, 2026-09-28): a control that is
    offered and then refuses every time is the worse of the two. The value is still readable in
    that pairing's diagnostics and in the apps. And the doorbell remains the one that enforces it -
    its 403 is still turned into a readable error (coordinator._write_error) if it is reached.
    """

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.role == "admin"

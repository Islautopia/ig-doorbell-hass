"""Doorbell sensors: viewers, the mode's reason, and the diagnostic ones."""
from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.const import EntityCategory, UnitOfInformation
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity, SourceEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        ViewersSensor(c),
        TextSensor(c, "fw_version", "firmware_version", "mdi:chip"),
        TextSensor(c, "panel_fw", "panel_firmware", "mdi:tablet"),
        # 1.3.0 (parity plan Phase 1)
        TextSensor(c, "wifi_ssid", "wifi_ssid", "mdi:wifi"),
        TextSensor(c, "ip", "ip_address", "mdi:ip-network"),
        RoleSensor(c),
        ModeReasonSensor(c),
        SdStateSensor(c),
        SdBytesSensor(c, "sd_total", "total_bytes"),
        SdBytesSensor(c, "sd_free", "free_bytes"),
        MicGainSensor(c),
        MemorySensor(c, "internal_free", ("interna", "libre")),
        MemorySensor(c, "internal_largest_block", ("interna", "mayor")),
        MemorySensor(c, "psram_free", ("psram", "libre")),
        LastBootSensor(c),
        ResetReasonSensor(c),
        # 1.8.0: the multi-region cloud (firmware 1.2.0) and the boot/video self-healing
        CloudRegionSensor(c, "cloud_region", "cloud_region"),
        CloudRegionSensor(c, "cloud_home", "cloud_home_region"),
        RegionListSensor(c),
        BootGuardSensor(c),
        VideoRecoverySensor(c),
        # 1.8.0: er10v2 hardware, only where the doorbell has it (coordinator.async_probe_features)
        *([ChimeSensor(c)] if "chime" in c.features else []),
        *([PartStateSensor(c, "keypad")] if "keypad" in c.features else []),
        *([PartStateSensor(c, "fingerprint")] if "fingerprint" in c.features else []),
    ])


class ViewersSensor(DoorbellEntity, SensorEntity):
    """`webrtc_clients` (§1.2): how many people are watching right now, 0-4.

    Counts ONLY WebRTC sessions, including ones still negotiating ICE/DTLS. RTSP clients do not
    count: they are third-party NVRs, not users.

    ⚠️ Up to 30 s of lag, and that is not a defect to fix by polling more often. The counter changes
    in places that run on the doorbell's real-time audio/video path, so asking more often costs it
    exactly what it would save us. **The events entity is there for live automation**, and it
    arrives pushed.
    """

    _attr_translation_key = "viewers"
    _attr_icon = "mdi:account-eye"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "viewers")

    @property
    def native_value(self) -> int:
        return int((self.coordinator.data or {}).get("webrtc_clients", 0))


class TextSensor(DoorbellEntity, SensorEntity):
    """A diagnostic text field.

    ⚠️ `panel_fw` **only appears if there is a panel** (§1.2-ter), and its absence means "no
    panel", not "not known". `None` is returned in that case instead of an empty string or a dash:
    a client that paints "-" is asserting something the doorbell never said.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DoorbellCoordinator, field: str, translation_key_name: str, icon: str) -> None:
        super().__init__(coordinator, field)
        self._field = field
        self._attr_translation_key = translation_key_name
        self._attr_icon = icon

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get(self._field) or None



# ==================================================================================================
# 1.3.0 (parity plan Phase 1): what the apps' "About" and settings screens show, as sensors.
# ==================================================================================================


class RoleSensor(DoorbellEntity, SensorEntity):
    """THIS pairing's role on the doorbell (I4): what explains why the settings are unavailable.

    `admin` writes, `user` reads (§1.16-bis). `unknown` = a pairing made before roles existed, or the
    doorbell could not be asked yet. Re-pairing from an administrator account is the only way up.
    """

    _attr_translation_key = "pairing_role"
    _attr_icon = "mdi:account-key"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["admin", "user", "unknown"]

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "pairing_role")

    @property
    def native_value(self) -> str:
        role = self.coordinator.role
        return role if role in self._attr_options else "unknown"


class ModeReasonSensor(SourceEntity, SensorEntity):
    """WHY the doorbell is in its mode (D2, §1.12-bis): set by hand, by the schedule, or neither.

    From `GET /api/mode_rules` (admin), re-read at once when the mode changes (webhook
    `mode_changed`, or a poll that sees a new `m`). `until`: when the current state is expected to
    change - OMITTED when the doorbell does not know, never a 1970 date.
    """

    _source = "mode_rules"
    _attr_translation_key = "mode_reason"
    _attr_icon = "mdi:home-clock-outline"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["manual", "schedule", "no_clock", "none"]

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "mode_reason")

    def _state(self) -> dict:
        state = (self.source or {}).get("state")
        return state if isinstance(state, dict) else {}

    @property
    def native_value(self) -> str | None:
        why = self._state().get("why")
        return why if why in self._attr_options else None

    @property
    def extra_state_attributes(self) -> dict | None:
        until = self._state().get("until")
        if not isinstance(until, (int, float)) or until <= 0:
            return None
        return {"until": dt_util.utc_from_timestamp(until).isoformat()}


class SdStateSensor(SourceEntity, SensorEntity):
    """The SD card in one word (§1.3-bis-v2 `sd_state`, firmware 0.95.0).

    `unreadable` is the one that asks for the owner: the card has a file system that does not mount
    and it is NOT formatted by itself. Formatting is left to the apps on purpose (irreversible,
    plan §0). A firmware before 0.95.0 has no `sd_state`: derived from `sd_present`/`sd_mounted`.
    """

    _source = "storage"
    _attr_translation_key = "sd_state"
    _attr_icon = "mdi:sd"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["absent", "mounted", "formatting", "blank", "unreadable", "format_failed"]

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "sd_state")

    @property
    def native_value(self) -> str | None:
        s = self.source or {}
        state = s.get("sd_state")
        if state in self._attr_options:
            return state
        if state is not None:
            return None     # a state newer than this integration: "unknown", not a guess
        if not s.get("sd_present"):
            return "absent"
        return "mounted" if s.get("sd_mounted") else "unreadable"


class SdBytesSensor(SourceEntity, SensorEntity):
    """Size / free space of the SD card's file system. `0` from the doorbell = not mounted: shown
    as unknown, not as an empty card."""

    _source = "storage"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.DATA_SIZE
    _attr_native_unit_of_measurement = UnitOfInformation.BYTES
    _attr_suggested_unit_of_measurement = UnitOfInformation.GIGABYTES
    _attr_suggested_display_precision = 1
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:sd"

    def __init__(self, coordinator: DoorbellCoordinator, key: str, field: str) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._attr_translation_key = key

    @property
    def native_value(self) -> int | None:
        s = self.source or {}
        if not s.get("sd_mounted"):
            return None
        value = s.get(self._field)
        return int(value) if isinstance(value, (int, float)) else None


class MicGainSensor(DoorbellEntity, SensorEntity):
    """`mgain`: READ-ONLY, and not a control on purpose (F11).

    ⚠️ The microphone gain is FIXED by the firmware (`MIC_GAIN_FIXED`, §1.2-bis): `save_states`
    ignores `mgain` since 2026-07-09 and no route writes it. It multiplies the microphone before the
    echo canceller, whose tuning (filter length, analog gain) was measured against that value - a
    user-facing gain would move the AEC's input under it. Shown for diagnostics only, disabled by
    default.
    """

    _attr_translation_key = "mic_gain"
    _attr_icon = "mdi:microphone-settings"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "mic_gain")

    @property
    def native_value(self) -> float | None:
        v = (self.coordinator.data or {}).get("mgain")
        return float(v) if isinstance(v, (int, float)) else None


class MemorySensor(SourceEntity, SensorEntity):
    """`/api/mem_stats` (§1.2-quater). Disabled by default: read only while one of these is enabled.

    The number that matters is the LARGEST internal block, not the free total: when it falls and the
    free total does not, that is fragmentation - what makes a TLS connection or a recording fail
    with no other warning. Internal RAM is this device's scarce resource, not PSRAM.
    """

    _source = "mem"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_device_class = SensorDeviceClass.DATA_SIZE
    _attr_native_unit_of_measurement = UnitOfInformation.BYTES
    _attr_suggested_unit_of_measurement = UnitOfInformation.KILOBYTES
    _attr_suggested_display_precision = 0
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:memory"

    def __init__(self, coordinator: DoorbellCoordinator, key: str, path: tuple[str, str]) -> None:
        super().__init__(coordinator, key)
        self._path = path
        self._attr_translation_key = key

    @property
    def native_value(self) -> int | None:
        block = (self.source or {}).get(self._path[0])
        value = block.get(self._path[1]) if isinstance(block, dict) else None
        return int(value) if isinstance(value, (int, float)) else None


class LastBootSensor(SourceEntity, SensorEntity):
    """When the doorbell last started (uptime from `/api/mem_stats`). Disabled by default.

    A timestamp and not an uptime counter: an uptime changes on every read and would fill the
    recorder with meaningless states. The instant only moves when the doorbell restarts - a jitter
    under a minute between reads is the request's own latency, not a reboot, and is ignored.
    """

    _source = "mem"
    _attr_translation_key = "last_boot"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:restart"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "last_boot")
        self._boot: datetime | None = None

    @property
    def native_value(self) -> datetime | None:
        uptime = (self.source or {}).get("uptime_s")
        if not isinstance(uptime, (int, float)):
            return self._boot
        boot = (dt_util.utcnow() - timedelta(seconds=int(uptime))).replace(microsecond=0)
        if self._boot is None or abs((boot - self._boot).total_seconds()) > 60:
            self._boot = boot
        return self._boot


class ResetReasonSensor(SourceEntity, SensorEntity):
    """Why the doorbell last restarted (`/api/debug/boot` -> `reset_txt`, ESP-IDF's own word:
    `poweron`, `sw`, `panic`, `int_wdt`, `task_wdt`, `brownout`...). English on purpose: it is a
    diagnostic that gets pasted into a report. Disabled by default."""

    _source = "boot"
    _attr_translation_key = "reset_reason"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:restart-alert"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "reset_reason")

    @property
    def native_value(self) -> str | None:
        return (self.source or {}).get("reset_txt") or None


# ==================================================================================================
# 1.8.0: the multi-region cloud (firmware 1.2.0, API_CONTRACT 3.7) and the self-healing diagnostics.
#
# All told by the DOORBELL over the LAN (`get_states` every 30 s, `/api/debug/boot` every ~10 min),
# never asked of our cloud: principle 1, and the same reason as cloud_link.py - asking a region
# "where is my doorbell?" would depend on the very thing being reported. Technical values in English
# (region ids, protocol states): they get pasted into reports.
# ==================================================================================================


def _relay_region(coordinator: DoorbellCoordinator) -> dict:
    relay = (coordinator.extra.get("boot") or {}).get("relay")
    region = relay.get("region") if isinstance(relay, dict) else None
    return region if isinstance(region, dict) else {}


class CloudRegionSensor(DoorbellEntity, SensorEntity):
    """`cloud_region` = the region whose relay the doorbell is connected to now; `cloud_home` = the
    region it belongs to. Different = the doorbell failed over and is away from home (it moves back
    by itself at a quiet moment, never during a call). Both from `get_states` only: an enabled entity
    never makes the doorbell serve `/api/debug/boot` (the details are RegionListSensor, disabled by
    default). Unavailable on a firmware that does not report the field (before the multi-region
    cloud)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:earth"

    def __init__(self, coordinator: DoorbellCoordinator, field: str, key: str) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._attr_translation_key = key

    @property
    def available(self) -> bool:
        return super().available and isinstance((self.coordinator.data or {}).get(self._field), str)

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get(self._field) or None


class RegionListSensor(SourceEntity, SensorEntity):
    """The signed region list the doorbell holds (its serial as the state) and the cloud link's
    details: where TURN is allocated, whether the list verified, how many failovers and moves home
    since boot (`/api/debug/boot` -> relay.region, API_CONTRACT 3.7). Disabled by default, like every
    entity that reads `/api/debug/boot`: enabling it costs the doorbell one request every ~10 min."""

    _source = "boot"
    _attr_translation_key = "region_list"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:format-list-checks"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "region_list")

    @property
    def native_value(self) -> int | None:
        serial = _relay_region(self.coordinator).get("serial")
        return serial if isinstance(serial, int) and not isinstance(serial, bool) else None

    @property
    def extra_state_attributes(self) -> dict | None:
        r = _relay_region(self.coordinator)
        if not r:
            return None
        out = {
            "region": r.get("id"),
            "home": r.get("home"),
            "relay_host": r.get("host"),
            "turn_server": r.get("turn"),
            "turn_allocated": (r.get("turn_state") == 4) if "turn_state" in r else None,
            "source": r.get("source"),
            "expired": r.get("expired"),
            "signature_selftest": r.get("sig_selftest"),
            "regions": r.get("regions"),
            "failovers": r.get("failovers"),
            "fast_failovers": r.get("fast_failovers"),
            "moves_home": r.get("moves_home"),
            "last_switch": r.get("last_switch") or None,
        }
        return {k: v for k, v in out.items() if v is not None}


class BootGuardSensor(SourceEntity, SensorEntity):
    """The boot watchdog (firmware 1.2.0, `/api/debug/boot` -> `arranque_vigilado`): `disarmed` after
    a normal boot. It turns a boot that hangs into a reset, and a new image that hangs into a
    rollback; `fired_total` counts how often it had to. Disabled by default."""

    _source = "boot"
    _attr_translation_key = "boot_guard"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:shield-refresh"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "boot_guard")

    def _g(self) -> dict:
        g = (self.source or {}).get("arranque_vigilado")
        return g if isinstance(g, dict) else {}

    @property
    def native_value(self) -> str | None:
        return self._g().get("state") or None

    @property
    def extra_state_attributes(self) -> dict | None:
        g = self._g()
        if not g:
            return None
        out = {"mode": g.get("mode"), "boot_ms": g.get("boot_ms"),
               "slowest_stage": g.get("slowest_stage"), "fired_total": g.get("fired_total"),
               "detached": g.get("detached")}
        return {k: v for k, v in out.items() if v is not None}


class VideoRecoverySensor(SourceEntity, SensorEntity):
    """The video self-healing ladder (`/api/debug/boot` -> `video_heal`): `idle` when the picture
    pipeline is healthy. `rungs_total` counts the recoveries per rung (rung 1 = the PPA reset of
    firmware 1.2.0, the ones nobody sees). Disabled by default."""

    _source = "boot"
    _attr_translation_key = "video_recovery"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:video-wireless-outline"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "video_recovery")

    def _v(self) -> dict:
        v = (self.source or {}).get("video_heal")
        return v if isinstance(v, dict) else {}

    @property
    def native_value(self) -> str | None:
        ladder = self._v().get("ladder")
        return (ladder.get("state") or None) if isinstance(ladder, dict) else None

    @property
    def extra_state_attributes(self) -> dict | None:
        rungs = self._v().get("rungs")
        if not isinstance(rungs, dict):
            return None
        return {"rungs_total": rungs.get("total"), "rungs_this_boot": rungs.get("boot")}


class ChimeSensor(SourceEntity, SensorEntity):
    """The 433 MHz chime transmitter (er10v2, API_CONTRACT 1.23.5): `running` when it can send.
    One-way radio: the doorbell cannot know whether a chime HEARD it, so the counters say "keyed on
    air", never "a chime rang". `selftest` other than `ok` = no chime would accept its frames."""

    _source = "chime"
    _attr_translation_key = "chime_transmitter"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:bell-ring-outline"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "chime_transmitter")

    @property
    def native_value(self) -> str | None:
        return (self.source or {}).get("state") or None

    @property
    def extra_state_attributes(self) -> dict | None:
        s = self.source or {}
        keys = ("selftest", "rings", "tests", "copies_sent", "onair_ms_last_hour", "cap_ms_hour",
                "dropped_cap", "tx_errors")
        out = {k: s.get(k) for k in keys if s.get(k) is not None}
        return out or None


class PartStateSensor(SourceEntity, SensorEntity):
    """The er10v2 keypad / fingerprint reader, in the doorbell's own word (`running`, `idle`,
    `i2c_errors`, `uart_errors`...). Created only where the part is fitted. Disabled by default:
    they are for an installer tuning the glass, not for the house. No digit and no finger slot is
    ever exposed (the doorbell does not return them either)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False

    def __init__(self, coordinator: DoorbellCoordinator, part: str) -> None:
        super().__init__(coordinator, f"{part}_state")
        self._source = part
        self._attr_translation_key = f"{part}_state"
        self._attr_icon = "mdi:dialpad" if part == "keypad" else "mdi:fingerprint"

    @property
    def native_value(self) -> str | None:
        return (self.source or {}).get("state") or None

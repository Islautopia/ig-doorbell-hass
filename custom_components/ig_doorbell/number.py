"""Wall panels: back to the home page after: how long a card waits, untouched, before taking a wall
panel's screen back to Home Assistant's default page (1.2.0; wall panels only since 1.2.3).

## Only on a wall panel (Iñaki, 2026-09-28, 1.2.3)

It applies ONLY on a page the integration recognises as a wall panel picked in the Ring
notifications options (call_page_nav.is_configured_panel: since 1.2.4 by its companion login,
panel_identity.py; the card gets the answer as `back_home` in get_connection_info). A desktop browser or a
phone is attended and is never navigated away - in 1.2.2 his PC was sent home at the same moment
as the salon panel. The name says so, in every language.

## What it was, and why it changed (Iñaki, 2026-09-27)

Until 1.1.x this was the *live view timeout*: after this many seconds without a touch the card
paused the stream. Iñaki's rule for 1.2.0 replaces it: **when the card is visible there is always a
stream; when it is not visible the stream stops at once** (the hide/off-screen pause, unchanged). So
the deadline no longer cuts the stream: it takes the screen back to the default page, and leaving
the card is what stops the stream.

- During a call that was **not** answered: after the deadline (counted from the ring) -> default page.
- During a call that **was** answered (microphone/turn): never while it lasts.
- Outside a call: after the deadline without a touch -> default page. `0` = never: the card stays,
  with its stream on.
- A card that IS on the default page stays there (no navigation loop).

The value, the entity id and the unique id are the same as before on purpose: an owner who had set
it keeps it (RestoreNumber), and only its meaning and name change. The card applies it, because the
card is the one on screen.
"""
from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.number import NumberEntity, NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN, LIVE_TIMEOUT_DEFAULT_S, LIVE_TIMEOUT_MAX_S
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity, DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        LiveTimeoutNumber(c),
        *(StateNumber(c, d) for d in STATE_NUMBERS),
        *(DetectNumber(c, d) for d in DETECT_NUMBERS),
        ExposureCompensationNumber(c),
        ManualExposureNumber(c),
        ManualGainNumber(c),
    ])


class LiveTimeoutNumber(DoorbellEntity, RestoreNumber):
    """Seconds without a touch before the card goes back to Home Assistant's default page."""

    _attr_translation_key = "live_view_timeout"
    _attr_icon = "mdi:home-clock-outline"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_native_min_value = 0
    _attr_native_max_value = LIVE_TIMEOUT_MAX_S
    _attr_native_step = 15
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "live_timeout")
        self._attr_native_value = float(LIVE_TIMEOUT_DEFAULT_S)

    @property
    def available(self) -> bool:
        # A Home Assistant setting, not a doorbell reading: it stays usable (and readable by the
        # card) while the doorbell is off. An unavailable value would make every card fall back to
        # its own default, silently ignoring what the owner set.
        return True

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        previous = await self.async_get_last_number_data()
        if previous is not None and previous.native_value is not None:
            self._attr_native_value = previous.native_value

    async def async_set_native_value(self, value: float) -> None:
        self._attr_native_value = value
        self.async_write_ha_state()



# ==================================================================================================
# DOORBELL SETTINGS (1.3.0, parity plan Phase 1). Admin only (entity.AdminEntity). Plan rule R5 -
# "secret, irreversible or editor?" - answered for all of these at once: none. They are the same
# values the apps' Advanced screen writes, applied live by the doorbell, and any of them can be put
# back. Ranges are the doorbell's own (§1.2) - `save_states` does NOT clamp, a value outside them is
# stored as sent, so Home Assistant's min/max are the validation.
# ==================================================================================================


@dataclass(frozen=True)
class NumberDef:
    key: str                 # unique id suffix + translation key
    field: str               # the doorbell's field
    lo: float
    hi: float
    step: float = 1
    unit: str | None = None
    icon: str | None = None
    enabled: bool = True     # enabled by default in the entity registry


STATE_NUMBERS: tuple[NumberDef, ...] = (
    # Image (F1): applied to the real ISP since 2026-07-09 (§1.2).
    NumberDef("brightness", "br", -100, 100, icon="mdi:brightness-6"),
    NumberDef("contrast", "con", -100, 100, icon="mdi:contrast-box"),
    NumberDef("saturation", "sat", 0, 100, icon="mdi:palette"),
    NumberDef("hue", "hue", 0, 359, unit="\u00b0", icon="mdi:palette-swatch"),
    # Door (F10): seconds the door stays released. 1-10 is what both apps offer.
    NumberDef("door_open_time", "dur", 1, 10, unit=UnitOfTime.SECONDS, icon="mdi:timer-lock-open"),
    # Streams (G4): DISABLED by default. They change what every viewer and the recordings get, and
    # the defaults are the measured ones (§1.2: "the 15 is true since 0.96.3").
    NumberDef("main_stream_fps", "mfps", 2, 20, unit="fps", icon="mdi:filmstrip", enabled=False),
    NumberDef("main_stream_bitrate", "mkbps", 500, 4000, step=100, unit="kbit/s",
              icon="mdi:speedometer", enabled=False),
    NumberDef("sub_stream_fps", "sfps", 2, 10, unit="fps", icon="mdi:filmstrip", enabled=False),
    NumberDef("sub_stream_bitrate", "skbps", 100, 1500, step=50, unit="kbit/s",
              icon="mdi:speedometer", enabled=False),
)

DETECT_NUMBERS: tuple[NumberDef, ...] = (
    # Detection (F7, §1.14-bis). `min_area` is THE size filter for both classes; `aimin` of §1.2
    # filters nothing since 2026-09-04 and is deliberately not offered (plan F8).
    NumberDef("person_threshold", "conf_person", 1, 99, unit=PERCENTAGE, icon="mdi:account-search"),
    NumberDef("package_threshold", "conf_pkg", 1, 99, unit=PERCENTAGE, icon="mdi:package-variant"),
    NumberDef("detection_min_area", "min_area", 0, 90, unit=PERCENTAGE, icon="mdi:selection-drag"),
)


class _SettingNumber(AdminEntity, NumberEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: DoorbellCoordinator, d: NumberDef) -> None:
        super().__init__(coordinator, d.key)
        self._def = d
        self._attr_translation_key = d.key
        self._attr_native_min_value = d.lo
        self._attr_native_max_value = d.hi
        self._attr_native_step = d.step
        self._attr_native_unit_of_measurement = d.unit
        self._attr_icon = d.icon
        self._attr_entity_registry_enabled_default = d.enabled

    def _raw(self):
        return (self.coordinator.data or {}).get(self._def.field)

    @property
    def available(self) -> bool:
        return super().available and self._raw() is not None

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._raw())
        except (TypeError, ValueError):
            return None


class StateNumber(_SettingNumber):
    """A `get_states` / `save_states` field."""

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_save_states(
            {self._def.field: str(int(round(value)))}, self._def.key.replace("_", " "))


class DetectNumber(_SettingNumber):
    """A `/api/detect_config` field."""

    _source = "detect"

    def _raw(self):
        return (self.source or {}).get(self._def.field)

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_save_detect(
            {self._def.field: str(int(round(value)))}, self._def.key.replace("_", " "))


class _ImgNumber(AdminEntity, NumberEntity):
    """`/api/img_settings` (exposure). Admin to read AND write, so unavailable for a `user` pairing.

    Unavailable too when the doorbell says `sensor_soportado:false`: the exposure loop is only
    verified on the SC2336, and the doorbell refuses every write with 503 on any other sensor.
    """

    _source = "img"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_mode = NumberMode.BOX

    @property
    def available(self) -> bool:
        return super().available and bool((self.source or {}).get("sensor_soportado"))


class ExposureCompensationNumber(_ImgNumber):
    """EV compensation in `auto` exposure: +-2 EV in thirds, 0 = the algorithm decides."""

    _attr_translation_key = "exposure_compensation"
    _attr_icon = "mdi:plus-minus-variant"
    _attr_native_unit_of_measurement = "EV"
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "exposure_compensation")

    @property
    def native_min_value(self) -> float:
        return float((self.source or {}).get("ev_min", -2.0))

    @property
    def native_max_value(self) -> float:
        return float((self.source or {}).get("ev_max", 2.0))

    @property
    def native_step(self) -> float:
        return round(float((self.source or {}).get("ev_step", 1 / 3)), 6)

    @property
    def native_value(self) -> float | None:
        ev = (self.source or {}).get("ev")
        return None if ev is None else round(float(ev), 2)

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_save_img({"ev": f"{value:.3f}"}, "the exposure compensation")


class _ManualNumber(_ImgNumber):
    """Manual exposure time / gain. ALWAYS sent together (the doorbell answers `400
    manual_incomplete` otherwise): moving one re-sends the other's stored value unchanged. They act
    only in `manual` mode (the exposure mode select); in `auto` they are stored for later."""

    async def _send(self, exposure: int, gain: int, what: str) -> None:
        await self.coordinator.async_save_img(
            {"exposure_us": str(exposure), "gain_idx": str(gain)}, what)


class ManualExposureNumber(_ManualNumber):
    """⚠️ `exposure_us` is NOT in microseconds on the SC2336: its unit is 100 us (§1.9-quater,
    checked in the driver). Shown in milliseconds, converted both ways here and nowhere else."""

    _attr_translation_key = "manual_exposure"
    _attr_icon = "mdi:camera-timer"
    _attr_native_unit_of_measurement = UnitOfTime.MILLISECONDS
    _attr_native_step = 0.1

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "manual_exposure")

    @property
    def native_min_value(self) -> float:
        return int((self.source or {}).get("exposure_us_min", 3)) / 10

    @property
    def native_max_value(self) -> float:
        return int((self.source or {}).get("exposure_us_max", 398)) / 10

    @property
    def native_value(self) -> float | None:
        v = (self.source or {}).get("manual_exposure_us")
        return None if v is None else int(v) / 10

    async def async_set_native_value(self, value: float) -> None:
        gain = (self.source or {}).get("manual_gain_idx")
        if gain is None:
            raise HomeAssistantError("The doorbell has not reported its manual gain yet")
        await self._send(int(round(value * 10)), int(gain), "the manual exposure")


class ManualGainNumber(_ManualNumber):
    _attr_translation_key = "manual_gain"
    _attr_icon = "mdi:tune-vertical"
    _attr_native_step = 1

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "manual_gain")

    @property
    def native_min_value(self) -> float:
        return int((self.source or {}).get("gain_idx_min", 0))

    @property
    def native_max_value(self) -> float:
        return int((self.source or {}).get("gain_idx_max", 118))

    @property
    def native_value(self) -> float | None:
        v = (self.source or {}).get("manual_gain_idx")
        return None if v is None else int(v)

    async def async_set_native_value(self, value: float) -> None:
        exposure = (self.source or {}).get("manual_exposure_us")
        if exposure is None:
            raise HomeAssistantError("The doorbell has not reported its manual exposure yet")
        await self._send(int(exposure), int(round(value)), "the manual gain")

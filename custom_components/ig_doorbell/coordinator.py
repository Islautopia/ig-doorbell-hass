"""Asks the doorbell for its state, and every entity lives off that.

## Why poll at all if the webhook pushes

Because they are two different things. The webhook brings **what happens** - someone rang, there
is a package, the door opened - and polling brings **how things are** - what mode, how many people
are watching, whether there is a street panel, what firmware is running. The second kind changes
without anyone announcing it: the mode is touched from the doorbell's own dashboard, §1.12-ter's
scheduler changes it on its own, and a panel shows up the moment someone plugs in a cable.

And it does a third job that used to be MQTT's LWT: **availability**. If `get_states` fails, the
entities go unavailable. That comes free from polling, whereas with MQTT you had to configure a
last-will message - one more piece that could be left unconfigured.

## Why 30 s and not 5

Almost everything that changes fast arrives pushed. Polling more often would punish the doorbell
to refresh things that almost never move, and `esp_http_server` **serves one request at a time**:
a slow request leaves the whole device unable to answer anything else while it runs. That effect
was already measured with the recordings listing, where a 0.31 s `/api/device_id` went up to 22.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import api
from .const import DOMAIN, POLL_INTERVAL, generic_name

_LOGGER = logging.getLogger(__name__)


# ==================================================================================================
# THE SLOW SOURCES (1.3.0, Phase 1 of the parity plan)
#
# Everything an entity reads that `get_states` does not carry. Three rules, and each is load-bearing:
#
# 1. A source is read ONLY WHILE AN ENTITY WANTS IT (`want()`, called from `async_added_to_hass`).
#    A disabled entity is never added, so the memory/boot diagnostics - disabled by default - cost
#    the doorbell NOTHING until someone enables one. `esp_http_server` serves one request at a time
#    (§1.0-quinquies): a request nobody looks at still delays one somebody needs.
# 2. ONE request per source per `every` polls, whatever the number of entities reading it. Adding an
#    entity never adds a request.
# 3. `admin` sources are not even asked for with a `user` pairing: the doorbell would answer 403 every
#    time. Their entities go unavailable instead (entity.py), which is what "you may not" looks like.
# ==================================================================================================


@dataclass(frozen=True)
class Source:
    path: str
    every: int            # polls (x POLL_INTERVAL s) between reads
    admin: bool = False   # the doorbell refuses it to a `user` pairing


SOURCES: dict[str, Source] = {
    "storage": Source("/api/storage_info", 10),                # SD card, ~5 min
    "detect": Source("/api/detect_config", 10),                # detection per class
    "img": Source("/api/img_settings", 10, admin=True),        # exposure
    "mode_rules": Source("/api/mode_rules", 10, admin=True),   # why the mode is what it is
    "mem": Source("/api/mem_stats", 10),                       # memory (disabled by default)
    "boot": Source("/api/debug/boot", 20),                     # reset reason (disabled by default)
}


class DoorbellCoordinator(DataUpdateCoordinator[dict]):
    """One doorbell. `data` is `get_states` with `firmware_info` mixed into it."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        device_id: str,
        credential: str,
        session: aiohttp.ClientSession,
        address: str | None = None,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{device_id}",
            update_interval=timedelta(seconds=POLL_INTERVAL),
            # `config_entry` stopped being optional: without it, Home Assistant warns, and on
            # newer versions refuses to build the coordinator.
            config_entry=entry,
        )
        self.device_id = device_id
        self.credential = credential
        # The doorbell's LAN address (net.py). Only for display (configuration_url); requests go
        # through the session, whose resolver already maps the name to it.
        self.address = address
        # THIS entry's session, with the resolver that tries the local address before public DNS
        # (net.py). Not the shared one: a resolver on that one would answer for every integration
        # on this Home Assistant.
        self._session = session
        # `firmware_info` is only asked for once in a while: the version does not change on its
        # own, and asking every 30 s would be one more request against a device that serves one
        # at a time. It refreshes after an OTA because the doorbell reboots and the next poll
        # fails, which resets this to zero. So the update is noticed without asking often.
        self._cycles_until_firmware = 0
        self._firmware: dict = {}
        # THIS credential's role on the doorbell ("admin"/"user"/"unknown", §3.3-ter) - this is
        # what the card is allowed to show (REC, hass_todo_en_la_integracion), never whether
        # whoever is looking at the dashboard is a HOME ASSISTANT administrator. Same cadence as
        # firmware_info: it does not change on its own, so asking every 30 s would be one more
        # request against a device that serves one at a time.
        self._cycles_until_role = 0
        self._role = "unknown"
        # The slow sources (see SOURCES): what was read, who wants it, and when it is due.
        self.extra: dict[str, dict] = {}
        self._wanted: dict[str, int] = {}
        self._due: dict[str, int] = {}
        self._kick: asyncio.Task | None = None
        self._source_lock = asyncio.Lock()

    @property
    def session(self) -> aiohttp.ClientSession:
        """This doorbell's session, for whoever has the coordinator and not hass.data."""
        return self._session

    async def _async_update_data(self) -> dict:
        try:
            state = await api.async_get_states(self._session, self.device_id, self.credential)
        except api.AuthenticationError as err:
            # ⚠️ A 401 on a credential that USED TO work is not a network failure: it means that
            # doorbell no longer recognises this integration - factory reset, revocation, or the
            # slot evicted by age (§1.5, 16 slots, the oldest goes). In all three cases the only
            # fix is re-pairing, so that is what is said instead of retrying in a loop.
            raise UpdateFailed(
                "The doorbell no longer recognises this integration: re-pair it"
            ) from err
        except api.DoorbellApiError as err:
            raise UpdateFailed(str(err)) from err

        if self._cycles_until_firmware <= 0:
            try:
                self._firmware = await api.async_get_firmware_info(
                    self._session, self.device_id, self.credential
                )
                self._cycles_until_firmware = 20     # ~10 minutes
            except api.DoorbellApiError:
                # Not a reason to leave the entities without data: `get_states` already answered,
                # so the doorbell is alive. Retried on the next cycle.
                _LOGGER.debug("Could not read firmware_info; will retry", exc_info=True)
        else:
            self._cycles_until_firmware -= 1

        if self._cycles_until_role <= 0:
            role = await api.async_get_role(self._session, self.device_id, self.credential)
            # "unknown" is ALSO what a failed read returns (api.async_get_role never raises). Once
            # the doorbell has said admin or user, a failed read must not turn every admin control
            # unavailable for ten minutes: a role never goes back to "unknown" on its own.
            if role != "unknown" or self._role == "unknown":
                self._role = role
            self._cycles_until_role = 20     # ~10 minutes, same as firmware_info
        else:
            self._cycles_until_role -= 1

        previous_mode = (self.data or {}).get("m")
        async with self._source_lock:
            for name in list(self._wanted):
                due = self._due.get(name, 0) - 1
                # The mode changed since the last poll (the doorbell's own dashboard, its
                # scheduler): the reason travels with it, so it is read now, not in five minutes.
                if (name == "mode_rules" and previous_mode is not None
                        and state.get("m") != previous_mode):
                    due = 0
                self._due[name] = due
                if due <= 0:
                    await self._read_source(name)

        # Mixed into a single dict so the entities do not have to know which of the two routes
        # each field comes from. `get_states` wins: if the two ever returned the same key, the
        # state one is the one refreshed every 30 s.
        return {**self._firmware, **state}

    # -- the slow sources ------------------------------------------------------------------------

    async def _read_source(self, name: str) -> None:
        source = SOURCES[name]
        self._due[name] = source.every
        if source.admin and self._role != "admin":
            self.extra.pop(name, None)
            return
        try:
            self.extra[name] = await api.async_get_json(
                self._session, self.device_id, self.credential, source.path
            )
        except api.NotAllowedError:
            self.extra.pop(name, None)
        except api.DoorbellApiError:
            # Kept as it was: one failed read of a slow source is not a reason to blank the SD card
            # or the thresholds. Retried on the next poll instead of in five minutes.
            _LOGGER.debug("Could not read %s; will retry", source.path, exc_info=True)
            self._due[name] = 1

    @callback
    def want(self, name: str) -> Callable[[], None]:
        """An entity reads source `name` from now on. Returns the undo (for async_on_remove)."""
        self._wanted[name] = self._wanted.get(name, 0) + 1
        if name not in self.extra and self._kick is None:
            # Read at once, not at the next poll: without this every new entity would show
            # "unavailable" for up to 30 s after a restart. ONE task for all the entities being
            # added in the same moment (they arrive one by one while the platforms set up).
            # Tied to the entry: cancelled if the entry unloads before it runs.
            self._kick = self.config_entry.async_create_task(
                self.hass, self._async_kick(), f"{self.name}_first_read"
            )

        @callback
        def _undo() -> None:
            count = self._wanted.get(name, 0) - 1
            if count <= 0:
                self._wanted.pop(name, None)
            else:
                self._wanted[name] = count

        return _undo

    async def _async_kick(self) -> None:
        try:
            await asyncio.sleep(0.2)
            if not self.last_update_success:
                return
            async with self._source_lock:
                for name in list(self._wanted):
                    if name not in self.extra:
                        await self._read_source(name)
            self.async_update_listeners()
        finally:
            self._kick = None

    async def async_refresh_source(self, name: str) -> None:
        """Read one source now (after a write, or when the webhook says it changed)."""
        async with self._source_lock:
            await self._read_source(name)
        self.async_update_listeners()

    # -- writes: always the doorbell's own validation, always read back ---------------------------

    @staticmethod
    def _write_error(err: api.DoorbellApiError, what: str) -> HomeAssistantError:
        if isinstance(err, api.NotAllowedError):
            return HomeAssistantError(
                f"This pairing is not an administrator of the doorbell, so it cannot change {what}. "
                "Re-pair it from an administrator account."
            )
        return HomeAssistantError(f"Could not change {what}: {err}")

    async def async_save_states(self, fields: dict[str, str], what: str) -> None:
        """PARTIAL `save_states`, then the doorbell's state read back and published at once.

        ⚠️ Read back, never assumed: `save_states` ignores a field it does not accept WITHOUT an
        error status (§1.2), so only the read-back tells "applied" from "silently dropped". A field
        the doorbell did not take fails the service call with a readable reason (same rule as the
        mode select, 0.7.4). And only the fields that change go: sending the whole state would turn
        a reading up to 30 s old into a write that stomps what someone else just changed.
        """
        try:
            answer = await api.async_save_states(
                self._session, self.device_id, self.credential, fields
            )
        except api.DoorbellApiError as err:
            raise self._write_error(err, what) from err
        refused = (answer or {}).get("refused")
        try:
            state = await api.async_get_states(self._session, self.device_id, self.credential)
        except api.DoorbellApiError:
            await self.async_request_refresh()
            state = None
        if state is not None:
            self.async_set_updated_data({**(self.data or {}), **state})
        if refused:
            raise HomeAssistantError(f"The doorbell refused {what}: {refused}")
        if state is not None:
            for key, sent in fields.items():
                got = state.get(key)
                if got is None:
                    continue
                if str(got) != str(sent) and not _same_number(got, sent):
                    raise HomeAssistantError(
                        f"The doorbell did not apply {what} (it reports {key}={got})."
                    )

    async def async_save_detect(self, fields: dict[str, str], what: str) -> None:
        """POST /api/detect_config, then read it back (the entities show what the doorbell has)."""
        try:
            await api.async_post_detect_config(
                self._session, self.device_id, self.credential, fields
            )
        except api.DoorbellApiError as err:
            raise self._write_error(err, what) from err
        await self.async_refresh_source("detect")

    async def async_save_img(self, fields: dict[str, str], what: str) -> None:
        """POST /api/img_settings, then read it back."""
        try:
            await api.async_post_img_settings(
                self._session, self.device_id, self.credential, fields
            )
        except api.DoorbellApiError as err:
            raise self._write_error(err, what) from err
        await self.async_refresh_source("img")

    # -- helpers several entities use -----------------------------------------------------------

    @property
    def doorbell_name(self) -> str:
        """`dname`, and if the doorbell has no name, the firmware's own generic one.

        Empty means "nobody has named it", not a name (§1.4-ter): stomping what the client already
        had with that would leave it worse than before. And the generic name - never the bare id
        (Inaki, 2026-09-26) - is the same one the firmware uses for its mDNS instance when it too
        has no name, see `generic_name`.
        """
        return (self.data or {}).get("dname") or generic_name(self.device_id)

    @property
    def role(self) -> str:
        """"admin" / "user" / "unknown" - this pairing's role on the doorbell (§3.3-ter).

        What the card is allowed to show (get_connection_info, websocket_api.py) - not a live
        signalling field, refreshed on the same slow cadence as firmware_info, but the SAME
        `paired_app_role[]` lookup the doorbell does for `session_info.role`.
        """
        return self._role

    @property
    def has_lock(self) -> bool:
        """`door_m=2` is "none" (§1.2).

        With that, the open button **is not drawn** (§1.4-ter). Before `door_m` was carried, a
        client could only find out by **failing**: it offered the button, got a
        `no_lock_configured`, and only then hid it - so the first user of every session saw a
        button that does not work, and on a video doorbell that is exactly the button that cannot
        disappoint.
        """
        return (self.data or {}).get("door_m", 2) != 2


def _same_number(a, b) -> bool:
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False

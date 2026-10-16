"""The doorbell's link to OUR cloud (the relay), as the DOORBELL reports it (1.7.0).

## Why Home Assistant needs this at all

Home Assistant reaches the doorbell over the LAN, so a doorbell that lost its cloud link looks
perfectly healthy here - while every phone outside the house can no longer see it, and the apps
get "<doorbell> offline". On 2026-10-16 the owner got that push while at home and nothing in Home
Assistant could confirm or deny it.

## Why the doorbell is the source, not the VPS

The product's first principle: what happens inside the house keeps working without internet or
without our VPS. Asking the VPS "is my doorbell connected to you?" would make this sensor depend on
the very link it is reporting on, and would send the house's state to a server for no reason. The
doorbell knows the answer locally (its own WebSocket client), and `get_states` is polled anyway.

Firmware contract (API_CONTRACT §1.2, firmware addition): `cloud` (1 = connected to the relay,
0 = not) and `cloud_s` (seconds since `cloud` last changed). Both ABSENT on older firmware: then
the entity is unavailable and no event is ever fired - never a guessed value.

## The same rules as the apps' push, so both tell the same story

- "lost" only after the link has been down for LOST_AFTER_S (90 s, the relay's grace): a deploy of
  the relay or a WiFi hiccup is not an outage for a person.
- "restored" only after it has held for RESTORED_AFTER_S (60 s, the relay's stability window): a
  flapping link is ONE outage, one lost + one restored.
- "restored" is fired ONLY for an outage this tracker knew about (paired with "lost").
  The one exception is deliberate: an outage already past its grace at the FIRST reading (Home
  Assistant restarted during it) fires no "lost" - that would re-announce an old fact on every
  restart - but it is remembered, so its end IS announced.
"""
from __future__ import annotations

LOST_AFTER_S = 90
RESTORED_AFTER_S = 60

EV_LOST = "cloud_link_lost"
EV_RESTORED = "cloud_link_restored"


class CloudLinkTracker:
    """Pure state machine fed by every `get_states` poll. No Home Assistant objects in here."""

    def __init__(self) -> None:
        self.supported = False        # the firmware reports `cloud` / `cloud_s`
        self.connected: bool | None = None
        self.lost = False             # an outage is open (lost announced, or seen past its grace)
        self._down_at: float | None = None

    def update(self, state: dict, now: float) -> tuple[str, dict] | None:
        """One poll. Returns `(event_type, attributes)` when an event must be fired, else None."""
        cloud = state.get("cloud")
        cloud_s = state.get("cloud_s")
        if (cloud not in (0, 1) or isinstance(cloud, bool)
                or not isinstance(cloud_s, (int, float)) or isinstance(cloud_s, bool)):
            self.supported = False
            return None
        first = not self.supported and self.connected is None
        self.supported = True
        cloud_s = max(0.0, float(cloud_s))
        changed_at = now - cloud_s

        if cloud == 0:
            if self._down_at is None:
                self._down_at = changed_at
            if self.lost:
                self.connected = False          # still the same outage (or it flapped back)
                return None
            if cloud_s < LOST_AFTER_S:
                # Inside the grace: not an outage yet for anybody.
                self.connected = True if self.connected is None else self.connected
                return None
            self.lost = True
            self.connected = False
            if first:
                return None                     # see the module header
            # How long it has been down CONTINUOUSLY, as the doorbell counts it.
            return EV_LOST, {"offline_s": int(round(cloud_s))}

        # cloud == 1
        if self.lost:
            if cloud_s < RESTORED_AFTER_S:
                self.connected = False          # back, but not for long enough yet
                return None
            offline_s = int(round(changed_at - (self._down_at if self._down_at is not None
                                                 else changed_at)))
            self.lost = False
            self._down_at = None
            self.connected = True
            return EV_RESTORED, {"offline_s": max(0, offline_s)}
        self._down_at = None
        self.connected = True
        return None

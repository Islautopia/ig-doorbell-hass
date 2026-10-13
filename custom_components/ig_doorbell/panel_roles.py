"""Which wall panel loads the live video by itself on a ring (1.6.0, docs/design/panel-roles.md).

A house with several wall panels: on a ring ALL of them show the call, and ONE - the primary -
loads the live stream by itself. The others show a still picture and a "View" button. The doorbell
serves four viewers at most and each one costs it; three tablets loading on every ring is a load
it may not afford.

This module is the whole decision and nothing else: no Home Assistant import, no clock of its own
(the caller passes `now`), so every rule here is a unit test.

## The rules

1. ORDER. The declared primary first, then the other picked panels in the order of the stored
   list. Panels Home Assistant knows are gone (no registration, disabled) are left out by the
   caller BEFORE the order is built - so the next one is first, with no wait.
2. ONE HOLDER PER CALL, SET ONCE. The holder is the only panel ever told to load by itself for
   that call. It is never changed afterwards: that is what makes "never two" true by construction.
3. WHO BECOMES THE HOLDER. A panel "reports in" when its page asks about the call (the only proof
   Home Assistant has that a tablet is there: the companion app has no online state).
   - The first panel of the order reports in -> it is the holder, at once.
   - Until PRIMARY_GRACE_S after the ring, any other panel that reports in waits (still picture).
   - At PRIMARY_GRACE_S with no holder: the first panel IN THE ORDER among those that reported in.
   - After that with no holder: the first panel to report in.
   So there is a holder as soon as one panel is known to be there and the primary had its chance.
4. NOT CONFIGURED (LEGACY). Options written before 1.6.0 have no primary stored: every panel
   loads and nothing is told to any page, exactly as before - nothing changes on upgrade. Saving
   the Ring notifications step stores a primary (the form proposes the first panel; with one
   panel it is that one) and the roles apply from then on.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

# How long the first panel of the order has to report in before the role may pass to another one.
# A page already on screen reports in well under 2 s; a screen that had to be woken, 2-5 s. The
# ring itself lasts ~15 s, so a longer wait would hand the video over when the call is nearly gone.
PRIMARY_GRACE_S = 6.0

AUTO = "auto"          # load the live stream by yourself
STANDBY = "standby"    # show the still picture and the "View" button


def effective_primary(panels: Iterable[str] | None, primary: str | None) -> str | None:
    """The primary the options MEAN, or None when the roles are not configured (legacy).

    - no panel: None.
    - nothing stored (`primary` is None: options from before 1.6.0): None = legacy, with one
      panel or with several. Nothing changes on upgrade until the owner saves the options step.
    - a stored primary that is one of the panels: it.
    - a stored primary that is NOT one of them (removed from the list later, or stored empty):
      the first of the list - a declared intent to have ONE loader is kept, never widened back
      to "all".
    """
    panels = [p for p in dict.fromkeys(panels or []) if p]
    if not panels or primary is None:
        return None
    return primary if primary in panels else panels[0]


def declared_order(panels: Iterable[str] | None, primary: str | None) -> list[str]:
    """The fallback order: the primary first, then the rest as stored. No duplicates."""
    panels = [p for p in dict.fromkeys(panels or []) if p]
    first = effective_primary(panels, primary)
    if first is None:
        return panels
    return [first] + [p for p in panels if p != first]


def form_default_primary(panels: Iterable[str] | None, primary: str | None) -> str | None:
    """What the options form shows in "Main panel": the stored one, else the first of the list."""
    panels = [p for p in dict.fromkeys(panels or []) if p]
    if not panels:
        return None
    return primary if primary in panels else panels[0]


def primary_to_store(panels: Iterable[str] | None, submitted: str | None) -> str | None:
    """What a SAVED form stores: always a primary when there are panels (the migration point).

    An empty or foreign field becomes the first panel of the list, so a saved form never leaves
    a house with several panels in legacy mode.
    """
    return form_default_primary(panels, submitted or None)


@dataclass
class CallRoles:
    """The roles of ONE call. `order` holds only panels that can be reached at all."""

    order: list[str]
    ring_at: float
    legacy: bool = False
    grace_s: float = PRIMARY_GRACE_S
    holder: str | None = None
    reported: list[str] = field(default_factory=list)

    def role(self, panel: str) -> str | None:
        """What `panel` is told right now, without reporting it in. None = not a panel here."""
        if panel not in self.order:
            return None
        if self.legacy:
            return AUTO
        return AUTO if panel == self.holder else STANDBY

    def claim(self, panel: str, now: float) -> str | None:
        """`panel`'s page reports in for this call. Returns what it is told."""
        if panel not in self.order:
            return None
        if self.legacy:
            return AUTO
        if panel not in self.reported:
            self.reported.append(panel)
        if self.holder is None and (panel == self.order[0] or now - self.ring_at >= self.grace_s):
            # After the grace: the best ranked of those that reported in. Normally that is this
            # panel (tick() already served anyone who reported before); if the tick ran late it
            # may be another one - the caller tells the holder whenever it changed.
            self.holder = panel if panel == self.order[0] else self._best_reported()
        return self.role(panel)

    def tick(self, now: float) -> str | None:
        """Called at the end of the grace. Returns the panel PROMOTED now (to be told), or None."""
        if self.legacy or self.holder is not None or now - self.ring_at < self.grace_s:
            return None
        self.holder = self._best_reported()
        return self.holder

    def _best_reported(self) -> str | None:
        return next((p for p in self.order if p in self.reported), None)

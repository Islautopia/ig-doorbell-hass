"""Quick replies and sequences at the street, over `POST /api/call_action` (1.4.0, API_CONTRACT §1.4-quinquies).

Shared by the quick-reply `select` + `button` and the `play_sequence` / `play_audio` actions, so the three can
never disagree about what a name means or what an error says.

## Why HTTP now and no longer the signalling channel (1.4.0)

Until 1.3.0 these travelled as signalling messages over a throw-away SSE session (the old signal_client.py),
because the doorbell had no HTTP route for them. Firmware 0.103.1 added one (Iñaki's decision Dec-2 of the parity
plan): the same firmware functions, no session slot taken, and an answer in one round trip. Older firmware answers
404 there, which is said as "update the doorbell's firmware" -- never as "no such sequence".

## What a failure says

Failures are raised, never swallowed: someone may be waiting at the door, and an action that "succeeds" without
playing anything is the silent no-op this project refuses.
"""
from __future__ import annotations

from homeassistant.exceptions import HomeAssistantError

from . import api
from .coordinator import DoorbellCoordinator

# What the doorbell's refusals mean to the person who ran the action (§1.4-quinquies).
ERRORS = {
    "not_found": "That sequence no longer exists on the doorbell.",
    # Firmware with the "on demand, only quick replies" rule (API_CONTRACT §1.18.10 §1-bis): the sequence is
    # there, it is just not launchable until it is marked. Said with the remedy, never as a bare HTTP 422.
    "not_quick_reply": (
        "That sequence is not a quick reply: mark it as a quick reply on the doorbell "
        "- hidden if you do not want it offered during calls."
    ),
    "bad_seq_id": "That is not a valid sequence id.",
    "empty_slot": "That quick-reply slot has no audio.",
    "bad_slot": "Quick-reply slot out of range (1-10).",
    "busy": "The doorbell is already playing something; try again in a moment.",
    "store_not_ready": "The doorbell is still starting up; try again in a moment.",
    "no_sd": "The doorbell has no usable SD card, so it cannot record.",
    "firmware_too_old": "The doorbell's firmware is too old for this (it needs 0.103.1 or newer).",
}


# The list a script may name a sequence from: the quick replies AND the hidden ones (§1.18.8, `&hidden=1`).
# A firmware older than the hidden quick reply ignores the parameter and answers the plain list.
PATH_QUICK = "/api/sequences?quick=1"
PATH_QUICK_WITH_HIDDEN = "/api/sequences?quick=1&hidden=1"


def items_of(answer: object, with_hidden: bool) -> list[dict]:
    """The quick replies of a `?quick=1` answer (`id`, `label`), valid entries only, in the doorbell's order.

    A HIDDEN quick reply (`hidden: true`) is a sequence its owner wants launchable from a script and NOT
    offered to a person during a call. So it is only returned when `with_hidden` is asked - which only the
    name resolution of the `play_sequence` action does. Everything a person picks from goes without.
    """
    items = answer.get("quick_replies") if isinstance(answer, dict) else None
    out = []
    for item in items if isinstance(items, list) else []:
        if not (isinstance(item, dict) and isinstance(item.get("id"), int)):
            continue
        if item.get("hidden") is True and not with_hidden:
            continue
        out.append({"id": item["id"], "label": str(item.get("label") or f"#{item['id']}")})
    return out


def quick_list(coordinator: DoorbellCoordinator) -> list[dict]:
    """The VISIBLE quick replies as last read: what the select and the button offer."""
    return items_of(coordinator.extra.get("quick"), with_hidden=False)


def option_labels(items: list[dict]) -> dict[str, int]:
    """label -> id for a select. Two quick replies with the same label get their id appended, so every option
    is unambiguous (a select keyed by a label that matches two sequences would play whichever came first)."""
    counts: dict[str, int] = {}
    for item in items:
        counts[item["label"]] = counts.get(item["label"], 0) + 1
    return {(i["label"] if counts[i["label"]] == 1 else f"{i['label']} ({i['id']})"): i["id"] for i in items}


def resolve_name(items: list[dict], name: str) -> int:
    """A quick reply by its label (case- and surrounding-space-insensitive), or by `#<id>` / a bare number."""
    wanted = name.strip().casefold()
    if wanted.lstrip("#").isdigit():
        return int(wanted.lstrip("#"))
    matches = [i["id"] for i in items if i["label"].strip().casefold() == wanted]
    if not matches:
        # also the disambiguated "label (id)" the select shows
        by_option = {k.casefold(): v for k, v in option_labels(items).items()}
        if wanted in by_option:
            return by_option[wanted]
        raise HomeAssistantError(f"The doorbell has no quick reply called '{name.strip()}'.")
    if len(matches) > 1:
        raise HomeAssistantError(
            f"Several quick replies are called '{name.strip()}'; use its id instead ({', '.join(map(str, matches))})."
        )
    return matches[0]


async def async_run(coordinator: DoorbellCoordinator, action: str, params: dict[str, str]) -> dict:
    """POST /api/call_action and turn every refusal into a readable HomeAssistantError."""
    try:
        return await api.async_call_action(
            coordinator.session, coordinator.device_id, coordinator.credential, action, params
        )
    except api.NotAllowedError as err:
        raise HomeAssistantError(
            "This pairing is not an administrator of the doorbell, so it cannot do that."
        ) from err
    except api.CallActionError as err:
        raise HomeAssistantError(ERRORS.get(err.code, f"The doorbell refused: {err.code}")) from err
    except api.DoorbellApiError as err:
        raise HomeAssistantError(f"The doorbell did not take the command: {err}") from err


async def async_play_sequence(coordinator: DoorbellCoordinator, seq_id: int) -> None:
    await async_run(coordinator, "play_sequence", {"seq_id": str(seq_id)})


async def async_play_audio(coordinator: DoorbellCoordinator, slot: int) -> None:
    await async_run(coordinator, "play_audio", {"audio_slot": str(slot)})

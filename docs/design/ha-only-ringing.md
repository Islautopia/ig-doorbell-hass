# Design: ringing with Home Assistant only (no IG Doorbell app)

Status: **design, 2026-09-27** — integration 1.2.0 + firmware 0.101.3. Measured / believed marks
are explicit; anything not measured on a device says so.

## The goal

Two households, neither with our app installed:

1. **A phone with only the Home Assistant companion app** (iOS or Android): when someone rings,
   the phone must ring like a doorbell, show who is there, let the owner open the call page (video +
   talk) or open the door, and **stop ringing everywhere once somebody has dealt with the call**.
2. **A wall panel running the companion app** (Android tablet, or an iPad): on a ring the panel
   wakes, shows the doorbell full-screen, chimes, and **goes back to its dashboard** when the call
   is over.

Iñaki, 2026-09-27: *"IG Doorbell will be the first video doorbell that gives them a really good
video-doorbell experience in HA."* And the product rule: *configure in one place*.

## Decision: the integration sends the notifications itself (no automation, no blueprint)

Configured in **Settings → Devices & services → IG Doorbell → Configure → Ring notifications**:
pick phones, pick panels, two switches. Nothing else to write.

| option considered | verdict | why |
|---|---|---|
| **Built into the integration** (options flow) | **chosen** | One place to configure (product rule). Fixes to payloads ship with the integration — iOS/Android companion keys change and a copied YAML never learns. The call lifecycle (per-call tag, which devices were notified, clear on resolution, panel returns home, a safety timeout, "open door" valid only during the ring) is **state**, which is trivial in Python and fragile in YAML. The integration already holds the doorbell credential, so "Open door" needs no second automation. |
| Blueprint shipped by the integration | rejected | A copied blueprint is the user's file: it does not update with the integration, and overwriting it on update would destroy their edits. Clearing everywhere needs a second automation keyed on `call_id`, the notification-action handler a third. Three YAML pieces to keep in sync with a firmware that evolves — the "stale on its own" failure this project keeps hunting. |
| Documentation only (write your own automation) | kept **as well**, not instead | HA convention: power users compose. So everything the built-in notifier uses is **also exposed as entities**: the `event` entity (ring + the new call resolutions) and the new `image` entity. Anyone can ignore the built-in notifier (it is off until devices are picked) and write their own — e.g. Iñaki's existing "Llaman al timbre". |

Off by default: with no phone and no panel picked, nothing changes for anyone upgrading. This
matters for Iñaki's own HA, which already has a working automation to the salon panel — enabling
the built-in path there is his decision, and would double the chime until the old automation is
disabled (the options step says so).

## What the doorbell must tell Home Assistant: the call's resolution (firmware 0.101.3)

Today HA gets `ring` and nothing more: `call_answered/declined/missed` (n 6/7/8) are history-only
and refused on the webhook too (API_CONTRACT §3.6.7). Without the resolution HA cannot clear a
notification or send a panel home.

**Change**: the three resolution events go to **Home Assistant's webhook** (never to the relay),
with **exactly the envelope the history stores** (§3.6.1 fields, `call_id` on top, `d.by` when
known, `d.reason:"quick_reply"` for a quick reply, `rec` inherited from the ring).

Why these and not a new `call_resolved` type on the HA wire:
- It is the dialect HA already reads twice: the webhook (§4, "the §3.6.1 envelope without changing a
  comma") and the history the card lists (`GET /api/events`, same `ev` values). A `call_resolved`
  envelope would be a fifth shape for the same fact.
- The reason 6/7/8 stay off the relay wire — the relay generates its own and pushes them — **does
  not apply to HA**: HA pushes nothing on its own. The relay keeps getting its separate
  `{"type":"call_resolved"}` (0.101.2), unchanged.
- For automation writers `call_missed` / `call_answered` read better than `call_resolved` +
  `reason`.

Every resolution path already goes through one point (`webrtc_call_ended_ex` →
`evento_llamada_resuelta`), including the relay's `call_declined` (a phone with our app declined)
— HA needs that one too, to stop its own notifications. Sent from the HA webhook task's own queue
(`hass_encolar`), which never blocks the caller: safe from the audio task.

## Integration pieces (1.2.0 — a new function: middle digit)

### 1. `event` entity: three more known types
`call_answered`, `call_declined`, `call_missed` added to the listed types (unknown ones were already
accepted). Attributes carry `call_id`, `by`, `reason`.

### 2. `image` entity "Visitor" (new)
On each `ring`, the integration fetches `GET /api/snapshot?for=alert` from the doorbell (LAN,
never the VPS) and exposes it as `image.<doorbell>_visitor`.
- `403 call_snapshot_disabled` (the owner's `call_snap` = 0): **no image**, the entity is cleared,
  no retry. `503`: no image, no retry (§3.5: never delay the ring for a picture).
- Kept **in RAM only**, one frame, replaced on the next ring, gone on restart. Never written to
  disk by us. (HA's recorder stores the entity's state — a timestamp — not the picture.)
- The notification points at `/api/image_proxy/image.<…>`, the path the companion docs give for
  image entities. The notification is sent **at once**; the phone fetches the picture a moment
  later, and the entity awaits the in-flight fetch (bounded, 4 s), so the ring is never delayed.

**Privacy, said plainly (principle 2):** the picture does **not** travel through Apple's or
Google's push service — the push carries text and a URL; the phone downloads the picture **from
the owner's own Home Assistant**. It transits HA's memory and is kept by the companion app with the
notification on the owner's phone. Nothing is stored on any server of ours.

### 3. The ring notifier (new, `notify_ring.py`)
Targets are **companion-app devices** picked with HA's device selector (`integration: mobile_app`);
the notify service is resolved from the registration at send time (a renamed phone keeps working).

Per `ring` with a `call_id` (tag = `igd_<device_id>_<call_id>`, so each call is its own
notification and its resolution clears exactly that one):

| target | on ring | on resolution |
|---|---|---|
| **iPhone** | `interruption-level: critical` + critical sound at full volume (if "ring through silent mode" is on, else `time-sensitive`); picture; tap → call page; actions: **Open call**, **Open door** (`authenticationRequired`: needs Face ID) | `clear_notification` by tag; a missed call is **replaced** by a quiet "Missed call" (same tag, `passive`, no sound) |
| **Android phone** | `ttl: 0`, `priority: high`, channel `alarm_stream` (rings through silent mode) or a high-importance "Doorbell" channel; picture; tap → call page; actions **Open call**, **Open door**; `car_ui: true` | `clear_notification`; missed → replaced, `alert_once` |
| **Android panel** | `command_screen_on`, then `command_webview` → call page full-screen, plus a chime notification | chime cleared, `command_webview` back to the panel's dashboard (configurable path; empty = the app's home) |
| **iPad panel** | iOS cannot navigate the app remotely. Notification (time-sensitive, sound) whose tap opens the call page; recommended setup is the call page left open in Guided Access, where the card itself wakes on the ring | cleared / replaced as iPhone |

Safety net: if no resolution arrives in **120 s** (a firmware before 0.101.3, a lost webhook),
panels are sent home anyway. Phones' notifications are left as they are (the outcome is unknown,
and inventing "missed" would be a false statement).

Texts are in the doorbell owner's language (the envelope's `lang`), in the six product languages,
English fallback — what the family reads, so it is translated (CLAUDE.md language rule).

**"Open door" from a notification** (listens to `mobile_app_notification_action`):
- Only while that call is live (≤ 3 min after its ring and before its resolution): a stale
  notification must never open the door hours later.
- Only offered when the doorbell has a lock (`door_m != 2`), same rule as the button.
- Uses the same LAN call as the button. A failure is **reported back** with a notification to the
  phones ("Could not open the door"), never swallowed (§1.8).
- The action carries `authenticationRequired: true`: iOS asks for Face ID first. **Whether the
  Android companion honours it from the lock screen is not measured** — if it does not, anyone
  holding a locked phone could open the door. Measured first on the M23; until then the option is
  **off by default** and its description says why.

Quick replies from the notification: **not in 1.2.0**. Android allows three actions, and a quick
reply without seeing who is there is a poor fit; the call page already has them. Candidate for iOS
(up to 10 actions) later.

### 4. The call page (new): `/ig-doorbell?device=<device_id>`
A frontend panel registered by the integration, **hidden from the sidebar**, not admin-only: the
card full-screen for one doorbell, with a close button back to the previous page / home. It is what
notifications and panels open, so **nobody has to build a dashboard view** for this to work.
The card already has the wall-panel behaviour (wake lock, idle pause lifted by a ring, sound on
ring).

## What the platform does NOT allow, said plainly

- **Push to a phone needs internet** (Apple/Google) — *except* when the companion's **local push**
  (iOS, on the home Wi-Fi SSID) or **persistent connection** (Android) is active: then the ring
  arrives over the LAN with the internet down. *Believed from the companion docs; to be measured.*
- **Outside the house** the notification arrives, but opening the call page or the picture needs
  remote access to HA (Home Assistant Cloud or your own proxy). Without it: text only.
- **Talking needs a secure page** (browser rule): the integration's HTTPS (docs/https.md) or
  Home Assistant Cloud. On `http://` the call page shows video but no microphone.
- **iOS has no CallKit screen** for companion notifications: a critical alert is the best there is,
  and the user must allow *Critical Alerts* for the companion app. iOS custom sounds must be
  imported into the companion app first; the default critical sound is used otherwise.
- **iOS `clear_notification` is a silent push** that iOS may throttle when the app has not been used
  recently: clearing is best-effort there. *To be measured on Iñaki's iPhone.*
- **Android `command_webview`** needs "Display over other apps" for the companion; without it the
  command silently falls back to a plain notification (lived on the salon panel). The setup guide
  and the options step both say it.
- **iPad cannot be woken into a page remotely**; see the table above.

## Principle 1 (LAN without internet)
Doorbell → HA webhook, HA → doorbell snapshot and open door: all LAN. The panel path works with no
internet (local push / persistent connection). Phones: see above.

## Tests
- Integration (pytest, harness image): envelope → notify calls per OS/role (payload keys asserted),
  resolution clears by the same tag, missed replaced, panel sent home, safety timeout, stale "open
  door" refused, open-door failure reported, 403 → no image, options kept across steps. Mutants in
  `tools/mutants.py` for each rule (tag mismatch, no clear, stale action accepted, critical dropped,
  403 ignored).
- Docker HA: a fake doorbell posting envelopes to the real webhook; mobile_app registrations faked.
- Waveshare (COM10): 0.101.3 posts `call_answered/declined/missed` to HA; control 0.101.2 posts none.
- Devices (need Iñaki): M23 (Android phone), iPhone, salon Galaxy Tab (Android panel), iPad (iOS
  panel). Exact steps are in the hand-off to the coordinator.

## Not in scope
Quick-reply actions; custom sound upload; a CallKit-grade call screen (needs our app).

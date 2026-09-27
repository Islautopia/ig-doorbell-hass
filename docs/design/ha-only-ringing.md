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

The product goal (2026-09-27): *"IG Doorbell will be the first video doorbell that gives them a really good
video-doorbell experience in HA."* And the product rule: *configure in one place*.

## Decision: the integration sends the notifications itself (no automation, no blueprint)

Configured in **Settings → Devices & services → IG Doorbell → Configure → Ring notifications**:
pick phones, pick panels, two switches. Nothing else to write.

| option considered | verdict | why |
|---|---|---|
| **Built into the integration** (options flow) | **chosen** | One place to configure (product rule). Fixes to payloads ship with the integration — iOS/Android companion keys change and a copied YAML never learns. The call lifecycle (per-call tag, which devices were notified, clear on resolution, panel returns home, a safety timeout, "open door" valid only during the ring) is **state**, which is trivial in Python and fragile in YAML. The integration already holds the doorbell credential, so "Open door" needs no second automation. |
| Blueprint shipped by the integration | rejected | A copied blueprint is the user's file: it does not update with the integration, and overwriting it on update would destroy their edits. Clearing everywhere needs a second automation keyed on `call_id`, the notification-action handler a third. Three YAML pieces to keep in sync with a firmware that evolves — the "stale on its own" failure this project keeps hunting. |
| Documentation only (write your own automation) | kept **as well**, not instead | HA convention: power users compose. So everything the built-in notifier uses is **also exposed as entities**: the `event` entity (ring + the new call resolutions) and the new `image` entity. Anyone can ignore the built-in notifier (it is off until devices are picked) and write their own — e.g. an existing "when the bell rings" automation. |

Off by default: with no phone and no panel picked, nothing changes for anyone upgrading. This
matters for installations that already have a working bell automation to a panel — enabling
the built-in path there is the owner's decision, and would double the chime until the old automation is
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
  holding a locked phone could open the door. To be measured on an Android phone; until then the option is
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

### 5. Revised the same night (Iñaki, 2026-09-27): the stream rule, going home, speakers, a chime

- **Stream rule**: while the card is visible there is always a stream; when it is not visible the
  stream stops at once (the existing hide/off-screen `live_pause`). The integration's timeout no
  longer cuts the stream.
- **The timeout is repurposed**: the number entity keeps its id, unique id and value (so an owner's
  setting is kept) and is renamed *Back to the home page after*. After that long with nobody
  touching it, the card takes the screen to Home Assistant's default page. That is the user's
  `default_panel` in the frontend's `core` user data, then the system one, then the built-in `home`
  dashboard (all measured on HA 2026.9.3). For an unanswered call the time counts from the ring.
  An answered call (microphone/turn) never goes home while it lasts. On the default page itself the
  card stays, so there is no navigation loop. `0` means never. This replaces the notifier's
  `command_webview` back home and its "return path" option; the notifier only clears the panel's
  chime notice.
- **Speakers** (`announce.py`, off by default): Echo devices (official `alexa_devices`) play
  Amazon's doorbell chime through `send_sound` and speak through their `announce` notify entity.
  Other media players play our chime with `play_media(announce=true)`, plus `tts.speak` if there is
  a TTS engine. This coexists with users' own announcement automations: the options text says they
  will announce twice.
- **The IG Doorbell chime**: synthesized for the product (`tools/make_chime.py`, no third-party
  audio) and served at `/ig_doorbell/sounds/ig-doorbell-chime.mp3` without authentication, because
  speakers fetch it with no token. The call page plays it only when a ring arrives while the page
  is already open (an iPad kiosk); when the ring opened the page, the notification has already
  sounded. Android channel sounds and iOS notification sounds cannot be set from Home Assistant;
  the docs say how to set them by hand.

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
  recently: clearing is best-effort there. *To be measured on an iPhone.*
- **Android `command_webview`** needs "Display over other apps" for the companion; without it the
  command silently falls back to a plain notification (seen on a real wall panel). The setup guide
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
- Bench doorbell: 0.101.3 posts `call_answered/declined/missed` to HA; control 0.101.2 posts none.
- Devices: an Android phone, an iPhone, an Android wall tablet, an iPad (iOS
  panel). Exact steps are in the hand-off to the coordinator.

## Measured (2026-09-27)

- **Firmware 0.101.3 on the bench doorbell, against a real HA 2026.9.3** (its event entity's
  history, read-only): control 0.101.2 → the `ring` arrives and no resolution (the doorbell's own
  history had the `call_missed`); 0.101.3 → `call_missed`, and `call_answered` with `by` = the
  answering session's label, each with the ring's `call_id`.
- **Docker HA 2026.9.3 with real `mobile_app` registrations** (push_url pointed at a local
  recorder, so the payload is what the real mobile_app notify sends): per-OS payloads as designed,
  per-call tag, `clear_notification` to all four after `call_answered`, the missed-call replacement,
  the Android panel's `command_screen_on` / `command_webview` and its return path. The options
  flow works through the real UI API. The call page loads for the doorbell given in the URL even
  when the browser's saved card selection is another doorbell, and it leaves that saved choice alone.
  It is not in the sidebar and does not require admin. One run lost one recorded push; the recorder
  was writing without a lock. After adding the lock, 5 more ring/answer cycles recorded every push.
  *Believed*: the recorder was at fault, not HA.
- **Found on the way, fixed in 1.2.0**: with the doorbell switched off when HA starts, requests time
  out, and the timeout was not caught, so the entry ended in `setup_error`. HA does not retry that,
  so nothing would ever have rung until a manual reload. Every request in `api.py` now turns a
  timeout into a doorbell error.
- **Real Android 14 phone, real HA** (bench doorbell ringing): the ring arrived at once on
  `alarm_stream` with the picture (480x544, fetched by the companion through `image_proxy`), the
  per-call tag and the title/text as designed. **The clear and the missed-call replacement did NOT
  arrive for over a minute**: the phone, lying still, was in Doze (`deviceidle` mState=IDLE), and those
  two went as normal-priority pushes, which Firebase holds for a maintenance window. Fixed: every
  Android message goes `priority: high`, `ttl: 0` (`ANDROID_NOW`, with its reason next to it).
- **After the Doze fix, same phone, still in Doze**: the missed-call replacement arrived ~17 s
  after the ring (the ring runs 15 s), and the clear arrived ~2 s after the call was answered. The
  call page opened in the companion app showed the doorbell live, and *Close* went back to the
  default dashboard.
- **Startup race, fixed**: at a real restart with two doorbells, the second entry to register the
  call page's static route died with "method GET is already registered" (`setup_error`, not
  retried). The registration now runs under a lock, and a failure there can no longer take the entry
  down. Covered by a startup test with both entries in both orders. Control: without both defences,
  that test fails with the exact error seen on the installation.
- **iPhone, real HA, silent mode, Critical Alerts allowed** (single test pushes, then real rings):
  the critical alert sounds in silent mode, both `push.sound.critical` alone and our full ring
  payload. **With an Apple Watch worn, iOS delivers to the Watch and the iPhone stays silent** —
  Apple's routing, not our payload (same pushes, Watch off: the phone sounds). The picture works in
  every form that points at our picture: HA-relative `image` and `attachment`, and absolute
  URLs with a token over the public HTTPS name and over the LAN. (A third-party internet image did
  not show; not ours, not chased.) **The picture "never arrived" on a real missed ring because the
  "Missed call" replacement (same tag) had no picture and replaced the notice that had one.** Fixed:
  the replacement carries the picture of that same call, and none if a newer ring came in between.
  The ring now also waits, at most 1.5 s, for its picture (measured ready 0.8 s after the ring),
  because iOS downloads the attachment only once.
- **Android wall tablet (companion, real HA)**: ring → screen on, the call page full-screen and
  live; answered → back to the home dashboard ~5 s later; missed → back at the end of the ring;
  a ring with no resolution (as from a firmware before 0.101.3) → back at 120 s. The call is only
  answered when the microphone opens: opening the call page does not answer (measured on the
  doorbell's call status, iPhone case). **Not measured**: the iPad as a panel; whether Android asks
  to unlock before a notification action (the test phone has no lock), which is why "Open door"
  stays off by default.
- **Open items**: a call answered from an HA card shows `by` = the integration's pairing label,
  not the HA user who answered; quick replies from the notification.
- **Fixed on the way**: the missed-call time now uses the doorbell's `tz_name`, not HA's zone (the
  Docker HA was on UTC and showed the wrong hour).

## Not in scope
Quick-reply actions; custom sound upload; a CallKit-grade call screen (needs our app).

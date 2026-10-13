# Design: panel roles — one wall panel loads the live video, the others show the call

Status: **built in 1.6.0 (2026-10-13), measured on benches only.** Nothing here has run on a real
tablet yet; the last section says exactly what that leaves open.

## The problem

A house with Home Assistant and several wall tablets. Up to 1.5.4 every picked panel was sent to
the call page on each ring, and the call page always starts the live view: three tablets = three
video sessions on every ring, besides any phone. The doorbell serves four video viewers at most,
and each one costs it.

## The behaviour

- **All panels ring and show the call.** Nothing changes in who is notified.
- **One panel — the primary — loads the live video by itself.** The others show the visitor's
  **still picture**, a notice and a **View** button; the live video starts there only when someone
  taps it (the same page, no navigation).
- **Answered anywhere** (a phone, a panel): every panel page that is not the one talking **gives
  its video back** (hangs up its session), says "Answered on another device" and goes home
  (never when the owner set *back to the home page after* to 0 = never).
- **Declined / missed**: as before for a panel holding the video (its own *back to the home page*
  deadline); a panel showing only the still says "Call declined" / "Missed call" and goes home.

## Who decides: the integration, in one place

`panel_roles.py` holds the rules (no Home Assistant import, no clock: all of it is unit tests).
`notify_ring.py` applies them per call and builds the ONE answer a page ever gets,
`panel_instruction()`. The card decides nothing; it contributes the two facts only a page can know:
*a person tapped View here* and *this page is the one talking*.

### States

Per call: `ringing` → `answered` | `declined` | `missed` (the doorbell's events, §3.6.7) | `ended`
(no resolution after 120 s: outcome unknown, never invented).

Per panel and call, as told to its page (`stream`):

| `stream` | when | the page |
|---|---|---|
| `auto` | ringing, this panel is the holder | loads the live video |
| `standby` | ringing, another panel is (or may yet be) the holder | still picture + View |
| `release` | answered | hangs up unless it is talking; a page opened now shows the notice |
| `keep` | declined / missed / ended | leaves its stream alone; a still-only page says so, goes home |

### The fallback rule (explicit, and the whole of it)

1. **Order**: the declared primary, then the other panels in the order of the stored list.
2. **Known gone, left out before the ring**: a picked device that no longer exists, is not a
   companion app, or is disabled. The next one is then first, with no wait.
3. **One holder per call, set once, never changed** — "never two" by construction.
4. A panel **reports in** when its page asks about the call (`get_connection_info`, its
   subscription, or a page already listening when the ring arrives).
   - the first panel of the order reports in → it is the holder, at once;
   - before `PRIMARY_GRACE_S` (6 s) any other panel that reports in waits;
   - at 6 s with no holder → the best-ranked panel among those that reported in, and it is
     **told** (pushed) to load;
   - after 6 s with no holder → the first panel to report in.

So there is a holder as soon as a panel is known to be there and the primary had its chance —
"never zero when one is available" — and a primary that wakes late gets the still, not a second
video.

**Why "reports in" and not a device state.** What Home Assistant can know about a tablet was
checked: `mobile_app` has no online/offline state (its sensors keep their last value); the page's
websocket is only connected while the screen is on, so "no page connected" describes every healthy
panel that is asleep; the last time a page was seen says the panel existed, not that it is there
now. The only true signal is the page answering for *this* call. 6 s: a page on screen answers in
under 2 s, a woken screen in 2–5 s, and the ring itself lasts about 15 s.

## What the card is told, and how

No new identity: the page is recognised exactly as for `back_home` (`panel_identity.py`: the
companion login of its websocket, bound by the ring's one-time code or unique for its user).

- **`ig_doorbell/get_connection_info`** (the call the card already makes before opening anything)
  gains `panel_call` = `{call_id, phase, stream, still_entity}` or `null`, and `panel_sub` (this
  page is a picked panel of this doorbell with the roles on). The role arrives **before** any
  session exists, so a secondary never opens one.
- **`ig_doorbell/subscribe_panel_call`** (new; only a page with `panel_sub` uses it) pushes the
  same dict when it changes: the role passing to this panel, the resolution, the end.
  Any other page subscribes to silence.
- **The still** is the `image` entity the integration already fills with ONE snapshot per ring
  (`image.py`, RAM only, `call_snap` respected). Every panel reads that one from Home Assistant
  (`entity_picture`); no panel asks the doorbell, and the ring never waits for it.

A page that is not a picked panel (a phone, a computer) gets `panel_call: null` and behaves as
always.

## Migration

`notify_primary_panel` is a new option. **Absent** (every installation from before 1.6.0) = the
roles are off: every panel loads and nothing is told to any page, exactly as 1.5.4 — with one
panel or with several. Nothing changes on upgrade.

The roles turn on when the owner **saves** *Configure → Ring notifications*. The form shows
*Main panel* already filled with the first panel of the stored list; saving stores it (or the one
picked). A main panel that is not in the list is refused with an error. A stored primary that is
later removed from the list falls back to the first panel — one loader is kept, never "all" again.
With no panels the key is dropped. To change the succession order, re-pick the panels in the order
wanted (the list keeps pick order).

## iPad panels

Checked in the code: nothing in `call_page_nav.py` / `panel_identity.py` is Android-specific (the
identity already handles the iOS companion's client id). The two Android-only pieces were the
notifier (`platform == "android"` guarded the whole wake-and-show block) and the card (its listener
required `window.externalApp`). Both now cover iOS: the notifier asks an iPad's page to navigate in
place, and the card offers itself inside either companion app (iOS: the WKWebView message handlers
`getExternalAuth` / `externalBus`). `command_screen_on` and `command_webview` stay Android-only:
iOS has no equivalent, so an iPad that is asleep or showing another app only has its notification.

On a ring, an **always-on iPad** showing Home Assistant: its page goes to the call page by itself,
then primary → live video; secondary → still + View. Roles, release and going home are identical
to Android, since they live in the page.

## Failure cases

| case | what happens |
|---|---|
| primary offline / asleep and not waking | after 6 s the best-ranked panel that is there loads; with none there, the first to appear |
| primary known gone (removed, disabled) | skipped before the ring; the next is first, no wait |
| a panel's page not identified (ambiguous user, never opened from its own notification) | it is not a panel to the integration: `panel_call: null`, it loads as before 1.6.0. Opening the call page once from that panel's ring notification binds it |
| two rings in a row | pages are only told about the latest call; a late resolution of the earlier one is not sent |
| a panel woken after the call resolved (within 30 s) | the notice of what happened + still, no live video by itself; later it is just a page, as always |
| firmware before 0.101.3 (no resolution events) | roles at the ring work; nobody is told to release; at 120 s pages are told `ended`, still-only panels go home |
| the subscription fails / an older cached card | a 1.5.4 card ignores `panel_call` and loads as before; a 1.6.0 card without the subscription still obeys the role at start, but cannot be promoted or released |
| the picture is off (`call_snap` 0) or failed | the notice and View without a picture |
| Home Assistant restarts mid-call | call state is in RAM: pages get `null` and behave as before 1.6.0 for that call |

## Deliberately not done

- **A panel that already shows the live video before the ring** (a card left open on a dashboard)
  is not cut when the ring comes: that stream is somebody's choice, not caused by the ring. It
  *is* released on "answered elsewhere".
- **No holder change mid-call** (a holder that dies after claiming keeps the role).
- **No knowledge of which page answered**: the doorbell names the pairing, not the browser. Hence
  "release unless you are talking", decided by the page.
- **No auto-resume** of a released panel when the conversation ends; it went home.
- **Phones** are untouched: a person opened that page.
- **No firmware change**, no new request to the doorbell.

## Tests

- `tests/test_panel_roles.py` (26): the rules; "never zero, never two" over 3000 generated calls
  against an independent reference; the migration through the real options flow; the notifier and
  websocket (roles at the ring, gone primary, promotion pushed, resolution, two rings, no
  resolution, one snapshot for three panels, the iPad in place). 19 mutants in `tools/mutants.py`.
- `tests/card/panel_roles/` (real card, real Chromium): R1–R11, 12 built-in mutants, and a control
  against the 1.5.4 card that must fail R2.

## Not verified (needs real tablets)

Timing of the 6 s grace on real panels (wake time, the `command_webview` fallback path, which can
take longer than 6 s and would then lose the role to a faster secondary); the iOS companion bridge
detection and in-place navigation on a real iPad; how the still picture looks on each screen; the
released panel's trip home; three real sessions' worth of load on the doorbell, before and after.

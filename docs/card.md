# The IG Doorbell card - accumulated knowledge

This is the working memory of the Lovelace card that ships inside this integration
(`custom_components/ig_doorbell/frontend/ig-doorbell-card.js`, element `custom:ig-doorbell-card`).
Until 1.0.0 the card lived in its own repository with this text as its `CLAUDE.md`; it moved here
with the card. Entries are newest first. Identifiers, element tags, storage keys and file paths
were updated to the 1.0.0 names (the card's internals were renamed to English in 1.0.0 - see
`tests/card/fixtures/rename_map.json` for the full old -> new map).

Source of truth for the doorbell's own interface (WebRTC, signalling, `pair_app`, events):
`API_CONTRACT.md` in the IG_Doorbell firmware repository. Don't duplicate it here.

## "Configuration error" on load: the card registered in the wrong registry (1.1.2, 2026-09-27)

**Symptom** (Iñaki, integration 1.1.1, HA 2026.9.3, desktop Chrome, zero-config panel card): some
loads showed Home Assistant's red "Configuration error" instead of the card; a hard reload fixed it.
The error card's message was `Custom element doesn't exist: ig-doorbell-card.` The card never threw.

**Mechanism (measured on the real HA through CDP).** Home Assistant's app bundle includes
`@webcomponents/scoped-custom-element-registry`, which REPLACES `window.customElements` when the
bundle runs. The page imports extra modules (ours, via `add_extra_js_url`) in PARALLEL with that
bundle. When the card runs first, `customElements.define` goes to the native registry; the
polyfill's registry, which is what HA's `createCardElement` asks (`get`, then `whenDefined`),
never hears of it - so the error card never goes away. In the failing page:
`customElements.get('ig-doorbell-card')` undefined, `document.createElement('ig-doorbell-card')`
an `IgDoorbellCard`, and `window.customCards` listing the card (pushed right after the define).

**Why https and why Ctrl+F5.** Over https the service worker (HA's `sw-modern.js`, stale-while-
revalidate for anything outside `/static`, `/frontend_*`, `/api`) serves the card from cache in
~30 ms, ahead of the 560 KB app bundle. Plain http has no service worker, the card arrives later,
and it never failed. Ctrl+F5 bypasses the service worker; a plain F5 does not (4/6 bad).

**Frequency, before -> after** (goto of the dashboard, fresh browser context each run, Waveshare
pinned, error card still up 6 s after navigation): https 1.1.1: 13/15 (goto), 11/15 (F5); http
1.1.1: 0/3. https 1.1.2, same service-worker path: 1/15, 0/15, 0/20, 0/20, 0/20 - one bad load in
90, not caught again with the console recorded (open question: probably a slow cold load over the
internet, which HA's own `whenDefined` rebuild recovers; the 1.1.1 failure never recovered).

**Fix.** Registration is idempotent per registry (`igRegisterElements`) and runs again when the
registry is swapped: on the native `whenDefined('home-assistant')` (HA defines its root right
after installing the polyfill, and the polyfill defines a stand-in natively, so the native registry
sees it), and on a bounded 30 s watch of `window.customElements` for a polyfill installed by anyone
else. Defining the same class on the polyfill after the native one is safe: the polyfill reuses the
native definition as its stand-in. Bench: `tests/card/registry_race/` (real polyfill from npm,
both orders, HA-style mount; mutants Z1-Z3; the 1.1.1 build is a control that must fail R1).

## Six languages, the same set as the apps (1.1.1, Iñaki 2026-09-27)

The integration/card set used to be es/en/fr/de/pt/zh-Hans/ru/hi/ar (nine languages, no Italian).
Decision: the product's languages are es, en, fr, it, de, pt - the exact set the iOS and Android
apps already ship, fallback English. zh-Hans/ru/hi/ar are gone from `igLocales`, `IG_EV_TEXT` and
`IG_HTTPS_TEXT` in `ig-doorbell-card.js`, and from the `T` table in `frontend/https-install.html`;
`it` was added to all four with full key parity to `en`. Each table's own per-key English
fallback (`getLocalText`, `igEvText`, `igHttpsText`, and the install page's `t()`) needed no
change - it already falls back key-by-key, not just language-by-language.

The `document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'` line in the install page lost
its reason to exist (Arabic was the only RTL language in the old set) and is now a plain `'ltr'`.

`tests/test_supported_languages.py` pins the six-language set going forward: it fails loudly if
any of the four surfaces (translations/, the three card.js tables, the install page's table) ever
drifts from exactly {es, en, fr, it, de, pt}, or from full key parity with `en`.

## The microphone on a page that is not secure (1.1.0)

On `http://<ip>:8123` the page is not a secure context and the browser has **no**
`navigator.mediaDevices`: until 1.0.x a tap on the mic requested the talk turn, `getUserMedia`
threw, and the button silently went back to off. Now `toggleTalk()` checks `igMicPossible()`
first and, if it fails, opens `.ig-https-panel` (same overlay as the quick replies) instead of
requesting the turn. The panel asks the integration `ig_doorbell/https_status` and links to the
install page `/ig_doorbell/https` (QR on a fine pointer), or to the integration when HTTPS is off.
Texts: `IG_HTTPS_TEXT` at the end of the file (6 languages as of 1.1.1: es/en/fr/it/de/pt). Bench:
`tests/card/mic_https_1_1_0`
opens the card as `http://insecure.test` (mapped to 127.0.0.1: NOT secure) and as `127.0.0.1`
(secure, the control), with a mutant that removes the guard. `sim_multicliente` now declares its
fake page a secure context, which it always implicitly was.

## How the card reaches the browser (1.0.0)

- `card.py` serves the file at `/ig_doorbell/ig-doorbell-card.js` and registers it with
  `frontend.add_extra_js_url` with `?v=<first 12 hex of its SHA-256>`: every page Home Assistant
  serves loads it, so no Lovelace resource is needed, and `window.customCards` puts it in the card
  picker. See "Updating the card" below for what a user has to do after an update.
- The card has no configuration (since 1.10.0): it finds the doorbells in `hass.devices` by the
  `ig_doorbell` domain and each doorbell's entities by `translation_key`.

## Updating the card (measured 2026-09-26, throwaway HA 2026.9.0 in Docker, Chromium with a persistent profile)

| What happened | What the browser ran |
|---|---|
| First load, no Lovelace resource at all (`lovelace/resources` = `[]`) | the card, from `/ig_doorbell/ig-doorbell-card.js?v=9948a64c810f`; listed in `window.customCards` (card picker) as "IG Doorbell"; Waveshare streaming (1080x1200, dot live) |
| File replaced on disk, **no HA restart**, same browser reloads | the **new** file, under the **old** `?v=` (the hash is computed at startup): the route sends no long-lived cache headers, so the browser revalidates |
| HA restarted while a page stays open, **no reload** | the **old** build keeps running (a custom element cannot be redefined in a page); the stream recovered by itself |
| Reload after the restart | the **new** build under a **new** URL (`?v=25515d27e1a7`), streaming again |

So an update needs what HACS asks for anyway — **restart Home Assistant, then reload the page**.
No cache clearing, no resource to edit. Open wall panels keep the previous card until their page
reloads.

## Running the benches

```
cd tests/card
npm install
node run_all.js
```

`run_all.js` starts its own static server rooted at this repository and checks that every
browser bench really fetched the card from it. **Do not start `python -m http.server` by hand for
these benches**: on 2026-09-26 several of those servers were still running from older sessions on
the card's former repository, on the same ports and paths - a bench pointed at one would have
measured the old card and said ALL OK. Controls that need an older build use the translated
fixtures in `tests/card/fixtures/legacy/` (`make_legacy.js` explains why).

Known flaky, and not a regression: `idle_release_network` CASE 2 ("first start HUNG, then tap")
reports "did not recover in 13 s" about one run in three - measured the same on the old repository
before the 1.0.0 renames. The bench is a diagnostic (it prints verdicts, it does not fail on them).

**Integration 1.1.1 (2026-09-27) — SPLIT: call buttons beside the picture, not over it.**
(Iñaki's screenshot: iPhone 15 Pro in landscape, HA app, Ermita 10's portrait stream. Overlay put
sound/mic/door over the lower half of a picture using ~25 % of the width, over the visitor's face,
with > 35 % of the width empty on each side. *"We are not optimizing the space in this specific
case."* Cause: under 350 px of height the side column is not allowed, so 1.11.0 fell back to overlay.)

- **Rule.** While the card has room beside the picture for a column of buttons, they go there;
  overlay only survives when the picture fills the width (no room for a 44 px column) or the
  height is under `SPLIT_MIN_H` (180). Fourth layout `split` (class `ig-split`), two variants
  (`_planSplit()`): **header beside** (`ig-split-head`: picker / mode / REC / bell / Recordings /
  Quick replies in a compact 144 px column on the LEFT, buttons in an 88 px column on the RIGHT,
  the picture at the FULL height) and **header on top** (buttons column only; Recordings in the
  header when short, as overlay-short). `ig-split-lbl` from 270 px of picture: labels + mic 64 /
  others 52; below, no labels, mic 56 / others 48 (always >= 44).
- **Split only REPLACES overlay** (`_planLayout`): when overlay (or the no-fit fallback, now scored
  like an overlay) won, the best split takes over if its uncovered area >= overlay's area x 0.85.
  Stack and side column (approved in 1.11.0) are never displaced: every non-overlay row of the
  1.11.0 matrix is identical.
- Reuses the existing boxes: `#stack-controls` = button column, `#side-col` = header column; CSS
  `order` places them. The frame is sized to the picture as in side.
- **Learned (measured):** (1) the frame's 1 px border sits outside its inline width: a row exactly
  full (144 + 10 + 220 + 10 + 88 = 472) wrapped the button column to a second line and the
  correction pass then shrank the picture to the 180 floor. `_planSplit` subtracts the measured
  border and `_imgWidth()` never rounds the frame up past what the columns leave. (2) An
  unconditional split in place of the fallback shrank a landscape picture from 420x236 to 322x181
  in a 492 px column with no room beside it: the fallback is scored like overlay now.
- **Verification.** `tests/card/ui_v1_11_0/driver.js` extended: sizes + 932x430, streams 1080x1920
  / 1080x1200 / 1280x720; **L13** (no call button over the picture while >= 98 px free beside it),
  L1 / L6 / L11 extended to the split columns. 724/724; mutants M12 (split never used -> L13),
  M13 (labelled column at any height -> L11), M14 (split frame not sized -> L6) caught, M1-M11
  still caught. Negative control in `run_all.js`: the 1.0.0 card (`fixtures/legacy/card_1.0.0.js`)
  goes red on L13 (18 cases). Offline, phone 844x390 panel: portrait 146x260 covered -> 177x314
  free (12 -> 17 % of the screen), near-square 234x260 -> 283x314 (18 -> 27 %), landscape 462x260
  -> 557x313 (37 -> 53 %). Real HA (`tests/card/layout_matrix_1_1_1/`, Waveshare only, temporary
  dashboard `igd-card-layout-111` removed after; 5 views x 6 sizes x 3 streams = 90 cases, before =
  1.0.0 card): call buttons over the picture 29 -> 7 cases, and those 7 have 12-48 px free beside
  the picture (no room for the column); 22 layouts changed, all former overlays; overflow /
  unreachable / touch < 44 unchanged (1 / 1 / 0, the by-design Sidebar-side phone). Panel phone
  844x390: portrait 12 -> 17 %, near-square 18 -> 27 %, landscape 36 -> 53 % of the screen, none
  covered. `table.md` has the 90 rows. Screenshots gitignored (real camera).

**"2 viewers for a few seconds on opening the card" (measured 2026-09-27, Waveshare + real HA).**
Leaving the dashboard and coming back within the 15 s pause grace, Home Assistant builds a NEW card
element instead of re-inserting the old one. The old view, off the page, kept its paused session
until its grace ran out: `/api/debug/cores` showed viewers=2 for ~12 s, then 1. Every mount opened
exactly one EventSource and closed it with `bye` - no leak, just a grace kept for an element nobody
would put back. Fix: a view starting a session hangs up (with `bye`, before its own SSE) any view
of the same doorbell that is off the page and still in its grace (`VIEWS_WITH_SESSION`,
`_hangUpDetachedTwins`). Re-insertion of the same element still resumes with `live_resume`.
Re-measured with the fix: viewers never above 1. Bench: `tests/card/mount_sessions` (sessions per
mount, with mutants X1-X3). Switching views inside the same dashboard re-inserts the same element
(no second session), and a plain reload sends `bye` from `pagehide` - both measured clean.

**v1.11.0 (2026-09-26) — adaptive layout.** (Iñaki approved the proposals of the 1.10.0 layout
analysis.)

- **Three layouts, exactly one active** (`_layout`; classes `ig-stack` / `ig-side` / neither =
  overlay, `ig-short` = overlay with Recordings/Quick replies moved into the header,
  `ig-side-compact` = column under 600 px). `_planLayout()` computes the picture each layout would
  give from the MEASURED space (container width, `_availableHeight()`, stream aspect) and keeps the
  biggest; overlay counts at 85 % (its buttons cover the picture), the current layout gets +5 %
  (hysteresis). Side column needs the image ≥ 350 px tall (`SIDE_MIN_H`) and ≥ 160 px wide; overlay
  needs width ≥ 520. Nothing fits → overlay-short with a 150 px floor (`MIN_FALLBACK_FEED_H`).
- **Groups are MOVED, never cloned** (`_placeControls`): header, `.actions-row`, `#bottom-row` go to
  `#side-col` / `#stack-controls` / back. All references and listeners stay valid.
- **Correction pass**: after applying a plan `_fitToSpace()` measures the card's real height and
  gives the difference to the video (the chrome is an estimate). `_bottomReserve()` sums the
  bottom padding/border/margin of every ancestor across shadow roots (what HA puts under the card).
  This is what removed the 2-20 px page overflow.
- **The §1.9 rail is fullscreen-only now** and only with ≥ 350 px (`_layoutRotation`). Outside
  fullscreen a rail was a 4th layout competing with the others (1.9.8 mic-straddling bug).
- Touch: `@media (pointer: coarse)` gives 44 px to picker, mode chip, REC, bell, fullscreen, panel
  nav buttons; `--ig-tap` (34 mouse / 44 touch) sizes the new pieces. Column width 144 (not 140):
  three 44 px targets + two 6 px gaps in the compact header row.
- `getGridOptions()` `{columns:12,min_columns:6,rows:'auto',min_rows:6}` + legacy
  `getLayoutOptions()`; `getCardSize()` = ceil(height/50) (12 before first layout).
- **Learned (measured, not guessed):** (1) HA's frontend installs a scoped custom-element registry
  polyfill while booting: a card defined by an init script BEFORE that is lost ("Configuration
  error"); inject after `hass` is up and Lovelace rebuilds on `whenDefined`. (2) A squeezed flex
  column does not overflow ITSELF — its rows shrink and the buttons pile up; `scrollHeight` stays
  green. L11 checks control rectangles for overlap instead (first version of the check could not
  go red: mutant M5 exposed it). (3) With `(pointer: coarse)` a crowded short header squeezed the
  picker to 26 px in real HA while the offline bench (short doorbell name) never did: the offline
  narrow case now uses a long name and L12 checks the picker width. (4) `@container igfeed
  (max-width:520px) .hud-bottom {bottom:148px}` pushes the fullscreen button out of a short frame:
  in `ig-short` it goes to the top-right corner. (5) `_availableHeight` for a card that is NOT
  first in its column still fits "a screen" (1.9.7 decision): Sidebar-side on a phone scrolls to
  the card by design (the only overflow/unreachable row left in the matrix).
- **Verification.** `tests/card/ui_v1_11_0/driver.js` (Playwright, real dist/, fake HA views
  `hui-panel-view`/`hui-masonry-view`, 6 sizes × 4 container kinds × 2 stream shapes + live
  resize/rotation + fullscreen): 355/355, checks L1-L12, and 11 built-in mutants (M1-M11) each turn
  their target check red. `tests/card/layout_matrix_1_11_0/run.js` (real HA, Waveshare only, card
  injected under `-dev` tags into a temporary dashboard `igd-card-layout-1110`, removed after):
  same matrix as the analysis, before (1.10.0, `CARD_REF=6753e72`) and after;
  `table.py` → `table.md` (full 50-row table). Screenshots gitignored (real camera). All older
  benches green (ui_v1_10_0 with its mutants, ui_v1_9_7, ui_v1_9_8, sim_multicliente,
  sim_carrera_reentrada — its negative control was red since 1.10.0 because it only captured the
  VIEW tag; fixed to fall back to the card tag of pre-1.10 commits — idle_release_network: same
  verdicts). Ermita 10 was not used.

  Before → after, real HA, 50 cases (5 view types × 5 sizes × portrait/landscape stream):

  | metric | 1.10.0 | 1.11.0 |
  |---|---|---|
  | cases with overflow (card past the viewport, or page scroll in single-card views) | 21 | 1 (Sidebar-side phone, card below another card: by design) |
  | cases with a control unreachable without scrolling | 9 | 1 (same case) |
  | touch cases with a target < 44 px | 40/40 | 0/40 |
  | worst overflow | 134 px (Sections, phone landscape; Recordings off-screen) | 0 |

  | case (stream) | layout before → after | video % of screen |
  |---|---|---|
  | Panel PC 1920×1080 (portrait) | overlay+rail → side | 22 → 27 |
  | Panel PC (landscape) | overlay → side | 70 → 60 (width-limited; overlay was bigger but covered) |
  | Panel tablet 1280×800 (portrait) | overlay+rail → side | 21 → 29 |
  | Panel tablet 1280×800 (landscape) | stack → overlay | 41 → 56 |
  | Panel tablet 800×1280 (portrait) | stack → side | 51 → 68 |
  | Panel phone 844×390 (landscape / portrait) | overlay (portrait: rail, sound button unreachable) → overlay-short | 25 → 36 / 8 → 12 |
  | Sidebar PC / tablet landscape (portrait) | overlay+rail → side | 21 → 26 / 20 → 27 |
  | Sections/Masonry tablet 1280×800 (portrait) | stack → side (compact) | 11 → 18 / 12 → 17 |
  | Sections/Masonry phone 844×390 | stack, 118-134 px overflow → overlay-short, fits | 18 → 13-20 |
  | Sections/Masonry phone 390×844 (portrait) | stack → stack | 42 → 37 / 45 → 43 (gave 5-19 px back to stop the page scroll) |

**v1.10.0 (2026-09-26) — no configuration, live doorbell switcher.** (Written in English, per the
project's documentation rule; older entries below are Spanish.)

- **Two elements now.** `ig-doorbell-card` (class `IgDoorbellCard`, the one HA
  creates) is a thin SHELL: lists the doorbells from `hass.devices` (identifier
  `[IG_DOMAIN, id]`, disabled devices skipped, sorted by name), picks the default (localStorage
  `ig-doorbell-card-selected`, else first) and hosts ONE `ig-doorbell-view`
  (class `IgDoorbellView` = the whole former card) per doorbell being watched. Tests that
  poke internals must use the VIEW tag (all harnesses were updated).
- **Switching = destroy + create, never "change device_id".** `_switchTo()` is synchronous:
  `viejo._destroy()` (hang up with `bye`, stop mic/turn/timers/listeners, forget
  `PAUSED_BY_DOORBELL[id]`, set `_destroyed`) then a new view. Why: the apps' bug (name changed, dot
  stayed green) is what "reset field by field" produces; a fresh instance has no stale state by
  construction, and a late callback of the old one writes into a detached element.
  `_destroyed` guards `startWebRTC`, `_scheduleReconnect`, `_pause`, `_resume`,
  `connectedCallback`, `sendNativeSignal`; `disconnectedCallback` on a destroyed view does nothing
  (it would otherwise PAUSE, i.e. `bye` only after 15 s). `_startTalk` drops a getUserMedia that
  resolves after the session generation changed.
- **The dot and "live".** The picker dot is painted in `_setLiveState` = the live tag's state.
  Since 1.10.0 `setupRemoteStream` (ontrack) no longer sets 'live': ontrack fires when the offer is
  applied, before any packet. 'live' comes from `_confirmLiveFromMedia` (video `timeupdate` or
  getStats progress); `startWebRTC` resets to 'connecting'. Measured on real HA: Ermita went green
  863 ms after the switch, with a decoded frame.
- **Config keys, where each went:** device_id → registry + picker; entities → `_autoEntity` by
  translation_key (`mode`, `rec`, `events`, `visitor` for the presence badge); unlock_entity →
  gone, the door is always the doorbell's `open` (door_m=1 lets the doorbell drive a HA entity from
  the integration's allow-list); unlock_duration → constant `DOOR_OPEN_DISPLAY_S` = 3 (apps use a
  fixed value too); height → gone (`_feedCap` = Infinity); idle_release_seconds → the integration's
  `number.*_live_view_timeout` (fallback 120 s). Nothing needed the integration's options flow; the
  integration was NOT changed. Legacy keys are ignored silently (a throw would break Iñaki's
  dashboard on update).
- Also fixed: rail + stack both active (mic straddling the video edge — `carril` now requires
  `!ig-stack`); door wait 6 → 10 s (door_m=1 answers when HA confirms, up to ~8 s, contract §3.3);
  mode chip showing "unavailable". Removed the `.hud-sig` bars (CSS-only echo of the live state).
- Rename prep: `IG_DOMAIN`, `CARD_TAG`, `VIEW_TAG`, `EDITOR_TAG` constants at the top are the only
  places with those names in code (localStorage keys keep the old prefix on purpose: renaming them
  forgets saved prefs).
- **Verification.** `tests/card/ui_v1_10_0` (Playwright, real dist/, fake doorbells that hand out slots
  and a real SDP offer): zero-config, legacy keys, default memory (incl. localStorage throwing),
  the apps' dot bug, old session hung up, 6 rapid switches → 1 session/1 pc/1 view, late
  get_connection_info of the old doorbell, late mic permission, panels/armed door not carried,
  menu dots, single doorbell, i18n, editor. **Built-in positive controls**: three mutants of dist/
  (sticky dot, no destroy, no mic check) must each turn their check red — they do.
  `tests/card/real_ha_1_10_0/run.js`: injects dist/ under `-dev` tags into HA's profile page (no
  dashboard touched) and measures sessions at each doorbell's `/api/debug/cores`: Waveshare → Ermita
  → Waveshare → burst W→E→W→E→W; always exactly one session, on the right doorbell; all 0 after.
- **Layout analysis (analysis only, Iñaki decides):** `tests/card/layout_matrix_1_9_8/` (README, run.js,
  metrics.json; 4 view types × 5 sizes, portrait/landscape stream). The 31 screenshots are
  gitignored ON PURPOSE: they are frames of real doorbell cameras and this repo is public
  (privacy principle). Re-run `run.js` to regenerate them locally. Main findings:
  `getCardSize()` returns 4 (card is 700-1000 px); no `getGridOptions()`; Panel on wide screens
  with a portrait stream uses ~31-35 % of the area (rail mode, controls far from the image); phone
  landscape clips the rail buttons; touch targets < 44 px (mode pill 32, REC 24, bell 30).
- Old sim `tests/card/sim_multicliente.js` is green again (DOM double lacked `style.setProperty` since
  1.9.6; two aspect checks were stale since 1.9.7; ring test now uses the integration's entity).

**v1.9.8 (2026-09-25, early hours) — Quick reply, integrated into the same Recordings row.**

- Request: bring to the card the «Quick reply ›» row the apps already have, below the three
  buttons. Iñaki's design after the first draft: *"so it doesn't take up more space, split the
  Recordings bar into two buttons: Recordings and Quick Replies"* — no new row at all, the SAME wide
  row from 1.9.7 goes from one button to two, same height as before. `#bottom-row` is now `flex`
  with two `.quick-btn.half` (Recordings and Quick Replies); if one is hidden the other takes the
  whole row on its own, for free, by being `flex:1` — no separate CSS for that case.
  Recordings stays admin-only; Quick Replies is visible to any user, same as `/api/sequences?quick=1`
  on the doorbell itself (doesn't require a role) — visibility in a separate method
  (`_updateQuickReplyButton()`, not merged with `_updateRecordingsButton()`: two different
  visibility rules in the same `if` is the "defense spread across places" landmine from CLAUDE.md).
- **The list comes from the integration (`ig_doorbell/get_quick_replies`, a new WS command
  in 0.7.5), which in turn reads it from the doorbell via `GET /api/sequences?quick=1`
  (API_CONTRACT.md §1.18.8) — NEVER `/api/list_audios`**, the retired 10-slot mechanism that once
  made Android say "there are none" while having them: here it uses the same source iOS already
  uses. No credential ever reaches the card — same pattern as `get_connection_info`/
  `get_local_signal_url`.
- Tapping a phrase calls the `play_sequence` service the integration already exposed since Phase 0
  ("the card shows, the integration exposes") — there's no new route for playback. That same
  signaling message is what already resolves a ring in progress (§1.18.1: the firmware cuts the
  street announcement and does NOT chain the no-answer sequence) since firmware 0.94.40, so this
  card needs no separate path for that case: it's the same button, at the same instant.
- The list panel (`#qr-panel`) reuses the bell's pattern and CSS classes (`#ev-panel`,
  `.ev-head`/`.ev-row`/`.ev-empty`) instead of duplicating styles. A network failure doesn't clear
  what's already rendered (§1.18.8); a playback failure does NOT close the panel (same criterion as
  iOS's `QuickRepliesSheet`): someone's waiting at the door and closing the panel would take away
  their button to retry.
- `tests/card/ui_v1_9_8` (real Playwright, real dist/, only network/hass doubled): 22/22 OK — neither
  half clips text at 375px width, not in Spanish nor in the catalog's longest German
  ("Schnellantworten"), Recordings admin-only, Quick Replies for any role, the row doesn't
  grow taller (50px), open/list/tap/close, a doorbell rejection leaves the panel open with
  its own text, an empty catalog and a network failure each give their own message (never a
  blank list). **Positive control**: the same bench against v1.9.7's `dist/` doesn't come out clean
  red, it comes out an **exception** (`#qr-button` doesn't exist yet) — confirms the bench measures
  something real and isn't green by accident.
- **⚠️ The ring-in-progress case wasn't tested on a real bench** (neither the Waveshare —no
  button— nor Ermita —a real home, without touching the bell/mic/speaker—): covered by the fact
  that it's the same `play_sequence` message the apps already use there, with the firmware hook
  already measured in `tools/probar_respuesta_en_timbrazo.py` (17 OK / 0 FAIL, API_CONTRACT.md
  §1.18.1) — there's no new code on the call path, but the card itself hasn't been seen firing a
  quick reply with the bell genuinely ringing.

**v1.9.7 (2026-09-25, night) — the card fits itself, Recordings is actually visible, the bell,
optimistic mode. Measured with Playwright against real HA (`panel` view, 393x852 and 1280x800)
and on the tablet.**

- **Recordings was NOT hidden because of height, but a CSS rule**: `.bottom-row { display: none }`
  in the sheet, and `_updateRecordingsButton()` "showed" it with `style.display = ''`, which falls
  right back into that rule. The 1.9.5 bench checked the INLINE `style.display` (`!== 'none'`) and
  came out green: an instrument that looks at the inline style doesn't see the sheet.
  `tests/card/ui_v1_9_7` looks at the COMPUTED display; served with 1.9.6 (`CARD_FILE=`) it comes out red.
- **HA's wrapper doesn't crop**: `hui-panel-view` measures the viewport minus the bar (796 out of
  852) with overflow visible. What overflowed was the card: the YAML's `height: 650px` was applied
  AS-IS to the frame, and with the real video (1080x1200) in a 373 px-wide space the image occupies
  414 px and the rest was black bars (the "gap above the video" from the iPhone).
- `_fitToSpace()` measures the available space (visible viewport minus whatever is above the
  card), subtracts the controls, and gives the rest to the video with its ratio preserved; `height`
  becomes a CAP. Two layouts: STACK (portrait phone, a copy of the iOS app: video, chips, buttons
  48/96/60 outside the image, Recordings) and OVERLAID (the usual one, with the rail). Observers:
  the element itself, HA's view, `resize` and `visualViewport`.
- Bell: HA recorder history for the integration's `event` entity via
  `history/history_during_period` (the doorbell has no history route; the apps read the VPS's
  queue, which the card can't use). Filters same as the apps. Red dot per browser (localStorage).
- Optimistic mode with pending and revert on service failure (integration 0.7.4 confirms by
  reading the doorbell and throws an error if it didn't apply). No «System idle». A padlock instead
  of a key.
- `tests/card/sim_multicliente.js` was already failing with 1.9.6 (`this.content.style.setProperty` in
  the DOM double): not from this version, still pending.

**v1.9.6 (2026-09-25, same afternoon) — Recordings (1.9.5) was unreachable on the real living-room
tablet: `ha-card` clips whatever doesn't fit, and it didn't fit.**

- Measured on the living-room tablet, not reasoned: Iñaki's real dashboard
  (`lovelace.ig_doorbell_p4_v2`, `type: panel` view, `height: "650px"`) has the video filling the
  screen edge to edge — confirmed at the pixel level (`deriva_color`-style: color sampling along a
  vertical column) that the real video frame reaches the screen's bottom edge, well past the
  configured 650px. **This already happened in 1.9.4** (confirmed with `git diff v1.9.4 HEAD` on
  `_applyFeedAspect`/`_layoutRotation`/`RAIL_WIDTH`: zero changes) — it's not a regression in this
  card, it's a pre-existing trait of the height calculation in rail mode. But before 1.9.5 it never
  mattered, because nothing lived AFTER the video frame in the document's normal flow
  (`.actions-row`/`.status-line` are overlay layers inside `.feed-wrap` itself, `position:absolute`).
  `#bottom-row` (Recordings) is the first piece that actually leaves that layer — and with
  `ha-card { overflow: hidden }` (meant to clip decorative bleed, never meant to clip real content)
  the button ended up entirely outside, with no scroll that could reach it: confirmed with several
  real `swipe` attempts on the tablet, none moved the page.
- Fix: `ha-card { overflow: hidden auto }` (`overflow-x` stays `hidden`, nothing grows sideways).
  In the normal case (content that fits) this is indistinguishable from `hidden` — no bar appears,
  nothing changes visually; it only comes into play when the content genuinely overflows, which is
  exactly the case that needs fixing. Fullscreen isn't touched: there `top-row`/`bottom-row` are
  already fully hidden (a 1.9.5 rule) and the only content left fits exactly into 100% of the
  height.
- **Not fully confirmed on the real tablet after the fix**: `swipe` attempts to reach Recordings
  still moved nothing after the change, which suggests the real limit may be one level up (Home
  Assistant's `panel` view wrapper, outside this card's reach) and not only in `ha-card`. The
  `ha-card` change is kept because it's correct and can't make anything worse — but if Recordings
  still doesn't show on THAT specific dashboard after this, the next path is to lower the
  configured `height` (e.g. to 550-580px) to make room, or investigate the panel view's wrapper
  separately. On a normal dashboard (not `panel`, with more margin between the video and the
  screen's edge) Recordings shows fine without this problem.

**v1.9.5 (2026-09-25, same afternoon) — the card emulates the apps' look: REC in a header
capsule, mode as a dropdown chip, a Recordings button. Compared piece by piece against the real
app on the living-room tablet, not reasoned.**

- Iñaki's decision: *"The REC button shows, but the look is very different from the apps'. REC
  and the bell must look the same. The modes should also be a dropdown chip. As far as possible,
  the card should emulate the apps' look."* And in the same request:
  *"We're not adding a settings button (that's what the integration is for), but we ARE adding
  the Recordings button."*
- **REC** moves from `.actions-row` (a shared 60px circle with sound/door, a decision from that
  same morning) to a small capsule in the header (`#top-row`/`.rec-pill`): a blinking hollow/filled
  red dot + fixed, UNtranslated "REC" (just like the apps' `RecButton.dart` — it's the universal
  label for a recorder). Gating (`_connInfo.role === 'admin'`, never `hass.user.is_admin`) and the
  source of truth (the entity, never the last tap) don't change from 1.9.4 — only the look and
  where it lives.
- **No bell**: this card has no "alert history" view to open it into (the app's opens its own
  screen, `/home/events`) — one isn't invented. If an events viewer is ever added to the card,
  this is where it would go, with the same look (small circle + red dot, no number,
  `BellButton.dart`).
- **Mode**: the row of 4 segmented chips (`.chip`) is replaced with ONE dropdown chip
  (`.mode-pill`/`.mode-menu`, same pattern as the apps' `_ModePill`) — icon + label of the CURRENT
  mode + arrow, which on tap opens the list of options. Still calls `select.select_option` on the
  same auto-detected entity (v1.9.3), translated with `formatEntityState`. A click outside closes
  it (`_onDocClickForModeMenu`, same criterion as this card's other menus).
- **Recordings** (`#bottom-row`/`.quick-btn`, below the video frame): same look as the apps'
  `_QuickButton`, same gating as REC (the doorbell's role, not HA admin) and **no
  Settings** — configuration lives in the integration and its entities. Opens Home Assistant's
  NATIVE media browser (`/media-browser/browser/<encoded type,media_content_id>`, with
  `browser` as the marker for "no associated media_player" — `BROWSER_PLAYER` in the frontend's
  `data/media-player.ts`) against the `media_source` the integration already publishes
  (`media_source.py`/`DoorbellMediaSource`, `media-source://ig_doorbell/<device_id>`) — the
  card **doesn't reimplement a player**, it just navigates (`history.pushState` +
  `location-changed`, the same SPA convention used by the whole HA frontend).
- Reviewed with a real Chromium: `tests/card/ui_v1_9_2/driver.js` was updated (tests 4 and 7, which
  assumed the row of chips and REC inside `.actions-row`) and `tests/card/ui_v1_9_5/driver.js` is new,
  with positive and negative controls for the three pieces (REC/mode/Recordings). Pending: visual
  verification on the living-room tablet against the real app (before/after screenshots) — see
  HANDOFF.md if a more recent entry exists.

**v1.9.4 (2026-09-25) — REC no longer depends on the Home Assistant user, but on the role the
DOORBELL gave the integration when it was paired.**

- Iñaki's decision: *"Why are we using the HASS user? When the integration is paired, it asks
  for a user, and that's the one that should govern, not the panel's user."* `_updateRecButton()`
  stopped looking at `hass.user.is_admin` (the user of THIS Home Assistant panel) and looks at
  `this._connInfo.role === 'admin'` — the same value the doorbell resolves for
  `session_info.role` (API_CONTRACT.md §3.3-ter), which now arrives in `get_connection_info`
  (`ig-doorbell-hass` >= 0.7.3, `GET /api/whoami?token=` with no session). Found on
  the living-room tablet: the "Kiosko" user isn't a Home Assistant administrator and REC never
  showed up there, even though the integration is paired as the real doorbell's administrator. The
  doorbell is still the one that genuinely enforces this (`rec_start` rejects with `admin_required`
  anyone who isn't an admin) — this is only what the card shows. `_connInfo.role` arrives once per
  session (`get_connection_info`, HA's WebSocket) and `_updateRecButton()` repaints as soon as it
  arrives, without waiting for the next `set hass()` tick. Reviewed with a real Chromium
  (`tests/card/ui_v1_9_2/driver.js`, harness extended with `tSetRole()`): visible with the doorbell's
  admin role even when the HA user is NOT an admin, hidden with role `user` even when the HA user
  IS one, and also hidden with role `unknown` (a pairing with no label, §3.3-ter) — all three
  conditions with a real positive and negative control, not just reasoned about.

**v1.9.2 (2026-09-25) — REC, relocated speaker, clock/quality retired, fullscreen fixed. Watched
on the card in real use (Iñaki), not a reasoned handoff.**

- The overlaid clock (`.hud-time`/`_updateHudClock`) and quality selector (`.hud-quality`/`q-btn`/
  `q-menu`) were RETIRED from the UI: the video already carries its own date/time OSD, and on HA
  quality is always automatic (never manual). The volume slider (`#vol-slider`,
  `localStorage['ig-doorbell-vol']`) was also retired — a separate decision the same day:
  "no client has it on its live view, not here either", volume belongs to the device. The internal
  quality machinery (`_probeQualitySupport`/`_handleQualityState`/`_paintQuality`) STAYS alive and
  always on `auto` — only the visual control was removed; the automatic-degradation notices
  (`q_auto_loss`/`q_auto_bw`/`q_low_warn` on the status line) stay.
- Action row reordered to **sound, mic, open, REC** (the real order from `HomeView.swift`'s
  `fullscreenControls`/`live_view_body.dart`, not invented) — the sound button (previously in the
  HUD next to volume) is now just another button in the row, the same size as the door one.
- **New REC, and it uses the integration's entity, never a protocol of its own** (the 08-31 rule
  "the card shows, the integration exposes"): `rec_entity` (a new config option, same pattern as
  `unlock_entity`/`mode_entity`) must point to a `switch.*` that
  `ig-doorbell-hass` still does NOT publish as of this change — `rec_session.py`
  exists in that integration (keeps the signaling session open for as long as the recording lasts)
  but `switch.py` is missing. Until it exists, `rec_entity` is left unconfigured and the
  button stays hidden — it's never pointed at a made-up entity_id. Visible only with
  `hass.user.is_admin` and the entity present; the state (`recording`) is ALWAYS the entity's,
  never the last tap's (`_updateRecButton()`/`toggleRec()`).
- **Native fullscreen fixed with a real measurement** (not just reasoned): on the living-room
  tablet (the official Home Assistant Android app, `io.homeassistant.companion.android` — not
  Chrome even though it looks like it from the outside) `requestFullscreen()` WAS granted
  (confirmed with `uiautomator dump`: the WebView fills the full physical 1920×1200, system bars
  hidden) but it left a stable black gap of ~210px at the bottom / ~15px at the top — reproducible
  three times, not a transition frame. The stylesheet never set explicit
  `position:fixed;inset:0` for the NATIVE path (only the CSS fallback `.ig-fs-pseudo` did) — it
  relied on the browser's UA stylesheet for `:fullscreen`, and in this WebView that wasn't enough.
  Added the `ig-fs-native-layout` class (native only, see `_applyFullscreenUI()`) with that
  explicit rule.
  **Not re-verified on the tablet after the change** (it was fixed and tested by logic + real
  Playwright in `tests/card/ui_v1_9_2/`, but there was no time to repeat the live measurement in this
  session — the next person touching fullscreen on Android should confirm it before considering
  the gap closed). New test: `tests/card/ui_v1_9_2/` (harness + Playwright driver, same pattern as
  `tests/card/idle_release_network`) covers REC/speaker/mode/button order/fullscreen with a real
  Chromium, with no real HA or doorbell in front of it — see `driver.js`'s header for how to
  run it (needs `playwright-core`, not installed in this repo).

**Current state (2026-07-10): `native` mode is the ONLY mode — the legacy `go2rtc` mode was fully
retired, see the Q22-bis entry further below.** `custom_components/ig_doorbell/frontend/ig-doorbell-card.js` remains a
single committed file (no build tooling — kept that way on purpose, see `ARCHITECTURE.md`
§5). `device_id` is mandatory (speaks the doorbell's own protocol — local SSE/POST over real
HTTPS, with a fallback to remote WS via the relay; credentials/host served by the
`ig_doorbell` integration — repo `ig-doorbell-hass` — via `hass.connection.
sendMessagePromise`, nothing pasted by hand in YAML); primary door opening = native `open`/
`open_result` message, with `unlock_entity`+`callService` available as an explicit alternative.
Syntax verified with `node --check` — **not tested against a real HA + real doorbell instance**
(not available in this session).

UX patterns kept from the previous version: dummy audio track + hot-swap `replaceTrack`
without renegotiating SDP, clean connection teardown on leaving the tab, Lovelace visual editor,
i18n (9 languages), volume memory in `localStorage`. Published on HACS
(the former separate card repository, tags `v1.0.0`/`v1.0.1`).

**Editor: native device picker with `ha-selector` (2026-07-09).** The `device_id` field is no
longer a text input where the user has to copy/paste the ID — the editor mounts an
`<ha-selector>` (the same component Home Assistant itself uses in its forms),
filtered to `selector: {device: {filter: {integration: 'ig_doorbell'}}}`, so it only
lists doorbells already paired with that integration, by name. Requires the integration to
register the device in HA's device registry (done in
`custom_components/ig_doorbell/__init__.py::
async_setup_entry`, `device_registry.async_get_or_create(...)` with
`identifiers={(DOMAIN, device_id)}`). The picker returns HA's internal ID (an opaque UUID),
NOT our own `device_id` — `findOurDeviceIdForHaDeviceId()`/`findHaDeviceIdForOurDeviceId()`
in the editor translate between the two via that same `identifiers`, and the card's config still
always stores our own `device_id` (stable, derived from the MAC), never HA's internal ID
(less stable long-term). Falls back to a hidden text `<input>` if for whatever reason
`ha-selector` weren't available in the frontend (defensive, shouldn't happen in practice).

**Local signaling now requires a credential (2026-07-09).** The local `/webrtc/signal`/
`/webrtc/signal/post` stopped accepting unauthenticated connections (a real security gap, closed
by the lead). `tryLocalSignaling()`/`sendNativeSignal()` add `?token=<pair_app credential>` as a
query param to both URLs (`EventSource` doesn't support custom headers, hence the query string
instead of `Authorization`) — it's the SAME credential from `this._connInfo.credential` already
requested for the remote WS, with no new secret or call. Without this `?token=`, local `native`
mode gives `401` from that date on. See `COORDINATION.md` Q9.

**Idempotency guards in `customElements.define`/`window.customCards` (2026-07-09).**
Found in real testing: with the old HACS resource and the new `/local/...` one both loaded
at the same time in the browser (a real case: testing local changes without publishing a new
HACS release first), the second `customElements.define('ig-doorbell-card', ...)` threw an
exception ("has already been used with this registry") — and, worse than the console noise,
depending on the load order the OLD HACS copy could end up active instead of the one being
tested. Both `customElements.define` calls (editor + card) now check
`customElements.get(...)` first, with an explicit `console.warn` about which copy wins on a
collision — it avoids the crash, but **it doesn't replace the real fix**: during any test of
unpublished changes, keep only one Lovelace resource for this card active at a time (disable/
remove the HACS one, or the manual one, not both). See `COORDINATION.md` Q11.

**Slot release on closing/reloading the tab (2026-07-10).** Verified against the real code
(not from memory) that the card did NOT replicate the `pagehide`+`sendBeacon` pattern the
doorbell's own web dashboard already uses — it only had `disconnectedCallback()` (Custom
Elements), reliable when switching Lovelace views but not guaranteed on a tab close/full reload.
Fixed two real bugs: (1) `disconnectedCallback()` wasn't sending `bye` for the LOCAL path
before closing (only the remote one did) — fixed; (2) new `pagehide` listener at the
`window` level (`_registerUnloadHandler()`/`_unregisterUnloadHandler()`), with
`navigator.sendBeacon()` for the local path (an in-flight `fetch()` gets canceled when the page
vanishes, `sendBeacon` doesn't) and a synchronous `nativeWS.send()` for the remote one (sendBeacon
doesn't apply to WebSocket). Deliberately WITHOUT `visibilitychange` — switching browser tabs
without closing it must not cut the session, that would be worse UX than the current one. See
`COORDINATION.md` Q18.

**Life-signal watchdog + automatic reconnection (2026-07-10).** Symmetric design with the
firmware's abandonment timeout (lowered from 45s to 20s) — the card no longer waits passively,
`_startLifeWatchdog()` probes `pc.getStats()` every 5s (real progress of `packetsReceived` on the
video inbound-rtp, not the browser's ICE state, which is unreliable/not tunable to exactly 20s) and
`_scheduleReconnect()` reconnects if 20s pass with no life signal (signaling messages during
negotiation, or video progress once connected). **Aggressive criterion, an explicit user
decision** (the same criterion `android_app` reached independently): both `failed`
AND `disconnected` on `pc.onconnectionstatechange` trigger immediate reconnection without waiting
out the rest of the clock — knowingly, since `disconnected` can be transient, to be validated live
against the user's poor 4G/5G coverage (pending, "under real fire" phase). Indefinite retries with
backoff (2s/4s/8s, capped at 15s), no attempt limit (a home-security product). New
`_teardownConnectionObjects()` centralizes the cleanup (used by `disconnectedCallback()`,
`startWebRTC()` and `_scheduleReconnect()`, without duplicating code) — a `bye` received from the
device itself now also triggers reconnection, instead of just painting the badge red. Verified
with `node --check` and an isolated Node simulation of the backoff formula and `getStats()`
parsing — no access to a real browser/HA in this session. See `COORDINATION.md` Q19.

**Real bug in `triggerUnlock()` for a `cover`-domain `unlock_entity` (2026-07-10) —
FIXED.** The README already advertised `cover` as a supported domain (gates/garage doors), but
the code fell into the generic `else` and called `cover.turn_on` — a service that does NOT EXIST
in HA's `cover` domain (verified against the real docs before touching anything: `cover` uses
`open_cover`/`close_cover`/`stop_cover`, never `turn_on`/`turn_off`; calling it throws
`ServiceNotFound`). Any user with a real `cover` entity configured would have seen the opening
fail silently. Fixed: `cover` now explicitly uses `open_cover`/`close_cover`, same as the other
domains. **Separate note, no code change**: the opener actuator the firmware itself publishes is
migrating from the `button` domain to `light`/`switch` (a firmware_cloud decision) — doesn't
affect this card at all, since `unlock_entity` is always an entity manually chosen by the user
(never auto-linked to the firmware's) and the code already treats `switch`/`light` identically.

**Three real bugs reported by the user, all three FIXED (2026-07-10):**

1. **The video didn't scale when resizing the card's width.** This card doesn't use Shadow DOM
   (direct `this.innerHTML` on the element itself) and the custom element
   (`<ig-doorbell-card>`) never declared its own `display`/`width` — autonomous Custom
   Elements are `display: inline` by default (they size to their content, not the
   container) unless declared otherwise explicitly; nobody does that for you. All the relative
   internal CSS (`width:100%` on `.ig-container`/`.video-wrapper`/`video`) was
   correct, but it resolved "100%" against an element that never grew. Fixed: `this.style.
   display='block'; this.style.width='100%'` in `setConfig()` + a CSS fallback rule
   `ig-doorbell-card { display:block; width:100% }` in `injectStyles()`. **Landmine for
   the future**: if Shadow DOM is ever added, this will need revisiting (a real `:host` would
   replace the tag-name rule, which only works in light DOM).

2. **The user's suspicion about the audio backchannel (browser mic → doorbell speaker) having no
   real audio despite the UI showing "mic active".** The muted-track+`replaceTrack()` pattern
   itself (`toggleTalk()`/`buildNativePeerConnection()`) is correct and equivalent to the
   already-verified web dashboard's (`main/webtask.c` in `IG_Doorbell`, Phase 9) — it was NOT the
   cause. Real cause: `_teardownConnectionObjects()` (the single teardown point, also used by
   Q19's reconnection watchdog) closed `pc`/signaling but never reset the talk state —
   after ANY reconnection (including a spontaneous one from the aggressive
   `disconnected`→reconnect criterion), the new `RTCPeerConnection` is born with a new muted track
   but the UI kept showing "mic active" indefinitely, without ever re-attaching the real
   microphone. Fixed: `_teardownConnectionObjects()` now stops the real `localAudioStream` and
   resets `talkActive`/the button to "off" on any teardown — a reconnect does NOT reactivate
   the mic on its own, the user has to tap again (an explicit decision: visible and predictable,
   not a silent auto-reactivation that would add another race).

3. **A brief "❌ Error" flash on a cold dashboard load before settling into the correct state.**
   `startNativeSession()` treated the momentary absence of `this._hass.connection`
   (a genuine startup race: HA can insert the element before the `hass` setter has been invoked
   with a hydrated instance) as a TERMINAL error with no retry at all — unlike any other failure
   in that function. The element gets remounted shortly after with `hass` already ready (hence why
   it looked like it "settled on its own": a second, luckier attempt papered over the first, the
   function itself was never fixed). Fixed: silently retries every 250ms for up to ~5s before
   genuinely giving up.

Verification in all three cases: `node --check` (syntax) + structured reading/reasoning about the
code — **no access to a real browser/HA in this session** (same limit as Q19). Pending
visual/on-hardware confirmation by the lead/user; the exact checklist of what to verify in each
case is in `COORDINATION.md` Q22.

**Visual redesign aligned with the Figma mockup + complete removal of the legacy `go2rtc` mode
(2026-07-10).**

1. **Visual language from the Figma mockup** (same as `android_app`/`ios_app`, an explicit user
   decision): exact palette (`--ig-lime #78C800`, `--ig-cyan #00C4D4`, `--ig-blue #1976D2`,
   `--ig-surf1/2/3` for dark backgrounds), scoped as custom properties on `.ig-container`
   (never on `:root` — this card doesn't use Shadow DOM, so `:root` would leak into HA's entire
   document). Video frame (`.feed-wrap`) with ~22px rounded corners and the HUD overlaid INSIDE
   the video itself: `.live-tag` (dot + text, replacing the old standalone `.status-badge` —
   pulses red only in `live`/`open` state, a different color per state via `data-state`),
   a cyan `.audio-pill` (only with the mic active), an amber `.motion-pill` (only with
   `motion_entity` configured and `on` — **never visible with the mic active**, an explicit user
   rule, applied in `_updateMotionPill()`). Asymmetric action buttons (`.btn.mic` 80px, the star,
   with a pulse ring via `.pulsering` when active, `.btn.door` 60px secondary — exact sizes, see
   the precision pass further below). New status line below the video (`.status-line`,
   different from `.live-tag` — that one is about the CONNECTION STATE, this one is about the
   DOOR STATE): a real green countdown ("Door open · Closing in Ns", `_startDoorCountdown()`)
   on opening, gray "Sistema operativo" at rest. Mode chips (`.mode-row`, optional via the
   `mode_entity` config, an arbitrary `select.*`) with an icon+color per mode (`MODE_META`) — the
   matching between HA's real label and a known mode (normal/away/night/custom) is by
   case-insensitive *substring* (`_modeKeyFor()`), deliberately tolerant because the exact
   string firmware_cloud would publish for the mode entity wasn't finalized at the time of this
   change; an unrecognized option still renders (a generic, untinted chip), never hides the
   whole row. Mockup elements that were NOT copied (an explicit decision, they don't apply to an
   HA card): a device selector with a dropdown (one card = one device), a branding header
   (logo+notifications — HA already has its own navigation), a row of links to
   Recordings/Settings as "screens" (the card doesn't navigate to screens of its own).

2. **Legacy `go2rtc`/`gateway` mode COMPLETELY REMOVED** (an explicit user decision —
   **breaks compatibility** for any install still using `stream:`/`go2rtc_url:` instead of
   `device_id:`, see the notice in `README.md`). Removed from
   `custom_components/ig_doorbell/frontend/ig-doorbell-card.js`: `this.mode` (native is the only possible mode now),
   `connectGo2RTCWebSocket()`, `this.vlcWS`, the visual editor's `stream`/`go2rtc_url` inputs,
   the `ed_stream`/`ed_url` translation keys across all 9 languages. `setConfig()` now requires
   `device_id` directly (it used to accept `stream` as an alternative). `startWebRTC()`
   simplified to always call `startNativeSession()`. Reused the same failed-`getUserMedia()`
   notice in `toggleTalk()` to add a `console.warn` (previously the error was swallowed
   silently, with no trace at all, not even in the console).

Verified with `node --check` (syntax OK after every edit) — **no access to a real browser/HA
in this session**, the result couldn't be confirmed visually. Verification checklist for the
lead/user in `COORDINATION.md` Q22-bis.

**Precision pass with EXACT values from the real source code (2026-07-10, same day) — the lead
went from the reconstructed mockup/screenshots to the literal values in `android_app`/`ios_app`'s
source code.** Adjustments on top of what was already built in Q22-bis:

- Button sizes fixed from 76px/56px (approximate) to **80px/60px exact**.
- Palette completed with the 4 missing tokens: `--ig-bg #070D1A` (previously an approximate
  `#05070c`, now used in `.ig-container`/`ha-card`), `--ig-text #E8F0FE` (previously the
  HUD text was plain `#fff`), `--ig-faint #334155` and `--ig-blue-dark #1565C0` (both defined as
  available custom properties but with NO clear semantic slot in the card's current design — not
  forced into an artificial use just because they exist in the palette; documented here in case a
  natural spot for them shows up later).
- **Two HUD pieces that were completely missing**, added for the real visual parity the user
  asks for (app→HASS→app as the same product):
  - Overlaid clock top-right (`#hud-time-hm`/`#hud-time-date`, monospaced font,
    large hour:minute + small date) — `_updateHudClock()`, a 1s `setInterval` started in
    `render()` and stopped in `disconnectedCallback()`. It's the browser's own clock (decorative,
    like any security-camera overlay), not data from the device.
  - Signal bars, bottom-right corner (`.hud-sig`, 4 bars). **A deliberate adaptation, not a
    literal imitation**: the mockup uses them for the device's own WiFi RSSI, data this card has
    no way to know (there's no HA entity for it) — instead of inventing a fake number, the bars
    reflect the WebRTC connection's real `data-state` (the same attribute `.live-tag` already
    paints, also propagated to `.feed-wrap` from `_setLiveState()`): all lit while live, partial
    while `connecting`, the first one red on `error`. Honest about what the card can genuinely
    know, in the same place/visual style as the mockup.
  - The volume control (a real feature of the card, with no equivalent in the app's mockup) was
    relocated next to the signal bars in the bottom-right corner (`.hud-bottom-right`) instead of
    competing for the "Audio active" pill's exact spot (which IS 1:1 with the mockup, bottom-left
    corner).

Verified the same way as the rest: `node --check` after every edit, with no real browser/HA
available.

**Real bug FIXED (2026-07-10, same day): two failure points in `startNativeSession()` left the
card on "Error" forever, with no retry at all** — investigated from a real report by the lead (a
card on real HA, "IG DoorBell p4 v2", showing a persistent "Error", a suspicion of an old/disabled
test `device_id`). Confirmed by reading the code (with no access to that real instance): it's the
only place in the whole file where a failure did NOT schedule a reconnection, unlike
`nativeWS.onclose`, `'sessions_full'`, connectionState `failed`/`disconnected`, the 20s watchdog,
and a received `bye` — all of those DO call `_scheduleReconnect()` (and the two that don't
explicitly, `nativeWS.onclose` and `sessions_full`, are already covered because
`_startLifeWatchdog()` starts before them and would end up reconnecting anyway once it hits 20s
with no life signal). The two fixed points COULD run BEFORE the life watchdog started (which
only starts after `buildNativePeerConnection()`), so they had no safety net at all:

1. `hass.connection` still hasn't shown up after ~5s of silent retry (line ~762) — previously a
   terminal `return` with the badge set to "Error"; now it also calls `_scheduleReconnect()`.
2. The `catch` wrapping `get_connection_info`/`buildNativePeerConnection()`/signaling
   (line ~792) — previously it only set the badge to "Error"; now it also calls
   `_scheduleReconnect()` after the error message. Covers exactly the suspected case: if
   `get_connection_info` fails (e.g. because that `device_id` no longer has a
   valid/paired entry in the `ig_doorbell` integration — consistent with an
   old/disabled test device) or `startRelaySignaling()` rejects (the relay doesn't open the
   connection, unauthorized device), the card now retries with the usual backoff instead of
   staying dead. If the device genuinely no longer exists, this simply retries in a loop
   in the background (the same principle already established in Q19: better to keep retrying
   silently than a permanent "Error" with no recovery path except manually reloading the page).

This doesn't resolve whether "IG DoorBell p4 v2" is, indeed, a real device already
discontinued (that can only be confirmed by looking at the list of paired devices in the
`ig_doorbell` integration, out of this session's reach) — but if it is, with this
fix the card should stop showing a permanently fixed "Error" and instead keep visibly
retrying (badge "Connecting...") in a loop, which is the correct behavior whether the device
comes back someday or not.

**HASS→speaker backchannel mute, CONFIRMED and FIXED with real Playwright data
(2026-07-11) — see `COORDINATION.md` Q24/Q24-bis for the full analysis.** Critical data point from
the user: the device's own web dashboard and the Android/iOS apps DO have real bidirectional
audio — ruled out firmware/protocol from the start, it was a bug specific to this card's JS.

A line-by-line comparison against the dashboard confirmed the cause with real data (not just
theory): the SDP answer this card generated said **`a=recvonly`** on the audio line, even though
`audioTransceiver.direction` read as `sendrecv` at that very instant — the device, as the
offerer, never expected audio from the browser. The code order (muted track +
`direction:'sendrecv'` before `createAnswer()`) was already correct, so it wasn't a sequencing
problem. The one real code difference left unexplained against the dashboard (same creation
order in both: video first, audio after): the card used an explicit
`pc.addTransceiver(dummyTrack, {direction:'sendrecv'})`; the dashboard uses
`pc.addTrack(dummyTrack)`. By WebRTC spec they should be equivalent — the real Playwright data
said otherwise. **Fixed**: changed to `pc.addTrack(dummyTrack)`, retrieving the
transceiver with `pc.getTransceivers().find(t => t.sender === audioSender)` so as not to touch the
rest of the code. **Honest note**: there's no definitive explanation for WHY they diverge in
practice despite being theoretically equivalent — documented as "fixed with real empirical
evidence", not "fully understood" (possibly a real Chromium implementation nuance not precisely
described in the spec). If it reappears, `chrome://webrtc-internals` in a real session would be
the next step to dig deeper.

The diagnostic instrumentation (`DIAG audio` in the console) that made it possible to isolate
this stays in the code — useful for any future regression of the same kind: a log at transceiver
creation, in handling the SDP offer (negotiated direction + the real `m=audio` line), in
`toggleTalk()` (getUserMedia/replaceTrack step by step), and probing of `outbound-rtp`
(`_startAudioSendDiagnostics()`) every 3s while the mic is active.

**Real verification partially completed (2026-07-11)**: the lead repeated the test with
Playwright against real HA. **SDP negotiation CONFIRMED fixed**: `currentDirection=sendrecv`
(previously `null`/mismatched) and the answer says `a=sendrecv` (previously `a=recvonly`) — the
`addTransceiver()`→`addTrack()` fix genuinely works. **`bytesSent`/real audio could NOT be
verified**: the test environment reaches HA over `http://192.168.1.10:8123` (a bare LAN IP, not
HTTPS) — `navigator.mediaDevices` is `undefined` there (`isSecureContext:false`), so
`getUserMedia()` fails BEFORE ever reaching anything from this fix, regardless of whether the fix
is correct. Confirmed as a limitation of the test sandbox (not of the real product, which is
served via Nabu Casa/HTTPS or the app). **Status**: SDP negotiation CLOSED; end-to-end audio
delivery pending an environment with real TLS — not fully closed. I have no way to complete this
last piece either (zero browser access in this session, not even Playwright).

---

# HANDOFF NOTE — branch `feature-multicliente-calidad` (2026-07-26)

Written so someone else (or another agent) can carry on without me. The **contract** is
`API_CONTRACT.md` §1.4-ter in the firmware repo — this is only the state of the work.

## Important notice about this repo's git state

`main` was still pointing at `v1.0.0` and **the whole later native redesign was uncommitted**
(months of work living only in this PC's working directory). This branch's first commit
(`Base: previous work…`) captures it as-is, without touching a line, so the multi-client
commits have a readable diff. **Nothing in this branch is in `main` yet.** The same was true,
even worse, in `ig-doorbell-hass`: that repo had ZERO commits.

## What's been done

The contract's three mechanisms, over the signaling channel the card already used (local
SSE+POST with `?token=`, remote relay WS) — no new endpoint or transport:

| Mechanism | State in the card |
|---|---|
| Talk turn | outgoing `talk_request`/`talk_release`; incoming `talk_granted`/`talk_denied`/`talk_state`. The mic **only** opens with a real `talk_granted` |
| Client counter | a `👥 N` pill top-left, next to the *live-tag*. Only appears once `session_info` arrives |
| Quality | an Auto/High/Low/Audio-only selector bottom-right, with `quality`/`quality_state` and the reason for automatic changes |

**Design decisions worth not undoing without reading this:**

1. **Denied ≠ mute.** A `talk_denied` leaves the user in **listen-only** (hears the doorbell,
   mic closed) with the reason written out, not in an ambiguous state. Mic and listening are two
   axes, not one. Real detail: the `<video>` is born `muted` **out of necessity** (the browser's
   autoplay policy — with sound, `play()` would be rejected and there wouldn't even be an image);
   unmuting requires a user gesture, and pressing the mic button **is** that gesture.
   That's why "listen-only" can only be activated from a tap, never on its own.
2. **Never open the mic because of a message we didn't request.** The relay does **fan-out** to
   all clients on the same `device_id`: someone else's `talk_granted` could open this user's
   microphone without them touching anything — a privacy bug, not a UI one. This finding
   uncovered the same bug in all three apps and ended in a **contract resolution common to
   card/Android/iOS** (2026-07-26) with three rules that **must not be reverted while
   "simplifying"** (`_talkMsgIsForUs()`; the cases in block 12 of `tests/card/sim_multicliente.js` fail
   if any of them is removed):
   1. **Never learn your own identity from a message you're currently validating** — it's
      circular: if `talk_granted` could set `_slot`, the comparison would always be true and
      wouldn't validate anything. Android had exactly that bug (`_mySlot ??= msg.slot`).
   2. The own slot is learned **only** from `offer` and `session_info`.
   3. **Both** guards are required (an own request in flight **and** a matching slot), and with
      an **unknown** own slot it's **rejected**. This last part was this card's weak link
      until the resolution: it covers the one case `_talkPending` **cannot** stop — two
      users tapping the mic at the same time, both with a request in flight, and one's
      `talk_granted` reaching the other. Verified in the firmware that `sig_out_push()` sets
      `slot` on every message over both transports (including the offer), so rejecting
      produces no false negatives: the own slot is already known before the mic button gets
      enabled. Documented exception: a message **without** `slot` (intermediate firmware) IS
      accepted, relying on `_talkPending` — there the data doesn't exist, and rejecting would
      leave the mic useless against that firmware.
3. **Degradation with old firmware = silence, not an error.** 3s with no reply to
   `talk_request` ⇒ the mic opens anyway, reporting it once, and subsequent taps in that
   session are instant. Quality probes itself on connecting
   (`quality:auto`, with one retry) and the selector **doesn't appear** without confirmation —
   a control that does nothing is a button that lies. Everything gets re-probed on every new
   session, so the card finds out about a firmware update on its own without reloading.
4. **`audio_only` and the life watchdog.** In that mode the device stops sending video *on
   purpose*; the watchdog (which measures the **video** inbound-rtp's `packetsReceived`)
   would have reconnected in a loop every 20s. In that mode, and only that one, the life signal
   becomes the audio. It genuinely happened to the Android app.
5. **"Low" is labeled, not abbreviated.** It's ~1 frame/s (keyframes only), not smooth video at
   lower quality: each option carries a second explanatory line and turning on "Low" gives a
   notice. No HD/SD — they suggest a resolution change when what changes is the frame rate.
6. **Responsive via `@container`, not `@media`.** An HA card's width has nothing
   to do with the window's.

## What's missing / next step

- [ ] **Test in a real browser against a real doorbell.** None of this has been seen
      working from here: there was no browser or hardware in this session. **The firmware with
      the whole contract IS already flashed and validated on the real device by the lead
      (2026-07-26, a clean regression)** — i.e. the other end exists and works; all that's
      missing is exercising THIS card against it. Minimal script: two tabs → counter reaches 2 in
      both; mic in A → B sees "busy" and gets `talk_denied` on tapping; releasing A → B sees the
      channel-free notice; `low` → a clean ~1 fps; `audio_only` → frozen image, intact audio and
      **no reconnections** in 60s; and with a doorbell on old firmware, that the mic still opens
      after 3s and the quality selector doesn't appear.
- [ ] Verify on HA with **a light theme**: the card is a dark island on purpose (product
      identity, a Q22-bis decision), but the quality menu is new and hasn't been seen.
- [ ] Once the firmware consumes RTCP RR, unsolicited `quality_state` with
      `auto_loss`/`auto_bandwidth` will arrive: the card already renders them, but they've never
      actually been received.
- [ ] Publish a HACS release. Watch out for the `/local/` resource's cache (see `CARD_BUILD_ID`,
      currently `2026-07-26-multicliente-calidad`): if you don't see that value in DevTools, the
      browser is serving a stale copy.

## How to verify without a browser

```
node --check custom_components/ig_doorbell/frontend/ig-doorbell-card.js
node tests/card/sim_multicliente.js custom_components/ig_doorbell/frontend/ig-doorbell-card.js     # 60 checks
```

`tests/card/` is new (2026-07-26): loads the real `dist/` file, captures the class via
`customElements.define` and exercises the state machine against minimal DOM doubles.
**It doesn't replace** a real test: it doesn't touch WebRTC, SSE, or the relay. When you change
the talk turn or quality, run it — it has cases for the old-firmware paths, which are exactly
the ones nobody tests by hand.

## Contract issues found (reported, not fixed by me)

- **Only ONE client fits remotely**, not N. The firmware stores a single `g_remote_slot` and a
  new `request_offer` closes the previous remote session. Turn arbitration between two
  **remote** clients can't work, and the counter can only reach "local sessions + 1". It's
  pre-existing, not introduced by the multi-client contract, but it limits it.
- **`webrtc_clients` from `GET /api/get_states` is unreachable for the HA integration**
  (that route requires a session cookie; the integration only has the `pair_app` credential).
  Doesn't matter for the card — it gets it via `session_info` — but it invalidates that field as
  a source for any HA entity. See the reasoned decision in `ig-doorbell-hass`'s
  CLAUDE.md.

---

# HANDOFF NOTE — branch `feature-giro-imagen-audio-confirmacion` (2026-08-03)

Four whole contract sections this card was ENTIRELY missing, plus a real bug measured on the
local path. Everything verified against the real doorbell (`0123456789abcdef`) and Iñaki's real
Home Assistant, with a real browser — not just `node --check`, which is how almost everything
else in this repo had been verified until now.

## How it was tested without touching anything in Iñaki's Home Assistant

Worth writing down, because it's reusable and avoids the "it can't be tested" excuse:
go in with Playwright, **inject the branch's `dist/` into the page** (`addScriptTag`) and
mount the card by hand, taking the real `hass` from the frontend itself (`document.querySelector
('home-assistant').hass`). Zero changes to their install: no Lovelace resource, no dashboard, no
entities. The card HACS serves there is still the published one.

One harness detail that cost a session's worth of the doorbell's slots: the element has to be
**added to the DOM BEFORE `setConfig()`**. The other way around, `render()` starts one session and
`connectedCallback()` starts another, and the doorbell runs out of slots because of the harness,
not the card.

## 1. The rotation (§1.9) — the bug that motivated all of this

The camera is mounted rotated 90° inside the housing **on purpose** and this card was rendering
the image sideways. It wasn't a misconfigured setting: `rot` wasn't read anywhere in the file.

Verified with the real device at `rot=90`: it arrives in `session_info`, the frame switches to
9:16, the video box is declared with width and height **swapped** (648×398 inside a
398×648 frame) and rotated around its center, so that after the rotation it exactly fills the
space. A with/without comparison captured in the same session: without the fix the OSD's
timestamp runs **vertically** along the left edge; with it, it reads horizontally at the top and
the scene is upright.

What must NOT be "improved" later without rereading §1.9: **it doesn't crop to fill**. Zooming to
cover the width throws away the top and the bottom — exactly what was gained by rotating the
sensor.

The fullscreen side rail is decided by **measuring the frame in JS**, not with a
`@container`: `.feed-wrap` is `container-type: inline-size` and that's why it doesn't support
ratio queries. Changing it to `size` to be able to query it would affect the width rules that
already exist.

## 2. Watching isn't listening (§1.10)

The speaker starts muted and only plays for an explicit reason. Along the way, a control that
**lied** got fixed: the slider changed the volume of an element that stayed muted. Now the icon
is a real button, and the slider, when raised above zero, counts as the gesture the browser
requires to unmute.

The doorbell ring is read from an optional HA entity (`ring_entity`) because that signal doesn't
travel over WebRTC signaling. Both `binary_sensor` (transition to `on`) and `event` (a timestamp
change) are supported, and **the first read never fires**: a sensor that was already `on` when
opening the dashboard isn't a call happening now.

⚠️ **Where that entity comes from changed on 2026-08-24**, and this paragraph used to say the old
way: the firmware published it over MQTT. MQTT was retired (§4), and now the **integration**
creates it as an `event`-type entity -- the events one, which carries everything the doorbell
reports. The card needs no change, because its `event` branch already existed; what changes is
**which one has to be configured**, and that an older ring `binary_sensor` stops updating.

## 3. Double-tap to open (§1.8)

All three rules are implemented and tested, including the 3s expiry (the test case genuinely
waits). Against the real doorbell the important thing was checked: the first tap sends **no**
`open` at all, and neither does an immediate bounce. None of Iñaki's doors got opened.

## 4. The local path: two separate things

**(a) The reachability probe was throwing away the local path for being slow.** Measured with
`curl` against the device on the same network: the ESP32's TLS handshake takes 0.40–0.90s and
the full request 0.46–1.06s. The probe had 1200ms and treated **its own expiry** as a verdict of
"unreachable". Seen across two consecutive runs: 1094ms (barely passed) and 1202ms (failed, and
the session went out to Germany via the relay to watch a hallway camera). Fixed: expiring no
longer decides anything, the 3000ms timeout does, which knows whether the offer arrived. After
the change, with the same doorbell: probe 1340ms → **offer received via SSE, local session,
never touching the relay**.

**(b) The integration's signaling proxy existed and this card wasn't using it.** It's already
wired up and is the preferred path (`get_local_signal_url` → `/api/ig_doorbell/signal/
<device_id>`), falling back to the public hostname if the integration is older. **NOT verifiable
yet**: the integration installed on Iñaki's HA answers `unknown_command`, meaning it predates
commit `71fb052` in the `ig-doorbell-hass` repo. What WAS verified is the
degradation: the card detects it, logs it, and continues via the usual path.

Once that integration is updated there's **one specific unknown** worth checking: the tab-close
`bye` uses `sendBeacon` against the **signed** URL, and it's not confirmed that Home Assistant
accepts a signature on a POST. If it doesn't, the only thing lost is the slot's immediate
release, which the doorbell recovers on its own after 20s — but it's worth checking rather than
assuming. Normal signaling POSTs don't depend on that: they go through `hass.callApi`.

## 5. Nothing happens in silence (§1.0, a new rule from 2026-08-04)

Of the three cases this rule flags for this card, **one wasn't a gap but a lie**:
`triggerNativeOpen()` painted the button green and the label "Open" **on tapping**, before the
doorbell had answered anything. If `open_result` never arrived, the user was left staring at a
button that said "Open" with the door closed. Now there are three states that never jump ahead of
each other: **Opening** (sent, spinning icon, inline notice), **Open** (confirmed by
`open_result`) and **no response** after 6s, which explicitly says the door has NOT
opened. The `unlock_entity` path had the same problem and now waits for `callService`: a wrong
domain used to fail silently before, with the button green.

Verified on a real browser against the doorbell, **intercepting the `open` message on purpose
so as not to open one of Iñaki's doors** (`door_m=1`, it would go to Home Assistant): "Opening"
with an amber label, and after 6s the indicator ends with "The doorbell didn't respond — the
door has NOT opened".

The other two: falling back to the relay says so on the status line (the slowest, least
self-explanatory step), and a reconnection paints the countdown to the next attempt — the
loading spinner already spun, but it spun **saying nothing**, exactly the case the rule calls
worse than having no indicator.

## 6. Rejected credential — genuinely tested against the relay

With a made-up credential, the relay closes with **4401** and the card writes a sticky, translated
notice ("The doorbell rejected the pairing — re-pair it in Settings › Devices & Services")
instead of silently retrying behind an endless "Connecting...". It clears itself as soon as video
comes back.

**What this notice does NOT cover, and needs to be known**: after a doorbell factory reset the
NVS gets wiped, and with it `paired_app_hash[]`, so **the local path gives 401 but the remote one
keeps working** (the cloud keeps the `app_instance`). Meaning the card would keep giving video via
the relay, slower, saying nothing about it. `EventSource` doesn't expose the status code, so over
the direct path that isn't detectable. **With the integration's proxy it WOULD be** — it passes
the 401 through as-is, precisely for this. One more argument for updating the integration.

## The simulation already covers what's new

`node tests/card/sim_multicliente.js custom_components/ig_doorbell/frontend/ig-doorbell-card.js` — blocks 13 (rotation), 14
(sound) and 15 (door) are new. And **two checks in block 12 had been red since 2026-07-29**:
they described a talk-turn rule that flipped sign that day (commit "the four bugs seen on the
real iPhone") and nobody updated the case. A suite that's red by default stops warning about
anything, so the case was fixed to explain why it changed, not the code.

## What's left to verify on hardware

- [ ] Microphone and bidirectional audio: Iñaki's HA is served over **plain HTTP** (a LAN IP),
      so `navigator.mediaDevices` is `undefined` and `getUserMedia()` fails before touching
      anything in this card. It's the same old limitation of the test environment, not the
      product. Needs an origin with real TLS (Nabu Casa).
- [ ] The fullscreen side rail on a genuinely landscape tablet.
- [ ] The path through the integration's proxy, once the integration is updated.
- [ ] `ring_entity`: tested in simulation with both entity shapes, not with a real ring
      sounding.

---

**Do not commit/push without explicit authorization.** Work directly in this folder, no
isolated worktree.

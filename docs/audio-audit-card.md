# Audio audit — the Home Assistant card (`frontend/ig-doorbell-card.js`)

The card against the nine rules of `docs/audio-invariants.md` (firmware repository). Branch
`audio-audit-card`, from `origin/main`. Integration and card **1.5.1 → 1.5.2**. Not deployed to any
Home Assistant, no release published.

## Result

| | `tests/card/audio_invariants` (32 checks) | the rest of `run_all.js` |
|---|---|---|
| card 1.5.1 (before) | **red on C1, C1b, C2, C3 and C4** (the control job, `fixtures/legacy/card_1.5.1.js`) | all green (baseline run 2026-10-06, before any edit) |
| card 1.5.2 (this branch) | **32 of 32 green, mutants MC1–MC6 all caught** | see "Suite" below |

Run it: `cd tests/card && npm install && node run_all.js` (≈12 min), or only this bench with
`ONLY_JOBS="audio_invariants,CONTROL audio_invariants" node run_all.js`.

**What the bench is and is not.** The REAL card file in a real Chromium with a fake microphone
(real `MediaStreamTrack`s; "microphone open" is the browser's own `readyState`, and every
`getUserMedia()` call is counted). Home Assistant and the doorbell are doubled
(`ui_v1_10_0/harness.js`): the doorbell's messages arrive on the card's real signalling handler,
ICE never connects, so **no audio really flows** — what is measured is whether a capture exists,
what the card shows, what it sends, and whether the `<video>` is muted or paused. The companion
WebView's autoplay rule is EMULATED (`index.html` says why: desktop Chromium does not refuse a
`MediaStream`). Instrument controls in every run (A0): the counter sees a track the bench opens
and sees it stop; the autoplay emulation refuses an unmuted `play()` on an untouched page and
allows it on a touched one.

**Nothing here touched a real doorbell or the real Home Assistant.** The card's media path to a
real doorbell was last verified by Iñaki on 1.4.4; this audit did not change it.

## Findings and fixes

MEASURED = red on 1.5.1 and green on 1.5.2 in the bench, with a mutant that turns it red again.

| id | rule | on 1.5.1 | fix (1.5.2) | status |
|---|---|---|---|---|
| C1 | 8 | sound refused by the browser (a ring on a wall panel nobody touched, a new stream, a resume): a 5 s "Tap the speaker to listen", then a mute picture with nothing saying why | a standing **"Tap to hear the street"** control on the picture (`#hear-btn`), from the refusal until it is tapped or the street sounds; the ring's "sound on" notice is withdrawn when the sound was refused | MEASURED C1, C1b, C1c (control), mutant MC1 — refusal EMULATED |
| C2 | 6 | no answer to `talk_request` in 3 s → the mic opened anyway, in both branches (L=1, shown open) | the request ends: nothing captured (`getUserMedia` never called), `talk_release` sent, "The doorbell did not give the talk turn. Tap the microphone again."; a second tap asks again. `_talkUnsupported` removed | MEASURED C2 (with and without `session_info`), C2p (control), mutant MC2 |
| C3 | 5/6/9 | the signalling SSE failing under a live session only closed the channel: the capture and the "open" label lived on until the 20 s life watchdog | the session ends at once (`_scheduleReconnect`): L=0 within 300 ms, a new session starts, the mic is not reopened by it, the reason is said when the picture returns, and whoever was hearing still hears | MEASURED C3, mutants MC3, MC5 |
| C4 | contract §1.10 | closing the mic RESTORED the sound to what it was before opening it | closing the mic closes the speaker, always; a pause or the watchdog closing it leaves the listening state alone, so "hidden and back" returns to the same state | MEASURED C4, C4b, mutants MC4, MC6 |
| C5 | 8 (found by the bench, not by reading) | a `play()` aborted because a newer stream replaced the element's source was read as "sound blocked": it turned the sound off for someone listening, on any quick re-session | `AbortError` / a superseded stream is ignored; the new stream applies the wish itself | MEASURED (C3's "still HEARS" check was red until this) |
| C6 | 8 (found by the bench) | a notice flashed when the new stream arrived was erased by the start-up's own status resets before anyone could read it (status line: "retrying in 2s" → "1s" → empty) | the mic-lost notice is sticky for 9 s or until the mic is tapped | MEASURED C3 |

## Rule by rule

| rule | verdict | evidence |
|---|---|---|
| 1 hands-free by default | holds: the street starts muted by contract §1.10; a ring, the speaker button or the mic open it | R1, C1c, C2p — MEASURED (element state; no real audio in this bench) |
| 2 earpiece only by proximity | not applicable to a web view: the card chooses no route | READ |
| 3 car / headphones win | not applicable: the card never sets a sink or a device id | READ |
| 4 no channel without a stream | holds: hidden → `<video>` paused here, `live_pause` sent and re-sent until `live_state`, hang-up after the grace and by wall clock; back → `live_resume` and the same state | H1, C4b — MEASURED; `mic_privacy`, `idle_release_network`, `mount_sessions` benches (already green) |
| 5 the voice path closes at once | was broken on a dropped signalling (C3), fixed; hide, `pagehide`, pause, teardown, doorbell switch, leaving the DOM already stopped the tracks | C3, C4b — MEASURED; `mic_privacy` P1–P14 (already green) |
| 6 never open unasked, never silently dead | was broken (C2), fixed; a ring never opens the mic; denied / taken turn close it and say why; a plain-HTTP page explains why there is no microphone | C2, T1, T2, R1 — MEASURED; `mic_https_1_1_0` |
| 7 the right volume | not applicable: the card has no volume control (removed 2026-09-25), the element is always at 1 | READ |
| 8 failures are visible | was broken (C1, C5, C6), fixed; closing the mic by hand shows no notice | C1, C1b, C3, N1 — MEASURED, the refusal EMULATED |
| 9 every state | see the matrix | |

Counter badges: the card has none (the bell is a dot, no number). Nothing to change for `+99`.

## State matrix

One route column (whatever the OS gives the web view). "capture" = live microphone tracks.

| state | street audio | capture | evidence |
|---|---|---|---|
| card visible, just watching | element muted | none | R1 before the ring — MEASURED |
| listening (speaker tapped) | sounding | none | H1 — MEASURED |
| mic open (turn granted) | sounding (follows the mic) | 1 track | C2p — MEASURED |
| turn asked, never answered | as it was | none, never asked of the browser; said | C2 — MEASURED |
| turn denied | sounding (listen only), said | none | T2 — MEASURED |
| turn taken by another client | sounding, said | stopped | T1 — MEASURED |
| mic closed by hand | muted | none, no notice | C4, N1 — MEASURED |
| ring, page touched before | sounding, "someone is calling" | none | R1, C1c — MEASURED |
| ring, page never touched (wall panel) | picture plays muted + the standing control | none | C1 — MEASURED, EMULATED rule |
| new stream while the sound was wanted, refused | same | none | C1b — MEASURED, EMULATED |
| hidden while listening | paused here + `live_pause` | none | H1 — MEASURED |
| hidden with the mic open, and back | paused; back: sounding, turn asked again, mic open again on the grant | stopped at once; reopened only on the new grant | C4b — MEASURED |
| signalling dropped mid-conversation | still sounding on the new session | stopped within 300 ms, not reopened, said | C3 — MEASURED |
| doorbell switched / card removed / `pagehide` | session torn down | stopped | `mic_privacy` P3, P5, P6 — MEASURED (existing bench) |
| quick-reply preview, recordings | the card plays neither: quick replies are sent to the doorbell, recordings open in Home Assistant's media browser | — | READ |
| voice disguise | not implemented in the card | — | READ |

## Suite

`node run_all.js` on this branch: see the last milestone commit of this branch for the run's
verdict (27 jobs: 19 benches and simulations + 8 controls). Two existing tests were CHANGED, on
purpose, because they asserted the behaviour this audit removes: `sim_multicliente.js` section 5
("mic opens anyway after 3s" → "the mic does NOT open") and its §1.10 check ("returns the sound to
how it was" → "closes the speaker"); `mic_privacy`'s mutant MA got a new anchor.

## Not verified here — for Iñaki, by importance

1. **The salon wall tablet (Android companion WebView)**: a ring on a panel nobody touched —
   does "Tap to hear the street" appear and does ONE tap give sound? The refusal is emulated here;
   only the tablet has the real rule. Also that the standing control does not cover anything needed
   during a call on that screen (it sits at 34 % of the picture's height).
2. **iOS Safari and the iOS companion app's WebView** (iPhone/iPad): the same refusal path, and
   whether the microphone indicator goes off the moment the card is hidden (rule 5).
3. **A real conversation through Home Assistant after the update**: mic open → voice at the door
   → close → the street goes silent (new: it used to stay on if you were listening first).
4. **A real signalling drop** (restart Home Assistant's proxy path or the Wi-Fi mid-call): the card
   should reconnect at once instead of after ~20 s, say why the mic closed, and still sound.
5. **A doorbell that does not answer `talk_request`**: the mic no longer opens. With the current
   firmware this should never be seen; if "The doorbell did not give the talk turn" shows up in
   normal use, that is a lost message worth a look, not a regression.
6. Remote viewing (relay + TURN, 1.4.4) was not re-run (`tests/card/remote_path` needs the VPS).

Not covered by the nine rules, noted: neither the card nor the web has the "Hang up" control of
§1.11-quater.

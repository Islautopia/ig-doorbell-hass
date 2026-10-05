# Audio audit — the Home Assistant card (`frontend/ig-doorbell-card.js`)

Audit of the card against `docs/audio-invariants.md` of the firmware repository (9 rules). **WORK IN PROGRESS —
read "STATE AT STOP" first.** Branch `audio-audit-card`, from `origin/main` (1.5.1).

## STATE AT STOP (2026-10-05, end of day — stopped by the coordinator, not finished)

- **No code changed on this branch.** Only this document. Integration version still 1.5.1.
- **Nothing was measured.** Every finding below is READ in the code. The baseline `node run_all.js` was started
  and killed at the stop before it reported: whether the suite is green on this machine today is NOT known.
- The real Home Assistant, the Waveshare and Ermita 10 were not touched. No browser is left open.
- `self-cleanup-on-remove` exists on origin (`3184e40`) and was not touched.

### Next steps, in order

1. `cd tests/card && npm install && node run_all.js` — the baseline, before any edit.
2. New bench `tests/card/audio_invariants/` on `ui_v1_10_0/harness.js` (as `mic_privacy` does), with mutants,
   and a control against a copy of today's card (`fixtures/legacy/card_1.5.1.js`).
3. Fix C1–C4 below, each with its check; bump `manifest.json` + `CARD_VERSION`; `docs/card.md` entry; changelog.
4. No deploy to the real Home Assistant and no release: the coordinator does that after review.

## Findings (all READ, none measured, none fixed)

| id | rule | finding | where |
|---|---|---|---|
| C1 | 8 | sound refused by the browser (a ring on a wall panel nobody touched, a new stream, a resume): the card re-mutes, sets `_audioOn = false` and flashes "Tap the speaker to listen" for 5 s. After that the picture is mute with the speaker simply "off": no standing control says why. The web has a persistent "Tap to hear the street" button for this; the card needs the wish kept apart from `_audioOn` and the same control | `_setAudioOn`, `setupRemoteStream`, `_resume` |
| C2 | 6 | no answer to `talk_request` in 3 s → `_startTalk()` anyway, in both branches ("older firmware" and "lost message"). The microphone opens and is shown open without the doorbell's turn; since firmware 2026-08-04 (implicit turn retired) the doorbell discards that audio, so it is an open mic talking to nobody | `_requestTalkTurn` |
| C3 | 5/6/9 | the signalling SSE failing AFTER the session is up: `es.onerror` → `abandonLocal()` closes the channel and that is all. Nothing tears the session down until the life watchdog (20 s, after the doorbell's own ~5 s): the capture and the "open" label live on for up to ~25 s | `tryLocalSignaling` `es.onerror` |
| C4 | contract §1.10 | closing the mic restores the sound to what it was before (`_audioOnBeforeMic`); the contract says closing the mic ALWAYS closes the speaker, nothing is saved or restored (the web does that). Care when fixing: a pause with the mic open must keep the listening state (§1.4-bis), and a session drop should not leave a user in a call deaf | `_stopTalk`, `_teardownConnectionObjects` |

Read and found in order (to be confirmed by the bench, not re-litigated): the mic registry and its watchdog
(`IG_MIC`, bench `mic_privacy`) — tracks `stop()`ped on hide, `pagehide`, pause, teardown, doorbell switch;
`_pause()` pauses the `<video>` locally besides `live_pause`, re-sends it until `live_state`, hangs up after the
grace and by wall clock; the `AudioContext` of the silent track is closed with its peer; taking a ring opens the
sound and never the mic; a plain-HTTP page explains why there is no microphone.

Counter badges: the card has none (the bell is a dot, no number). Nothing to change for the `+99` rule.

Not covered by the 9 rules, noted: neither the card nor the web has the "Hang up" control of §1.11-quater.

## Cannot be verified here

iOS Safari, the iOS and Android companion-app WebViews and the wall tablet kiosk: none can be driven from this
PC. The benches EMULATE the WebView autoplay rule (`mic_privacy/index.html`). Iñaki's iPhone/iPad and the salon
tablet close it.

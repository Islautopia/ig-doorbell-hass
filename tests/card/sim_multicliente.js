// Isolated simulation of the card's multi-client/quality state, with no browser and no HA.
//
//   cd tests/card && npm install && node run_all.js            <- runs this bench and every other one
//   node sim_multicliente.js <path-to-dist>/ig-doorbell-card.js   (standalone, a single build)
//
// Why it exists (2026-07-26): this repo has neither a build nor tests (an explicit decision, see
// CLAUDE.md), and all historical verification has been `node --check` + reading the code. The
// talk turn has too many states (requesting / granted / denied / revoked by the
// doorbell / firmware that doesn't reply) to trust just from reading: this exercises the
// REAL state machine of the dist file (not a copy) against minimal DOM doubles. It does NOT replace
// a browser test with a real doorbell - it doesn't touch WebRTC, SSE, or the relay.
// Loads the real dist/ file, captures the class via customElements.define, and exercises
// handleNativeSignal()/toggleTalk() against minimal DOM doubles.
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2];
const src = fs.readFileSync(path, 'utf8');

let CardClass = null;
function fakeEl() {
  const s = new Set();
  return {
    classList: {
      toggle(c, v) { if (v === undefined) v = !s.has(c); v ? s.add(c) : s.delete(c); },
      add(c) { s.add(c); }, remove(...cs) { cs.forEach((c) => s.delete(c)); },
      contains(c) { return s.has(c); }, _set: s,
    },
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k]; },
    querySelectorAll() { return []; },
    style: { setProperty() {}, removeProperty() {} }, textContent: '', title: '', innerHTML: '',
  };
}

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, setInterval, clearInterval,
  HTMLElement: class {},
  WebSocket: { OPEN: 1 },
  document: { createElement: () => fakeEl(), addEventListener() {}, removeEventListener() {} },
  // (1.1.0) The page this simulates is a SECURE context with a microphone API: since 1.1.0 the
  // card checks both before requesting the talk turn (a non-secure page gets the HTTPS notice
  // instead - that case has its own real-browser bench, mic_https_1_1_0).
  window: { addEventListener() {}, removeEventListener() {}, isSecureContext: true },
  navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('no device in the simulation')) } },
  customElements: {
    get: () => undefined,
    define: (name, cls) => { if (name === 'ig-doorbell-view') CardClass = cls; },
  },
};
sandbox.window.customCards = [];
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
if (!CardClass) { console.error('FAILED: could not capture the class'); process.exit(1); }

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); failures += 1; }
}

function newCard() {
  const c = Object.create(CardClass.prototype);
  c._hass = { language: 'es', states: {} };
  c.config = { device_id: 'abc', unlock_duration: 3 };
  c.sent = [];
  c.sendNativeSignal = (m) => c.sent.push(m);
  c._mark = () => {};
  c._flashes = [];
  c._flashStatusLine = (k) => c._flashes.push(k);
  c._resetStatusLine = () => {};
  c._updateMotionPill = () => {};
  c._setLiveState = (s) => { c._live = s; };
  c._startAudioSendDiagnostics = () => {};
  c._stopAudioSendDiagnostics = () => {};
  // _recordLifeSignal is NOT replaced: case 8 (the life watchdog in audio_only) depends on its
  // real behavior.
  // DOM doubles
  c.micButton = fakeEl();
  c.micIcon = fakeEl();
  c.micLabel = fakeEl();
  // play() and volume have been part of the double since 2026-08-03: §1.10's sound control
  // (_setAudioOn) calls play() on unmuting, because unmuting with no user activation can
  // make the browser PAUSE the element instead of throwing an error.
  c.videoEl = { muted: true, volume: 1, play: () => Promise.resolve() };
  c.volIcon = fakeEl();
  c.sndBtn = fakeEl();
  c.audioPill = fakeEl();
  // These three are born with display:none in render()'s real HTML - reproduce it here, or the
  // simulation would "find" something visible that in the real card is hidden from the start.
  c.clientsPill = fakeEl(); c.clientsPill.style.display = 'none';
  c.clientsCount = fakeEl();
  c.qualityCtl = fakeEl(); c.qualityCtl.style.display = 'none';
  c.qualityBtn = fakeEl();
  c.qualityIcon = fakeEl();
  c.qualityLabel = fakeEl();
  c.qualityMenu = fakeEl();
  // Real getUserMedia doesn't exist here: _startTalk falls into its catch. It's replaced with a double
  // that only marks the logical state, which is what this simulation wants to verify.
  c._startTalk = async () => {
    c.talkActive = true; c._listenOnly = false; c.videoEl.muted = false;
    c._setLiveState('open'); c._paintMicState();
  };
  // Initial state identical to setConfig()'s
  Object.assign(c, {
    talkActive: false, _slot: null, _talkHeld: false, _talkPending: false, _talkTimer: null,
    _talkGrantedAt: 0, _talkUnsupported: false, _listenOnly: false, _talkerSlot: -1,
    _clients: null, _quality: 'auto', _qualityEffective: null, _qualitySupported: null,
    _qualityProbeTimer: null, _qualityProbeAttempts: 0, _qualityMenuOpen: false,
    localAudioStream: null, dummyAudioTrack: { id: 'dummy' }, audioTransceiver: null, pc: {},
  });
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== 1. Turn granted (new firmware) ==');
  let c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 1, talker: -1 });
  check('slot learned from session_info', c._slot === 1);
  check('client counter = 2', c._clients === 2);
  check('clients pill visible', c.clientsPill.style.display === 'flex');
  check('pill highlighted with >1 client', c.clientsPill.classList.contains('multi'));
  await c.toggleTalk();
  check('talk_request sent', c.sent.some((m) => m.type === 'talk_request'));
  check('mic STILL closed (waiting for permission)', c.talkActive === false);
  check('button in "requesting" state', c.micButton.classList.contains('requesting'));
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('mic open after talk_granted', c.talkActive === true);
  check('turn marked as ours', c._talkHeld === true);
  await c.handleNativeSignal({ type: 'talk_state', slot: 1, talker: 1 });
  check('talk_state with our slot does not close the mic', c.talkActive === true);

  console.log('\n== 2. Turn denied -> listen-only ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: 1 });
  check('button marked "busy with another"', c.micButton.classList.contains('busy-other'));
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_denied', slot: 0, reason: 'channel_busy' });
  check('mic NOT open', c.talkActive === false);
  check('listen-only mode active', c._listenOnly === true);
  check('speaker unmuted (the doorbell can be heard)', c.videoEl.muted === false);
  check('clear notice to the user', c._flashes.includes('talk_denied_msg'));
  check('button NOT disabled', c.micButton.getAttribute('disabled') === undefined);
  await c.toggleTalk();
  check('second tap exits listen-only', c._listenOnly === false);
  check('talk_release sent on exit', c.sent.some((m) => m.type === 'talk_release'));

  console.log('\n== 3. The doorbell takes the turn away (5s of silence / another user) ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 2, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 2 });
  c._talkGrantedAt = 0; // skips the 1.5s anti-race grace period
  await c.handleNativeSignal({ type: 'talk_state', slot: 2, talker: -1 });
  check('mic closed on losing the turn', c.talkActive === false);
  check('left in listen-only, not disconnected', c._listenOnly === true);
  check('reason "silence" explained', c._flashes.includes('talk_silence'));
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  c._talkGrantedAt = 0;
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: 3 });
  check('reason "another user" explained', c._flashes.includes('talk_taken'));

  console.log('\n== 4. Anti-race grace period (stale talk_state right after granted) ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 }); // stale
  check('the freshly opened mic is NOT closed by a stale talk_state', c.talkActive === true);

  console.log('\n== 5. OLD FIRMWARE: nobody answers talk_request ==');
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  check('still waiting at 100ms', c.talkActive === false && c._talkPending === true);
  await wait(3200);
  check('mic opens anyway after 3s', c.talkActive === true);
  check('marked as firmware without turn support', c._talkUnsupported === true);
  check('user notified once', c._flashes.includes('talk_legacy'));
  check('no clients pill (session_info never arrived)', c.clientsPill.style.display === 'none');
  await c.toggleTalk();
  check('clean shutdown', c.talkActive === false);
  const sentBefore = c.sent.length;
  await c.toggleTalk();
  check('2nd tap is INSTANT (no new talk_request)',
    c.talkActive === true && !c.sent.slice(sentBefore).some((m) => m.type === 'talk_request'));

  console.log('\n== 6. Quality: probe, confirmation and automatic changes ==');
  c = newCard();
  c._slot = 0;
  c._probeQualitySupport();
  check('"auto" probe sent on startup', c.sent.some((m) => m.type === 'quality' && m.mode === 'auto'));
  check('selector HIDDEN until confirmed', c.qualityCtl.style.display === 'none');
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'auto', reason: 'user' });
  check('selector visible after the first quality_state', c.qualityCtl.style.display === 'block');
  check('marked as supported', c._qualitySupported === true);
  c._sendQuality('low');
  check('manual change sent', c.sent.some((m) => m.type === 'quality' && m.mode === 'low'));
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'low', reason: 'user' });
  check('effective mode updated', c._qualityEffective === 'low');
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'low', reason: 'auto_loss' });
  check('automatic change explained with its reason', c._flashes.includes('q_auto_loss'));
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'audio_only', reason: 'auto_bandwidth' });
  check('bandwidth reason explained', c._flashes.includes('q_auto_bw'));

  console.log('\n== 7. Quality with OLD FIRMWARE (nobody answers) ==');
  c = newCard();
  c._slot = 0;
  c._probeQualitySupport();
  await wait(8600); // 2 attempts x 4s
  check('retry before giving up', c.sent.filter((m) => m.type === 'quality').length === 2);
  check('marked as NOT supported', c._qualitySupported === false);
  check('selector hidden, no dead button', c.qualityCtl.style.display === 'none');
  check('no notices bothering the user', c._flashes.length === 0);

  console.log('\n== 8. Life watchdog in audio_only (must not loop-reconnect) ==');
  c = newCard();
  c._qualityEffective = 'audio_only';
  c._lastLifeSignalAt = 1;
  c._prevPacketsReceived = null;
  let audioPkts = 100;
  c.pc = { getStats: async () => [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },   // frozen on purpose
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: (audioPkts += 50) },
  ] };
  c.pc.getStats = async () => { const arr = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: (audioPkts += 50) },
  ]; return { forEach: (f) => arr.forEach(f) }; };
  let reconnects = 0;
  c._scheduleReconnect = () => { reconnects += 1; };
  await c._checkLifeWatchdog();
  await c._checkLifeWatchdog();
  check('audio counts as a life signal in audio_only', reconnects === 0);
  // Same audio_only mode but with audio ALSO stopped: the watchdog must keep doing its
  // job (the relaxation is about which counter is watched, not about no longer watching anything).
  audioPkts = 999; // frozen: (audioPkts += 50) no longer applies because it's reassigned below
  c.pc.getStats = async () => { const arr = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 999 },
  ]; return { forEach: (f) => arr.forEach(f) }; };
  await c._checkLifeWatchdog();                              // takes the baseline
  c._lastLifeSignalAt = c._lastLifeSignalAt - 21000;         // simulates 21s with no progress
  await c._checkLifeWatchdog();
  check('in audio_only with audio ALSO stopped it does reconnect', reconnects > 0);

  reconnects = 0;
  c._qualityEffective = 'full';
  c._prevPacketsReceived = null;
  await c._checkLifeWatchdog();                              // takes the baseline (video 500)
  c._lastLifeSignalAt = c._lastLifeSignalAt - 21000;         // simulates 21s with no progress
  await c._checkLifeWatchdog();
  check('with video frozen in full mode it DOES reconnect', reconnects > 0);

  console.log('\n== 9. Per-session reset (nothing inherited from the previous one) ==');
  c = newCard();
  c._clients = 3; c._talkerSlot = 2; c._qualitySupported = true; c._quality = 'low';
  c._talkUnsupported = true; c._listenOnly = true;
  c._resetMulticlientState();
  check('counter forgotten', c._clients === null);
  check('turn forgotten', c._talkerSlot === -1 && c._listenOnly === false);
  check('quality goes back to auto/unconfirmed', c._quality === 'auto' && c._qualitySupported === null);
  check('turn support is probed again', c._talkUnsupported === false);

  console.log('\n== 10. Third-party messages (relay fan-out on the remote path) ==');
  c = newCard();
  c._slot = 0;
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 }); // we didn't request it
  check('an UNREQUESTED talk_granted does not open the mic', c.talkActive === false);
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  check('our own talk_granted does open the mic', c.talkActive === true);
  const flashesBefore = c._flashes.length;
  await c.handleNativeSignal({ type: 'talk_denied', slot: 1, reason: 'channel_busy' });
  check('a talk_denied for someone else does not close the mic', c.talkActive === true);
  check('nor does it bother with a notice', c._flashes.length === flashesBefore);

  console.log('\n== 11. Contract adjustments from 2026-07-26 ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: 1 });
  await c.handleNativeSignal({ type: 'talk_state', slot: 3, talker: 1 });
  check('a talk_state for someone else does NOT overwrite our slot', c._slot === 0);
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 2 }); // granted for ANOTHER slot
  check('talk_granted for a foreign slot does not open the mic', c.talkActive === false);
  check('our own request is still in flight', c._talkPending === true);
  await c.handleNativeSignal({ type: 'talk_denied', slot: 0, reason: 'channel_busy' });
  check('listen-only after the denial', c._listenOnly === true);
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 });
  check('notifies that the channel is free again', c._flashes.includes('talk_free_retry'));
  check('but does NOT reopen the mic on its own', c.talkActive === false);
  const flashesAfterHint = c._flashes.length;
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 });
  check('does not repeat the notice on every talk_state', c._flashes.length === flashesAfterHint);

  // ============================================================================================
  // 12. CONTRACT RESOLUTION FROM 2026-07-26, common to card/Android/iOS. These cases exist so
  //     nobody reverts the guards while "simplifying": each one fails if a rule is removed.
  // ============================================================================================
  console.log('\n== 12. Validating who the turn is for (rule common to all 3 clients) ==');

  // (a) Own slot UNKNOWN and an OWN request in flight => it's ACCEPTED, knowingly.
  //
  //     THIS CASE FLIPPED SIGN on 2026-07-29 (commit "the four bugs seen on the real
  //     iPhone") and the simulation was left un-updated until 2026-08-03: the two
  //     checks in this block had been red ever since, describing a rule the
  //     code no longer follows, and a suite that's red by default stops warning about anything.
  //
  //     Why it was relaxed, with the full reasoning in _handleTalkGranted(): over the
  //     REMOTE path the offer doesn't carry `slot` (the relay routes by device_id), so the own slot
  //     isn't known until the first session_info. Rejecting there discarded our OWN
  //     talk_granted, the 3s ran out and the card blamed "older firmware" on an up-to-date
  //     doorbell - seen on a real iPhone. And it protected nothing: once the 3s ran out the mic opened
  //     anyway, just later and lying about it.
  c = newCard();
  c._slot = null;
  await c.toggleTalk();
  check('with a request in flight but our own slot unknown, it IS ACCEPTED (see _handleTalkGranted)', c._talkPending === true);
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('  -> the mic opens, relying on the request having been ours', c.talkActive === true);

  // (b) Validation must NOT be circular: `talk_granted` can't teach us our own
  //     slot (if it could, msg.slot === this._slot would ALWAYS be true and would validate nothing). It's
  //     the bug the Android app had (`_mySlot ??= msg.slot` inside the handler itself).
  //     This rule was NOT relaxed, and it's the one still holding up case (c).
  check('  -> and talk_granted has NOT taught us our own slot', c._slot === null);
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  check('only session_info (or offer) sets our own slot', c._slot === 0);

  // (c) With the slot already known, someone else's is rejected and our own is accepted. A fresh card: here the
  //     slot filter is what's checked, not state carried over from the previous case.
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('talk_granted for someone else rejected once our own slot is known', c.talkActive === false);
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  check('our own talk_granted accepted', c.talkActive === true);

  // (d) Deliberate asymmetry: a message WITHOUT `slot` (intermediate firmware) is accepted relying
  //     only on _talkPending - rejecting it would leave the mic useless against that firmware.
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted' }); // no slot field
  check('a message with no slot (intermediate firmware) is still accepted', c.talkActive === true);

  // ============================================================================================
  // 13. IMAGE ROTATION (API_CONTRACT.md §1.9). The bug that motivated all of this was seen on the
  //     real device: the camera is mounted rotated 90° on purpose and the card was rendering the
  //     image sideways, because it never read the `rot` field from session_info.
  // ============================================================================================
  console.log('\n== 13. Image rotation (§1.9) ==');
  function cardWithFrame() {
    const card = newCard();
    card.feedWrap = fakeEl();
    card.feedWrap.clientWidth = 400;
    card.feedWrap.clientHeight = 711;
    card.videoEl.style = {};
    card._rot = 0;
    card._rotConfirmed = false;
    card.content = fakeEl();
    return card;
  }

  c = cardWithFrame();
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 90 });
  check('rot=90 read from session_info', c._rot === 90);
  // Since 1.9.7 the frame no longer carries an inline aspect-ratio (_fitToSpace gives it a measured height);
  // the shape reserved with no image is _recallAspect()'s, which comes from the known rotation.
  check('  -> the frame goes vertical (9:16 shape reserved)', c._recallAspect() < 1);
  check('  -> the video rotates 90° clockwise', /rotate\(90deg\)/.test(c.videoEl.style.transform));
  // With 90/270 width and height have to be SWAPPED, or the rotated image won't cover the space.
  check('  -> box with width and height swapped', c.videoEl.style.width === '711px' && c.videoEl.style.height === '400px');

  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 180 });
  check('rot=180 rotates without swapping dimensions', c.videoEl.style.transform === 'rotate(180deg)' && c.videoEl.style.width === '');

  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 0 });
  check('rot=0 rotates nothing', c.videoEl.style.transform === '' && c._recallAspect() > 1);

  // A weird value gets ignored instead of rendered: rendering it tilted with nothing explaining it is worse
  // than not rotating (same criterion as the firmware, which doesn't store it either).
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 45 });
  check('an unsupported rot value is ignored', c._rot === 0);

  // Firmware predating §1.9: with no `rot` field, nothing already known gets touched.
  c = cardWithFrame();
  c._rot = 90; c._rotConfirmed = true;
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1 });
  check('session_info with no rot does not touch the known rotation', c._rot === 90);

  // ============================================================================================
  // 14. WATCHING ISN'T LISTENING (API_CONTRACT.md §1.10)
  // ============================================================================================
  console.log('\n== 14. The client speaker starts muted (§1.10) ==');
  c = newCard();
  c._audioOn = false; c._audioOnBeforeMic = false; c.videoEl.muted = true;
  check('starts muted', c.videoEl.muted === true && c._audioOn === false);
  c._setAudioOn(true, 'user');
  check('the user turns the sound on -> it plays', c.videoEl.muted === false && c._audioOn === true);
  check('  -> and the icon says so', c.volIcon.getAttribute('icon') === 'mdi:volume-high');
  c._setAudioOn(false, 'user');
  check('and it can be muted again', c.videoEl.muted === true && c.volIcon.getAttribute('icon') === 'mdi:volume-off');

  // Listening and talking are independent axes: on closing the mic, the sound goes back to how it was
  // BEFORE opening it - if you were only watching in silence, you keep watching in silence.
  c = newCard();
  c._audioOn = true; c._audioOnBeforeMic = false; c.talkActive = true; c.videoEl.muted = false;
  await c._stopTalk();
  check('closing the mic returns the sound to how it was', c._audioOn === false && c.videoEl.muted === true);

  // The doorbell ring is the ONLY reason the sound turns on by itself.
  c = newCard();
  c._audioOn = false; c.videoEl.muted = true;
  c._connInfo = { events_entity: 'binary_sensor.timbre' };  // 1.10.0: no ring_entity in the YAML, the integration provides it
  c._hass.states['binary_sensor.timbre'] = { state: 'off' };
  c._updateRingState();
  check('first read of the ring sensor: triggers nothing', c._audioOn === false);
  c._hass.states['binary_sensor.timbre'] = { state: 'on' };
  c._updateRingState();
  check('someone rings the bell -> it plays by itself', c._audioOn === true && c.videoEl.muted === false);

  // A binary_sensor that was ALREADY 'on' when opening the dashboard isn't a call happening now.
  c = newCard();
  c._audioOn = false; c.videoEl.muted = true;
  c._connInfo = { events_entity: 'binary_sensor.timbre' };  // 1.10.0: no ring_entity in the YAML, the integration provides it
  c._hass.states['binary_sensor.timbre'] = { state: 'on' };
  c._updateRingState();
  check('a ring already on when opening does not unmute', c._audioOn === false);

  // ============================================================================================
  // 15. OPENING THE DOOR REQUIRES CONFIRMATION (API_CONTRACT.md §1.8)
  // ============================================================================================
  console.log('\n== 15. Double tap to open (§1.8) ==');
  function cardWithDoor() {
    const card = newCard();
    card.unlockButton = fakeEl();
    card.unlockIcon = fakeEl();
    card.unlockLabel = fakeEl();
    card._doorArmedAt = 0;
    card._doorArmTimer = null;
    card.isOpen = false;
    card.triggerNativeOpen = () => { card.isOpen = true; };
    return card;
  }

  c = cardWithDoor();
  c._onDoorPress();
  check('the first tap does NOT open', c.isOpen === false);
  check('  -> the button stays armed and shows it', c._doorArmedAt > 0 && c.unlockButton.classList.contains('confirming'));

  // Rule 2: a FAST double tap doesn't count. A phone in a pocket or a bouncing finger produce
  // exactly that.
  c._onDoorPress();
  check('a fast double tap (<300ms) does NOT open', c.isOpen === false);

  // Past the minimum, the second tap does open it.
  c._doorArmedAt = Date.now() - 400;
  c._onDoorPress();
  check('the second tap, spaced out, does open', c.isOpen === true);
  check('  -> and the button stops being armed (rule 3)', c._doorArmedAt === 0 && !c.unlockButton.classList.contains('confirming'));

  // Rule 1, the one that genuinely protects: confirmation EXPIRES. Without this, an accidental tap
  // leaves the door armed and the next one -equally accidental- opens it.
  c = cardWithDoor();
  c._onDoorPress();
  await new Promise((r) => setTimeout(r, 3200));
  check('the confirmation expires on its own after ~3s', c._doorArmedAt === 0 && !c.unlockButton.classList.contains('confirming'));
  c._doorArmedAt = 0;
  c._onDoorPress();
  check('  -> and after expiring, one tap only arms it again', c.isOpen === false);

  // ============================================================================================
  // 16. NOTHING HAPPENS IN SILENCE (API_CONTRACT.md §1.0). The door case wasn't a gap: it was
  //     A LIE. The card painted "Open" in green on tapping, before the doorbell
  //     had answered anything - so an open_result that never arrived left the user staring at a
  //     button that said "Open" with the door closed.
  // ============================================================================================
  console.log('\n== 16. Nothing happens in silence (§1.0) ==');
  c = cardWithDoor();
  c._doorArmedAt = Date.now() - 400; // already confirmed (§1.8), what's tested here is what happens after
  c.triggerNativeOpen = CardClass.prototype.triggerNativeOpen.bind(c);
  c._onDoorPress();
  check('sending the open shows "opening"', c.unlockButton.classList.contains('opening'));
  check('  -> and it does NOT claim to be open', !c.unlockButton.classList.contains('active-unlock'));
  check('  -> with the notice visible from the very first instant', c._flashes.includes('door_opening'));
  check('  -> and a deadline armed, so the indicator ENDS', !!c._doorWaitTimer);

  // A timeout is a timeout, never an "open".
  c._doorOpenNoAnswer();
  check('no answer: the indicator ends', !c.unlockButton.classList.contains('opening'));
  check('  -> it still makes no claim that it opened', !c.unlockButton.classList.contains('active-unlock'));
  check('  -> and it says there was no answer', c._flashes.includes('door_no_answer'));

  // And with real confirmation from the doorbell, then yes.
  c = cardWithDoor();
  c._doorArmedAt = Date.now() - 400;
  c.triggerNativeOpen = CardClass.prototype.triggerNativeOpen.bind(c);
  c._startDoorCountdown = () => {};
  c._onDoorPress();
  c.handleNativeOpenResult({ status: 'opened' });
  check('with open_result: now indeed "open"', c.unlockButton.classList.contains('active-unlock'));
  check('  -> and the wait has been closed', !c.unlockButton.classList.contains('opening') && !c._doorWaitTimer);

  console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED CHECK(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();

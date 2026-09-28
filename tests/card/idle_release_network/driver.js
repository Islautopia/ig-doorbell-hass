// Measures in a real Chromium WHY the video doesn't come back on tapping the card after it's
// released for idleness, WITHOUT replacing startWebRTC() (unlike the sibling harness
// test-idle-release-browser, whose total replacement of startWebRTC() masks exactly the race that
// needs to be seen). Loads the real dist/ig-doorbell-card.js; harness.js only doubles fetch/
// EventSource/WebSocket/hass.connection.sendMessagePromise -- the network layer, never the card's
// logic.
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the worktree root): `python -m http.server 8792`, then `node idle_release_network/driver.js`
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8792/tests/card/idle_release_network/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function newPage(browser) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('TESTLOG')) console.log(t.replace(/^TESTLOG /, ''));
    else if (msg.type() === 'error') console.log('[console.error] ' + t);
    else if (msg.type() === 'warning') console.log('[console.warn] ' + t);
    else if (msg.type() === 'info' || msg.type() === 'log') console.log('[console.' + msg.type() + '] ' + t);
  });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

// Polls tState(id) every `stepMs` up to `totalMs`, printing every sample -- to see EXACTLY
// when (if ever) hasPc goes back to true after the tap, instead of only looking at the end.
async function pollState(page, id, totalMs, stepMs) {
  let elapsed = 0;
  const samples = [];
  while (elapsed <= totalMs) {
    const s = await page.evaluate((id) => window.tState(id), id);
    samples.push({ t: elapsed, ...s });
    console.log(`  t+${elapsed}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} connGen=${s.connGen} startInFlightGen=${s.startInFlightGen} nativeWS=${s.nativeWS}`);
    await sleep(stepMs);
    elapsed += stepMs;
  }
  return samples;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STRUCTURAL POSITIVE CONTROL: the harness has to KNOW HOW TO SEE a restoration when it genuinely
  // happens, through a path already trusted as good (visibilitychange), before trusting what it says
  // about the idle+tap path. If this doesn't detect the restoration, the harness is blind and
  // nothing further below is worth anything.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## POSITIVE CONTROL: release via visibilitychange and restore via visibilitychange ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true });
      window.tCreateCard('p', { idle_release_seconds: 0 }); // 0 = disables the idle clock, doesn't interfere
      window.tAttach('p');
    });
    await sleep(600);
    const before = await page.evaluate(() => window.tState('p'));
    console.log('state after connecting:', JSON.stringify(before));
    await page.evaluate(() => window.tHide('p'));
    await sleep(200);
    const hidden = await page.evaluate(() => window.tState('p'));
    console.log('state after hiding (visibilitychange):', JSON.stringify(hidden));
    await page.evaluate(() => window.tShow('p'));
    await sleep(600);
    const shown = await page.evaluate(() => window.tState('p'));
    console.log('state after showing again:', JSON.stringify(shown));
    const verdict = !before.hasPc ? 'INVALID CONTROL (did not connect to begin with)'
      : (hidden.hasPc ? 'INVALID CONTROL (did not release on hiding)'
        : (shown.hasPc ? 'POSITIVE CONTROL OK: the harness DOES see a restoration when one happens' : 'INVALID CONTROL (did not restore via visibilitychange either -- harness suspect)'));
    console.log('=> ' + verdict);
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 1 (the fact to explain, FAST/normal network): short idle_release_seconds, let it release
  // on its own, then tap. startWebRTC() is the REAL code -- if this restores, the basic mechanism
  // works with a fast network and the failure has to be looked for in harsher conditions. If it does NOT
  // restore, the failure is fundamental and no slow network is needed to see it.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 1: idle_release_seconds=2, normal (fast) network, release on its own then TAP ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c1', { idle_release_seconds: 2 });
      window.tAttach('c1');
    });
    await sleep(500);
    console.log('state after connecting:', JSON.stringify(await page.evaluate(() => window.tState('c1'))));
    await sleep(2600); // > 2s past the deadline
    const released = await page.evaluate(() => window.tState('c1'));
    console.log('state after the idle deadline (with NO tap):', JSON.stringify(released));
    if (released.hasPc) {
      console.log('=> CASE 1 INVALID: it did not manage to release on its own, the tap cannot be tested');
    } else {
      console.log('-- tapping now, and sampling the state every 500ms for 13s (past the 12s fuse) --');
      await page.evaluate(() => window.tTouch('c1'));
      const samples = await pollState(page, 'c1', 13000, 500);
      const recovered = samples.some((s) => s.hasPc);
      console.log('=> CASE 1: ' + (recovered ? 'DID RESTORE (hasPc went back to true at some point)' : 'DID NOT RESTORE in 13s -- symptom reproduced'));
    }
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 2 (suspicion 1: reentrancy guard): the first startWebRTC() gets STUCK HALFWAY
  // (the relay never opens or fails -- wsOutcome='hang'), so its promise never resolves and
  // _startInFlightGen stays alive with THAT startup's value when idleness kicks in. It's
  // left to release on idle (which still sees this.pc truthy, assigned before the relay) and it's
  // tapped. Does the guard block the second startup? Does the 12s fuse kick in?
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 2: first startup STUCK (relay never opens/fails), idle_release_seconds=2, then TAP ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'hang', turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c2', { idle_release_seconds: 2 });
      window.tAttach('c2');
    });
    await sleep(500);
    const midflight = await page.evaluate(() => window.tState('c2'));
    console.log('state with the first startup stuck on the relay:', JSON.stringify(midflight));
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c2'));
    console.log('state after the idle deadline (the original startup is STILL stuck):', JSON.stringify(released));
    console.log('-- tapping now, sampling for 13s (fuse START_IN_FLIGHT_MAX_MS=12000ms) --');
    await page.evaluate(() => window.tTouch('c2'));
    const samples = await pollState(page, 'c2', 13000, 500);
    const stillLocked = samples.some((s) => s.startInFlightGen !== null && !s.hasPc);
    const recovered = samples.some((s) => s.hasPc);
    console.log(`=> CASE 2: startInFlightGen seen non-null at some point after tapping=${stillLocked}; ` + (recovered ? 'DID RESTORE' : 'DID NOT RESTORE in 13s'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 3 (suspicion 3: two producers of _streamPausedByHide): while the card stays on screen
  // (without hiding or leaving the view), idleness runs out. Before tapping, a visibilitychange
  // to 'hidden' and then immediately 'visible' ALSO fires (e.g. the browser switching
  // tabs for an instant, or any spurious event) to see whether the second producer
  // would leave _streamPausedByHide in a state the tap no longer recognizes as "needs restoring".
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 3: idle-release + a spurious visibilitychange BEFORE tapping ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c3', { idle_release_seconds: 2 });
      window.tAttach('c3');
    });
    await sleep(500);
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c3'));
    console.log('state after the idle deadline:', JSON.stringify(released));
    console.log('-- firing a spurious hidden->visible visibilitychange (the page never genuinely stops being active) --');
    await page.evaluate(() => { window.tHide('c3'); });
    await sleep(50);
    const afterHideSpurious = await page.evaluate(() => window.tState('c3'));
    console.log('state after the spurious hidden:', JSON.stringify(afterHideSpurious));
    await page.evaluate(() => { window.tShow('c3'); });
    await sleep(300);
    const afterShowSpurious = await page.evaluate(() => window.tState('c3'));
    console.log('state after the spurious show (did it reconnect on its own, without tapping?):', JSON.stringify(afterShowSpurious));
    console.log('-- now it really IS tapped --');
    await page.evaluate(() => window.tTouch('c3'));
    const samples = await pollState(page, 'c3', 4000, 500);
    const recovered = samples.some((s) => s.hasPc);
    console.log('=> CASE 3: ' + (recovered ? 'DID RESTORE after the tap' : 'DID NOT RESTORE after the tap'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 4 (fine-grained race): the FASTEST POSSIBLE network (connInfoDelay=0, turnDelay=0 -- resolved
  // via microtask, no setTimeout) to see whether this.pc can get assigned BEFORE the
  // just-armed idle clock itself (with the ABSOLUTE clock already expired, see
  // _armIdleWakeLockTimer) fires its "remaining <= 0" check -- which is a setTimeout(0)
  // scheduled EARLIER, synchronously, at the very start of startWebRTC(). If this check gets to
  // see this.pc already set, it self-releases the connection the tap just restored.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 4: the fastest possible network right after the tap -- fine-grained pc-vs-idle-clock race ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 10, wsOutcome: 'open', wsDelay: 10, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 10 });
      window.tCreateCard('c4', { idle_release_seconds: 2 });
      window.tAttach('c4');
    });
    await sleep(500);
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c4'));
    console.log('state after the idle deadline:', JSON.stringify(released));
    // Now the network becomes instantaneous (pure microtask) ONLY for whatever decides the race.
    await page.evaluate(() => window.tSetNetCfg({ connInfoDelay: 0, turnDelay: 0 }));
    console.log('-- tapping with an instantaneous network, sampling every 5ms for the first 300ms --');
    await page.evaluate(() => window.tTouch('c4'));
    let sawArmedTrue = false;
    let sawPcTrueThenFalseFast = false;
    let prevPc = false;
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => window.tState('c4'));
      if (s.idleTimerArmed) sawArmedTrue = true;
      if (prevPc && !s.hasPc) sawPcTrueThenFalseFast = true;
      prevPc = s.hasPc;
      if (i < 20 || i % 5 === 0) console.log(`  t+${i * 5}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} idleTimerArmed=${s.idleTimerArmed} connGen=${s.connGen}`);
      await sleep(5);
    }
    const final = await page.evaluate(() => window.tState('c4'));
    console.log('final state (300ms after the tap):', JSON.stringify(final));
    console.log(`=> CASE 4: idleTimerArmed seen true at some point=${sawArmedTrue}; pc went from true to false again after the tap=${sawPcTrueThenFalseFast}; final hasPc=${final.hasPc}`);
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 5 (a one-shot idle clock): after releasing on idle and restoring with
  // a tap, does the idle clock get armed again for a SECOND automatic cycle? If the
  // restoring tap never updates IG_IDLE.last (see the early `return` in
  // _onIdleActivity's "restore" branch), the check startWebRTC() arms sees the clock already
  // expired, fires almost instantly, finds nothing to release (or releases what was just restored,
  // CASE 4) and in NO case does it reschedule itself -- so the automatic idle clock
  // would stop firing EVER AGAIN in this session, even if the user leaves the
  // card untouched for however long.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 5: after restoring via a tap, does the idle clock fire again on its own? ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c5', { idle_release_seconds: 2 });
      window.tAttach('c5');
    });
    await sleep(500);
    await sleep(2600);
    console.log('state after the FIRST idle deadline:', JSON.stringify(await page.evaluate(() => window.tState('c5'))));
    await page.evaluate(() => window.tTouch('c5'));
    await sleep(500);
    const afterTouch = await page.evaluate(() => window.tState('c5'));
    console.log('state 500ms after the tap (reconnected):', JSON.stringify(afterTouch));
    console.log('-- waiting 6s with NO tap (3x the configured deadline) to see whether the idle clock fires a SECOND automatic cycle --');
    const samples = await pollState(page, 'c5', 6000, 1000);
    const secondFire = samples.some((s) => !s.hasPc);
    console.log('=> CASE 5: ' + (secondFire
      ? 'the clock DID fire again on its own (the automatic idle-release survives a cycle)'
      : 'the clock did NOT fire again in 6s -- reproduced: the automatic idle-release died after the first tap-restore cycle'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 6 (same mechanism, REALISTIC network -- not an instant microtask): 5-10ms per hop, on the
  // order of a Home Assistant WebSocket on the same machine/LAN. Confirms that CASE 4 isn't
  // an artifact of the "0ms = pure microtask" trick: with small but real network hops
  // (a genuine setTimeout), this.pc can still make it in time for the expired idle clock
  // to find it set and self-destroy the reconnection.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASE 6: same mechanism with a REALISTIC FAST network (5-10ms, no instant microtask) ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 8, wsOutcome: 'open', wsDelay: 8, turnFail: true,
        connInfoDelay: 6, turnDelay: 6, localSignalUrlDelay: 6 });
      window.tCreateCard('c6', { idle_release_seconds: 2 });
      window.tAttach('c6');
    });
    await sleep(500);
    await sleep(2600);
    console.log('state after the idle deadline:', JSON.stringify(await page.evaluate(() => window.tState('c6'))));
    console.log('-- tapping with a REALISTIC fast network (setTimeout of 6-8ms, not a microtask), sampling every 5ms --');
    await page.evaluate(() => window.tTouch('c6'));
    let sawPcTrue = false;
    for (let i = 0; i < 40; i++) {
      const s = await page.evaluate(() => window.tState('c6'));
      if (s.hasPc) sawPcTrue = true;
      if (i < 15 || i % 4 === 0) console.log(`  t+${i * 5}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} connGen=${s.connGen}`);
      await sleep(5);
    }
    const final6 = await page.evaluate(() => window.tState('c6'));
    console.log('final state (200ms after the tap):', JSON.stringify(final6));
    console.log(`=> CASE 6: this.pc was seen truthy in SOME sample=${sawPcTrue}; final state hasPc=${final6.hasPc} streamPausedByHide=${final6.streamPausedByHide}`);
    await page.close();
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

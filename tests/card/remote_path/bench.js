// 1.4.4 REMOTE PATH BENCH - the card from "outside the home", against the REAL Home Assistant and
// the REAL doorbells. Not part of run_all.js (it needs the real house); run by hand:
//
//   docker build -t igd-remote-bench remote_path/image          (once)
//   HASS_URL=... HASS_TOKEN=... IGD_BENCH_IP=<Waveshare LAN IP> [IGD_HOME_IP=<Ermita 10 LAN IP>] \
//     node remote_path/bench.js                    (from tests/card; Docker Desktop running)
//
// "OUTSIDE" IS MADE WITH THE NETWORK, NOT WITH JAVASCRIPT. The browser runs in a container
// (igd-remote-bench: Playwright's image + Google Chrome) whose OUTPUT chain drops every 192.168.0.0/16 destination except
// Home Assistant's own address and Docker's internal network (DNS). So the doorbell's LAN address is
// unroutable for that browser, exactly as from 4G through Nabu Casa, while Home Assistant stays
// reachable. The rules are applied by a sidecar (nicolaka/netshoot) sharing the container's network
// namespace. probe.js then MEASURES the isolation before trusting it (doorbell unreachable, HA
// reachable, STUN answering or not).
//
// Cases (CASES=A,B,... to pick):
//   A  outside, this card, Waveshare             -> live, selected pair NOT host->host, Internet pill
//   B  NEGATIVE CONTROL: outside AND all UDP off -> no video, the card says "no video path ... retrying"
//   C  POSITIVE CONTROL: at home (this PC's own Chromium on the LAN) -> live, host pair, no pill
//   D  BENCH CONTROL: outside with the 1.4.3 card -> must FAIL (the bug, measured; proves A can fail)
//   E  principle 1: at home with the VPS unreachable for the browser -> live over the LAN, host pair
//   F  outside, this card, Ermita 10 (READ-ONLY: skipped unless the doorbell is idle; view only)
//
// Doorbell safety (memory "pruebas en vivo"): before each case the doorbell's /api/debug/cores must say
// no call, no ring, not busy; one session per case, closed with the card's own teardown; after the
// case the session count must be back to where it was.
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const HERE = __dirname;
const CARD_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(CARD_DIR, '..', '..');
const CARD = 'custom_components/ig_doorbell/frontend/ig-doorbell-card.js';
const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HA_HOST = HASS_URL ? new URL(HASS_URL).hostname : '';
const IPS = { Waveshare: process.env.IGD_BENCH_IP, 'Ermita 10': process.env.IGD_HOME_IP };
// Built from remote_path/image (Playwright + Google Chrome: Playwright's Linux Chromium has no H.264).
const IMAGE = process.env.PW_IMAGE || 'igd-remote-bench';
const NAME = 'igd-remote-bench';
const CHROME_WIN = process.env.CHROME || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
if (!HASS_URL || !process.env.HASS_TOKEN || !IPS.Waveshare) { console.error('HASS_URL / HASS_TOKEN / IGD_BENCH_IP missing'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

async function cores(name) {
  const r = await fetch(`http://${IPS[name]}/api/debug/cores`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

// The old card for case D, straight from git (the 1.4.3 release, origin/main before this branch).
function oldCard() {
  const out = path.join(require('os').tmpdir(), 'igd-card-1.4.3.js');
  fs.writeFileSync(out, execFileSync('git', ['show', 'beae078:' + CARD], { cwd: REPO, encoding: 'utf8' }));
  return out;
}

function rules(net) {
  const r = ['iptables -F OUTPUT', `iptables -A OUTPUT -d ${HA_HOST} -j ACCEPT`,
    'iptables -A OUTPUT -d 192.168.65.0/24 -j ACCEPT', 'iptables -A OUTPUT -o lo -j ACCEPT'];
  if (net === 'outside' || net === 'none') r.push('iptables -A OUTPUT -d 192.168.0.0/16 -j DROP');
  if (net === 'none') r.push('iptables -A OUTPUT -p udp -j DROP');
  if (net === 'lan-no-vps') r.push('iptables -A OUTPUT -p udp ! -d 192.168.0.0/16 -j DROP');
  return r.join(' && ');
}

function runInContainer(net, env) {
  try { docker(['rm', '-f', NAME]); } catch (e) { /* not there */ }
  docker(['run', '-d', '--name', NAME, '--cap-add', 'NET_ADMIN', '-v', `${REPO}:/repo`, '-w', '/repo/tests/card', IMAGE, 'sleep', '600']);
  try {
    docker(['run', '--rm', '--net', `container:${NAME}`, '--cap-add', 'NET_ADMIN', 'nicolaka/netshoot', 'sh', '-c', rules(net)]);
    const envArgs = [];
    for (const [k, v] of Object.entries(env)) envArgs.push('-e', `${k}=${v}`);
    const chrome = '/opt/google/chrome/chrome';
    const r = spawnSync('docker', ['exec', ...envArgs, '-e', `CHROME=${chrome}`, NAME, 'node', 'remote_path/probe.js'], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    try { docker(['rm', '-f', NAME]); } catch (e) { /* gone */ }
  }
}

function runNative(env) {
  const r = spawnSync(process.execPath, ['remote_path/probe.js'], { cwd: CARD_DIR, encoding: 'utf8', env: { ...process.env, ...env, CHROME: CHROME_WIN } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ⚠️ D RUNS FIRST, AND THAT IS NOT COSMETIC. This bench's "outside" browser leaves through the SAME
// home router as the doorbell, i.e. with the same public IP. A remote case (A, F) makes the doorbell
// CreatePermission that IP on its TURN allocation, and coturn keeps a permission alive for 5 min after
// the last refresh. Within those 5 min the 1.4.3 card (no TURN of its own) reaches the doorbell's
// relay candidate straight from that IP and "works" - measured: D connected prflx->relay right after
// A, and failed (ICE 'failed' at ~15.7 s) when it ran first. From a real 4G phone the public IP is a
// different one and nothing permits it. So D first, and never within 5 min of another remote run.
const CASES = [
  { id: 'D', doorbell: 'Waveshare', net: 'outside', card: 'old', expect: 'fail', wait: 45000, title: 'BENCH CONTROL: outside with the 1.4.3 card (first: see above)' },
  { id: 'A', doorbell: 'Waveshare', net: 'outside', card: 'new', expect: 'live-remote', title: 'outside, this card' },
  { id: 'B', doorbell: 'Waveshare', net: 'none', card: 'new', expect: 'fail', wait: 60000, title: 'NEGATIVE CONTROL: outside and all UDP blocked' },
  { id: 'C', doorbell: 'Waveshare', net: 'lan', native: true, card: 'new', expect: 'live-local', title: 'POSITIVE CONTROL: at home, this PC on the LAN' },
  { id: 'E', doorbell: 'Waveshare', net: 'lan-no-vps', card: 'new', expect: 'live-local', title: 'principle 1: at home, VPS unreachable for the browser' },
  // Diagnostic only (not in the default run): the container with NO block, for "is it Docker's network?".
  { id: 'X', doorbell: 'Waveshare', net: 'lan', card: 'new', expect: process.env.X_EXPECT || 'live-local', diag: true, title: 'DIAGNOSTIC: container, no block' },
  { id: 'F', doorbell: 'Ermita 10', net: 'outside', card: 'new', expect: 'live-remote', title: 'outside, this card, Ermita 10 (read-only)' },
];

(async () => {
  const pick = process.env.CASES ? process.env.CASES.split(',') : CASES.filter((c) => !c.diag).map((c) => c.id);
  const summary = [];
  for (const c of CASES.filter((x) => pick.includes(x.id))) {
    console.log(`\n=== ${c.id}: ${c.title} ===`);
    if (!IPS[c.doorbell]) { console.log('  SKIP (no address for this doorbell)'); summary.push([c.id, 'SKIP']); continue; }
    const before = await cores(c.doorbell);
    console.log(`  doorbell before: busy=${before.busy} call=${before.call} ring=${before.ring} sessions=${before.sessions} viewers=${before.viewers}`);
    if (before.busy || before.call || before.ring || before.sessions > 0) {
      console.log('  SKIP: the doorbell is in use - never stream over a real call'); summary.push([c.id, 'SKIP (in use)']); continue;
    }
    const env = {
      HASS_URL, HASS_TOKEN: process.env.HASS_TOKEN, DOORBELL_IP: IPS[c.doorbell],
      DOORBELL_RE: c.doorbell === 'Waveshare' ? 'waveshare' : 'ermita', NET: c.net, EXPECT: c.expect,
      FORCE_RELAY: process.env.FORCE_RELAY || '0',
      WAIT_MS: String(c.wait || 45000), SAYS_NO_PATH: c.card === 'new' && c.expect === 'fail' ? '1' : '0',
      CARD_FILE: c.card === 'old' ? (c.native ? oldCard() : '/tmp/igd-card-1.4.3.js') : (c.native ? path.join(REPO, CARD) : '/repo/' + CARD),
    };
    if (c.card === 'old' && !c.native) {
      fs.writeFileSync(path.join(CARD_DIR, 'remote_path', '.card-1.4.3.js'), fs.readFileSync(oldCard()));
      env.CARD_FILE = '/repo/tests/card/remote_path/.card-1.4.3.js';
    }
    const r = c.native ? runNative(env) : runInContainer(c.net, env);
    console.log(r.out.split('\n').map((l) => '  | ' + l).join('\n'));
    let after = await cores(c.doorbell);
    for (let i = 0; i < 20 && after.sessions > before.sessions; i++) { await sleep(1000); after = await cores(c.doorbell); }
    const clean = after.sessions <= before.sessions;
    console.log(`  doorbell after: sessions=${after.sessions} viewers=${after.viewers} (${clean ? 'released' : 'STILL HELD'})`);
    summary.push([c.id, r.code === 0 && clean ? 'OK' : `FAIL (probe=${r.code}, released=${clean})`]);
    try { fs.unlinkSync(path.join(CARD_DIR, 'remote_path', '.card-1.4.3.js')); } catch (e) { /* none */ }
  }
  console.log('\nSUMMARY');
  for (const [id, v] of summary) console.log(`  ${id}: ${v}`);
  process.exit(summary.some(([, v]) => v.startsWith('FAIL')) ? 1 : 0);
})();

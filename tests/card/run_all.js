// Runs every card bench that must be green, plus their controls, against THIS repository's card
// (custom_components/ig_doorbell/frontend/ig-doorbell-card.js).
//
//   cd tests/card && npm install && node run_all.js            (Chromium from Playwright's cache:
//                                                              set PLAYWRIGHT_CHROMIUM_PATH if yours
//                                                              lives somewhere else)
//
// WHY IT SERVES THE FILES ITSELF. The browser benches load their page from a local HTTP server.
// Until 1.0.0 you started `python -m http.server <port>` by hand, and several of those servers were
// still running from older sessions on the card's former repository - same ports, same paths. A
// bench pointed at one of them measures the OLD card and says ALL OK. So this runner starts its
// own server on a free port, rooted at this repo, and also CHECKS that each browser bench really
// fetched the card from it (a count of card requests per bench, from the Referer). "No request"
// fails the run: a green bench that never loaded the file under test proves nothing.
//
// Controls (positive = must go RED, and red on its CHECKS, not on a crash):
//   - ui_v1_11_0 and ui_v1_10_0 carry built-in mutants of the card (they fail themselves if a
//     mutant survives).
//   - ui_v1_9_7 run against the 1.9.6 build, ui_v1_9_8 against the 1.9.7 build (fixtures/legacy).
//   - ui_v1_11_0 against the 1.0.0 card (fixtures/legacy/card_1.0.0.js, a plain copy: no renames
//     needed) must go red on L13 - the call buttons over a portrait picture on a phone in landscape
//     with room beside it (fixed in 1.1.1).
//   - registry_race against the 1.1.1 build (fixtures/legacy/card_1.1.1.js, a plain copy) must go
//     red on R1 - the card defined in the native registry before Home Assistant's polyfill replaced
//     it (fixed in 1.1.2).
//   - sim_carrera_reentrada.js --controls: negative control (the build before the reentrancy fix,
//     fixtures/legacy/card_3983f68.js) plus its own mutants.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CARD_REL = 'custom_components/ig_doorbell/frontend/ig-doorbell-card.js';
const CARD = path.join(REPO, CARD_REL);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
const cardHits = {};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(REPO, url);
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  if (url === '/' + CARD_REL) {
    const m = /\/tests\/card\/([^/]+)\//.exec(req.headers.referer || '');
    const bench = m ? m[1] : '(no referer)';
    cardHits[bench] = (cardHits[bench] || 0) + 1;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function run(job, port) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, job.env || {});
    if (job.bench) env.BASE_URL = `http://127.0.0.1:${port}/tests/card/${job.bench}/index.html`;
    const child = spawn(process.execPath, job.args, { cwd: __dirname, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const LEGACY = (f) => path.join(__dirname, 'fixtures', 'legacy', f);
const JOBS = [
  { name: 'ui_v1_11_0 (+ mutants M1-M14)', bench: 'ui_v1_11_0', args: ['ui_v1_11_0/driver.js'], expect: 0 },
  { name: 'ui_v1_10_0 (+ mutants)', bench: 'ui_v1_10_0', args: ['ui_v1_10_0/driver.js'], expect: 0 },
  { name: 'ui_v1_9_8', bench: 'ui_v1_9_8', args: ['ui_v1_9_8/driver.js'], expect: 0 },
  { name: 'ui_v1_9_7', bench: 'ui_v1_9_7', args: ['ui_v1_9_7/driver.js'], expect: 0 },
  { name: 'ui_v1_9_5', bench: 'ui_v1_9_5', args: ['ui_v1_9_5/driver.js'], expect: 0 },
  { name: 'ui_v1_9_2', bench: 'ui_v1_9_2', args: ['ui_v1_9_2/driver.js'], expect: 0 },
  { name: 'mount_sessions (+ mutants X1-X3)', bench: 'mount_sessions', args: ['mount_sessions/driver.js'], expect: 0 },
  { name: 'idle_release_network', bench: 'idle_release_network', args: ['idle_release_network/driver.js'], expect: 0 },
  { name: 'mic_https_1_1_0 (+ mutant)', bench: 'mic_https_1_1_0', args: ['mic_https_1_1_0/driver.js'], expect: 0 },
  { name: 'mic_privacy (+ mutants MA-MN)', bench: 'mic_privacy', args: ['mic_privacy/driver.js'], expect: 0 },
  { name: 'registry_race (+ mutants Z1-Z3)', bench: 'registry_race', args: ['registry_race/driver.js'], expect: 0 },
  { name: 'sim_multicliente', args: ['sim_multicliente.js', CARD], expect: 0 },
  { name: 'sim_carrera_reentrada', args: ['sim_carrera_reentrada.js', CARD], expect: 0 },
  { name: 'sim_carrera_reentrada --controls', args: ['sim_carrera_reentrada.js', '--controls'], expect: 0 },
  // positive controls: an older build must FAIL the newer checks, by failing checks
  { name: 'CONTROL ui_v1_9_7 vs 1.9.6 build (must fail)', bench: 'ui_v1_9_7', control: true,
    args: ['ui_v1_9_7/driver.js'], env: { CARD_FILE: LEGACY('card_1.9.6.js') }, expect: 1, failText: /^ {2}FAIL /m, },
  { name: 'CONTROL ui_v1_9_8 vs 1.9.7 build (must fail)', bench: 'ui_v1_9_8', control: true,
    args: ['ui_v1_9_8/driver.js'], env: { CARD_FILE: LEGACY('card_1.9.7.js') }, expect: 1, failText: /^ {2}FAIL /m, },
  { name: 'CONTROL ui_v1_11_0 vs 1.0.0 card (must fail L13)', bench: 'ui_v1_11_0', control: true,
    args: ['ui_v1_11_0/driver.js'], env: { CARD_FILE: LEGACY('card_1.0.0.js'), SKIP_MUTANTS: '1' }, expect: 1, failText: /^FAIL \[L13\]/m, },
  { name: 'CONTROL registry_race vs 1.1.1 card (must fail R1)', bench: 'registry_race', control: true,
    args: ['registry_race/driver.js'], env: { CARD_FILE: LEGACY('card_1.1.1.js') }, expect: 1, failText: /^ {2}FAIL \[R1\]/m, },
];

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const only = process.env.ONLY_JOBS ? process.env.ONLY_JOBS.split(',') : null;
  const jobs = JOBS.filter((j) => !only || only.some((o) => j.name.startsWith(o)));
  const logDir = process.env.LOG_DIR || null;
  if (logDir) fs.mkdirSync(logDir, { recursive: true });
  const results = [];
  const queue = jobs.slice();
  const workers = Array.from({ length: Number(process.env.PARALLEL || 4) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      const r = await run(job, port);
      results.push({ job, ...r });
      if (logDir) fs.writeFileSync(path.join(logDir, job.name.replace(/[^\w.-]+/g, '_') + '.log'), r.out);
    }
  });
  await Promise.all(workers);
  server.close();
  let bad = 0;
  console.log(`card under test: ${CARD_REL}`);
  for (const job of jobs) {
    const r = results.find((x) => x.job === job);
    const problems = [];
    if (job.expect === 0 && r.code !== 0) problems.push(`exit ${r.code}`);
    if (job.expect !== 0 && r.code === 0) problems.push('the control went GREEN (it controls nothing)');
    if (job.control && r.code !== 0) {
      // A crash is tolerated only AFTER a failed check: an old build that lacks the feature can
      // make a later probe throw, but the red has to come from a check first.
      const firstFail = r.out.search(job.failText);
      const firstCrash = r.out.search(/TypeError|ReferenceError|SyntaxError|triggerUncaughtException/);
      if (firstFail < 0) problems.push('red without a failed check');
      else if (firstCrash >= 0 && firstCrash < firstFail) problems.push('red on a CRASH before any failed check');
    }
    if (job.bench && !job.control && !cardHits[job.bench]) problems.push('never fetched the card from this repo');
    const hits = job.bench && !job.control ? ` [card fetched ${cardHits[job.bench] || 0}x]` : '';
    console.log(`${problems.length ? 'BAD ' : 'OK  '} ${job.name}${hits}${problems.length ? ' -> ' + problems.join('; ') : ''}`);
    if (problems.length) bad++;
  }
  console.log(bad ? `\n${bad} JOB(S) NOT AS EXPECTED` : '\nALL BENCHES GREEN, ALL CONTROLS RED ON THEIR CHECKS');
  process.exit(bad ? 1 : 0);
})();

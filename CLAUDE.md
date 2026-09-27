# IG Doorbell for Home Assistant — working notes

Integration `ig_doorbell` + the Lovelace card it ships (`custom_components/ig_doorbell/frontend/
ig-doorbell-card.js`, served by `card.py`). Public repository: no credentials, no screenshots of
real cameras, no personal Home Assistant details. The doorbell's interface is defined in
`API_CONTRACT.md` of the IG_Doorbell firmware repo — read only the sections you touch.

- **Card knowledge**: `docs/card.md` (newest first). Read the top before touching the card.
- **Tests**: `python -m pytest tests -q` in a container with pytest-homeassistant-custom-component
  (the `igd-test` image on the dev machine); `python tools/mutants.py` must say N/N killed AFTER
  "unmutated suite: green". Card: `cd tests/card && npm install && node run_all.js`.
- **Names are English inside** (identifiers, state values, comments) since 1.0.0. The only Spanish
  that belongs in code is the product's Spanish UI (the card's translation tables, `translations/
  es.json`) and Spanish option labels the card matches on purpose (`'ausente'`, `'noche'`...).
- **The card's version is the integration's** (`manifest.json` → `CARD_VERSION`): bump both in
  every build that reaches a device.

- **Secure local connection (1.1.0)**: `https_manager.py` (listener handed to `hass.http.runner`,
  public-name upkeep), `https_certs.py` (constrained local root, SNI), `https_cloud.py` (the ONLY
  code that talks to our VPS, voucher + CSR, API_CONTRACT §4-ter), `https_views.py` + `frontend/
  https-install.html` (install page). User docs: `docs/https.md`. The test image needs `segno`.

Landmines already paid for:
- **Never serve the card benches with a hand-started `python -m http.server`.** Old servers from
  earlier sessions were still serving the card's former repository on the same ports and paths;
  a bench pointed at one measures the old card and says ALL OK. `run_all.js` serves this repo
  itself and fails a bench that never fetched the card.
- **A mutant runner must check the unmutated suite first.** Until 1.0.0 a harness error in the
  first test killed every mutant for the wrong reason (17/17 "killed", none proven).
- **Anchored edits abort unless the anchor appears exactly once**, and anchors never carry
  backslashes through a shell (they collapse; it happened again on 2026-09-26 in a runner regex).
- **Rename by AST, never by text**, for code identifiers: the card has Spanish UI strings that a
  text replace would destroy. Tools: `tests/card/fixtures/make_legacy.js` shows the approach.

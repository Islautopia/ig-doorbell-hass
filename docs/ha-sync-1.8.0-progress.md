# 1.8.0 progress note: integration and card caught up with firmware 1.2.0 (2026-11-14)

Branch `ha-sync-1-2` (from `mic-cierra-calle-card`, which carried the unreleased 1.7.0).

## Gap inventory (firmware 1.2.0 vs integration 1.6.0 installed)

| Firmware capability | Before | 1.8.0 |
|---|---|---|
| Cloud link `cloud` / `cloud_s` | only on the unreleased 1.7.0 branch | binary sensor + events (1.7.0 folded in) |
| Multi-region: `cloud_region` / `cloud_home` | nothing | region, home, away-from-home entities |
| Signed region list, TURN per region, failovers (`/api/debug/boot` relay.region) | nothing | Region list sensor (disabled by default) |
| Card TURN from the doorbell's region | always the bootstrap host (Germany) | region-ordered, signed list, cache dropped on region change |
| Boot guard (`arranque_vigilado`) | nothing | Boot watchdog sensor (disabled) |
| PPA / video self-healing (`video_heal`) | nothing | Video recovery sensor (disabled) |
| Board check on OTA (`rejected_board`) | raw code in the error | verdict in words; 90 s quiet after restart |
| Catalog filtered by hw | already: the update entity reads `firmware_info.available` | unchanged |
| er10v2 night mode `/api/night` | nothing | select + IR intensity + night vision |
| er10v2 433 MHz chime `/api/chime` | nothing | volume, melody, test button, transmitter state |
| er10v2 keypad / fingerprint | nothing | state sensors (disabled, only if fitted) |
| Fingerprint enrolment, chime pairing key | - | NOT exposed on purpose: enrolment is not wired to keys yet (1.23.4); the pairing key is local-only and must not live in HA |

## Region-down drill on the er10v2 bench (firmware 1.2.0)

- (a) added to the real HA as "IG Doorbell 3" (replaced an ignored discovery of the same unit).
- (b) `assign` -> `us` on both VPS (backups `regions.json.bak-hasync-20261114-2228`), reboot to
  refresh: moved home de->us at uptime ~90 s, TURN allocated on the US coturn.
- (c) integration 1.6.0, card from this branch, remote bench: at home `prflx->host` first frame
  1.07 s; outside (LAN blocked for the browser, HA through its public domain) `relay->srflx` OK;
  negative control (all UDP blocked) no video and the card says so.
- (d) `systemctl stop rendezvous register_api igd-registry-sync` on ha-poc-us: connected on de within
  9.0 s of the command (fast failover, refused), TURN re-allocated on de at 20.5 s. Card: outside
  first frame 4.3 s `relay->srflx`, at home 1.08 s `prflx->host`.
- (e) B back up: home again (de->us) after ~92 s with no client. Then `assign` back to `de` on A and B
  (byte-identical to the backups), reboot: connected on de, home de, TURN on the German coturn.

## State / next

- Tests: 271 green; 1.8.0 mutants 10/10 killed; card benches all green, all controls red.
- NOT released and NOT deployed: pushing to main + the GitHub release was refused by the agent's
  permission guard, and the HA config share is not mapped on this PC. The real HA still runs 1.6.0
  (HACS). To ship: fast-forward main to this branch, tag v1.8.0, publish the release (notes =
  CHANGELOG 1.8.0 + 1.7.0), update through HACS, restart HA, check every ig_doorbell entry `loaded`,
  then repeat drill (c)/(d) to measure the region-ordered TURN with 1.8.0.
- The er10v2 stays in the real HA as "IG Doorbell 3" (its lock entity must never be operated).

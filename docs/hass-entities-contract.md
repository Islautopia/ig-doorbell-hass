# Entities the doorbell can act on: contract (1.5.3)

For the firmware, the apps and the web editors. This is exactly what the integration does today
(`custom_components/ig_doorbell/const.py`, `webhook.py::_act_on_entity`).

## What the doorbell receives

At setup the integration pushes the list (up to 5) to the doorbell:
`entities: [{"id": "script.x", "name": "...", "domain": "script"}, ...]`. Allowed domains:

| kind | domains | `on: true` | `on: false` |
|---|---|---|---|
| on/off | `fan`, `input_boolean`, `light`, `siren`, `switch` | `<domain>.turn_on` | `<domain>.turn_off` |
| on/off | `lock` | `lock.unlock` (open) | `lock.lock` |
| **launch-only** | `script` | `script.turn_on` (starts it; does not wait) | **refused: `no_off`** |
| **launch-only** | `automation` | `automation.trigger`, `skip_condition: false` | **refused: `no_off`** |

`button`, `scene` and `cover` stay out. There is **no new field**: launch-only is derived from
`domain in ("script", "automation")`. Editors show "Launch" instead of on/off for those, and must
not offer (nor send) `on: false` for them. The doorbell's own domain check must accept the two new
domains (it refuses an unknown domain for the whole list, `bad_entity_domain`).

## What the webhook returns (`hass_action`)

Body: `{"ig_doorbell": 1, "ok": bool, "error"?: str}`. Checks run in this order:

| `error` | meaning |
|---|---|
| `no_entity` | the envelope has no entity |
| `not_listed` | entity not in this integration's list |
| `bad_domain` | domain not allowed |
| `no_off` | `on: false` for a `script`/`automation`; nothing was called |
| `own_entity` | one of this integration's own entities (would loop) |
| `entity_missing` | it does not exist in Home Assistant |
| `entity_unavailable` | state is `unavailable` |
| `disabled` | an `automation` whose state is `off` (disabled in HA); not triggered |
| `service_failed` | the service call raised |

`ok: true` means *done* for on/off entities (blocking call) and *launched* for script/automation
(non-blocking: an automation can run for minutes and the doorbell would time out).

## Why these choices

- `script.turn_off` would **stop a running script**, and `automation.turn_on/turn_off` would
  **enable/disable** the automation: neither is what "off" means to a user, so `off` is refused
  out loud rather than mapped to them.
- Conditions are kept (`skip_condition: false`): they are part of what the owner wrote in HA.
- Anything to undo at the end of a sequence goes through a helper: see
  [examples/halloween-lights.md](examples/halloween-lights.md).

# Example: Halloween lights from a doorbell sequence

The doorbell does not need to know *how* to do Halloween. It only turns one thing on at the start
of a sequence and off at the end; Home Assistant does everything specific. This is the pattern in
use in a real house, with generic names.

## The pieces

1. A helper: **Settings → Devices & services → Helpers → Toggle**, named `Halloween lights`
   (`input_boolean.halloween_lights`).
2. One automation that reacts to the helper.
3. In **Configure → Entities the doorbell can act on**, pick `input_boolean.halloween_lights`.
4. In the doorbell's sequence, a step *Home Assistant: turn on* the helper at the start and a step
   *turn off* at the end.

## The automation

```yaml
alias: Halloween lights
mode: restart
triggers:
  - trigger: state
    entity_id: input_boolean.halloween_lights
    to: "on"
    id: "on"
  - trigger: state
    entity_id: input_boolean.halloween_lights
    to: "off"
    id: "off"
  # Safety: if it is still on after 3 minutes, turn itself off.
  - trigger: state
    entity_id: input_boolean.halloween_lights
    to: "on"
    for: "00:03:00"
    id: "timeout"
actions:
  - choose:
      - conditions: [{condition: trigger, id: "on"}]
        sequence:
          # Remember how the lights were, to give them back afterwards.
          - action: scene.create
            data:
              scene_id: before_halloween
              snapshot_entities:
                - light.porch_left
                - light.porch_right
          - action: light.turn_on
            target:
              entity_id: [light.porch_left, light.porch_right]
            data:
              effect: Halloween
      - conditions: [{condition: trigger, id: "off"}]
        sequence:
          - action: scene.turn_on
            target:
              entity_id: scene.before_halloween
      - conditions: [{condition: trigger, id: "timeout"}]
        sequence:
          - action: input_boolean.turn_off
            target:
              entity_id: input_boolean.halloween_lights
```

Turning the helper off (by the doorbell's last step, by you, or by the safety timeout) restores the
lights through the "off" branch. `mode: restart` keeps the snapshot from being taken twice.
(`effect` names depend on your lights.)

## Helper, or script/automation?

| You want to… | Use |
|---|---|
| Do something that has an **undo** (lights on, then back as they were) | a **helper** (`input_boolean`) + an automation that reacts to it. The doorbell turns it on and off. |
| **Fire and forget** (play a sound, send a notification, run a routine that ends by itself) | pick the **script** or **automation** itself. The doorbell launches it; there is no "off". |

A launch-only entity refuses "off" (`no_off`), so a sequence that has to put things back must use
a helper. See [../hass-entities-contract.md](../hass-entities-contract.md) for the exact behavior.

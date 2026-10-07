"""Constants for the IG Doorbell integration.

See ARCHITECTURE.md (repo root) for the design this implements, and
API_CONTRACT.md in the IG_Doorbell firmware repo for the interface these values come from.
"""
from __future__ import annotations

DOMAIN = "ig_doorbell"

# --- Webhook (API_CONTRACT.md §4) -----------------------------------------------------------
# ⚠️ THE MARKER OUR HANDLER RETURNS, and it is not decorative: Home Assistant answers `200` to a
# webhook that does NOT exist (measured 2026-08-24 against a real HA, with an empty body), on
# purpose, so nobody can enumerate an installation's webhooks by probing them. So by status code
# alone the doorbell cannot tell "delivered" from "HA forgot about me", and one whose integration
# was removed would keep firing into the void forever with its failure counter at zero. The marker
# is the only thing that breaks that tie. See webhook.py.
WEBHOOK_MARKER = "igd"

# Internal signal: one doorbell envelope, from the webhook to the entities. One per doorbell.
SIGNAL_EVENT = "ig_doorbell_event_{device_id}"

# How often the doorbell is asked for its state. Replaces MQTT's LWT: if `get_states` fails, the
# entities go unavailable, and that comes for free instead of needing a last-will message someone
# has to configure.
#
# 30 s and not 5: almost everything that changes fast arrives **pushed** by the webhook, so polling
# only covers what changes without notice (the mode from the doorbell's own dashboard, the viewer
# count, a street panel showing up). Polling more often would punish the doorbell -
# `esp_http_server` serves one request at a time - to refresh things that almost never move.
POLL_INTERVAL = 30

# --- Home Assistant entities the doorbell may act on (§4) --------------------------------------
# ⚠️ 5 (Inaki, 2026-09-25: "up to 5"), and it is not a memory limit: this list is the WHITELIST of
# what the doorbell can move in the house - the door and the `hass` steps may only point at one of
# these. A short whitelist is reviewed at a glance. Up to 0.7.5 there were 24. The doorbell refuses
# with `400 too_many_entities` instead of trimming.
MAX_ENTITIES = 5
CONF_ENTITIES = "entities"

# --- The doorbell's mode (§1.2, field `m`) -----------------------------------------------------
# ⚠️ 2 used to be called "Night" and the contract named it both ways, which led every client to
# pick one. Unified to **"Do not disturb"**, which describes what it does instead of when it is
# supposed to be used. The numeric value does NOT change: it stays 2, so there is nothing to
# migrate.
#
# ⚠️ The values are translation KEYS (2026-09-25), not text: Home Assistant translates a `select`'s
# state through `translation_key`, so what the owner reads comes out in their own language and what
# an automation stores stays stable. Up to 0.6.x the state was the Spanish text itself ("Ausente").
MODES: dict[int, str] = {
    0: "normal",
    1: "away",
    2: "do_not_disturb",
    3: "custom",
}

# The live-view timeout (`number` entity, applied by the card). See number.py.
LIVE_TIMEOUT_DEFAULT_S = 120
LIVE_TIMEOUT_MAX_S = 3600

# --- Config entry data keys -----------------------------------------------------------------
CONF_DEVICE_ID = "device_id"
CONF_CREDENTIAL = "credential"
CONF_HOST_HINT = "host_hint"
CONF_LABEL = "label"

# Confirmed against the firmware: use this fixed label so every
# HA instance that pairs with a given doorbell is identifiable in the cloud admin panel.
DEFAULT_PAIR_LABEL = "Home Assistant"


def generic_name(device_id: str) -> str:
    """The name to show when the doorbell has no `dname` configured (§0-bis).

    ⚠️ NEVER the bare id (Inaki, 2026-09-26): "the doorbell's name is actually useful, the id
    throws you off" - looking for where to configure its entities, he did not recognize the entry
    because it was named exactly like its device_id. Same format the firmware itself synthesizes
    for its mDNS instance when nobody has named the doorbell (API_CONTRACT.md, mDNS/Zeroconf,
    "IG Doorbell <device_id>"), so the generic name is the same across every client.
    """
    return f"IG Doorbell {device_id}"

# --- Zeroconf (API_CONTRACT.md §0-bis) ------------------------------------------------------
# Only used for the OPTIONAL pairing-discovery step in config_flow.py (async_step_zeroconf) -
# HA Core matches this against manifest.json's own "zeroconf": ["_igdoorbell._tcp.local."]
# declaration (the actual source of truth for that, not a Python constant) and routes matching
# announcements there. Match discovered instances by the `device_id` TXT record, NEVER by the
# mDNS instance name - the instance name tracks the doorbell's user-editable `device_name` and
# can change at any time (confirmed against the firmware).
#
# Deliberately NOT relied on anywhere else (2026-07-10): a previous
# `discovery.py` module used mDNS to resolve a doorbell's current LAN IP on every card session
# start - removed entirely. Two independent reasons: the card never actually used that value to
# connect (always uses the public hostname, see ARCHITECTURE.md §5/§7 "Q7"), and mDNS is
# multicast, which normally does not cross VLAN/subnet boundaries - relying on it would be
# actively wrong (not just unused) for any doorbell provisioned manually by IP because it lives
# on a different VLAN/subnet than the HA host, a real, legitimate setup. Pairing discovery here
# stays fine because it's purely optional/opportunistic - manual IP entry in config_flow.py
# always works as the real fallback, regardless of network segmentation.
#
# --- HTTP -------------------------------------------------------------------------------------
REQUEST_TIMEOUT = 8  # seconds - one-shot REST calls to the doorbell, not streams

# --- The doorbell's certificate name (API_CONTRACT.md §0) -------------------------------------
# ⚠️ ONLY the name the doorbell's TLS certificate is issued for. It is used for SNI and certificate
# validation and is NEVER resolved: the socket always goes to the LAN address this integration
# stored (net.py). There is deliberately no relay host here any more (2026-09-25, Phase 0): Home
# Assistant is a LOCAL client and never reaches the doorbell through the VPS, not even as a fallback.
DOORBELL_HOSTNAME_SUFFIX = "doorbell.islautopia.com"

# --- What the doorbell may act on, and how (contract 4) -------------------------------------
# Two kinds of entity (1.5.3). The same list lives in the firmware (`hass_domain_allowed`,
# main/hass.c) and each side checks its own half: the doorbell refuses to store anything else, and
# this integration refuses to act on anything else.
#
# 1. THINGS THAT TURN ON AND OFF (Inaki, 2026-09-25): fan, input_boolean, light, lock, siren,
#    switch. `on` and `off` both mean something.
# 2. LAUNCH-ONLY (LAUNCH_ONLY_DOMAINS; Inaki, 2026-10-07): `script` and `automation`. They are
#    back after being removed on 2026-09-25, and the reason they were removed has not gone away:
#    they have NO opposite state, so `on: false` means nothing. What changed is what to do about
#    it: `on: true` LAUNCHES them and `on: false` is REFUSED LOUDLY (`no_off`), never mapped to
#    something else. The owner's words: "Yo prefiero no ser tan especifico en la secuencia.
#    Simplemente encender (lanzar) el script Halloween (o la automatizacion). Que sea HASS quien
#    se encargue de lo especifico. Nosotros solo encendemos y apagamos cosas."
#    - script: `script.turn_on` (starts it, does not wait for it). NEVER `script.turn_off`: that
#      would STOP a running script, which is not what "off" means to a user.
#    - automation: `automation.trigger` with `skip_condition: false` (runs its actions; its own
#      conditions still apply, they are part of what the owner wrote). NEVER
#      `automation.turn_on/turn_off`: that enables/disables the automation, a different and
#      surprising thing. A DISABLED automation (state `off`) answers `disabled`.
#    Something to UNDO at the end of a sequence is not a script: use an `input_boolean` helper that
#    an automation reacts to (docs/examples/halloween-lights.md).
#
# Left out on purpose, and it is not an oversight:
# - `button`, `scene`: no opposite state either, and nobody has decided what `off` would do for
#   them. They stay out unless Inaki decides otherwise.
# - `cover`: a blind has positions in between and "open" takes a while; it is not a switch.
#
# In a LOCK, "on" means OPEN (`lock.unlock`) and "off" means CLOSE (`lock.lock`). Everything else
# maps to `turn_on` / `turn_off` of its own domain.
ALLOWED_DOMAINS: tuple[str, ...] = (
    "automation", "fan", "input_boolean", "light", "lock", "script", "siren", "switch",
)
# Domains with no "off": the editors show "Launch" for them. The domain already travels in the list
# the doorbell receives, so nothing extra is pushed.
LAUNCH_ONLY_DOMAINS: tuple[str, ...] = ("automation", "script")

DOMAIN_OPEN_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "unlock"),
    "light": ("light", "turn_on"),
    "switch": ("switch", "turn_on"),
    "input_boolean": ("input_boolean", "turn_on"),
    "fan": ("fan", "turn_on"),
    "siren": ("siren", "turn_on"),
    "script": ("script", "turn_on"),
    # Not `automation.turn_on`: that would ENABLE it. `trigger` runs its actions.
    "automation": ("automation", "trigger"),
}
DOMAIN_CLOSE_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "lock"),
    "light": ("light", "turn_off"),
    "switch": ("switch", "turn_off"),
    "input_boolean": ("input_boolean", "turn_off"),
    "fan": ("fan", "turn_off"),
    "siren": ("siren", "turn_off"),
    # script / automation: deliberately absent (LAUNCH_ONLY_DOMAINS); webhook refuses `off`.
}

# --- Ring notifications sent by the integration itself (1.2.0, docs/design/ha-only-ringing.md) ---
# Companion-app devices (device registry ids of `mobile_app` devices). Empty = the built-in
# notifier is off, which is the default: upgrading must not start ringing anybody's phone, and a
# house that already has its own automation would get every ring twice.
CONF_NOTIFY_PHONES = "notify_phones"
CONF_NOTIFY_PANELS = "notify_panels"
# iOS: critical alert / Android: the alarm stream. Both ring through silent mode.
CONF_NOTIFY_CRITICAL = "notify_critical"
# "Open door" button on the phone notification. OFF by default: whether the Android companion asks
# to unlock the phone before running an action from the lock screen is not measured yet.
CONF_NOTIFY_OPEN_DOOR = "notify_open_door"

# The call page the integration serves (a hidden frontend panel, see panel.py).
CALL_PAGE_PATH = "ig-doorbell"
# No resolution after this long (a firmware before 0.101.3, a lost webhook): panels go home anyway.
RING_SAFETY_S = 120
# "Open door" from a notification is honoured only this long after its ring, and never after the
# call was resolved: a notification left in the shade must not open the door hours later.
OPEN_DOOR_WINDOW_S = 180
# How long the snapshot for a ring may take. The notification never waits for it (it is sent at
# once and the phone fetches the picture a moment later); this bounds that fetch.
SNAPSHOT_TIMEOUT_S = 4
# Speakers that announce the call (media_player entities) and whether they also say it. Empty = off.
CONF_ANNOUNCE_PLAYERS = "announce_players"
CONF_ANNOUNCE_VOICE = "announce_voice"

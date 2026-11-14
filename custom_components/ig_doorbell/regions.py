"""Our cloud's regions, as Home Assistant needs them: where to ask for the card's TURN (1.8.0).

## Why Home Assistant needs the region list at all

The cloud is multi-region since firmware 1.2.0 (API_CONTRACT 3.7 / 3.0-ha): a doorbell lives on
its HOME region and fails over to another one when that region goes down. The integration talks to
our cloud for exactly one thing on the media path - the card's short-lived TURN credential
(turn_cloud.py) - and until 1.7 it always asked the bootstrap host (Germany). With Germany down the
card lost its TURN even though the doorbell itself was happily connected to the US region.

So the integration now asks, in this order: the region the DOORBELL says it is on (`cloud_region`
in `get_states`, read over the LAN), then its home region (`cloud_home`), then every other region
of the signed list, then the bootstrap host. The first that answers wins.

## Why the list is VERIFIED, and with the firmware's own keys

The pairing credential travels in the Authorization header of that request. A region list that
anybody could forge would be a way to send that credential to a host of their choosing. So the
integration accepts exactly what the firmware accepts: the ES256 envelope signed offline on the
operator PC, verified with the public keys compiled into the firmware (`main/cloud_regions.c`
`k_pubkeys`), with the same monotonic serial (a list older than the one held is refused). On top of
that every host must be under `.doorbell.islautopia.com`, the same zone rule as the firmware.

## Where a list comes from

1. The snapshot compiled in here (serial 1, the same one the firmware compiles in), so a fresh
   install knows every region before it has asked anything.
2. A newer list fetched from the cloud (`GET /device/<id>/regions` answers it in `manifest`),
   verified, and kept in Home Assistant's storage so a restart during an outage of the bootstrap
   host still knows where the other regions are.

Principle 1: nothing local depends on this. The only consumer is the TURN fetch, which already has
a hard deadline and an empty answer as its failure mode.
"""
from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass, field

_LOGGER = logging.getLogger(__name__)

ZONE_SUFFIX = ".doorbell.islautopia.com"
BOOTSTRAP_HOST = "relay.doorbell.islautopia.com"

# The firmware's public keys (main/cloud_regions.c k_pubkeys): uncompressed P-256 points, hex.
# regions-2026a is the current key, regions-2026b the next one (rotation without a release).
PUBKEYS: dict[str, str] = {
    "regions-2026a": (
        "0444c7f7903e5caee3ddc45ad7c3a07b84a7b0b8c74c089297c87a7810cbdb1a74"
        "96647044728e18d511d45345e62715b86ca01ed57eba58046e354cc39d200375"
    ),
    "regions-2026b": (
        "04566411caa69345c74d356f79644453ac290b26a8c4af4671efdde95de7d5efe7"
        "d604e5735d4f84fd8307baf825c3b562c9fc358e065660c3a24b610edfdfc602"
    ),
}

# The firmware's compiled snapshot (main/include/regions_snapshot.h, serial 1), byte for byte.
SNAPSHOT = (
    '{"v":1,"alg":"ES256","key_id":"regions-2026a","payload":"eyJmb3JtYXQiOjEsInNlcmlhbCI6MSwia'
    'XNzdWVkX2F0IjoiMjAyNi0xMS0xMlQyMjowMDowMFoiLCJleHBpcmVzX2F0IjoiMjAyNy0xMS0xMlQwMDowMDowMFoiL'
    'CJib290c3RyYXAiOiJyZWxheS5kb29yYmVsbC5pc2xhdXRvcGlhLmNvbSIsInJlZ2lvbnMiOlt7ImlkIjoiZGUiLCJ6b'
    '25lIjoiZXUiLCJob3N0IjoicmVsYXkuZG9vcmJlbGwuaXNsYXV0b3BpYS5jb20iLCJ0dXJuIjoicmVsYXkuZG9vcmJlb'
    'GwuaXNsYXV0b3BpYS5jb206MzQ3OCIsIndlaWdodCI6MTAwLCJzdGF0ZSI6ImFjdGl2ZSJ9LHsiaWQiOiJ1cyIsInpvb'
    'mUiOiJ1cyIsImhvc3QiOiJoYS1wb2MtdXMuZG9vcmJlbGwuaXNsYXV0b3BpYS5jb20iLCJ0dXJuIjoiaGEtcG9jLXVzL'
    'mRvb3JiZWxsLmlzbGF1dG9waWEuY29tOjM0NzgiLCJ3ZWlnaHQiOjAsInN0YXRlIjoiYWN0aXZlIn1dfQ==","sig":"z'
    'hv5jRKDIO8YQ4+pZc9QmPXvu19myjHL/GK9yDvUBM7ySiWi0snfPpOrSFbUu02C5skuWkaU2s5DsvcBTxk+ew=="}'
)

STORAGE_KEY = "ig_doorbell.regions"
STORAGE_VERSION = 1


class RegionListError(ValueError):
    """A list that must not be used. `str(err)` is the firmware's own reason word."""


@dataclass(frozen=True)
class Region:
    id: str
    host: str
    state: str          # active | standby | draining


@dataclass
class RegionList:
    serial: int
    bootstrap: str
    regions: list[Region] = field(default_factory=list)
    envelope: str = ""

    def host_of(self, region_id: str | None) -> str | None:
        for r in self.regions:
            if r.id == region_id:
                return r.host
        return None


def _in_zone(host: object) -> bool:
    return (isinstance(host, str) and 0 < len(host) < 64 and host == host.lower()
            and host.endswith(ZONE_SUFFIX) and "/" not in host and ":" not in host)


def verify(envelope_text: str) -> RegionList:
    """Verify an envelope exactly as the firmware does; raise RegionListError with its reason."""
    # Imported here: `cryptography` ships with Home Assistant, but keeping it out of import time
    # keeps every other module of the integration importable without it (tests, tools).
    from cryptography.exceptions import InvalidSignature  # noqa: PLC0415
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: PLC0415

    try:
        env = json.loads(envelope_text)
    except (TypeError, ValueError) as err:
        raise RegionListError("bad_envelope") from err
    if not isinstance(env, dict) or env.get("v") != 1 or env.get("alg") != "ES256":
        raise RegionListError("bad_envelope")
    pk_hex = PUBKEYS.get(env.get("key_id"))
    if not pk_hex:
        raise RegionListError("unknown_key")
    try:
        payload = base64.b64decode(env.get("payload") or "", validate=True)
        sig = base64.b64decode(env.get("sig") or "", validate=True)
    except (ValueError, TypeError) as err:
        raise RegionListError("bad_b64") from err
    if len(sig) != 64 or not payload:
        raise RegionListError("bad_sig_len")
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), bytes.fromhex(pk_hex))
    der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    try:
        pub.verify(der, payload, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as err:
        raise RegionListError("bad_signature") from err
    try:
        m = json.loads(payload)
    except ValueError as err:
        raise RegionListError("bad_manifest") from err
    if not isinstance(m, dict) or m.get("format") != 1:
        raise RegionListError("bad_manifest")
    serial = m.get("serial")
    if not isinstance(serial, int) or isinstance(serial, bool) or serial < 1:
        raise RegionListError("bad_serial")
    regions: list[Region] = []
    for r in m.get("regions") or []:
        if not isinstance(r, dict):
            raise RegionListError("bad_region")
        rid, host, state = r.get("id"), r.get("host"), r.get("state", "active")
        if not isinstance(rid, str) or not rid or not _in_zone(host) or state not in (
                "active", "standby", "draining"):
            raise RegionListError("bad_region")
        regions.append(Region(rid, host, state))
    if not regions or not any(r.state == "active" for r in regions):
        raise RegionListError("no_active_region")
    bootstrap = m.get("bootstrap") if _in_zone(m.get("bootstrap")) else BOOTSTRAP_HOST
    return RegionList(serial, bootstrap, regions, envelope_text)


class RegionBook:
    """The list in use: the compiled snapshot until a newer verified one arrives."""

    def __init__(self) -> None:
        self.current: RegionList = verify(SNAPSHOT)
        self.source = "compiled"
        self.last_reject: str | None = None

    def learn(self, envelope: object) -> bool:
        """Offer a list (text or the parsed envelope object). True if it replaced the current one."""
        text = envelope if isinstance(envelope, str) else json.dumps(envelope, separators=(",", ":"))
        try:
            new = verify(text)
        except RegionListError as err:
            self.last_reject = str(err)
            _LOGGER.warning("Refused a region list from the cloud: %s", err)
            return False
        if new.serial < self.current.serial:
            self.last_reject = "serial_rollback"
            return False
        if new.serial == self.current.serial:
            # Same serial: the same list again is a no-op; other bytes are refused (firmware rule).
            if json.loads(new.envelope).get("payload") != json.loads(self.current.envelope).get("payload"):
                self.last_reject = "serial_conflict"
            return False
        self.current, self.source, self.last_reject = new, "fetched", None
        return True

    def hosts_for(self, current: str | None, home: str | None) -> list[str]:
        """Where to ask, in order: the doorbell's region, its home, the other active regions, the
        standby ones, the bootstrap. Never a draining region unless the doorbell is ON it."""
        out: list[str] = []

        def add(host: str | None) -> None:
            if host and host not in out:
                out.append(host)

        add(self.current.host_of(current))
        rl = self.current
        if home and home != current:
            r = next((x for x in rl.regions if x.id == home), None)
            if r is not None and r.state != "draining":
                add(r.host)
        for state in ("active", "standby"):
            for r in rl.regions:
                if r.state == state:
                    add(r.host)
        add(rl.bootstrap)
        return out

"""The public name for Home Assistant: a voucher from the doorbell, a claim and a signature from the
VPS (API_CONTRACT.md §4-ter of the firmware repo).

⚠️ THIS IS THE ONLY PLACE THE INTEGRATION TALKS TO OUR VPS, and only while HTTPS is enabled. The
doorbell link stays 100 % local: the voucher is asked for over the LAN session of the entry
(net.py), with the pairing credential, and the VPS only ever sees the voucher, the HA's LAN IP and
a CSR. The private key never leaves Home Assistant.

A voucher is single use and lives 10 minutes, and the doorbell hands out at most 6 in a burst (one
back per minute): ask for one right before each VPS call, never cache them.
"""
from __future__ import annotations

from urllib.parse import quote

import aiohttp

from .api import doorbell_hostname

VPS_BASE = "https://relay.doorbell.islautopia.com"

_DOORBELL_TIMEOUT = aiohttp.ClientTimeout(total=10)
# The cert call may wait for Let's Encrypt (DNS-01, ~40 s measured on the VPS).
_VPS_TIMEOUT = aiohttp.ClientTimeout(total=180)


class PublicNameError(Exception):
    """A step of the public-name path failed. `code` is the contract's error code (or ours)."""

    def __init__(self, code: str, status: int | None = None, detail: dict | None = None) -> None:
        super().__init__(f"{code} (HTTP {status})" if status else code)
        self.code = code
        self.status = status
        self.detail = detail or {}


# Codes after which trying again later cannot help until someone changes something. The manager
# stops retrying on them and says what to change.
PERMANENT = frozenset(
    {
        "admin_required",  # the pairing is role user: only an admin pairing may vouch
        "device_not_paired",  # the doorbell was never registered with the cloud
        "auth_required",  # the pairing credential was revoked
        "voucher_unsupported",  # firmware without POST /api/ha_voucher
        "ip_must_be_private_ipv4",
        "doorbell_has_ha_name",  # another HA holds this doorbell's name; the owner must decide
        "device_not_authorized",
        "unknown_device",
    }
)


async def async_voucher(
    session: aiohttp.ClientSession, device_id: str, credential: str, purpose: str, ha_key: str
) -> str:
    """POST /api/ha_voucher on the doorbell, over the LAN (§4-ter.1)."""
    url = (
        f"https://{doorbell_hostname(device_id)}:8443/api/ha_voucher?token={quote(credential)}"
    )
    try:
        async with session.post(
            url, json={"purpose": purpose, "ha_key": ha_key}, timeout=_DOORBELL_TIMEOUT
        ) as resp:
            body = await _json(resp)
            if resp.status == 200 and isinstance(body.get("voucher"), str):
                return body["voucher"]
            if resp.status == 404:
                raise PublicNameError("voucher_unsupported", 404)
            raise PublicNameError(str(body.get("error") or "voucher_failed"), resp.status, body)
    except aiohttp.ClientError as err:
        raise PublicNameError("doorbell_unreachable", None, {"error": str(err)}) from err


async def async_claim(
    session: aiohttp.ClientSession,
    voucher: str,
    ip: str,
    *,
    replace: bool = False,
    adopt: dict | None = None,
) -> dict:
    """POST /ha_instance/v2/claim → {hostname, ha_instance_id, status}."""
    body: dict = {"voucher": voucher, "ip": ip, "replace": replace}
    if adopt:
        body["adopt"] = adopt
    return await _vps(session, "/ha_instance/v2/claim", body)


async def async_sign(session: aiohttp.ClientSession, voucher: str, csr_pem: str) -> dict:
    """POST /ha_instance/v2/cert → {hostname, cert, not_after, reused}. Never a key."""
    return await _vps(session, "/ha_instance/v2/cert", {"voucher": voucher, "csr": csr_pem})


async def _vps(session: aiohttp.ClientSession, path: str, body: dict) -> dict:
    try:
        async with session.post(VPS_BASE + path, json=body, timeout=_VPS_TIMEOUT) as resp:
            data = await _json(resp)
            if resp.status == 200:
                return data
            raise PublicNameError(str(data.get("error") or f"http_{resp.status}"), resp.status, data)
    except aiohttp.ClientError as err:
        raise PublicNameError("vps_unreachable", None, {"error": str(err)}) from err
    except TimeoutError as err:
        raise PublicNameError("vps_unreachable", None, {"error": "timeout"}) from err


async def _json(resp: aiohttp.ClientResponse) -> dict:
    try:
        data = await resp.json(content_type=None)
    except (ValueError, aiohttp.ContentTypeError):
        return {}
    return data if isinstance(data, dict) else {}

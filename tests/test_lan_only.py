"""Phase 0 rule 1: the integration reaches the doorbell at its LAN address and NOTHING else.

The resolver has no DNS inside. These tests make that observable: a name it does not know raises
and no system resolver is consulted, and a name it knows goes to the stored IP.
"""
from __future__ import annotations

import socket
from unittest.mock import patch

import aiohttp
import pytest

from custom_components.ig_doorbell import const, net

from .conftest import DEVICE_ID, LAN_IP

HOST = f"{DEVICE_ID}.{const.DOORBELL_HOSTNAME_SUFFIX}"


class _DnsSpy:
    """Counts every call into the system resolver (both paths aiohttp could take)."""

    def __init__(self):
        self.calls = []

    def getaddrinfo(self, *a, **k):
        self.calls.append(a[0] if a else k.get("host"))
        raise AssertionError("system DNS consulted")


async def test_known_name_goes_to_the_lan_ip_without_dns():
    spy = _DnsSpy()
    with patch.object(socket, "getaddrinfo", spy.getaddrinfo):
        r = net.LanOnlyResolver({HOST: LAN_IP})
        res = await r.resolve(HOST, 8443)
    assert [x["host"] for x in res] == [LAN_IP]
    assert spy.calls == []


async def test_unknown_name_raises_and_never_asks_dns():
    """The old resolver fell back to public DNS here. Now: an error, and zero DNS queries."""
    spy = _DnsSpy()
    with patch.object(socket, "getaddrinfo", spy.getaddrinfo), \
         patch.object(aiohttp.ThreadedResolver, "resolve", side_effect=AssertionError("DNS")):
        r = net.LanOnlyResolver({HOST: LAN_IP})
        with pytest.raises(OSError):
            await r.resolve("relay.doorbell.islautopia.com", 443)
        with pytest.raises(OSError):
            await r.resolve(f"otro.{const.DOORBELL_HOSTNAME_SUFFIX}", 8443)
    assert spy.calls == []


def test_a_name_can_never_be_stored_as_the_address():
    with pytest.raises(ValueError):
        net.LanOnlyResolver({HOST: HOST})


# The ONLY modules allowed to reach our cloud: the public name for Home Assistant's own HTTPS
# (API_CONTRACT §4-ter), and only while HTTPS is enabled (tests/test_https.py). Nothing about the
# doorbell goes there: test_https_cloud_is_only_for_the_public_name pins that.
PUBLIC_NAME_MODULES = {"https_cloud.py", "https_manager.py"}


def test_no_relay_or_turn_left_in_the_code():
    """Nothing in the package may point at the relay or fetch TURN credentials (plan §1.3 #1-#4)."""
    import pathlib

    root = pathlib.Path(net.__file__).parent
    text = "\n".join(
        p.read_text(encoding="utf-8") for p in root.glob("*.py")
        if p.name not in PUBLIC_NAME_MODULES
    )
    assert not hasattr(const, "RELAY_HOST")
    for forbidden in ("relay.doorbell", "app_turn_credentials", "get_turn_credentials",
                      "async_get_clientsession("):
        # docstrings may TELL the story; code may not do it. Only non-comment code lines count.
        lines = [
            l for l in text.splitlines()
            if forbidden in l and not l.strip().startswith(("#", '"', "'", "-", "`"))
            and "NOT `async_get_clientsession" not in l
        ]
        assert lines == [], (forbidden, lines)


def test_https_cloud_is_only_for_the_public_name():
    """The two modules that may reach the cloud use it for the public name and nothing else: the
    shared (DNS-resolving) session is taken ONCE and handed only to the claim and the signature;
    every voucher is asked of the doorbell over the entry's LAN session."""
    import pathlib
    import re

    root = pathlib.Path(net.__file__).parent
    mgr = (root / "https_manager.py").read_text(encoding="utf-8")
    cloud = (root / "https_cloud.py").read_text(encoding="utf-8")
    code = [ln for ln in mgr.splitlines() if not ln.strip().startswith(("#", '"', "'"))]
    assert sum("async_get_clientsession(" in ln for ln in code) == 1
    uses = [ln.strip() for ln in code if re.search(r"[(, ]vps[,)]", ln)]
    assert uses, "the shared session is never used?"
    for use in uses:
        assert ("async_claim(" in use or "async_sign(" in use or "_async_claim(" in use), use
    firsts = re.findall(r"async_voucher\(\s*([^,]+),", mgr)
    assert firsts and all(f.strip() == 'doorbell["session"]' for f in firsts), firsts
    routes = set(re.findall(r'"(/ha_instance/[a-z0-9/]+)"', cloud))
    assert routes == {"/ha_instance/v2/claim", "/ha_instance/v2/cert"}, routes
    assert "/api/ha_voucher" in cloud

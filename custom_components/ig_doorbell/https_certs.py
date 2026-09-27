"""Certificates for the local HTTPS listener: the local certificate authority, the LAN leaf, the
key and CSR for the public name, and the per-connection certificate choice (SNI).

Everything in this module is BLOCKING (key generation, file I/O, loading a chain into an
SSLContext) except `SniContexts._pick`, which runs inside the TLS handshake. Callers on Home
Assistant's loop go through `hass.async_add_executor_job`.

Two certificates, two paths (API_CONTRACT.md §4-ter of the firmware repo):

| path | certificate |
|---|---|
| bare IP, `homeassistant.local`, anything unknown | leaf from the LOCAL certificate authority |
| `<id>.ha.doorbell.islautopia.com` | Let's Encrypt, signed from this Home Assistant's CSR |

⚠️ THE LOCAL ROOT CARRIES NAME CONSTRAINTS, and that is the whole reason a leaked key is not a
disaster. The root's private key lives in Home Assistant's config directory, where backups, file
editors and every other custom integration can read it. A root WITHOUT constraints, once installed
on a phone, lets whoever holds that key impersonate ANY website to that phone. With constraints it
can only vouch for private addresses, `.local` names and our own zone for Home Assistant names -
names that only mean something inside a home network. Do not "simplify" the constraints away, and
do not add a public name to them.

⚠️ AND THE LEAF MUST STAY INSIDE THEM. A verifier that enforces name constraints rejects the WHOLE
leaf if a single SAN falls outside - one public IP on some adapter would break HTTPS on every
device. `constrained_names` filters before issuing; keep every SAN going through it.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import ipaddress
import os
import ssl
import uuid
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

# The zone the VPS hands out public names in (§4-ter.2).
PUBLIC_ZONE = "ha.doorbell.islautopia.com"

CA_COMMON_NAME = "IG Doorbell Home Assistant Local CA"
CA_DAYS = 3650
# 398 days: the longest lifetime Apple platforms accept for a TLS server certificate.
LEAF_DAYS = 398
# Re-issue the local leaf this long before it expires.
LEAF_RENEW_DAYS = 30

PERMITTED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("::1/128"),
)
# dNSName constraints match the name itself and anything below it (RFC 5280 §4.2.1.10).
PERMITTED_DNS: tuple[str, ...] = ("local", "localhost", PUBLIC_ZONE)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def write_private(path: Path, data: bytes) -> None:
    """Write a private key readable by its owner only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def write_public(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _key_pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )


def dns_permitted(name: str) -> bool:
    name = name.lower().rstrip(".")
    return any(name == c or name.endswith("." + c) for c in PERMITTED_DNS)


def ip_permitted(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr.version == n.version and addr in n for n in PERMITTED_NETWORKS)


def constrained_names(dns_names: list[str], ips: list[str]) -> tuple[list[str], list[str]]:
    """The subset of names a constrained root may vouch for, de-duplicated, order kept."""
    dns = [n.lower().rstrip(".") for n in dns_names if n and dns_permitted(n)]
    return list(dict.fromkeys(dns)), list(dict.fromkeys(i for i in ips if ip_permitted(i)))


def not_after(cert: x509.Certificate) -> dt.datetime:
    return cert.not_valid_after_utc


def load_cert_chain_first(pem: bytes) -> x509.Certificate:
    return x509.load_pem_x509_certificates(pem)[0]


def cert_san(cert: x509.Certificate) -> tuple[set[str], set[str]]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return set(), set()
    return (
        {n.lower() for n in san.get_values_for_type(x509.DNSName)},
        {str(i) for i in san.get_values_for_type(x509.IPAddress)},
    )


# ------------------------------------------------------------------------------ local CA
@dataclass
class LeafFiles:
    chain: Path
    key: Path


class LocalCA:
    """The integration's own certificate authority, stored in `directory`. Blocking methods."""

    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)
        self.ca_cert_path = self.dir / "ca.crt"
        self.ca_key_path = self.dir / "ca.key"
        self.leaf = LeafFiles(self.dir / "local-fullchain.crt", self.dir / "local.key")

    def exists(self) -> bool:
        return self.ca_cert_path.exists() and self.ca_key_path.exists()

    def ensure(self) -> bool:
        """Create the CA if there is none. True if it was created now."""
        if self.exists():
            return False
        self.create()
        return True

    def create(self) -> None:
        key = ec.generate_private_key(ec.SECP256R1())
        # A short suffix so two installations (or a regenerated root) are told apart in a
        # phone's certificate list, where only the name is shown.
        suffix = spki_sha256(key.public_key())[:8].upper()
        name = x509.Name(
            [
                x509.NameAttribute(NameOID.COMMON_NAME, f"{CA_COMMON_NAME} {suffix}"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Islautopia"),
            ]
        )
        now = _now()
        constraints = x509.NameConstraints(
            permitted_subtrees=[x509.DNSName(d) for d in PERMITTED_DNS]
            + [x509.IPAddress(n) for n in PERMITTED_NETWORKS],
            excluded_subtrees=None,
        )
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.KeyUsage(False, False, False, False, False, True, True, False, False),
                critical=True,
            )
            .add_extension(constraints, critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256())
        )
        write_private(self.ca_key_path, _key_pem(key))
        write_public(self.ca_cert_path, cert.public_bytes(serialization.Encoding.PEM))
        # A new root invalidates the old leaf.
        for p in (self.leaf.chain, self.leaf.key):
            p.unlink(missing_ok=True)

    def cert(self) -> x509.Certificate:
        return x509.load_pem_x509_certificate(self.ca_cert_path.read_bytes())

    def cert_pem(self) -> bytes:
        return self.ca_cert_path.read_bytes()

    def cert_der(self) -> bytes:
        return self.cert().public_bytes(serialization.Encoding.DER)

    def common_name(self) -> str:
        attrs = self.cert().subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        return str(attrs[0].value) if attrs else CA_COMMON_NAME

    def is_constrained(self) -> bool:
        try:
            self.cert().extensions.get_extension_for_class(x509.NameConstraints)
        except x509.ExtensionNotFound:
            return False
        return True

    def fingerprint(self) -> str:
        return self.cert().fingerprint(hashes.SHA256()).hex(":").upper()

    def leaf_is_current(self, dns_names: list[str], ips: list[str]) -> bool:
        """The stored leaf exists, was issued by THIS root, covers exactly these names and is not
        about to expire."""
        if not (self.leaf.chain.exists() and self.leaf.key.exists()):
            return False
        try:
            leaf = load_cert_chain_first(self.leaf.chain.read_bytes())
            ca = self.cert()
        except (OSError, ValueError, IndexError):
            return False
        if leaf.issuer != ca.subject:
            return False
        try:
            leaf.verify_directly_issued_by(ca)
        except Exception:  # noqa: BLE001 - InvalidSignature, wrong key type...: not ours
            return False
        if not_after(leaf) - _now() < dt.timedelta(days=LEAF_RENEW_DAYS):
            return False
        have_dns, have_ips = cert_san(leaf)
        return have_dns == {d.lower() for d in dns_names} and have_ips == {
            str(ipaddress.ip_address(i)) for i in ips
        }

    def issue_leaf(self, dns_names: list[str], ips: list[str]) -> LeafFiles:
        if self.is_constrained():
            dns_names, ips = constrained_names(dns_names, ips)
        if not dns_names and not ips:
            raise ValueError("no name to issue a local certificate for")
        ca_key = serialization.load_pem_private_key(self.ca_key_path.read_bytes(), None)
        ca_cert = self.cert()
        key = ec.generate_private_key(ec.SECP256R1())
        now = _now()
        san = [x509.DNSName(n) for n in dns_names] + [
            x509.IPAddress(ipaddress.ip_address(i)) for i in ips
        ]
        cert = (
            x509.CertificateBuilder()
            # No CN on purpose: some verifiers check a hostname-looking CN against the root's
            # name constraints, and every name that matters is in the SAN anyway.
            .subject_name(x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Islautopia")]))
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=LEAF_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(True, False, False, False, False, False, False, False, False),
                critical=True,
            )
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(san), critical=True)
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
                critical=False,
            )
            .sign(ca_key, hashes.SHA256())
        )
        write_private(self.leaf.key, _key_pem(key))
        write_public(
            self.leaf.chain, cert.public_bytes(serialization.Encoding.PEM) + self.cert_pem()
        )
        return self.leaf


# ------------------------------------------------------------------ public-name key and CSR
def spki_sha256(public_key) -> str:
    """`ha_key` of §4-ter.1: hex SHA-256 of the public key as SubjectPublicKeyInfo DER."""
    der = public_key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return hashlib.sha256(der).hexdigest()


def load_or_create_key(path: Path) -> ec.EllipticCurvePrivateKey:
    """The key of the public name. Generated HERE and never sent anywhere (§4-ter decision 2)."""
    if path.exists():
        key = serialization.load_pem_private_key(path.read_bytes(), None)
        if isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1):
            return key
    key = ec.generate_private_key(ec.SECP256R1())
    write_private(path, _key_pem(key))
    return key


def make_csr(key: ec.EllipticCurvePrivateKey, hostname: str) -> str:
    """A CSR the VPS accepts: P-256, SAN exactly [hostname], CN equal to it (§4-ter.2)."""
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)]))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return csr.public_bytes(serialization.Encoding.PEM).decode("ascii")


def public_cert_usable(chain_pem: bytes, key: ec.EllipticCurvePrivateKey, hostname: str) -> bool:
    """The stored public certificate is for this key and this name (expiry checked apart)."""
    try:
        cert = load_cert_chain_first(chain_pem)
    except (ValueError, IndexError):
        return False
    if spki_sha256(cert.public_key()) != spki_sha256(key.public_key()):
        return False
    dns, _ = cert_san(cert)
    return hostname.lower() in dns


# --------------------------------------------------------------------- SNI / TLS contexts
def _server_context(chain: Path, key: Path) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.set_alpn_protocols(["http/1.1"])
    ctx.load_cert_chain(chain, key)
    return ctx


class SniContexts:
    """`listen` is the context the port is bound with. Its `sni_callback` hands each connection
    the context for the name it asked for; no SNI (a bare IP) keeps `listen` itself, which is why
    `listen` also carries the local certificate.

    Swapping a certificate replaces the per-name context: the port is never re-bound, so a
    renewal does not drop open WebSockets."""

    def __init__(self) -> None:
        self.local: ssl.SSLContext | None = None
        self.public: ssl.SSLContext | None = None
        self.public_name: str | None = None
        self.listen = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.listen.minimum_version = ssl.TLSVersion.TLSv1_2
        self.listen.set_alpn_protocols(["http/1.1"])
        self.listen.sni_callback = self._pick

    def load_local(self, leaf: LeafFiles) -> None:  # blocking
        self.local = _server_context(leaf.chain, leaf.key)
        self.listen.load_cert_chain(leaf.chain, leaf.key)

    def load_public(self, name: str, chain: Path, key: Path) -> None:  # blocking
        ctx = _server_context(chain, key)
        self.public, self.public_name = ctx, name.lower()

    def drop_public(self) -> None:
        self.public, self.public_name = None, None

    def _pick(self, sslobj: ssl.SSLObject, name: str | None, _ctx: ssl.SSLContext) -> None:
        if name and self.public is not None and name.lower() == self.public_name:
            sslobj.context = self.public
        elif self.local is not None:
            sslobj.context = self.local


# ------------------------------------------------------------------ Apple configuration profile
def mobileconfig(ca_der: bytes, ca_name: str, fingerprint: str) -> bytes:
    """A configuration profile holding only the root certificate (payload type
    `com.apple.security.root`). iOS installs it as a profile; FULL TRUST for a root is a separate
    switch the user turns on in Settings (see the install page)."""
    # Stable identifiers derived from the root, so re-downloading the same root replaces the
    # profile instead of piling up copies.
    ns = uuid.UUID("5b0c1f64-2f0e-4c55-9d53-4b1d6a0f3c7e")
    profile_uuid = str(uuid.uuid5(ns, "profile:" + fingerprint)).upper()
    payload_uuid = str(uuid.uuid5(ns, "root:" + fingerprint)).upper()
    b64 = base64.b64encode(ca_der).decode("ascii")
    lines = "\n".join(b64[i : i + 64] for i in range(0, len(b64), 64))
    esc = ca_name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ig-doorbell-ha-root.cer</string>
      <key>PayloadContent</key>
      <data>
{lines}
      </data>
      <key>PayloadDescription</key>
      <string>Root certificate for the secure local address of your Home Assistant.</string>
      <key>PayloadDisplayName</key>
      <string>{esc}</string>
      <key>PayloadIdentifier</key>
      <string>com.islautopia.igdoorbell.ha.root.{payload_uuid}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>{payload_uuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Lets this device open your Home Assistant over HTTPS on your home network, so the IG Doorbell card can use the microphone. It can only vouch for private addresses and local names.</string>
  <key>PayloadDisplayName</key>
  <string>IG Doorbell - Home Assistant HTTPS</string>
  <key>PayloadIdentifier</key>
  <string>com.islautopia.igdoorbell.ha.{profile_uuid}</string>
  <key>PayloadOrganization</key>
  <string>Islautopia</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{profile_uuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"""
    return xml.encode("utf-8")

"""Test harness: pytest-homeassistant-custom-component.

Run (from the repo root, in a Linux container with the harness installed):

    python -m pytest tests -q

The doorbell is never contacted: every network function is patched. What these tests measure is
the RULES of Phase 0 (LAN only, the credential never leaves the server, nothing half-configured,
translated entities, the live-view timeout entity). tools/mutants.py flips each rule back and
checks that the suite goes red.
"""
from __future__ import annotations

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"

# pycares >= 4.9 destroys DNS channels on ONE process-wide daemon thread
# (`_run_safe_shutdown_loop`), started lazily the first time a channel dies. Whichever test sets up
# `http` first starts it, and the harness's `verify_cleanup` then fails that test at teardown for
# a thread it did not create. Until 2026-09-26 that was test_credential_stays_server_side (first
# alphabetically), and because tools/mutants.py runs with `-x`, EVERY mutant "died" on that
# harness error instead of on the rule it broke: 17/17 killed meant nothing. Starting the thread
# here, before any test, puts it in every test's "threads before" set.
try:
    import pycares as _pycares

    _pycares._shutdown_manager.start()  # noqa: SLF001 - private, but it is the thread at stake
except (ImportError, AttributeError):  # older pycares: no shared shutdown thread, nothing to do
    pass

DEVICE_ID = "0123456789abcdef"
CREDENTIAL = "c" * 64
LAN_IP = "192.168.1.10"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield

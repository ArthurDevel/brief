"""
Pytest fixtures for IMAP integration tests.

Spawns a Hoodiecrow IMAP server as a Node.js subprocess. The server
prints "READY" to stdout once it's listening on port 14143, then stays
alive for the duration of the test session.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Generator

import pytest
from imapclient import IMAPClient

from src.session import ImapConfig

IMAP_PORT = 14143
HOODIECROW_SCRIPT = Path(__file__).parent / "hoodiecrow_server.cjs"
NODE_MODULES = Path(__file__).parents[2] / "packages" / "email" / "node_modules"


@pytest.fixture(scope="session")
def hoodiecrow_server() -> Generator[subprocess.Popen, None, None]:
    """Start Hoodiecrow IMAP server as a subprocess for the test session."""
    proc = subprocess.Popen(
        ["node", str(HOODIECROW_SCRIPT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "NODE_PATH": str(NODE_MODULES)},
    )

    # Wait for "READY" on stdout
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            stderr = proc.stderr.read().decode() if proc.stderr else ""
            raise RuntimeError(f"Hoodiecrow exited early (code {proc.returncode}): {stderr}")
        line = proc.stdout.readline().decode().strip() if proc.stdout else ""
        if line == "READY":
            break
    else:
        proc.kill()
        raise RuntimeError("Hoodiecrow did not become ready within 10 seconds")

    yield proc

    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture(scope="session")
def imap_config() -> ImapConfig:
    """IMAP config pointing at the local Hoodiecrow server."""
    return ImapConfig(
        host="127.0.0.1",
        port=IMAP_PORT,
        user="testuser",
        password="testpass",
    )


@pytest.fixture()
def imap_client(
    hoodiecrow_server: subprocess.Popen, imap_config: ImapConfig
) -> Generator[IMAPClient, None, None]:
    """Create a fresh IMAPClient connection for each test."""
    client = IMAPClient(imap_config.host, port=imap_config.port, ssl=False)
    client.login(imap_config.user, imap_config.password)
    yield client
    try:
        client.logout()
    except Exception:
        pass

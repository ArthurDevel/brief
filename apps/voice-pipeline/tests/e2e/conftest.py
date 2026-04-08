"""
E2E test fixtures for email tool dispatch.

Builds EmailClientContext objects from the same env vars as the TypeScript
e2e tests. Each account that has its env vars configured is included;
accounts with missing vars are skipped. At least one account must be
configured or the entire suite is skipped.

Provides a mock Supabase client that returns empty results (dispatch uses
session_id=None so Supabase is never actually queried for email operations).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generator
from unittest.mock import MagicMock

from dotenv import load_dotenv

# Load test env vars from .env.test.local at the repo root
_env_file = Path(__file__).resolve().parents[4] / ".env.test.local"
load_dotenv(_env_file)

import pytest  # type: ignore[import-untyped]
from imapclient import IMAPClient  # type: ignore[import-untyped]

from src.session import ImapConfig, SmtpConfig
from src.tools.email_client import EmailClientContext


# ============================================================================
# CONSTANTS
# ============================================================================

TEST_RUN_ID = f"e2e-py-{int(time.time() * 1000)}"

DELIVERY_WAIT_S = 15

RETRY_WAIT_S = 5
MAX_RETRIES = 6


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class E2EAccount:
    """A test account with its EmailClientContext and metadata."""

    label: str
    email_address: str
    connection_type: str  # "unipile" | "imap_smtp"
    email_ctx: EmailClientContext


# ============================================================================
# ACCOUNT BUILDERS
# ============================================================================

def _env(name: str) -> str:
    """Read an env var or raise with a clear message."""
    value = os.environ.get(name)
    if not value:
        raise KeyError(f"Missing env var: {name}")
    return value


def _build_gmail_unipile() -> E2EAccount:
    account_id = _env("TEST_GMAIL_UNIPILE_ACCOUNT_ID")
    email_address = _env("TEST_GMAIL_UNIPILE_EMAIL")
    _env("UNIPILE_API_KEY")
    _env("UNIPILE_DSN")

    return E2EAccount(
        label="Gmail (Unipile)",
        email_address=email_address,
        connection_type="unipile",
        email_ctx=EmailClientContext(
            connection_type="unipile",
            provider="gmail",
            unipile_account_id=account_id,
        ),
    )


def _build_outlook_unipile() -> E2EAccount:
    account_id = _env("TEST_OUTLOOK_UNIPILE_ACCOUNT_ID")
    email_address = _env("TEST_OUTLOOK_UNIPILE_EMAIL")
    _env("UNIPILE_API_KEY")
    _env("UNIPILE_DSN")

    return E2EAccount(
        label="Outlook (Unipile)",
        email_address=email_address,
        connection_type="unipile",
        email_ctx=EmailClientContext(
            connection_type="unipile",
            provider="outlook",
            unipile_account_id=account_id,
        ),
    )


def _build_gmail_imap() -> E2EAccount:
    email_address = _env("TEST_GMAIL_IMAP_EMAIL")
    imap_config = ImapConfig(
        host=_env("TEST_GMAIL_IMAP_HOST"),
        port=int(_env("TEST_GMAIL_IMAP_PORT")),
        user=_env("TEST_GMAIL_IMAP_USER"),
        password=_env("TEST_GMAIL_IMAP_PASSWORD"),
    )
    smtp_config = SmtpConfig(
        host=_env("TEST_GMAIL_SMTP_HOST"),
        port=int(_env("TEST_GMAIL_SMTP_PORT")),
        user=_env("TEST_GMAIL_SMTP_USER"),
        password=_env("TEST_GMAIL_SMTP_PASSWORD"),
    )
    client = IMAPClient(imap_config.host, port=imap_config.port, ssl=True)
    client.login(imap_config.user, imap_config.password)

    return E2EAccount(
        label="Gmail (IMAP)",
        email_address=email_address,
        connection_type="imap_smtp",
        email_ctx=EmailClientContext(
            connection_type="imap_smtp",
            provider="gmail",
            imap_holder={"client": client, "config": imap_config},
            smtp_config=smtp_config,
        ),
    )


def _build_outlook_imap() -> E2EAccount:
    email_address = _env("TEST_OUTLOOK_IMAP_EMAIL")
    imap_config = ImapConfig(
        host=_env("TEST_OUTLOOK_IMAP_HOST"),
        port=int(_env("TEST_OUTLOOK_IMAP_PORT")),
        user=_env("TEST_OUTLOOK_IMAP_USER"),
        password=_env("TEST_OUTLOOK_IMAP_PASSWORD"),
    )
    smtp_config = SmtpConfig(
        host=_env("TEST_OUTLOOK_SMTP_HOST"),
        port=int(_env("TEST_OUTLOOK_SMTP_PORT")),
        user=_env("TEST_OUTLOOK_SMTP_USER"),
        password=_env("TEST_OUTLOOK_SMTP_PASSWORD"),
    )
    client = IMAPClient(imap_config.host, port=imap_config.port, ssl=True)
    client.login(imap_config.user, imap_config.password)

    return E2EAccount(
        label="Outlook (IMAP)",
        email_address=email_address,
        connection_type="imap_smtp",
        email_ctx=EmailClientContext(
            connection_type="imap_smtp",
            provider="outlook",
            imap_holder={"client": client, "config": imap_config},
            smtp_config=smtp_config,
        ),
    )


ALL_BUILDERS = [
    ("gmail-unipile", _build_gmail_unipile),
    ("outlook-unipile", _build_outlook_unipile),
    ("gmail-imap", _build_gmail_imap),
    ("outlook-imap", _build_outlook_imap),
]


# ============================================================================
# FIXTURES
# ============================================================================

def _load_accounts() -> list[E2EAccount]:
    """Build all accounts whose env vars are present. Skip those that aren't."""
    accounts: list[E2EAccount] = []
    skipped: list[str] = []

    for key, builder in ALL_BUILDERS:
        try:
            accounts.append(builder())
        except (KeyError, Exception) as e:
            skipped.append(f"{key}: {e}")

    if skipped:
        print(f"[e2e] Skipping {len(skipped)} account(s):\n" + "\n".join(skipped))

    return accounts


# Build once at import time so parametrize can use the list
_ACCOUNTS = _load_accounts()


@pytest.fixture(params=_ACCOUNTS if _ACCOUNTS else [pytest.param(None, marks=pytest.mark.skip(reason="No e2e accounts configured"))], ids=[a.label for a in _ACCOUNTS] if _ACCOUNTS else ["no-accounts"])
def account(request: pytest.FixtureRequest) -> E2EAccount:
    """Parametrized fixture that yields each configured test account."""
    return request.param


@pytest.fixture()
def mock_supabase() -> MagicMock:
    """Mock Supabase client. Not used when session_id=None but required by signature."""
    return MagicMock()

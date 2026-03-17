"""
Shared Langfuse client singleton for the voice pipeline.

Initialized once from environment variables at import time.
The SDK batches events internally (flushes every 5s), so a single
client safely handles multiple concurrent calls.
"""

from __future__ import annotations

import logging
import os

from langfuse import Langfuse


logger = logging.getLogger(__name__)

_client: Langfuse | None = None


def get_langfuse_client() -> Langfuse:
    """Return the shared Langfuse client, creating it on first call."""
    global _client
    if _client is None:
        _client = Langfuse(
            public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
            secret_key=os.environ["LANGFUSE_SECRET_KEY"],
            base_url=os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
        )
        logger.info("[langfuse] Client initialized")
    return _client


def shutdown_langfuse_client() -> None:
    """Flush pending events and shut down the client."""
    global _client
    if _client is not None:
        _client.shutdown()
        logger.info("[langfuse] Client shut down")
        _client = None

"""
Environment configuration and pricing constants for the voice pipeline.

- Loads and validates all required environment variables
- Provides typed Settings dataclass with defaults
- Defines per-provider pricing constants for cost tracking
"""

from dataclasses import dataclass, field
from dotenv import load_dotenv
import os


# ============================================================================
# CONSTANTS
# ============================================================================

REQUIRED_ENV_VARS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DEEPGRAM_API_KEY",
    "OPENROUTER_API_KEY",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "WEB_APP_URL",
    "INTERNAL_API_KEY",
]


@dataclass(frozen=True)
class PricingConstants:
    """Per-provider pricing rates for cost tracking."""

    LLM_COST_PER_INPUT_TOKEN: float = 0.15 / 1_000_000
    LLM_COST_PER_OUTPUT_TOKEN: float = 0.60 / 1_000_000
    TTS_COST_PER_CHAR: float = 0.015 / 1_000
    STT_COST_PER_MINUTE: float = 0.0059  # Nova-3 pay-as-you-go


PRICING = PricingConstants()

# OpenRouter generation API (for post-hoc actual LLM cost fetching)
OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation"
OPENROUTER_COST_RETRY_DELAY = 2  # seconds
OPENROUTER_COST_MAX_RETRIES = 3


# ============================================================================
# SETTINGS
# ============================================================================

LLM_MODEL = "google/gemini-3-flash-preview"


@dataclass
class Settings:
    """All configuration values for the voice pipeline."""

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    deepgram_api_key: str = ""
    openrouter_api_key: str = ""
    web_app_url: str = ""
    internal_api_key: str = ""
    port: int = 7860
    public_url: str = "http://localhost:7860"
    metered_api_key: str = ""
    recording_enabled: bool = False
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    app_environment: str = "prod"


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def load_settings() -> Settings:
    """Load all env vars via python-dotenv, validate required keys, return Settings.

    Returns:
        Settings with all configuration values populated.

    Raises:
        RuntimeError: If any required environment variable is missing.
    """
    load_dotenv()

    # Validate required env vars are present
    missing = [var for var in REQUIRED_ENV_VARS if not os.getenv(var)]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}"
        )

    return Settings(
        supabase_url=os.environ["SUPABASE_URL"],
        supabase_service_role_key=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        deepgram_api_key=os.environ["DEEPGRAM_API_KEY"],
        openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
        web_app_url=os.environ["WEB_APP_URL"],
        internal_api_key=os.environ["INTERNAL_API_KEY"],
        port=int(os.getenv("PORT", "7860")),
        public_url=os.getenv("PUBLIC_URL", "http://localhost:7860"),
        metered_api_key=os.getenv("METERED_API_KEY", ""),
        recording_enabled=os.getenv("RECORDING_ENABLED", "false").lower() == "true",
        twilio_account_sid=os.getenv("TWILIO_ACCOUNT_SID", ""),
        twilio_auth_token=os.getenv("TWILIO_AUTH_TOKEN", ""),
        app_environment=os.getenv("APP_ENVIRONMENT", "prod"),
    )

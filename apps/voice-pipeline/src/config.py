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
]


@dataclass(frozen=True)
class PricingConstants:
    """Per-provider pricing rates for cost tracking."""

    LLM_COST_PER_INPUT_TOKEN: float = 0.15 / 1_000_000
    LLM_COST_PER_OUTPUT_TOKEN: float = 0.60 / 1_000_000
    TTS_COST_PER_CHAR: float = 0.015 / 1_000
    STT_COST_PER_MINUTE: float = 0.0043


PRICING = PricingConstants()


# ============================================================================
# SETTINGS
# ============================================================================

@dataclass
class Settings:
    """All configuration values for the voice pipeline."""

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    deepgram_api_key: str = ""
    openrouter_api_key: str = ""
    llm_model: str = "google/gemini-3-flash-preview"
    tts_voice: str = "aura-2-helena-en"
    port: int = 7860
    public_url: str = "http://localhost:7860"


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
        llm_model=os.getenv("LLM_MODEL", "google/gemini-3-flash-preview"),
        tts_voice=os.getenv("TTS_VOICE", "aura-2-helena-en"),
        port=int(os.getenv("PORT", "7860")),
        public_url=os.getenv("PUBLIC_URL", "http://localhost:7860"),
    )

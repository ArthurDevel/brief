"""
Supabase service-role client factory for the voice pipeline.

Creates a Supabase client using the service role key, which bypasses
Row Level Security. Used for server-side operations like session
management, action processing, and credential retrieval.

- Creates a Supabase client with service role permissions
- Mirrors apps/voice-gateway/src/supabase.ts
"""

from supabase import create_client, Client

from src.config import Settings


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def create_service_client(settings: Settings) -> Client:
    """Create a Supabase client using the service role key.

    Bypasses RLS for server-side operations.

    Args:
        settings: Application settings containing supabase_url and supabase_service_role_key.

    Returns:
        Supabase client with service role permissions.
    """
    return create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
    )

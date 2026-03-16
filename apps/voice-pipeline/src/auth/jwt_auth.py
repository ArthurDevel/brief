"""
Supabase JWT token verification for WebRTC browser connections.

- Verifies a Supabase access token and extracts the user ID
- Returns None on any auth failure (expired, invalid, revoked)
"""

import logging

from supabase import Client


logger = logging.getLogger(__name__)


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def verify_token(token: str, supabase: Client) -> str | None:
    """Verify a Supabase JWT token and return the user ID.

    Calls supabase.auth.get_user() which validates the token server-side.

    Args:
        token: The Supabase access token (JWT) from the client.
        supabase: Supabase client (service role) for auth verification.

    Returns:
        The user ID string if the token is valid, None otherwise.
    """
    try:
        user_response = supabase.auth.get_user(token)

        if user_response is None or user_response.user is None:
            logger.warning("[jwt_auth] Token verification returned no user")
            return None

        return user_response.user.id

    except Exception as exc:
        logger.warning("[jwt_auth] Token verification failed: %s", exc)
        return None

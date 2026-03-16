"""
Supabase Vault helpers for storing and retrieving secrets.

Wraps public RPC functions that delegate to vault.create_secret() etc.
Secrets are encrypted by pgsodium and never leave the database in plaintext.

- Retrieve decrypted secrets by UUID
- Store new secrets and return their UUID
"""

from supabase import Client


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def retrieve_secret(supabase: Client, secret_id: str) -> str:
    """Retrieve a decrypted secret from Supabase Vault by UUID.

    Args:
        supabase: Supabase client with service role permissions.
        secret_id: UUID of the secret to retrieve.

    Returns:
        The decrypted secret value.

    Raises:
        RuntimeError: If the RPC call fails or the secret is not found.
    """
    response = supabase.rpc(
        "vault_retrieve_secret",
        {"secret_id": secret_id},
    ).execute()

    if response.data is None:
        raise RuntimeError(f'Secret "{secret_id}" not found or empty')

    return response.data


def store_secret(supabase: Client, secret: str, name: str) -> str:
    """Store a secret in Supabase Vault via vault.create_secret().

    Args:
        supabase: Supabase client with service role permissions.
        secret: The plaintext secret value to store.
        name: A human-readable name for the secret.

    Returns:
        The UUID of the created secret.

    Raises:
        RuntimeError: If the RPC call fails.
    """
    response = supabase.rpc(
        "vault_create_secret",
        {"secret": secret, "name": name},
    ).execute()

    if response.data is None:
        raise RuntimeError(f'Failed to store secret "{name}"')

    return response.data

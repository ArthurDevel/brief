/**
 * Supabase Vault helpers for storing and retrieving secrets.
 *
 * Wraps Supabase Vault RPC calls for managing encrypted secrets
 * (IMAP/SMTP passwords). Secrets are encrypted by pgsodium and
 * never leave the database server in plaintext.
 *
 * Responsibilities:
 * - storeSecret: create a new secret in Vault
 * - retrieveSecret: decrypt and return a secret by ID
 * - updateSecret: update an existing secret's value
 * - deleteSecret: remove a secret from Vault
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Stores a secret in Supabase Vault via vault.create_secret().
 * @param supabase - Supabase client with service role permissions
 * @param value - The plaintext secret value to store
 * @param name - A human-readable name for the secret
 * @returns The UUID of the created secret
 */
export async function storeSecret(supabase: SupabaseClient, value: string, name: string): Promise<string> {
  const { data, error } = await supabase.rpc("vault_create_secret", {
    secret: value,
    name: name,
  });

  if (error) {
    throw new Error(`Failed to store secret "${name}": ${error.message}`);
  }

  return data as string;
}

/**
 * Retrieves a decrypted secret from Supabase Vault by UUID.
 * @param supabase - Supabase client with service role permissions
 * @param secretId - The UUID of the secret to retrieve
 * @returns The decrypted plaintext secret value
 */
export async function retrieveSecret(supabase: SupabaseClient, secretId: string): Promise<string> {
  const { data, error } = await supabase
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("id", secretId)
    .single();

  if (error) {
    throw new Error(`Failed to retrieve secret "${secretId}": ${error.message}`);
  }

  if (!data?.decrypted_secret) {
    throw new Error(`Secret "${secretId}" not found or empty`);
  }

  return data.decrypted_secret;
}

/**
 * Updates an existing secret's value in Supabase Vault.
 * @param supabase - Supabase client with service role permissions
 * @param secretId - The UUID of the secret to update
 * @param newValue - The new plaintext value
 */
export async function updateSecret(supabase: SupabaseClient, secretId: string, newValue: string): Promise<void> {
  const { error } = await supabase.rpc("vault_update_secret", {
    secret_id: secretId,
    new_secret: newValue,
  });

  if (error) {
    throw new Error(`Failed to update secret "${secretId}": ${error.message}`);
  }
}

/**
 * Deletes a secret from Supabase Vault.
 * @param supabase - Supabase client with service role permissions
 * @param secretId - The UUID of the secret to delete
 */
export async function deleteSecret(supabase: SupabaseClient, secretId: string): Promise<void> {
  const { error } = await supabase.rpc("vault_delete_secret", {
    secret_id: secretId,
  });

  if (error) {
    throw new Error(`Failed to delete secret "${secretId}": ${error.message}`);
  }
}

/**
 * Supabase Vault helpers for storing and retrieving secrets.
 *
 * Wraps public RPC functions that delegate to vault.create_secret() etc.
 * Secrets are encrypted by pgsodium and never leave the database in plaintext.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stores a secret in Supabase Vault via vault.create_secret().
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
 */
export async function retrieveSecret(supabase: SupabaseClient, secretId: string): Promise<string> {
  const { data, error } = await supabase.rpc("vault_retrieve_secret", {
    secret_id: secretId,
  });

  if (error) {
    throw new Error(`Failed to retrieve secret "${secretId}": ${error.message}`);
  }

  if (!data) {
    throw new Error(`Secret "${secretId}" not found or empty`);
  }

  return data as string;
}

/**
 * Updates an existing secret's value in Supabase Vault.
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
 */
export async function deleteSecret(supabase: SupabaseClient, secretId: string): Promise<void> {
  const { error } = await supabase.rpc("vault_delete_secret", {
    secret_id: secretId,
  });

  if (error) {
    throw new Error(`Failed to delete secret "${secretId}": ${error.message}`);
  }
}

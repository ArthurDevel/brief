/**
 * Server helpers for managing user email accounts.
 *
 * Loads and manages the active email account from user_email_accounts,
 * replacing the legacy IMAP/SMTP fields on user_settings.
 *
 * Responsibilities:
 * - Load the active email account for a user and map to EmailAccountSummary
 * - Create or update a custom IMAP/SMTP email account with Vault secret storage
 * - Deactivate previous accounts when switching mailbox identity
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailAccountSummary, CustomEmailAccountInput } from "./types";
import type { EmailAccountRecord } from "@dublin/email";
import { storeSecret, updateSecret, retrieveSecret } from "@dublin/tools/src/vault";

// ============================================================================
// MAIN ENTRYPOINTS
// ============================================================================

/**
 * Loads the user's single active email account and maps it to a summary DTO.
 * @param supabase - Supabase client (user-scoped or service role)
 * @param userId - The user's ID
 * @returns The active email account summary, or null if none configured
 */
export async function getActiveEmailAccount(
  supabase: SupabaseClient,
  userId: string
): Promise<EmailAccountSummary | null> {
  const { data, error } = await supabase
    .from("user_email_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load active email account: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return mapRowToSummary(data);
}

/**
 * Creates or updates the user's active custom IMAP/SMTP email account.
 * Deactivates any existing active account if the mailbox identity changes.
 * Stores IMAP/SMTP passwords in Vault.
 *
 * @param supabase - Supabase client (user-scoped, for reading/writing account rows)
 * @param serviceClient - Supabase service-role client (for Vault secret operations)
 * @param userId - The user's ID
 * @param input - Custom email account input with IMAP/SMTP details
 * @returns The upserted email account summary
 */
export async function upsertCustomEmailAccount(
  supabase: SupabaseClient,
  serviceClient: SupabaseClient,
  userId: string,
  input: CustomEmailAccountInput
): Promise<EmailAccountSummary> {
  // Step 1: Check for existing active account
  const existing = await getExistingActiveAccount(supabase, userId);

  // Step 2: If existing account has a different identity, deactivate it
  if (existing && existing.imap_user !== input.imapUser) {
    await deactivateAccount(supabase, existing.id as string);
  }

  // Step 3: Store or update IMAP/SMTP passwords in Vault
  const imapPasswordSecretId = await storeOrUpdatePassword(
    serviceClient,
    input.imapPassword,
    existing?.imap_password_secret_id,
    `imap_password_${userId}`
  );

  const smtpPasswordSecretId = await storeOrUpdatePassword(
    serviceClient,
    input.smtpPassword,
    existing?.smtp_password_secret_id,
    `smtp_password_${userId}`
  );

  // Step 4: Upsert the account row
  const canReuseRow = existing && existing.imap_user === input.imapUser;

  const row = {
    user_id: userId,
    provider: "custom" as const,
    connection_type: "imap_smtp" as const,
    email_address: input.imapUser,
    status: "connected" as const,
    is_active: true,
    imap_host: input.imapHost,
    imap_port: input.imapPort,
    imap_user: input.imapUser,
    imap_password_secret_id: imapPasswordSecretId ?? existing?.imap_password_secret_id ?? null,
    smtp_host: input.smtpHost,
    smtp_port: input.smtpPort,
    smtp_user: input.smtpUser,
    smtp_password_secret_id: smtpPasswordSecretId ?? existing?.smtp_password_secret_id ?? null,
    connected_at: new Date().toISOString(),
  };

  let resultRow;

  if (canReuseRow) {
    // Update existing row
    const { data, error } = await supabase
      .from("user_email_accounts")
      .update(row)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to update email account: ${error.message}`);
    }
    resultRow = data;
  } else {
    // Insert new row
    const { data, error } = await supabase
      .from("user_email_accounts")
      .insert(row)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to create email account: ${error.message}`);
    }
    resultRow = data;
  }

  return mapRowToSummary(resultRow);
}

/**
 * Loads the user's active email account as a full EmailAccountRecord,
 * including resolved IMAP/SMTP passwords from Vault for custom accounts.
 * Used by action routes that need to create a provider-agnostic email client.
 * @param supabase - Supabase client (user-scoped, for reading the account row)
 * @param serviceClient - Supabase service-role client (for Vault secret retrieval)
 * @param userId - The user's ID
 * @returns The full EmailAccountRecord, or null if no active account
 */
export async function getActiveEmailAccountRecord(
  supabase: SupabaseClient,
  serviceClient: SupabaseClient,
  userId: string
): Promise<EmailAccountRecord | null> {
  const { data, error } = await supabase
    .from("user_email_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load active email account: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const record: EmailAccountRecord = {
    id: data.id as string,
    userId: data.user_id as string,
    provider: data.provider as EmailAccountRecord["provider"],
    connectionType: data.connection_type as EmailAccountRecord["connectionType"],
    emailAddress: (data.email_address as string) ?? null,
    unipileAccountId: (data.unipile_account_id as string) ?? null,
    status: data.status as string,
    lastError: (data.last_error as string) ?? null,
  };

  // For custom accounts, resolve IMAP/SMTP passwords from Vault
  if (record.connectionType === "imap_smtp") {
    if (!data.imap_password_secret_id) {
      throw new Error("Custom email account has no IMAP password configured");
    }

    const imapPassword = await retrieveSecret(serviceClient, data.imap_password_secret_id as string);

    let smtpPassword = "";
    if (data.smtp_password_secret_id) {
      smtpPassword = await retrieveSecret(serviceClient, data.smtp_password_secret_id as string);
    }

    record.customConfig = {
      imap: {
        host: data.imap_host as string,
        port: data.imap_port as number,
        user: data.imap_user as string,
        password: imapPassword,
      },
      smtp: {
        host: data.smtp_host as string,
        port: data.smtp_port as number,
        user: data.smtp_user as string,
        password: smtpPassword,
      },
    };
  }

  return record;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Maps a user_email_accounts database row to an EmailAccountSummary DTO.
 * @param row - Raw database row from user_email_accounts
 * @returns Mapped EmailAccountSummary
 */
function mapRowToSummary(row: Record<string, unknown>): EmailAccountSummary {
  return {
    id: row.id as string,
    provider: row.provider as EmailAccountSummary["provider"],
    connectionType: row.connection_type as EmailAccountSummary["connectionType"],
    emailAddress: (row.email_address as string) ?? null,
    status: row.status as EmailAccountSummary["status"],
    lastError: (row.last_error as string) ?? null,
    hasImapPassword: row.imap_password_secret_id != null,
    hasSmtpPassword: row.smtp_password_secret_id != null,
  };
}

/**
 * Loads the existing active account row for a user, if any.
 * @param supabase - Supabase client
 * @param userId - The user's ID
 * @returns The raw account row, or null
 */
async function getExistingActiveAccount(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("user_email_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check existing email account: ${error.message}`);
  }

  return data;
}

/**
 * Deactivates an email account by setting is_active to false.
 * @param supabase - Supabase client
 * @param accountId - The account row ID to deactivate
 */
async function deactivateAccount(supabase: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await supabase
    .from("user_email_accounts")
    .update({ is_active: false })
    .eq("id", accountId);

  if (error) {
    throw new Error(`Failed to deactivate email account: ${error.message}`);
  }
}

/**
 * Stores a new password in Vault or updates an existing one.
 * Returns the secret ID if a password was stored/updated, or null if no password provided.
 * @param serviceClient - Supabase service-role client for Vault operations
 * @param password - The password to store (undefined means no change)
 * @param existingSecretId - Existing Vault secret ID to update, if any
 * @param secretName - Human-readable name for the Vault secret
 * @returns The Vault secret UUID, or null if no password was provided
 */
async function storeOrUpdatePassword(
  serviceClient: SupabaseClient,
  password: string | undefined,
  existingSecretId: unknown,
  secretName: string
): Promise<string | null> {
  if (!password) {
    return null;
  }

  if (existingSecretId && typeof existingSecretId === "string") {
    await updateSecret(serviceClient, existingSecretId, password);
    return existingSecretId;
  }

  const secretId = await storeSecret(serviceClient, password, secretName);
  return secretId;
}

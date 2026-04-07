/**
 * Provider-agnostic email account facade.
 *
 * Creates an EmailAccountClient that dispatches to either custom IMAP/SMTP
 * or Unipile-backed implementations based on the EmailAccountRecord's
 * connectionType field.
 *
 * Responsibilities:
 * - Factory function to build a provider-agnostic email client
 * - Custom path: opens IMAP connection and wraps imap-client + smtp-client functions
 * - Unipile path: wraps unipile-client functions with the stored account ID
 */

import type { EmailAccountRecord, EmailAccountClient, EmailMetaRequest, FolderInfo } from "./types";
import type { ImapFlow } from "imapflow";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Builds a provider-agnostic email client for the given account.
 * For custom accounts: creates an IMAP connection and wraps IMAP/SMTP functions.
 * For Unipile accounts: wraps the Unipile REST client functions.
 * @param account - The email account record with connection details
 * @returns A provider-agnostic EmailAccountClient
 */
export async function createEmailAccountClient(account: EmailAccountRecord): Promise<EmailAccountClient> {
  if (account.connectionType === "unipile") {
    return createUnipileClient(account);
  }

  if (account.connectionType === "imap_smtp") {
    return await createCustomClient(account);
  }

  throw new Error(`Unknown connection type: ${account.connectionType}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates that a target folder exists by checking against listFolders results.
 * Throws with available folder names if the folder is not found.
 * @param folder - The target folder path to validate
 * @param listFoldersFn - Function that returns the available folders
 */
async function validateFolderExists(folder: string, listFoldersFn: () => Promise<FolderInfo[]>): Promise<void> {
  const folders = await listFoldersFn();
  const folderPaths = folders.map((f) => f.path);
  const match = folderPaths.some(
    (p) => p.toLowerCase() === folder.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `Folder "${folder}" does not exist. Available folders: ${folderPaths.join(", ")}`
    );
  }
}

// ============================================================================
// UNIPILE CLIENT BUILDER
// ============================================================================

/**
 * Creates an EmailAccountClient backed by Unipile REST API.
 * @param account - The email account record (must have unipileAccountId)
 * @returns Unipile-backed EmailAccountClient
 */
async function createUnipileClient(account: EmailAccountRecord): Promise<EmailAccountClient> {
  const accountId = account.unipileAccountId;
  if (!accountId) {
    throw new Error("Unipile account has no unipile_account_id");
  }

  // Lazy import to avoid loading Unipile module for custom accounts
  const unipile = await import("./unipile-client");

  return {
    listInbox: (limit: number) => unipile.listInbox(accountId, limit),
    searchEmails: (query: string) => unipile.searchEmails(accountId, query),
    readEmail: (emailId: string) => unipile.readEmail(accountId, emailId),
    readThread: (emailId: string) => unipile.readThread(accountId, emailId),
    markAsRead: (emailId: string) => unipile.markAsRead(accountId, emailId),
    archiveEmail: (emailId: string, sourceFolder?: string) =>
      unipile.archiveEmail(accountId, emailId, sourceFolder ?? "INBOX"),
    deleteEmail: (emailId: string, sourceFolder?: string) =>
      unipile.deleteEmail(accountId, emailId, sourceFolder ?? "INBOX"),
    moveToFolder: async (emailId: string, folder: string, sourceFolder?: string) => {
      await validateFolderExists(folder, () => unipile.listFolders(accountId));
      return unipile.moveToFolder(accountId, emailId, folder, sourceFolder ?? "INBOX");
    },
    moveEmail: (emailId: string, destFolder: string, sourceFolder?: string) =>
      unipile.moveEmail(accountId, emailId, sourceFolder ?? "INBOX", destFolder),
    listFolders: () => unipile.listFolders(accountId),
    resolveSpecialUseFolder: (flag: string) => unipile.resolveSpecialUseFolder(accountId, flag),
    saveDraft: (input) => unipile.saveDraft(accountId, input),
    deleteDraft: (uid: number) => unipile.deleteDraft(accountId, String(uid)),
    sendEmail: (input) => unipile.sendEmail(accountId, input),
    replyEmail: (input) =>
      unipile.replyEmail(accountId, input.context.messageId, input.body, input.replyAll, input.senderAddress),
    fetchReplyContext: (emailId: string) => unipile.fetchReplyContext(accountId, emailId),
    fetchEmailMetaBatch: (ids: EmailMetaRequest[]) => unipile.fetchEmailMetaBatch(accountId, ids),
  };
}

// ============================================================================
// CUSTOM (IMAP/SMTP) CLIENT BUILDER
// ============================================================================

/**
 * Creates an EmailAccountClient backed by direct IMAP/SMTP connections.
 * Opens an IMAP connection eagerly and wraps imap-client + smtp-client functions.
 * @param account - The email account record (must have customConfig)
 * @returns Custom IMAP/SMTP-backed EmailAccountClient
 */
async function createCustomClient(account: EmailAccountRecord): Promise<EmailAccountClient> {
  if (!account.customConfig) {
    throw new Error("Custom account has no IMAP/SMTP configuration");
  }

  const { imap: imapConfig, smtp: smtpConfig } = account.customConfig;

  // Lazy imports to avoid circular dependencies
  const imapClient = await import("./imap-client");
  const smtpClient = await import("./smtp-client");

  const client: ImapFlow = await imapClient.createImapConnection(imapConfig);

  return {
    listInbox: (limit: number) => imapClient.listInbox(client, limit),
    searchEmails: (query: string) => imapClient.searchEmails(client, query),
    readEmail: (emailId: string) => imapClient.readEmail(client, emailId),
    readThread: (emailId: string) => imapClient.readThread(client, emailId),
    markAsRead: async (emailId: string) => { await imapClient.markAsRead(client, emailId); },
    archiveEmail: (emailId: string, sourceFolder?: string) =>
      imapClient.archiveEmail(client, emailId, sourceFolder ?? "INBOX"),
    deleteEmail: (emailId: string, sourceFolder?: string) =>
      imapClient.deleteEmail(client, emailId, sourceFolder ?? "INBOX"),
    moveToFolder: async (emailId: string, folder: string, sourceFolder?: string) => {
      await validateFolderExists(folder, () => imapClient.listFolders(client));
      return imapClient.moveEmailToFolder(client, emailId, folder, sourceFolder ?? "INBOX");
    },
    moveEmail: (messageId: string, destFolder: string, sourceFolder?: string) =>
      imapClient.moveEmail(client, messageId, sourceFolder ?? "INBOX", destFolder),
    listFolders: () => imapClient.listFolders(client),
    resolveSpecialUseFolder: async (flag: string) => {
      try {
        return await imapClient.resolveSpecialUseFolder(client, flag as "\\All" | "\\Trash" | "\\Drafts" | "\\Sent");
      } catch {
        return null;
      }
    },
    saveDraft: (input) => smtpClient.saveDraft(client, input),
    deleteDraft: (uid: number) => smtpClient.deleteDraft(client, String(uid)),
    sendEmail: (input) =>
      smtpClient.sendEmail(smtpConfig, input).then(() => undefined),
    replyEmail: (input) =>
      smtpClient.replyToEmail(smtpConfig, input.context, input.body, input.replyAll, input.senderAddress).then(() => undefined),
    fetchReplyContext: (emailId: string) => imapClient.fetchReplyContext(client, emailId),
    fetchEmailMetaBatch: async (ids: EmailMetaRequest[]) => {
      const map = await imapClient.fetchEmailMetaBatch(client, ids);
      // Convert Map<string, EmailMeta> to the same format
      return map;
    },
  };
}

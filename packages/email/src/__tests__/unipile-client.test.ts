/**
 * Unit tests for Unipile client draft and send operations.
 *
 * CRITICAL: Unipile has two separate endpoints that behave very differently:
 *   - POST /api/v1/drafts  -> creates a draft (returns "DraftCreated" with draft_id)
 *   - POST /api/v1/emails  -> SENDS the email immediately (returns "EmailSent")
 *
 * Previously we used POST /api/v1/emails with { draft: true } for drafts.
 * Unipile silently ignores that flag and sends the email anyway. This caused
 * every "save as draft" action (both voice pipeline and dashboard) to actually
 * send the email to the recipient.
 *
 * These tests exist to prevent that regression. Do NOT change the endpoint
 * assertions without verifying against the real Unipile API.
 *
 * Delete uses /api/v1/emails/{id} for both drafts and sent emails (there is
 * no DELETE /api/v1/drafts/{id} endpoint -- it returns 404).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set required env vars before importing the module
process.env.UNIPILE_API_KEY = "test-key";
process.env.UNIPILE_DSN = "https://test.unipile.com:1234";

const TEST_ACCOUNT_ID = "test-account-id";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Creates a mock Response that fetch will return.
 */
function mockFetchResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ============================================================================
// TESTS
// ============================================================================

describe("unipile-client draft/send endpoints", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saveDraft POSTs to /api/v1/drafts, not /api/v1/emails", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ object: "DraftCreated", draft_id: "abc123" }, 201)
    );

    // Import fresh to pick up env vars
    const { saveDraft } = await import("../unipile-client");
    await saveDraft(TEST_ACCOUNT_ID, {
      to: "recipient@example.com",
      subject: "Test draft",
      body: "Draft body",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/v1/drafts");
    expect(url).not.toContain("/api/v1/emails");
  });

  it("saveDraft does NOT include draft:true in the payload", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ object: "DraftCreated", draft_id: "abc123" }, 201)
    );

    const { saveDraft } = await import("../unipile-client");
    await saveDraft(TEST_ACCOUNT_ID, {
      to: "recipient@example.com",
      subject: "Test draft",
      body: "Draft body",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(options?.body as string);
    expect(sentBody).not.toHaveProperty("draft");
  });

  it("saveDraft reads draft_id from the response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ object: "DraftCreated", draft_id: "my-draft-123" }, 201)
    );

    const { saveDraft } = await import("../unipile-client");
    const recipe = await saveDraft(TEST_ACCOUNT_ID, {
      to: "recipient@example.com",
      subject: "Test draft",
      body: "Draft body",
    });

    expect(recipe.params.draftUid).toBe("my-draft-123");
  });

  it("sendEmail POSTs to /api/v1/emails, not /api/v1/drafts", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ object: "EmailSent", tracking_id: "xyz" }, 201)
    );

    const { sendEmail } = await import("../unipile-client");
    await sendEmail(TEST_ACCOUNT_ID, {
      to: "recipient@example.com",
      subject: "Test send",
      body: "Send body",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/v1/emails");
    expect(url).not.toContain("/api/v1/drafts");
  });

  it("deleteDraft DELETEs via /api/v1/emails/{id}, not /api/v1/drafts/{id}", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ object: "EmailDeleted" }, 200)
    );

    const { deleteDraft } = await import("../unipile-client");
    await deleteDraft(TEST_ACCOUNT_ID, "draft-to-delete");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/v1/emails/draft-to-delete");
    expect(url).not.toContain("/api/v1/drafts");
    expect(options?.method).toBe("DELETE");
  });
});

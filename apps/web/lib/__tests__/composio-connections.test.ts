import { describe, expect, it } from "vitest";
import { mapUserComposioConnectionRowToSummary } from "@/lib/composio-connections";

describe("mapUserComposioConnectionRowToSummary", () => {
  it("maps a raw row into the shared DTO", () => {
    expect(
      mapUserComposioConnectionRowToSummary({
        toolkit: "gmail",
        provider: "composio",
        connected_account_id: "conn_123",
        status: "connected",
        external_user_id: "user_123",
        connected_at: "2026-04-19T12:00:00.000Z",
        last_error: null,
      })
    ).toEqual({
      toolkit: "gmail",
      provider: "composio",
      connectedAccountId: "conn_123",
      status: "connected",
      externalUserId: "user_123",
      connectedAt: "2026-04-19T12:00:00.000Z",
      lastError: null,
    });
  });
});

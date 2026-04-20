import { describe, expect, it } from "vitest";
import {
  listUserComposioConnections,
  mapUserComposioConnectionRowToSummary,
} from "@/lib/composio-connections";

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

describe("listUserComposioConnections", () => {
  it("maps all saved rows into shared DTOs", async () => {
    const supabase = createListSupabaseMock([
      {
        toolkit: "gmail",
        provider: "composio",
        connected_account_id: "conn_123",
        status: "connected",
        external_user_id: "user_123",
        connected_at: "2026-04-19T12:00:00.000Z",
        last_error: null,
      },
      {
        toolkit: "slack",
        provider: "composio",
        connected_account_id: null,
        status: "error",
        external_user_id: "user_123",
        connected_at: null,
        last_error: "Slack was not connected.",
      },
    ]);

    await expect(listUserComposioConnections(supabase, "user_123")).resolves.toEqual([
      {
        toolkit: "gmail",
        provider: "composio",
        connectedAccountId: "conn_123",
        status: "connected",
        externalUserId: "user_123",
        connectedAt: "2026-04-19T12:00:00.000Z",
        lastError: null,
      },
      {
        toolkit: "slack",
        provider: "composio",
        connectedAccountId: null,
        status: "error",
        externalUserId: "user_123",
        connectedAt: null,
        lastError: "Slack was not connected.",
      },
    ]);
  });
});

function createListSupabaseMock(
  rows: Array<{
    toolkit: string;
    provider: string;
    connected_account_id: string | null;
    status: "connected" | "reconnect_required" | "pending" | "error";
    external_user_id: string | null;
    connected_at: string | null;
    last_error: string | null;
  }>
) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return Promise.resolve({
                    data: rows,
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof listUserComposioConnections>[0];
}

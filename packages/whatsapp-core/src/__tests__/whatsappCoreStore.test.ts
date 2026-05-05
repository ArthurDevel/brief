import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WhatsAppCoreStore } from "../whatsappCoreStore.js";

// ============================================================================
// TYPES
// ============================================================================

interface AuthUserRecord {
  app_metadata?: Record<string, unknown>;
  email: string | null;
  id: string;
  user_metadata?: Record<string, unknown>;
}

interface MockSupabaseState {
  authUsersById: Map<string, AuthUserRecord>;
  executionAgentThreads: Array<Record<string, unknown>>;
  nextMessageId: number;
  nextUserId: number;
  userSettingsByPhone: Map<string, string>;
  whatsappMessages: Array<Record<string, unknown>>;
}

interface UpsertUserSettingsInput {
  user_id: string;
  whatsapp_phone: string;
}

interface InsertWhatsAppMessageInput {
  contact_phone_number: string;
  direction: "inbound" | "outbound";
  meta_message_id: string;
  raw_payload: unknown;
  status: string;
  text: string;
  user_id: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a minimal Supabase client mock for WhatsApp core store tests.
 * @returns Supabase client mock plus mutable state
 */
function createSupabaseMock(): {
  state: MockSupabaseState;
  supabase: SupabaseClient;
} {
  const state: MockSupabaseState = {
    authUsersById: new Map<string, AuthUserRecord>(),
    executionAgentThreads: [],
    nextMessageId: 1,
    nextUserId: 1,
    userSettingsByPhone: new Map<string, string>(),
    whatsappMessages: [],
  };

  const supabase = {
    auth: {
      admin: {
        createUser: vi.fn(async (input: {
          app_metadata?: Record<string, unknown>;
          email: string;
          email_confirm: boolean;
          user_metadata?: Record<string, unknown>;
        }) => {
          const userId = `user-${state.nextUserId}`;
          state.nextUserId += 1;

          const user: AuthUserRecord = {
            app_metadata: input.app_metadata,
            email: input.email,
            id: userId,
            user_metadata: input.user_metadata,
          };

          state.authUsersById.set(userId, user);

          return {
            data: {
              user,
            },
            error: null,
          };
        }),
        getUserById: vi.fn(async (userId: string) => {
          const user = state.authUsersById.get(userId) ?? null;

          return {
            data: {
              user,
            },
            error: user ? null : new Error(`User ${userId} not found`),
          };
        }),
        updateUserById: vi.fn(async (
          userId: string,
          input: {
            email?: string;
            email_confirm?: boolean;
            user_metadata?: Record<string, unknown>;
          }
        ) => {
          const existingUser = state.authUsersById.get(userId);
          if (!existingUser) {
            return {
              data: {
                user: null,
              },
              error: new Error(`User ${userId} not found`),
            };
          }

          const updatedUser: AuthUserRecord = {
            ...existingUser,
            email: input.email ?? existingUser.email,
            user_metadata: input.user_metadata ?? existingUser.user_metadata,
          };

          state.authUsersById.set(userId, updatedUser);

          return {
            data: {
              user: updatedUser,
            },
            error: null,
          };
        }),
      },
    },
    from: vi.fn((tableName: string) => {
      if (tableName === "user_settings") {
        return {
          select: () => ({
            eq: (_columnName: string, phone: string) => ({
              maybeSingle: async () => {
                const userId = state.userSettingsByPhone.get(phone) ?? null;

                return {
                  data: userId
                    ? {
                        user_id: userId,
                        whatsapp_phone: phone,
                      }
                    : null,
                  error: null,
                };
              },
            }),
          }),
          upsert: async (input: UpsertUserSettingsInput) => {
            state.userSettingsByPhone.set(input.whatsapp_phone, input.user_id);
            return {
              error: null,
            };
          },
        };
      }

      if (tableName === "execution_agent_threads") {
        return {
          select: () => ({
            eq: (_columnName: string, userId: string) => ({
              order: () => ({
                limit: async (limit: number) => {
                  const rows = state.executionAgentThreads
                    .filter((row) => row.user_id === userId)
                    .sort((first, second) => {
                      return String(second.updated_at).localeCompare(String(first.updated_at));
                    })
                    .slice(0, limit);

                  return {
                    data: rows,
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }

      if (tableName === "whatsapp_messages") {
        return {
          insert: (input: InsertWhatsAppMessageInput) => ({
            select: () => ({
              single: async () => {
                const row = {
                  contact_phone_number: input.contact_phone_number,
                  created_at: "2026-04-23T00:00:00.000Z",
                  direction: input.direction,
                  id: `message-${state.nextMessageId}`,
                  meta_message_id: input.meta_message_id,
                  status: input.status,
                  text: input.text,
                  user_id: input.user_id,
                };

                state.nextMessageId += 1;
                state.whatsappMessages.push(row);

                return {
                  data: row,
                  error: null,
                };
              },
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${tableName}`);
    }),
  } as unknown as SupabaseClient;

  return {
    state,
    supabase,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppCoreStore", () => {
  it("creates a synthetic WhatsApp account for an unknown inbound phone", async () => {
    const { state, supabase } = createSupabaseMock();
    const store = new WhatsAppCoreStore(supabase);

    const result = await store.storeInboundTextMessage({
      fromPhone: "15551234567",
      metaMessageId: "wamid.first-message",
      rawPayload: {
        text: "hi",
      },
      text: "hi",
    });

    expect(result.status).toBe("inserted");
    expect(result.user).toEqual({
      userId: "user-1",
      whatsappPhone: "+15551234567",
    });
    expect(state.userSettingsByPhone.get("+15551234567")).toBe("user-1");
    expect(state.authUsersById.get("user-1")).toMatchObject({
      app_metadata: {
        signup_source: "whatsapp",
      },
      email: "wa_15551234567@wa.OpenPokeButVoice.invalid",
      id: "user-1",
      user_metadata: {
        whatsapp_auth: true,
        whatsapp_auth_email: "wa_15551234567@wa.OpenPokeButVoice.invalid",
        whatsapp_phone: "+15551234567",
      },
    });
    expect(state.whatsappMessages).toHaveLength(1);
    expect(state.whatsappMessages[0]).toMatchObject({
      contact_phone_number: "+15551234567",
      direction: "inbound",
      meta_message_id: "wamid.first-message",
      status: "received",
      text: "hi",
      user_id: "user-1",
    });
  });

  it("lists execution-agent threads for a user by most recent update", async () => {
    const { state, supabase } = createSupabaseMock();
    const store = new WhatsAppCoreStore(supabase);

    state.executionAgentThreads.push(
      {
        agent_name: "calendar",
        created_at: "2026-04-22T09:00:00.000Z",
        id: "thread-1",
        updated_at: "2026-04-22T10:00:00.000Z",
        user_id: "user-1",
      },
      {
        agent_name: "gmailInbox",
        created_at: "2026-04-22T09:30:00.000Z",
        id: "thread-2",
        updated_at: "2026-04-22T11:00:00.000Z",
        user_id: "user-1",
      },
      {
        agent_name: "otherUser",
        created_at: "2026-04-22T09:30:00.000Z",
        id: "thread-3",
        updated_at: "2026-04-22T12:00:00.000Z",
        user_id: "user-2",
      }
    );

    const threads = await store.listExecutionAgentThreads({
      limit: 10,
      userId: "user-1",
    });

    expect(threads.map((thread) => thread.agentName)).toEqual([
      "gmailInbox",
      "calendar",
    ]);
  });
});

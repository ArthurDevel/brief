/**
 * Shared Supabase-backed storage for WhatsApp runtimes.
 *
 * Responsibilities:
 * - Resolve a WhatsApp-linked user from `user_settings`
 * - Read user memory and WhatsApp thread history
 * - Persist inbound and outbound WhatsApp text rows to `whatsapp_messages`
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  InvalidWhatsAppPhoneError,
  WhatsAppUserNotFoundError,
} from "./errors.js";
import { normalizeWhatsAppPhone } from "./normalizeWhatsAppPhone.js";
import type {
  ListWhatsAppConversationMessagesDto,
  StoreInboundWhatsAppTextMessageDto,
  StoreInboundWhatsAppTextMessageResultDto,
  StoreOutboundWhatsAppTextMessageDto,
  WhatsAppConversationMessageDto,
  WhatsAppLinkedUserDto,
  WhatsAppMemoryEntryDto,
} from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

interface UserSettingsLookupRow {
  user_id: string;
  whatsapp_phone: string;
}

interface WhatsAppMessageRow {
  contact_phone_number: string;
  created_at: string;
  direction: "inbound" | "outbound";
  id: string;
  meta_message_id: string | null;
  status: string;
  text: string;
  user_id: string | null;
}

interface UserMemoryRow {
  content: string;
  id: string;
}

interface CreateWhatsAppCoreStoreConfig {
  supabaseServiceRoleKey: string;
  supabaseUrl: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const UNIQUE_VIOLATION_CODE = "23505";

// ============================================================================
// MAIN CLASS
// ============================================================================

export class WhatsAppCoreStore {
  private readonly supabase: SupabaseClient;

  /**
   * Creates the shared WhatsApp storage service.
   * @param supabase - Service-role Supabase client
   */
  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Loads the linked user for one WhatsApp phone number.
   * @param phone - Raw or normalized WhatsApp phone number
   * @returns Linked user DTO
   */
  async requireLinkedUserByPhone(phone: string): Promise<WhatsAppLinkedUserDto> {
    const normalizedPhone = this.requireNormalizedPhone(phone);
    const { data, error } = await this.supabase
      .from("user_settings")
      .select("user_id, whatsapp_phone")
      .eq("whatsapp_phone", normalizedPhone)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to look up the WhatsApp caller: ${error.message}`);
    }

    const userRow = data as UserSettingsLookupRow | null;
    if (!userRow?.user_id || !userRow.whatsapp_phone) {
      throw new WhatsAppUserNotFoundError(normalizedPhone);
    }

    return {
      userId: userRow.user_id,
      whatsappPhone: userRow.whatsapp_phone,
    };
  }

  /**
   * Loads the user's saved memory entries.
   * @param userId - Supabase user ID
   * @returns Memory entries ordered oldest-first
   */
  async getUserMemoryEntries(userId: string): Promise<WhatsAppMemoryEntryDto[]> {
    const { data, error } = await this.supabase
      .from("user_memory")
      .select("id, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to load user memory: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((row) => this.mapUserMemoryRow(row as UserMemoryRow));
  }

  /**
   * Loads recent WhatsApp messages for one user/contact thread.
   * @param input - Thread lookup DTO
   * @returns Conversation rows in ascending timestamp order
   */
  async listConversationMessages(
    input: ListWhatsAppConversationMessagesDto
  ): Promise<WhatsAppConversationMessageDto[]> {
    const normalizedPhone = this.requireNormalizedPhone(input.contactPhoneNumber);
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .select("id, user_id, contact_phone_number, direction, text, meta_message_id, status, created_at")
      .eq("user_id", input.userId)
      .eq("contact_phone_number", normalizedPhone)
      .order("created_at", { ascending: false })
      .limit(input.limit);

    if (error) {
      throw new Error(`Failed to load WhatsApp conversation history: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((row) => this.mapConversationRow(row as WhatsAppMessageRow))
      .reverse();
  }

  /**
   * Persists one inbound WhatsApp text message, deduplicated by Meta message ID.
   * @param input - Inbound message DTO
   * @returns Insert result with linked user info
   */
  async storeInboundTextMessage(
    input: StoreInboundWhatsAppTextMessageDto
  ): Promise<StoreInboundWhatsAppTextMessageResultDto> {
    const linkedUser = await this.requireLinkedUserByPhone(input.fromPhone);
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .insert({
        user_id: linkedUser.userId,
        contact_phone_number: linkedUser.whatsappPhone,
        direction: "inbound",
        text: input.text,
        meta_message_id: input.metaMessageId,
        status: "received",
        raw_payload: input.rawPayload,
      })
      .select("id, user_id, contact_phone_number, direction, text, meta_message_id, status, created_at")
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION_CODE) {
        return {
          message: null,
          status: "duplicate",
          user: linkedUser,
        };
      }

      throw new Error(`Failed to store inbound WhatsApp text message: ${error.message}`);
    }

    return {
      message: this.mapConversationRow(data as WhatsAppMessageRow),
      status: "inserted",
      user: linkedUser,
    };
  }

  /**
   * Persists one outbound WhatsApp text message after it is sent.
   * @param input - Outbound message DTO
   * @returns Stored outbound message row
   */
  async storeOutboundTextMessage(
    input: StoreOutboundWhatsAppTextMessageDto
  ): Promise<WhatsAppConversationMessageDto> {
    const normalizedPhone = this.requireNormalizedPhone(input.toPhone);
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .insert({
        user_id: input.userId,
        contact_phone_number: normalizedPhone,
        direction: "outbound",
        text: input.text,
        status: "sent",
        raw_payload: input.rawPayload,
      })
      .select("id, user_id, contact_phone_number, direction, text, meta_message_id, status, created_at")
      .single();

    if (error) {
      throw new Error(`Failed to store outbound WhatsApp text message: ${error.message}`);
    }

    return this.mapConversationRow(data as WhatsAppMessageRow);
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Validates and normalizes one WhatsApp phone number.
   * @param phone - Raw or normalized phone
   * @returns Normalized phone
   */
  private requireNormalizedPhone(phone: string): string {
    const normalizedPhone = normalizeWhatsAppPhone(phone);
    if (!normalizedPhone) {
      throw new InvalidWhatsAppPhoneError(phone);
    }

    return normalizedPhone;
  }

  /**
   * Maps one conversation row into the exported DTO.
   * @param row - Raw `whatsapp_messages` row
   * @returns Conversation message DTO
   */
  private mapConversationRow(row: WhatsAppMessageRow): WhatsAppConversationMessageDto {
    return {
      id: String(row.id),
      contactPhoneNumber: String(row.contact_phone_number),
      createdAt: String(row.created_at),
      direction: row.direction,
      metaMessageId: row.meta_message_id ? String(row.meta_message_id) : null,
      status: String(row.status),
      text: String(row.text),
      userId: row.user_id ? String(row.user_id) : null,
    };
  }

  /**
   * Maps one memory row into the exported DTO.
   * @param row - Raw `user_memory` row
   * @returns Memory entry DTO
   */
  private mapUserMemoryRow(row: UserMemoryRow): WhatsAppMemoryEntryDto {
    return {
      id: String(row.id),
      content: String(row.content),
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the shared WhatsApp storage service from Supabase env values.
 * @param config - Supabase service-role config
 * @returns Shared WhatsApp core store
 */
export function createWhatsAppCoreStore(
  config: CreateWhatsAppCoreStoreConfig
): WhatsAppCoreStore {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return new WhatsAppCoreStore(supabase);
}

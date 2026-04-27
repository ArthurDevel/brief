/**
 * Shared Supabase-backed storage for WhatsApp runtimes.
 *
 * Responsibilities:
 * - Resolve or create a WhatsApp-linked user from `user_settings`
 * - Read user memory and WhatsApp thread history
 * - Persist inbound and outbound WhatsApp text rows to `whatsapp_messages`
 * - Persist execution-agent threads and messages for WhatsApp text agents
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  InvalidWhatsAppPhoneError,
  WhatsAppUserNotFoundError,
} from "./errors.js";
import { normalizeWhatsAppPhone } from "./normalizeWhatsAppPhone.js";
import type {
  AppendExecutionAgentMessageDto,
  AppendExecutionAgentToolCallDto,
  AppendExecutionAgentToolResultDto,
  ExecutionAgentMessageDto,
  ExecutionAgentThreadDto,
  FindOrCreateExecutionAgentThreadDto,
  ListExecutionAgentThreadsDto,
  ListWhatsAppConversationMessagesDto,
  ListExecutionAgentMessagesDto,
  StoreInboundWhatsAppTextMessageDto,
  StoreInboundWhatsAppTextMessageResultDto,
  StoreOutboundWhatsAppTextMessageDto,
  StoreExecutionAgentMessageDto,
  StoreExecutionAgentMessagesDto,
  TouchExecutionAgentThreadDto,
  WhatsAppConversationMessageDto,
  WhatsAppLinkedUserDto,
  WhatsAppMemoryEntryDto,
  ExecutionAgentToolCallDto,
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

interface ExecutionAgentThreadRow {
  agent_name: string;
  created_at: string;
  id: string;
  updated_at: string;
  user_id: string;
}

interface ExecutionAgentMessageRow {
  content: string;
  created_at: string;
  id: string;
  role: "assistant" | "tool" | "user";
  thread_id: string;
  tool_arguments: Record<string, unknown> | null;
  tool_call_id: string | null;
  tool_calls: ExecutionAgentToolCallDto[] | null;
  tool_name: string | null;
  tool_result: Record<string, unknown> | null;
  user_id: string;
}

interface CreateWhatsAppCoreStoreConfig {
  supabaseServiceRoleKey: string;
  supabaseUrl: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const UNIQUE_VIOLATION_CODE = "23505";
const DEFAULT_WHATSAPP_AUTH_EMAIL_DOMAIN = "wa.brewdock.invalid";
const WHATSAPP_SIGNUP_SOURCE = "whatsapp";

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
    const linkedUser = await this.resolveOrCreateLinkedUserByPhone(input.fromPhone);
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

  /**
   * Finds or creates one persisted execution-agent thread for a user and agent name.
   * @param input - Thread lookup DTO
   * @returns Persisted execution-agent thread
   */
  async findOrCreateExecutionAgentThread(
    input: FindOrCreateExecutionAgentThreadDto
  ): Promise<ExecutionAgentThreadDto> {
    const { data, error } = await this.supabase
      .from("execution_agent_threads")
      .insert({
        agent_name: input.agentName,
        user_id: input.userId,
      })
      .select("id, user_id, agent_name, created_at, updated_at")
      .single();

    if (!error) {
      return this.mapExecutionAgentThreadRow(data as ExecutionAgentThreadRow);
    }

    if (error.code !== UNIQUE_VIOLATION_CODE) {
      throw new Error(`Failed to create execution-agent thread: ${error.message}`);
    }

    const { data: existingThread, error: existingThreadError } = await this.supabase
      .from("execution_agent_threads")
      .select("id, user_id, agent_name, created_at, updated_at")
      .eq("user_id", input.userId)
      .eq("agent_name", input.agentName)
      .single();

    if (existingThreadError) {
      throw new Error(`Failed to load execution-agent thread: ${existingThreadError.message}`);
    }

    return this.mapExecutionAgentThreadRow(existingThread as ExecutionAgentThreadRow);
  }

  /**
   * Loads recent persisted execution-agent threads for one user.
   * @param input - Thread list lookup DTO
   * @returns Execution-agent threads ordered most recently updated first
   */
  async listExecutionAgentThreads(
    input: ListExecutionAgentThreadsDto
  ): Promise<ExecutionAgentThreadDto[]> {
    const { data, error } = await this.supabase
      .from("execution_agent_threads")
      .select("id, user_id, agent_name, created_at, updated_at")
      .eq("user_id", input.userId)
      .order("updated_at", { ascending: false })
      .limit(input.limit);

    if (error) {
      throw new Error(`Failed to load execution-agent threads: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((row) => this.mapExecutionAgentThreadRow(row as ExecutionAgentThreadRow));
  }

  /**
   * Loads recent execution-agent messages for one persisted thread.
   * @param input - Thread message lookup DTO
   * @returns Execution-agent messages ordered oldest-first
   */
  async listExecutionAgentMessages(
    input: ListExecutionAgentMessagesDto
  ): Promise<ExecutionAgentMessageDto[]> {
    const { data, error } = await this.supabase
      .from("execution_agent_messages")
      .select(
        "id, thread_id, user_id, role, content, tool_call_id, tool_name, tool_arguments, tool_calls, tool_result, created_at"
      )
      .eq("user_id", input.userId)
      .eq("thread_id", input.threadId)
      .order("created_at", { ascending: false })
      .limit(input.limit);

    if (error) {
      throw new Error(`Failed to load execution-agent messages: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((row) => this.mapExecutionAgentMessageRow(row as ExecutionAgentMessageRow))
      .reverse();
  }

  /**
   * Persists one or more execution-agent messages for a thread.
   * @param input - Message insert DTO
   * @returns Stored execution-agent messages
   */
  async storeExecutionAgentMessages(
    input: StoreExecutionAgentMessagesDto
  ): Promise<ExecutionAgentMessageDto[]> {
    if (input.messages.length === 0) {
      return [];
    }

    const rowsToInsert = input.messages.map((message) => ({
      content: message.content,
      role: message.role,
      thread_id: input.threadId,
      tool_arguments: message.toolArguments,
      tool_call_id: message.toolCallId,
      tool_calls: message.toolCalls,
      tool_name: message.toolName,
      tool_result: message.toolResult,
      user_id: input.userId,
    }));
    const { data, error } = await this.supabase
      .from("execution_agent_messages")
      .insert(rowsToInsert)
      .select(
        "id, thread_id, user_id, role, content, tool_call_id, tool_name, tool_arguments, tool_calls, tool_result, created_at"
      );

    if (error) {
      throw new Error(`Failed to store execution-agent messages: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((row) => this.mapExecutionAgentMessageRow(row as ExecutionAgentMessageRow));
  }

  /**
   * Persists one user or assistant execution-agent message and touches the thread.
   * @param input - Execution-agent message append DTO
   * @returns Stored execution-agent message row
   */
  async appendExecutionAgentMessage(
    input: AppendExecutionAgentMessageDto
  ): Promise<ExecutionAgentMessageDto> {
    return await this.appendSingleExecutionAgentMessage(input.threadId, input.userId, {
      content: input.content,
      role: input.role,
      toolArguments: null,
      toolCallId: null,
      toolCalls: null,
      toolName: null,
      toolResult: null,
    });
  }

  /**
   * Persists one assistant execution-agent tool-call step and touches the thread.
   * @param input - Execution-agent tool-call append DTO
   * @returns Stored execution-agent message row
   */
  async appendExecutionAgentToolCall(
    input: AppendExecutionAgentToolCallDto
  ): Promise<ExecutionAgentMessageDto> {
    return await this.appendSingleExecutionAgentMessage(input.threadId, input.userId, {
      content: input.content,
      role: "assistant",
      toolArguments: null,
      toolCallId: null,
      toolCalls: input.toolCalls,
      toolName: null,
      toolResult: null,
    });
  }

  /**
   * Persists one execution-agent tool result and touches the thread.
   * @param input - Execution-agent tool-result append DTO
   * @returns Stored execution-agent message row
   */
  async appendExecutionAgentToolResult(
    input: AppendExecutionAgentToolResultDto
  ): Promise<ExecutionAgentMessageDto> {
    return await this.appendSingleExecutionAgentMessage(input.threadId, input.userId, {
      content: input.content,
      role: "tool",
      toolArguments: input.toolArguments,
      toolCallId: input.toolCallId,
      toolCalls: null,
      toolName: input.toolName,
      toolResult: input.toolResult,
    });
  }

  /**
   * Updates the persisted timestamp for one execution-agent thread.
   * @param input - Thread touch DTO
   * @returns Promise that resolves when the timestamp is updated
   */
  async touchExecutionAgentThread(input: TouchExecutionAgentThreadDto): Promise<void> {
    const { error } = await this.supabase
      .from("execution_agent_threads")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.threadId)
      .eq("user_id", input.userId);

    if (error) {
      throw new Error(`Failed to touch execution-agent thread: ${error.message}`);
    }
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
   * Resolves a linked user, creating a synthetic WhatsApp account when needed.
   * @param phone - Raw or normalized phone
   * @returns Linked user DTO
   */
  async resolveOrCreateLinkedUserByPhone(
    phone: string
  ): Promise<WhatsAppLinkedUserDto> {
    const normalizedPhone = this.requireNormalizedPhone(phone);
    const linkedUser = await this.findLinkedUserByPhone(normalizedPhone);

    if (linkedUser) {
      await this.ensureWhatsAppAuthEmail(linkedUser.userId, normalizedPhone);
      return linkedUser;
    }

    return await this.createLinkedUserByPhone(normalizedPhone);
  }

  /**
   * Loads a linked user when one exists for the normalized phone.
   * @param normalizedPhone - Valid normalized WhatsApp phone
   * @returns Linked user DTO or null
   */
  private async findLinkedUserByPhone(
    normalizedPhone: string
  ): Promise<WhatsAppLinkedUserDto | null> {
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
      return null;
    }

    return {
      userId: userRow.user_id,
      whatsappPhone: userRow.whatsapp_phone,
    };
  }

  /**
   * Ensures an existing WhatsApp-linked auth user has the internal email identity.
   * @param userId - Supabase auth user ID
   * @param normalizedPhone - Valid normalized WhatsApp phone
   * @returns Promise that resolves when the user can be used for WhatsApp auth
   */
  private async ensureWhatsAppAuthEmail(
    userId: string,
    normalizedPhone: string
  ): Promise<void> {
    const { data: authUserResult, error: authUserError } =
      await this.supabase.auth.admin.getUserById(userId);

    if (authUserError) {
      throw authUserError;
    }

    if (authUserResult.user?.email) {
      return;
    }

    const syntheticEmail = this.buildWhatsAppSyntheticEmail(normalizedPhone);
    const { data: updatedUserResult, error: updateError } =
      await this.supabase.auth.admin.updateUserById(userId, {
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          ...(authUserResult.user?.user_metadata ?? {}),
          whatsapp_phone: normalizedPhone,
          whatsapp_auth: true,
          whatsapp_auth_email: syntheticEmail,
        },
      });

    if (updateError || !updatedUserResult.user?.email) {
      throw updateError ?? new Error("Failed to attach an internal email to the WhatsApp account.");
    }
  }

  /**
   * Creates a synthetic Supabase auth user and links it to the WhatsApp phone.
   * @param normalizedPhone - Valid normalized WhatsApp phone
   * @returns Newly linked user DTO
   */
  private async createLinkedUserByPhone(
    normalizedPhone: string
  ): Promise<WhatsAppLinkedUserDto> {
    const syntheticEmail = this.buildWhatsAppSyntheticEmail(normalizedPhone);
    const { data: createdUserResult, error: createError } =
      await this.supabase.auth.admin.createUser({
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          whatsapp_phone: normalizedPhone,
          whatsapp_auth: true,
          whatsapp_auth_email: syntheticEmail,
        },
        app_metadata: {
          signup_source: WHATSAPP_SIGNUP_SOURCE,
        },
      });

    if (createError || !createdUserResult.user?.id) {
      throw createError ?? new Error("Failed to create the WhatsApp Supabase user.");
    }

    await this.saveWhatsAppPhoneForUser(createdUserResult.user.id, normalizedPhone);

    return {
      userId: createdUserResult.user.id,
      whatsappPhone: normalizedPhone,
    };
  }

  /**
   * Saves the WhatsApp phone link for one Supabase auth user.
   * @param userId - Supabase auth user ID
   * @param normalizedPhone - Valid normalized WhatsApp phone
   * @returns Promise that resolves when the link is persisted
   */
  private async saveWhatsAppPhoneForUser(
    userId: string,
    normalizedPhone: string
  ): Promise<void> {
    const { error } = await this.supabase
      .from("user_settings")
      .upsert(
        {
          user_id: userId,
          whatsapp_phone: normalizedPhone,
        },
        { onConflict: "user_id" }
      );

    if (error) {
      throw new Error(`Failed to save the WhatsApp phone link: ${error.message}`);
    }
  }

  /**
   * Builds the internal synthetic email used for WhatsApp-only auth accounts.
   * @param normalizedPhone - Valid normalized WhatsApp phone
   * @returns Synthetic auth email
   */
  private buildWhatsAppSyntheticEmail(normalizedPhone: string): string {
    const digitsOnly = normalizedPhone.replace(/[^\d]/g, "");
    const emailDomain =
      process.env.WHATSAPP_AUTH_EMAIL_DOMAIN?.trim()
      || DEFAULT_WHATSAPP_AUTH_EMAIL_DOMAIN;

    return `wa_${digitsOnly}@${emailDomain}`;
  }

  /**
   * Persists one execution-agent row and refreshes the parent thread timestamp.
   * @param threadId - Persisted execution-agent thread ID
   * @param userId - Supabase user ID that owns the thread
   * @param message - One execution-agent message row
   * @returns Stored execution-agent message row
   */
  private async appendSingleExecutionAgentMessage(
    threadId: string,
    userId: string,
    message: StoreExecutionAgentMessageDto
  ): Promise<ExecutionAgentMessageDto> {
    const [storedMessage] = await this.storeExecutionAgentMessages({
      messages: [message],
      threadId,
      userId,
    });

    if (!storedMessage) {
      throw new Error("Failed to store execution-agent message.");
    }

    await this.touchExecutionAgentThread({
      threadId,
      userId,
    });

    return storedMessage;
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

  /**
   * Maps one execution-agent thread row into the exported DTO.
   * @param row - Raw `execution_agent_threads` row
   * @returns Execution-agent thread DTO
   */
  private mapExecutionAgentThreadRow(row: ExecutionAgentThreadRow): ExecutionAgentThreadDto {
    return {
      agentName: String(row.agent_name),
      createdAt: String(row.created_at),
      id: String(row.id),
      updatedAt: String(row.updated_at),
      userId: String(row.user_id),
    };
  }

  /**
   * Maps one execution-agent message row into the exported DTO.
   * @param row - Raw `execution_agent_messages` row
   * @returns Execution-agent message DTO
   */
  private mapExecutionAgentMessageRow(row: ExecutionAgentMessageRow): ExecutionAgentMessageDto {
    return {
      content: String(row.content),
      createdAt: String(row.created_at),
      id: String(row.id),
      role: row.role,
      threadId: String(row.thread_id),
      toolArguments: row.tool_arguments,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
      toolCalls: Array.isArray(row.tool_calls) ? row.tool_calls : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      toolResult: row.tool_result,
      userId: String(row.user_id),
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

/**
 * DTOs shared by the WhatsApp voice execution observer and narration runtime.
 *
 * Responsibilities:
 * - Define the read-only execution snapshot the narrator can observe
 * - Define the text-only narration request and response shapes
 * - Keep the narration contract explicit and easy to follow
 */

// ============================================================================
// TYPES
// ============================================================================

export type VoiceExecutionStatus =
  | "starting"
  | "planning"
  | "running_tool"
  | "finished"
  | "failed";

export interface VoiceExecutionSnapshotDto {
  agentName: string;
  currentToolName: string | null;
  executionId: string;
  instructions: string;
  recentMessages: string[];
  startedAt: string;
  status: VoiceExecutionStatus;
  updatedAt: string;
}

export interface VoiceExecutionObserver {
  onExecutionSnapshot(snapshot: VoiceExecutionSnapshotDto): Promise<void> | void;
}

export interface VoiceNarrationRequestDto {
  activeExecution: VoiceExecutionSnapshotDto;
  previousNarration: string | null;
}

export interface VoiceNarrationResultDto {
  createdAt: string;
  message: string;
}

export interface VoiceOpenPokeNarrationAgent {
  generateNarration(
    input: VoiceNarrationRequestDto
  ): Promise<VoiceNarrationResultDto | null>;
}

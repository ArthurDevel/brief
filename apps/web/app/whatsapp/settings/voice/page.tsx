/**
 * WhatsApp voice settings page.
 *
 * Responsibilities:
 * - Stay inside the WhatsApp auth shell
 * - Render the WhatsApp-only voice settings UI
 * - Keep WhatsApp voice configuration separate from the dashboard settings surface
 */

import WhatsAppVoiceSettingsCard from "./WhatsAppVoiceSettingsCard";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Renders the WhatsApp voice settings page.
 * @returns Voice settings UI for the WhatsApp route tree
 */
export default function WhatsAppVoiceSettingsPage() {
  return <WhatsAppVoiceSettingsCard />;
}

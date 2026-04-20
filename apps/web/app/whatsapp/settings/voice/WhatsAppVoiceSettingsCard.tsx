"use client";

/**
 * Client-side WhatsApp voice settings card.
 *
 * Responsibilities:
 * - Load the saved WhatsApp voice config
 * - Load dynamic voice options from the active provider
 * - Let the user preview and save voice + speed changes
 */

import { useEffect, useRef, useState } from "react";
import type { WhatsAppVoiceConfig, WhatsAppVoiceOption } from "@/lib/whatsappVoice";

// ============================================================================
// CONSTANTS
// ============================================================================

const FALLBACK_ERROR_MESSAGE = "Something went wrong. Please try again.";

// ============================================================================
// TYPES
// ============================================================================

interface VoiceSettingsResponse {
  config: WhatsAppVoiceConfig;
}

interface VoiceOptionsResponse {
  options: WhatsAppVoiceOption[];
}

interface RouteErrorResponse {
  code?: string;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Renders the WhatsApp-specific voice settings form.
 * @returns Interactive WhatsApp voice settings card
 */
export default function WhatsAppVoiceSettingsCard() {
  const [voiceOptions, setVoiceOptions] = useState<WhatsAppVoiceOption[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [voiceSpeed, setVoiceSpeed] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void loadVoiceSettings();

    return () => {
      clearTimeout(savedTimerRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  async function loadVoiceSettings(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);

    try {
      const [settingsResponse, optionsResponse] = await Promise.all([
        fetch("/api/whatsapp/settings/voice"),
        fetch("/api/whatsapp/settings/voice/options"),
      ]);

      const settingsPayload = await settingsResponse.json().catch(() => null);
      const optionsPayload = await optionsResponse.json().catch(() => null);

      if (!settingsResponse.ok) {
        const payload = settingsPayload as RouteErrorResponse | null;
        throw new Error(getVoiceSettingsErrorMessage(payload?.code));
      }

      if (!optionsResponse.ok) {
        const payload = optionsPayload as RouteErrorResponse | null;
        throw new Error(getVoiceSettingsErrorMessage(payload?.code));
      }

      const settings = settingsPayload as VoiceSettingsResponse;
      const options = optionsPayload as VoiceOptionsResponse;

      setVoiceOptions(options.options);
      setSelectedVoiceId(settings.config.voiceId);
      setVoiceSpeed(settings.config.speed);

      if (!options.options.some((option) => option.id === settings.config.voiceId)) {
        setErrorMessage("Your saved WhatsApp voice is no longer available. Choose a new voice and save it.");
      }
    } catch (error) {
      console.error("[whatsapp-voice-settings/card] failed to load", {
        error: error instanceof Error ? error.message : String(error),
      });
      setErrorMessage(error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!selectedVoiceId) {
      setErrorMessage("Choose a WhatsApp voice before saving.");
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setSavedMessage(null);

    try {
      const response = await fetch("/api/whatsapp/settings/voice", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voiceId: selectedVoiceId,
          speed: voiceSpeed,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const errorPayload = payload as RouteErrorResponse | null;
        throw new Error(getVoiceSettingsErrorMessage(errorPayload?.code));
      }

      setSavedMessage("Saved");
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedMessage(null), 1500);
    } catch (error) {
      console.error("[whatsapp-voice-settings/card] failed to save", {
        error: error instanceof Error ? error.message : String(error),
      });
      setErrorMessage(error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  function handlePreview(voiceOption: WhatsAppVoiceOption): void {
    const previewUrl = voiceOption.previewUrl;
    if (!previewUrl) {
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (playingVoiceId === voiceOption.id) {
      setPlayingVoiceId(null);
      return;
    }

    const audio = new Audio(previewUrl);
    audio.playbackRate = voiceSpeed;
    audio.onended = () => {
      setPlayingVoiceId(null);
      audioRef.current = null;
    };

    void audio.play().catch((error) => {
      console.error("[whatsapp-voice-settings/card] failed to preview audio", {
        voiceId: voiceOption.id,
        error: error instanceof Error ? error.message : String(error),
      });
      setPlayingVoiceId(null);
    });

    audioRef.current = audio;
    setPlayingVoiceId(voiceOption.id);
  }

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  const selectedVoice = voiceOptions.find((option) => option.id === selectedVoiceId) ?? null;

  return (
    <div className="grid gap-6">
      <section className="settings-panel">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Voice Settings
            </div>
            <h1 className="mt-2 text-[28px] font-semibold">Adjust your WhatsApp voice</h1>
          </div>

          {savedMessage && (
            <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
              {savedMessage}
            </span>
          )}
        </div>

        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          Choose the voice and speed your WhatsApp agent should use during calls. This page is separate from the
          dashboard settings.
        </p>

        {errorMessage && (
          <div className="mt-6 border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {errorMessage}
          </div>
        )}

        <div className="mt-8 grid gap-6">
          <section className="grid gap-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Voice Speed
            </div>
            <p className="text-[14px] leading-6 text-[var(--text-secondary)]">
              Adjust how quickly the WhatsApp agent speaks. Preview uses the current speed.
            </p>

            <div className="rounded-[18px] border border-[var(--border-color)] p-4">
              <div className="flex items-center gap-3">
                <span className="w-8 text-[13px] text-[var(--text-secondary)]">1x</span>
                <input
                  type="range"
                  min={1}
                  max={1.5}
                  step={0.05}
                  value={voiceSpeed}
                  onChange={(event) => setVoiceSpeed(Number.parseFloat(event.target.value))}
                  className="flex-1 accent-[var(--btn-primary-bg)]"
                />
                <span className="w-12 text-[13px] text-[var(--text-secondary)]">1.5x</span>
                <span className="w-12 text-right text-[13px] font-medium text-[var(--text-primary)]">
                  {voiceSpeed.toFixed(2)}x
                </span>
              </div>
            </div>
          </section>

          <section className="grid gap-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Voice
            </div>
            <p className="text-[14px] leading-6 text-[var(--text-secondary)]">
              Available voices are loaded from the active WhatsApp voice provider.
            </p>

            {voiceOptions.length === 0 ? (
              <div className="rounded-[18px] border border-[var(--border-color)] p-4 text-[14px] text-[var(--text-secondary)]">
                No WhatsApp voices are currently available.
              </div>
            ) : (
              <div className="max-h-[420px] space-y-3 overflow-y-auto">
                {voiceOptions.map((voiceOption) => {
                  const isSelected = selectedVoiceId === voiceOption.id;

                  return (
                    <label
                      key={voiceOption.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-[18px] border p-4 transition ${
                        isSelected
                          ? "border-[var(--text-primary)] bg-[var(--bg-hover)]"
                          : "border-[var(--border-color)] hover:border-[var(--text-primary)]"
                      }`}
                    >
                      <input
                        type="radio"
                        name="whatsappVoiceId"
                        value={voiceOption.id}
                        checked={isSelected}
                        onChange={() => setSelectedVoiceId(voiceOption.id)}
                        className="accent-[var(--btn-primary-bg)]"
                      />

                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium text-[var(--text-primary)]">
                          {voiceOption.label}
                        </div>
                        <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
                          {voiceOption.accent ? `${voiceOption.accent} accent` : "Accent unavailable"}
                        </div>
                        <div className="mt-1 text-[12px] text-[var(--text-secondary)]">
                          {voiceOption.id}
                        </div>
                      </div>

                      {voiceOption.previewUrl && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            handlePreview(voiceOption);
                          }}
                          className="border border-[var(--border-color)] px-3 py-2 text-[12px] font-medium text-[var(--text-primary)]"
                        >
                          {playingVoiceId === voiceOption.id ? "Stop" : "Preview"}
                        </button>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !selectedVoice}
            className="bg-[var(--btn-primary-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--btn-primary-text)] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save voice settings"}
          </button>

          {selectedVoice && (
            <div className="text-[13px] text-[var(--text-secondary)]">
              Selected: <span className="font-medium text-[var(--text-primary)]">{selectedVoice.label}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Maps stable API codes to safe UI copy.
 * @param code - API error code
 * @returns User-facing error message
 */
function getVoiceSettingsErrorMessage(code: string | undefined): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "You need to sign in again to manage WhatsApp voice settings.";
    case "VOICE_SETTINGS_LOAD_FAILED":
      return "We couldn't load your WhatsApp voice settings. Please refresh and try again.";
    case "VOICE_SETTINGS_INVALID":
      return "Your saved WhatsApp voice settings are invalid. Please save them again.";
    case "VOICE_SETTINGS_SAVE_FAILED":
      return "We couldn't save your WhatsApp voice settings. Please try again.";
    case "VOICE_OPTIONS_LOAD_FAILED":
      return "We couldn't load WhatsApp voice options. Please try again.";
    case "INVALID_VOICE_SETTINGS":
      return "Choose a valid WhatsApp voice and speed.";
    default:
      return FALLBACK_ERROR_MESSAGE;
  }
}

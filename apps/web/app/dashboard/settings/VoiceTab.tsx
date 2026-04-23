/**
 * Voice settings tab -- voice speed and voice preference.
 *
 * Both controls auto-save on change.
 */

"use client";

import { useState, useEffect, useRef } from "react";
import type { UserSettings } from "@/lib/types";
import type { DeepgramVoice } from "@/app/api/deepgram/voices/route";
import { DEFAULT_SPEED, DEFAULT_VOICE } from "@/lib/user-settings-defaults";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";
import {
  SETTINGS_FIELD_CARD,
  SETTINGS_MAX_WIDTH,
  SETTINGS_SECTION_COPY,
} from "./settingsUi";

async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "SETTINGS_LOAD_FAILED",
      error: "Failed to load settings",
    });
  }
  return res.json();
}

async function fetchVoices(): Promise<DeepgramVoice[]> {
  const res = await fetch("/api/deepgram/voices");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "VOICE_LOAD_FAILED",
      error: "Failed to load voices",
    });
  }
  return res.json();
}

async function saveSettings(data: Record<string, unknown>): Promise<UserSettings> {
  const res = await fetch("/api/user/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "SETTINGS_SAVE_FAILED",
      error: "Failed to save settings",
    });
  }
  return res.json();
}

export default function VoiceTab() {
  const [voicePreference, setVoicePreference] = useState(DEFAULT_VOICE);
  const [voiceSpeed, setVoiceSpeed] = useState(DEFAULT_SPEED);
  const [voices, setVoices] = useState<DeepgramVoice[]>([]);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [previewingSpeed, setPreviewingSpeed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const speedDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    async function load() {
      try {
        const [settings, voiceList] = await Promise.all([fetchSettings(), fetchVoices()]);
        setVoicePreference(settings.voicePreference);
        setVoiceSpeed(settings.voiceSpeed ?? DEFAULT_SPEED);
        setVoices(voiceList);
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(savedTimerRef.current);
      clearTimeout(speedDebounceRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  function flashSaved(section: string) {
    setSavedSection(section);
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedSection(null), 1500);
  }

  async function handleVoiceChange(canonicalName: string) {
    setVoicePreference(canonicalName);
    setError(null);

    try {
      await saveSettings({ voicePreference: canonicalName });
      flashSaved("voice");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_SAVE_FAILED"));
    }
  }

  function handleSpeedChange(speed: number) {
    setVoiceSpeed(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }

    clearTimeout(speedDebounceRef.current);
    speedDebounceRef.current = setTimeout(async () => {
      setError(null);

      try {
        await saveSettings({ voiceSpeed: speed });
        flashSaved("speed");
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_SAVE_FAILED"));
      }
    }, 400);
  }

  function resetAudioState() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlayingVoice(null);
    setPreviewingSpeed(false);
  }

  function handlePlayPreview(canonicalName: string, sampleUrl: string) {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (playingVoice === canonicalName) {
      setPlayingVoice(null);
      return;
    }

    setPreviewingSpeed(false);
    const audio = new Audio(sampleUrl);
    audio.playbackRate = voiceSpeed;
    audio.onended = () => setPlayingVoice(null);
    audio.play();
    audioRef.current = audio;
    setPlayingVoice(canonicalName);
  }

  function handleSpeedPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoice(null);
    }

    if (previewingSpeed) {
      setPreviewingSpeed(false);
      return;
    }

    const selectedVoice = voices.find((voice) => voice.canonicalName === voicePreference);
    if (!selectedVoice?.sampleUrl) {
      return;
    }

    const audio = new Audio(selectedVoice.sampleUrl);
    audio.playbackRate = voiceSpeed;
    audio.onended = () => {
      setPreviewingSpeed(false);
      audioRef.current = null;
    };
    audio.play();
    audioRef.current = audio;
    setPreviewingSpeed(true);
  }

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div>
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2>Voice Speed</h2>
            {savedSection === "speed" && (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            )}
          </div>
          <p className={SETTINGS_SECTION_COPY}>
            Adjust how quickly the assistant speaks during WhatsApp voice sessions. You can preview the selected speed before saving.
          </p>
          <div className={`${SETTINGS_MAX_WIDTH} ${SETTINGS_FIELD_CARD}`}>
            <div className="flex items-center gap-2 md:gap-4 flex-wrap md:flex-nowrap">
              <span className="text-[13px] text-[var(--text-secondary)] w-8 md:w-10">1x</span>
              <input
                type="range"
                min={1}
                max={1.5}
                step={0.05}
                value={voiceSpeed}
                onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                className="flex-1 w-full md:w-auto min-w-[120px] accent-[var(--btn-primary-bg)]"
              />
              <span className="text-[13px] text-[var(--text-secondary)] w-10 md:w-12">1.5x</span>
              <span className="w-10 text-right text-[13px] font-medium text-[var(--text-primary)] md:w-12">
                {voiceSpeed.toFixed(2)}x
              </span>
              <button
                type="button"
                onClick={handleSpeedPreview}
                disabled={!voices.find((voice) => voice.canonicalName === voicePreference)?.sampleUrl}
                className="shrink-0 border border-zinc-200 px-3 py-2 text-sm font-semibold text-black hover:bg-zinc-50 disabled:opacity-50"
              >
                {previewingSpeed ? "Stop" : "Preview"}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2>Voice Preference</h2>
            {savedSection === "voice" && (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            )}
          </div>
          <p className={SETTINGS_SECTION_COPY}>
            Choose the voice BrewDock should use during WhatsApp voice sessions.
          </p>
          {voices.length === 0 ? (
            <p className="text-[13px] text-[var(--text-secondary)]">Loading voices...</p>
          ) : (
            <div className={`${SETTINGS_MAX_WIDTH} space-y-3 max-h-80 overflow-y-auto`}>
              {voices.map((voice) => (
                <label
                  key={voice.canonicalName}
                  className={`flex cursor-pointer items-center gap-3 border p-4 transition-colors ${
                    voicePreference === voice.canonicalName
                      ? "border-black bg-zinc-50"
                      : "border-zinc-200 bg-white hover:border-zinc-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="voicePreference"
                    value={voice.canonicalName}
                    checked={voicePreference === voice.canonicalName}
                    onChange={() => handleVoiceChange(voice.canonicalName)}
                    onClick={resetAudioState}
                    className="accent-[var(--btn-primary-bg)]"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium capitalize text-[var(--text-primary)]">
                      {voice.name}
                    </span>
                    <span className="ml-2 text-xs text-[var(--text-secondary)]">
                      English ({voice.accent} accent)
                    </span>
                  </div>
                  {voice.sampleUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        handlePlayPreview(voice.canonicalName, voice.sampleUrl!);
                      }}
                      className="shrink-0 border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    >
                      {playingVoice === voice.canonicalName ? "Stop" : "Preview"}
                    </button>
                  )}
                </label>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

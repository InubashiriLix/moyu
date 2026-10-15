export interface Chapter { id: string; title: string; text: string }
export interface Book { id: string; path: string; title: string; encoding: string; chapters: Chapter[] }
export interface Position { chapter: number; offset: number }

/** Speech backend preference. `auto` lets Rust pick the best available accelerator. */
export type VoiceBackend = 'auto' | 'cpu' | 'cuda' | 'vulkan';
/** Power/performance preference passed through to the speech engine. */
export type VoicePowerMode = 'eco' | 'balanced';
/** Catalog entries are either downloadable speech models or accelerator components. */
export type ModelKind = 'model' | 'backend';

export interface Preferences {
  backgroundOpacity: number; textOpacity: number; contrast: number;
  fontSize: number; lineHeight: number; theme: 'light' | 'dark';
  alwaysOnTop: boolean; shortcut: string;
  hideToolbar: boolean; fontFamily: 'jetbrains' | 'systemMono' | 'serif';
  voiceEngineDir: string; voiceModelsDir: string;
  voiceSpeaker: 'Uncle_Fu' | 'Serena'; voiceAutomatic: boolean;
  voiceBackend: VoiceBackend; voicePowerMode: VoicePowerMode; voiceModelId: string;
}
export interface Recent { id: string; path: string; title: string; encoding: string; openedAt: number }
export interface SavedState {
  preferences: Preferences; recents: Recent[]; progress: Record<string, Position>;
  marks: Record<string, Record<string, Position>>;
  lastBook: string | null; geometry: { width: number; height: number; x: number | null; y: number | null };
}
export interface Bootstrap { saved: SavedState; platform: string; wayland: boolean; shortcutError: string | null; warning: string | null; openPath: string | null }

export const defaults: Preferences = {
  backgroundOpacity: 0.86, textOpacity: 1, contrast: 0.72,
  fontSize: 16, lineHeight: 1.9, theme: 'light', alwaysOnTop: true, shortcut: 'Ctrl+Alt+M',
  hideToolbar: true, fontFamily: 'jetbrains',
  voiceEngineDir: '', voiceModelsDir: '', voiceSpeaker: 'Uncle_Fu', voiceAutomatic: true,
  voiceBackend: 'auto', voicePowerMode: 'eco', voiceModelId: 'qwen3-tts-1.7b-customvoice-f16',
};

/** One downloadable file belonging to a catalog entry. */
export interface CatalogFile { name: string; size: number; sha256: string; chunks: unknown[] }
/** A speech model or accelerator component offered by the Rust-side catalog. */
export interface CatalogEntry {
  id: string; label: string; kind: ModelKind; variant: string; revision: string;
  enabled: boolean; experimental: boolean; files: CatalogFile[];
}
export type DownloadPhase = 'not_installed' | 'checking' | 'downloading' | 'paused' | 'waiting_network'
  | 'verifying' | 'installing' | 'ready' | 'error' | 'cancelled';
/** Progress/state for a catalog entry, also delivered through the `model-progress` event. */
export interface DownloadStatus {
  id: string; phase: DownloadPhase; downloadedBytes: number; totalBytes: number;
  source: string | null; error: string | null; path: string | null;
}
export interface VoiceBackendInfo { id: string; label: string; available: boolean; reason?: string | null; device?: string | null; downloadRecommended?: boolean }
/** Result of `voice_devices`: available backends plus what was actually selected. */
export interface VoiceDevices { backends: VoiceBackendInfo[]; effectiveBackend?: string | null; device?: string | null }

export interface VoiceStatus {
  requestId: number; bookId: string; chapter: number;
  phase: 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'completed' | 'stopped' | 'error';
  paragraphStart: number | null; paragraphEnd: number | null; offset: number | null; error: string | null;
  effectiveBackend?: string | null; device?: string | null; fallbackReason?: string | null;
}

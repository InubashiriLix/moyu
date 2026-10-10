export interface Chapter { id: string; title: string; text: string }
export interface Book { id: string; path: string; title: string; encoding: string; chapters: Chapter[] }
export interface Position { chapter: number; offset: number }
export interface Preferences {
  backgroundOpacity: number; textOpacity: number; contrast: number;
  fontSize: number; lineHeight: number; theme: 'light' | 'dark';
  alwaysOnTop: boolean; shortcut: string;
  hideToolbar: boolean; fontFamily: 'jetbrains' | 'systemMono' | 'serif';
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
};

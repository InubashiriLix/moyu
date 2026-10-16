import { listen } from '@tauri-apps/api/event';
import * as bridge from './bridge';
import type { Position, VoiceStatus } from './types';

export interface VoiceTransport {
  available: boolean;
  start(requestId: number, bookId: string, position: Position): Promise<VoiceStatus>;
  control(requestId: number, action: string): Promise<VoiceStatus>;
  subscribe(callback: (status: VoiceStatus) => void): Promise<() => void>;
}
let supported = false;
export function setVoicePlatform(platform: string) { supported = bridge.native && platform === 'linux'; }
export const voiceTransport: VoiceTransport = {
  get available() { return supported; },
  start: bridge.voiceStart,
  control: bridge.voiceControl,
  async subscribe(callback) {
    if (!bridge.native) return () => {};
    return listen<VoiceStatus>('voice-status', event => callback(event.payload));
  },
};

import type { Preferences } from './types';

export type PanelName = 'toc' | 'settings' | 'library' | 'help' | 'marks' | 'search';

export type Command =
  | { type: 'panel'; panel: PanelName; query?: string }
  | { type: 'delmark'; letters: string[]; all: boolean }
  | { type: 'quit'; force: boolean }
  | { type: 'font'; mode: 'increase' | 'decrease' | 'set'; value: number }
  | { type: 'set'; values: Partial<Preferences>; invalid: string[] }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'chapter'; index: number }
  | { type: 'percent'; value: number }
  | { type: 'search'; query: string }
  | { type: 'open' }
  | { type: 'hide' }
  | { type: 'reset' }
  | { type: 'error'; message: string };

interface Setter {
  key: keyof Preferences;
  kind: 'number' | 'boolean' | 'theme' | 'fontFamily' | 'string';
  min?: number;
  max?: number;
}

// Numeric bounds mirror Preferences::normalize in src-tauri/src/state.rs.
const setters: Record<string, Setter> = {
  fontsize: { key: 'fontSize', kind: 'number', min: 10, max: 32 },
  fs: { key: 'fontSize', kind: 'number', min: 10, max: 32 },
  lineheight: { key: 'lineHeight', kind: 'number', min: 1.2, max: 2.6 },
  lh: { key: 'lineHeight', kind: 'number', min: 1.2, max: 2.6 },
  contrast: { key: 'contrast', kind: 'number', min: 0.05, max: 1 },
  backgroundopacity: { key: 'backgroundOpacity', kind: 'number', min: 0, max: 1 },
  bgopacity: { key: 'backgroundOpacity', kind: 'number', min: 0, max: 1 },
  bg: { key: 'backgroundOpacity', kind: 'number', min: 0, max: 1 },
  textopacity: { key: 'textOpacity', kind: 'number', min: 0.05, max: 1 },
  fgopacity: { key: 'textOpacity', kind: 'number', min: 0.05, max: 1 },
  fg: { key: 'textOpacity', kind: 'number', min: 0.05, max: 1 },
  theme: { key: 'theme', kind: 'theme' },
  ontop: { key: 'alwaysOnTop', kind: 'boolean' },
  alwaystop: { key: 'alwaysOnTop', kind: 'boolean' },
  pin: { key: 'alwaysOnTop', kind: 'boolean' },
  hidebar: { key: 'hideToolbar', kind: 'boolean' },
  hidetoolbar: { key: 'hideToolbar', kind: 'boolean' },
  fontfamily: { key: 'fontFamily', kind: 'fontFamily' },
  shortcut: { key: 'shortcut', kind: 'string' },
};

const fonts: Record<string, Preferences['fontFamily']> = {
  jetbrains: 'jetbrains', mono: 'jetbrains', systemmono: 'systemMono', system: 'systemMono', serif: 'serif', songti: 'serif',
};
const trues = ['on', 'true', '1', 'yes', 'enable', 'enabled'];
const falses = ['off', 'false', '0', 'no', 'disable', 'disabled'];

function toNumber(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
function toBoolean(text: string): boolean | null {
  const value = text.toLowerCase();
  if (trues.includes(value)) return true;
  if (falses.includes(value)) return false;
  return null;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function parseSet(rest: string): Command {
  if (!rest.trim()) return { type: 'panel', panel: 'settings' };
  const values: Partial<Preferences> = {};
  const invalid: string[] = [];
  for (const token of rest.split(/\s+/)) {
    const equal = token.indexOf('=');
    if (equal <= 0) { invalid.push(token); continue; }
    const setter = setters[token.slice(0, equal).toLowerCase()];
    const raw = token.slice(equal + 1);
    if (!setter) { invalid.push(token); continue; }
    if (setter.kind === 'number') {
      const value = toNumber(raw);
      if (value === null) { invalid.push(token); continue; }
      (values as Record<string, unknown>)[setter.key] = clamp(value, setter.min!, setter.max!);
    } else if (setter.kind === 'boolean') {
      const value = toBoolean(raw);
      if (value === null) { invalid.push(token); continue; }
      (values as Record<string, unknown>)[setter.key] = value;
    } else if (setter.kind === 'theme') {
      const value = raw.toLowerCase();
      if (value !== 'light' && value !== 'dark') { invalid.push(token); continue; }
      values.theme = value;
    } else if (setter.kind === 'fontFamily') {
      const value = fonts[raw.toLowerCase()];
      if (!value) { invalid.push(token); continue; }
      values.fontFamily = value;
    } else {
      values.shortcut = raw;
    }
  }
  if (!Object.keys(values).length && invalid.length) return { type: 'error', message: `无法识别：${invalid.join(' ')}` };
  return { type: 'set', values, invalid };
}

function parseFont(rest: string): Command {
  const value = rest.trim().toLowerCase();
  if (!value) return { type: 'error', message: '用法：:font increase | decrease | 20' };
  if (['increase', 'inc', 'up', '+', '+1'].includes(value)) return { type: 'font', mode: 'increase', value: 1 };
  if (['decrease', 'dec', 'down', '-', '-1'].includes(value)) return { type: 'font', mode: 'decrease', value: 1 };
  const relative = /^([+-])(\d+)$/.exec(value);
  if (relative) return { type: 'font', mode: relative[1] === '+' ? 'increase' : 'decrease', value: Number(relative[2]) };
  const absolute = toNumber(value);
  if (absolute !== null && absolute >= 1) return { type: 'font', mode: 'set', value: absolute };
  return { type: 'error', message: `无法识别的字号：${rest.trim()}` };
}

/** Translate a `:` command line into a structured command. Returns null for an empty line. */
export function parseCommand(raw: string): Command | null {
  const input = raw.trim().replace(/^[:,]\s*/, '');
  if (!input) return null;
  const [head, ...parts] = input.split(/\s+/);
  const name = head.toLowerCase();
  const rest = parts.join(' ');
  switch (name) {
    case 'q': case 'quit':
      return { type: 'quit', force: false };
    case 'qa!': case 'quit!': case 'wq': case 'x':
      return { type: 'quit', force: true };
    case 'index': case 'toc': case 't':
      return { type: 'panel', panel: 'toc' };
    case 'set': case 'se':
      return parseSet(rest);
    case 'font': case 'fontsize':
      return parseFont(rest);
    case 'help': case 'h':
      return { type: 'panel', panel: 'help' };
    case 'open': case 'e': case 'edit':
      return { type: 'open' };
    case 'library': case 'ls': case 'recent':
      return { type: 'panel', panel: 'library' };
    case 'marks':
      return { type: 'panel', panel: 'marks' };
    case 'delmark': case 'delmarks': case 'delm': {
      const letters = Array.from(new Set(rest.toLowerCase().split('').filter(char => /[a-z]/.test(char))));
      return { type: 'delmark', letters, all: letters.length === 0 };
    }
    case 'hide':
      return { type: 'hide' };
    case 'reset':
      return { type: 'reset' };
    case 'theme': {
      const value = rest.trim().toLowerCase();
      if (value === 'dark' || value === 'light') return { type: 'theme', theme: value };
      return { type: 'error', message: '用法：:theme dark | light' };
    }
    case 'search': case 'find':
      return rest.trim() ? { type: 'search', query: rest.trim() } : { type: 'panel', panel: 'search' };
    case 'chapter': case 'ch': {
      const value = Number.parseInt(rest, 10);
      if (!Number.isFinite(value) || value < 1) return { type: 'error', message: '用法：:chapter 3' };
      return { type: 'chapter', index: value - 1 };
    }
    default: {
      if (/^\d+$/.test(name)) return { type: 'percent', value: Math.min(100, Number(name)) };
      return { type: 'error', message: `未知命令：${name}` };
    }
  }
}

import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { defaults, type Book, type Bootstrap, type Position, type Preferences, type SavedState } from './types';

export const native = isTauri();
const previewKey = 'moyu-browser-preview-v1';
const previewBooks = new Map<string, Book>();
let previewSaved: SavedState;
function previewState(): SavedState {
  if (previewSaved) return previewSaved;
  try { const data = localStorage.getItem(previewKey); if (data) previewSaved = JSON.parse(data); } catch { /* A blocked storage area is allowed in preview. */ }
  previewSaved ??= { preferences: { ...defaults }, recents: [], progress: {}, marks: {}, lastBook: null, geometry: { width: 360, height: 480, x: null, y: null } };
  previewSaved.marks ??= {};
  return previewSaved;
}
function persistPreview() { localStorage.setItem(previewKey, JSON.stringify(previewState())); }

export async function bootstrap(): Promise<Bootstrap> {
  if (native) return invoke('bootstrap');
  return { saved: previewState(), platform: 'preview', wayland: false, shortcutError: null, warning: null, openPath: null };
}

export async function openBook(path: string, encoding?: string): Promise<Book> {
  if (native) return invoke('open_book', { path, encoding: encoding ?? null });
  const book = previewBooks.get(path);
  if (!book) throw new Error('浏览器预览不能重新访问本地文件，请再次选择文件。');
  const state = previewState();
  state.lastBook = book.id;
  state.recents = [{ id: book.id, path: book.path, title: book.title, encoding: book.encoding, openedAt: Date.now() / 1000 }, ...state.recents.filter(r => r.id !== book.id)].slice(0, 20);
  persistPreview();
  return book;
}

export async function chooseBook(encoding: string): Promise<Book | null> {
  if (native) {
    const path = await open({ multiple: false, filters: [{ name: '小说', extensions: ['txt', 'epub'] }] });
    return typeof path === 'string' ? openBook(path, encoding) : null;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.txt';
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.addEventListener('change', async () => {
      try { resolve(input.files?.[0] ? await previewFile(input.files[0], encoding) : null); }
      catch (e) { reject(e); }
    }, { once: true });
    input.click();
  });
}

export async function previewFile(file: File, encoding = 'auto'): Promise<Book> {
  if (!file.name.toLowerCase().endsWith('.txt')) throw new Error('浏览器预览仅支持 TXT；EPUB 请使用桌面应用。');
  if (file.size > 64 * 1024 * 1024) throw new Error('请选择不超过 64 MB 的文件。');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let chosen = encoding;
  if (chosen === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) chosen = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) chosen = 'utf-16be';
    else {
      try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); chosen = 'utf-8'; }
      catch { chosen = 'gb18030'; }
    }
  }
  let text: string;
  try { text = new TextDecoder(chosen, { fatal: true }).decode(buffer).replace(/\r\n?/g, '\n'); }
  catch { throw new Error('无法读取这个编码，请切换编码后重新打开。'); }
  if (!text.trim()) throw new Error('文件中没有可读取的文字。');
  const title = file.name.replace(/\.txt$/i, '');
  const chapters: Book['chapters'] = [];
  let name = title, body: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length <= 60 && /^(第.+[章回节卷]|chapter\s)/i.test(line.trim())) {
      if (body.join('\n').trim()) chapters.push({ id: String(chapters.length), title: name, text: body.join('\n').trim() });
      name = line.trim(); body = [];
    } else body.push(line);
  }
  if (body.join('\n').trim()) chapters.push({ id: String(chapters.length), title: name, text: body.join('\n').trim() });
  const book: Book = { id: `preview:${file.name}`, path: `preview:${file.name}`, title, encoding: chosen, chapters };
  previewBooks.set(book.path, book);
  return openBook(book.path);
}

export async function sampleBook(): Promise<Book> {
  const text = Array.from({ length: 12 }, (_, chapter) => `第${chapter + 1}章 山间来信\n\n` + Array.from({ length: 60 }, (_, paragraph) => {
    const content = ['午后的光落在窗台上，茶杯里的热气慢慢散去。远处传来一声鸟鸣，像是谁在翻过新的一页。', '小镇的路沿着河水向前。她把那封没有署名的信收进口袋，决定等雨停之后再出发。', '旧书店依然开着。老板没有问她从哪里来，只指了指靠窗的那张椅子，那里正好可以看见山。'];
    return `【${chapter + 1}-${paragraph + 1}】${content[paragraph % content.length].repeat(3)}`;
  }).join('\n\n')).join('\n\n');
  return previewFile(new File([text], '山间来信 · 示例.txt', { type: 'text/plain' }));
}

export async function savePreferences(preferences: Preferences): Promise<Preferences> {
  if (native) return invoke('save_preferences', { preferences });
  previewState().preferences = { ...preferences }; persistPreview(); return preferences;
}
export async function saveProgress(id: string, position: Position) {
  if (native) await invoke('save_progress', { id, position });
  else { previewState().progress[id] = position; persistPreview(); }
}
export async function saveMarks(id: string, marks: Record<string, Position>) {
  if (native) await invoke('save_marks', { id, marks });
  else {
    const state = previewState();
    if (Object.keys(marks).length) state.marks[id] = marks; else delete state.marks[id];
    persistPreview();
  }
}
export async function hideWindow() {
  if (!native) throw new Error('浏览器预览不控制系统窗口，请使用桌面应用。');
  await invoke('hide_window');
}
export async function quit() {
  if (!native) throw new Error('浏览器预览请关闭标签页。');
  await invoke('quit');
}
export async function drag() { if (native) await getCurrentWindow().startDragging(); }
export async function resize(direction: 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest') {
  if (native) await getCurrentWindow().startResizeDragging(direction);
}

import './style.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import * as bridge from './bridge';
import { comparePosition, type Match } from './model';
import { VimKeys, type KeyAction } from './keys';
import { parseCommand, type PanelName } from './commands';
import { Reader } from './reader';
import { defaults, type Book, type Bootstrap, type Position, type Preferences } from './types';

type Panel = PanelName | null;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main class="window" aria-label="摸鱼小说阅读器">
    <header class="toolbar">
      <div class="drag-handle" title="拖动窗口"><span class="brand">摸鱼</span><span class="book-label"></span></div>
      <button class="icon-button" data-action="library" title="打开 / 最近阅读 (o)" aria-label="打开 / 最近阅读">⌑</button>
      <button class="icon-button" data-action="settings" title="设置 (s)" aria-label="设置">⋯</button>
      <button class="icon-button hide-button" data-action="hide" title="隐藏窗口" aria-label="隐藏窗口">−</button>
    </header>
    <div class="toolbar-hotspot" title="停留显示工具栏；拖动可移动窗口" aria-hidden="true"></div>
    <section class="reader" tabindex="0" aria-label="小说正文"></section>
    <section class="welcome">
      <div class="welcome-icon" aria-hidden="true"><span></span><span></span></div>
      <h1>摸鱼</h1>
      <p>留一小扇窗，读几页书。</p>
      <button class="primary" data-action="open">打开小说 <kbd>o</kbd></button>
      <p class="hint">TXT / EPUB · 拖入即可阅读</p>
      <div class="recent-welcome"></div>
    </section>
    <footer class="status"><span class="chapter-label"></span><span class="progress-label"></span></footer>
    <section class="panel" hidden aria-label="阅读面板"></section>
    <form class="cmdline" hidden aria-label="命令行"><span aria-hidden="true">:</span><input name="command" type="text" spellcheck="false" autocomplete="off" aria-label="命令行"><span class="cmdline-hint">index · set · font · q · qa!</span></form>
    <div class="drop-overlay" hidden>松开，开始阅读</div>
    <div class="toast" role="status" hidden></div>
    ${['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'].map(direction => `<div class="resize-edge ${direction.toLowerCase()}" data-resize="${direction}" aria-hidden="true"></div>`).join('')}
  </main>`;

const viewport = app.querySelector<HTMLElement>('.reader')!;
const panelElement = app.querySelector<HTMLElement>('.panel')!;
const welcome = app.querySelector<HTMLElement>('.welcome')!;
const toastElement = app.querySelector<HTMLElement>('.toast')!;
const dropOverlay = app.querySelector<HTMLElement>('.drop-overlay')!;
const cmdline = app.querySelector<HTMLFormElement>('.cmdline')!;
const cmdlineInput = cmdline.querySelector<HTMLInputElement>('input')!;
let prefs: Preferences = { ...defaults };
const reader = new Reader(viewport, prefs);
const keys = new VimKeys();
let data: Bootstrap;
let book: Book | null = null;
let panel: Panel = null;
let encoding = 'auto';
let busy = false;
let progressTimer: ReturnType<typeof setTimeout>;
let settingsTimer: ReturnType<typeof setTimeout>;
let toastTimer: ReturnType<typeof setTimeout>;
let preferencesQueue: Promise<unknown> = Promise.resolve();
let progressQueue: Promise<unknown> = Promise.resolve();
let matches: Match[] = [];
let matchIndex = -1;
let query = '';
let searchVersion = 0;
let panelCursor = 0;
let panelFilter = '';
let panelLastG = 0;
let markPending: 'set' | 'jump' | null = null;
let historyIndex = 0;
const commandHistory: string[] = [];
const commandNames = ['index', 'toc', 'set ', 'q', 'qa!', 'quit', 'wq', 'x', 'font increase', 'font decrease', 'help', 'open', 'library', 'marks', 'theme dark', 'theme light', 'chapter ', 'search ', 'hide', 'reset'];
const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function toast(message: unknown, sticky = false) {
  clearTimeout(toastTimer);
  toastElement.textContent = message instanceof Error ? message.message : String(message);
  toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, sticky ? 10000 : 4500);
}
function fail(error: unknown) { toast(error, true); }

function applyAppearance() {
  const root = app.querySelector<HTMLElement>('.window')!;
  const dark = prefs.theme === 'dark';
  const bg = dark ? [28, 32, 29] : [247, 246, 239];
  const end = dark ? [239, 239, 223] : [39, 47, 41];
  const rgb = bg.map((channel, i) => Math.round(channel + (end[i] - channel) * prefs.contrast));
  root.dataset.theme = prefs.theme;
  root.dataset.hideToolbar = String(prefs.hideToolbar);
  root.dataset.font = prefs.fontFamily;
  root.style.setProperty('--reader-bg', `rgba(${bg.join(',')},${prefs.backgroundOpacity})`);
  root.style.setProperty('--reader-text', `rgba(${rgb.join(',')},${prefs.textOpacity})`);
  root.style.setProperty('--font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--line-height', String(prefs.lineHeight));
  reader.appearance(prefs);
}

function recentButtons() {
  return (data?.saved.recents ?? []).map(recent => `<button class="recent-item" data-recent="${escape(recent.id)}"><span>${escape(recent.title)}</span><small>${escape(recent.encoding)}</small></button>`).join('');
}
function renderWelcome() {
  app.querySelector('.recent-welcome')!.innerHTML = data?.saved.recents.length ? `<p class="section-label">最近阅读</p>${recentButtons()}` : '';
}
function panelHeader(title: string) { return `<div class="panel-header"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="关闭面板">×</button></div>`; }
function range(name: keyof Preferences, title: string, min: number, max: number, step: number, suffix: string, scale = 1) {
  const value = Number(prefs[name]) * scale;
  return `<label class="setting"><span>${title}<output data-output="${name}">${Math.round(value * 10) / 10}${suffix}</output></span><input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${value}" data-scale="${scale}" data-suffix="${suffix}"></label>`;
}
function encodingSelect() {
  return `<label class="setting compact"><span>TXT 编码</span><select name="encoding">${[['auto', '自动识别'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['gb18030', 'GB18030 / GBK']].map(([value, title]) => `<option value="${value}"${value === encoding ? ' selected' : ''}>${title}</option>`).join('')}</select></label>`;
}
function tocItems() {
  if (!book) return '<p class="note">先打开一本小说。</p>';
  const needle = panelFilter.toLowerCase();
  const entries = book.chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => !needle || chapter.title.toLowerCase().includes(needle));
  if (!entries.length) return '<p class="note">没有匹配的章节。</p>';
  return entries.map(({ chapter, index }) => `<button class="toc-item" data-chapter="${index}" aria-current="${reader.position().chapter === index}"><small>${String(index + 1).padStart(2, '0')}</small><span>${escape(chapter.title)}</span></button>`).join('');
}
function recentItems() {
  const needle = panelFilter.toLowerCase();
  const recents = (data.saved.recents ?? []).filter(recent => !needle || recent.title.toLowerCase().includes(needle));
  if (!recents.length) return '<p class="note">打开一本书，从这里继续读。</p>';
  return recents.map(recent => `<button class="recent-item" data-recent="${escape(recent.id)}"><span>${escape(recent.title)}</span><small>${escape(recent.encoding)}</small></button>`).join('');
}
function bookMarks(): Record<string, Position> {
  if (!book) return {};
  data.saved.marks ??= {};
  return (data.saved.marks[book.id] ??= {});
}
function marksItems() {
  if (!book) return '<p class="note">先打开一本小说。</p>';
  const entries = Object.entries(bookMarks()).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return '<p class="note">还没有书签。正文中按 m 加字母记录，’ 加字母跳回。</p>';
  return entries.map(([letter, position]) => `<button class="toc-item" data-mark="${escape(letter)}"><small>${escape(letter)}</small><span>${escape(book!.chapters[position.chapter]?.title ?? '')}</span></button>`).join('');
}
function filterRow() { return `<input class="panel-filter" type="text" placeholder="输入以过滤（按 / 聚焦）" value="${escape(panelFilter)}" aria-label="过滤列表">`; }

function renderPanel() {
  panelElement.hidden = panel === null;
  panelElement.classList.toggle('search-panel', panel === 'search');
  if (!panel) { panelElement.replaceChildren(); viewport.focus({ preventScroll: true }); return; }
  switch (panel) {
    case 'settings':
      panelElement.innerHTML = `${panelHeader('阅读设置')}<div class="panel-body">
        <div class="segmented" aria-label="主题"><button data-theme="light" aria-pressed="${prefs.theme === 'light'}">浅色</button><button data-theme="dark" aria-pressed="${prefs.theme === 'dark'}">深色</button></div>
        <label class="setting"><span>阅读字体</span><select name="fontFamily">${[['jetbrains', 'JetBrainsMono Nerd Font Mono'], ['systemMono', '系统等宽'], ['serif', '宋体 / 衬线']].map(([value, title]) => `<option value="${value}"${value === prefs.fontFamily ? ' selected' : ''}>${title}</option>`).join('')}</select></label>
        <label class="toggle-setting"><span>隐藏顶部栏</span><input type="checkbox" name="hideToolbar"${prefs.hideToolbar ? ' checked' : ''}></label>
        ${range('backgroundOpacity', '背景透明度', 0, 100, 1, '%', 100)}
        ${range('textOpacity', '文字透明度', 5, 100, 1, '%', 100)}
        ${range('contrast', '文字对比度', 5, 100, 1, '%', 100)}
        ${range('fontSize', '字号', 10, 32, 1, ' px')}
        ${range('lineHeight', '行距', 1.2, 2.6, 0.1, '')}
        ${data.wayland ? '<p class="note">Wayland 的浮动与置顶由窗口管理器控制。niri 请使用随应用提供的浮动规则。</p>' : `<label class="toggle-setting"><span>窗口置顶</span><input type="checkbox" name="alwaysOnTop"${prefs.alwaysOnTop ? ' checked' : ''}></label>`}
        ${data.wayland ? '<p class="note">隐藏 / 恢复：在 niri 中绑定 <code>moyu --toggle</code>。</p>' : `<form class="shortcut-form"><label class="setting"><span>隐藏 / 恢复快捷键</span><input name="shortcut" type="text" value="${escape(prefs.shortcut)}" spellcheck="false" aria-label="隐藏 / 恢复快捷键"></label><button class="secondary" type="submit">应用快捷键</button></form>`}
        <button class="text-button" data-action="reset">恢复默认外观</button>
        <div class="divider"></div><div class="action-row"><button class="secondary" data-action="help">键位帮助</button><button class="text-button" data-action="quit">退出应用</button></div>
        ${!bridge.native ? '<p class="note preview-note">浏览器预览 · 窗口透明、隐藏与全局快捷键请在桌面应用中体验。</p>' : ''}
      </div>`;
      break;
    case 'library':
      panelElement.innerHTML = `${panelHeader('打开小说')}<div class="panel-body">${encodingSelect()}<button class="primary wide" data-action="open">选择 TXT / EPUB</button>${book && book.encoding !== 'EPUB' ? '<button class="text-button" data-action="reopen">用所选编码重新打开当前书</button>' : ''}${!bridge.native ? '<button class="text-button" data-action="sample">打开阅读示例</button>' : ''}<p class="section-label">最近阅读</p>${filterRow()}<div class="panel-list">${recentItems()}</div></div>`;
      break;
    case 'toc':
      panelElement.innerHTML = `${panelHeader('目录')}<div class="panel-body toc-list">${filterRow()}<div class="panel-list">${tocItems()}</div></div>`;
      break;
    case 'marks':
      panelElement.innerHTML = `${panelHeader('书签')}<div class="panel-body toc-list"><div class="panel-list">${marksItems()}</div></div>`;
      break;
    case 'help':
      panelElement.innerHTML = `${panelHeader('键位帮助')}<div class="panel-body"><p class="note">正文区域支持 Vim 常用键位；输入框中正常输入。</p><dl class="key-list">${[['j / k', '向下 / 向上滚动'], ['5j / 3k', '数字前缀：重复移动'], ['Ctrl+d / u', '向下 / 向上半页'], ['Ctrl+f / b', '向下 / 向上一页'], ['gg / G', '书首 / 书尾'], ['50G', '跳到全书 50%'], ['/', '搜索整本书'], ['n / N', '下一个 / 上一个结果'], ['o / s / t', '打开书 / 设置 / 目录'], ['m{a-z}', '记录书签'], ['’{a-z}', '跳到书签'], [':', '命令行'], ['Esc', '关闭当前面板'], ['?', '显示帮助']].map(([key, title]) => `<div><dt><kbd>${key}</kbd></dt><dd>${title}</dd></div>`).join('')}</dl><p class="note">命令行命令：<code>:index</code> 目录、<code>:set</code> 设置、<code>:font increase|decrease</code> 字号、<code>:marks</code> 书签、<code>:q</code> 关面板、<code>:qa!</code> 退出。面板内 <kbd>j</kbd>/<kbd>k</kbd> 选择、<kbd>Enter</kbd> 确认、设置页 <kbd>h</kbd>/<kbd>l</kbd> 调节。</p><p class="note">${data.wayland ? '全局隐藏 / 恢复由窗口管理器绑定 moyu --toggle。' : `全局隐藏 / 恢复：${escape(prefs.shortcut)}`}</p><p class="note">拖动窗口顶部可移动，拖动边缘可缩放。关闭窗口会隐藏，设置中可退出。</p></div>`;
      break;
    case 'search':
      panelElement.innerHTML = `<form class="search-form"><span aria-hidden="true">/</span><input type="search" name="query" value="${escape(query)}" placeholder="搜索整本书" aria-label="搜索整本书" autocomplete="off"><span class="search-count"></span><button type="button" class="icon-button" data-action="previous" title="上一个结果" aria-label="上一个结果">↑</button><button type="button" class="icon-button" data-action="next" title="下一个结果" aria-label="下一个结果">↓</button><button type="button" class="icon-button" data-action="close" aria-label="关闭搜索">×</button></form>`;
      updateSearchCount();
      requestAnimationFrame(() => { const input = panelElement.querySelector<HTMLInputElement>('input')!; input.focus(); input.select(); });
  }
  if (panel !== 'search') syncPanelCursor();
}
function openPanel(next: Panel) {
  const closing = next === panel && next !== 'search';
  panel = closing ? null : next;
  if (!closing) { panelCursor = 0; panelFilter = ''; }
  renderPanel();
}

function panelNavItems(): HTMLElement[] {
  switch (panel) {
    case 'toc': return Array.from(panelElement.querySelectorAll<HTMLElement>('.panel-list [data-chapter]'));
    case 'library': return Array.from(panelElement.querySelectorAll<HTMLElement>('.panel-list .recent-item'));
    case 'marks': return Array.from(panelElement.querySelectorAll<HTMLElement>('.panel-list [data-mark]'));
    case 'settings': return Array.from(panelElement.querySelectorAll<HTMLElement>('.panel-body select, .panel-body input, .panel-body button'));
    default: return [];
  }
}
function syncPanelCursor() {
  const items = panelNavItems();
  if (!items.length) return;
  panelCursor = Math.max(0, Math.min(panelCursor, items.length - 1));
  items.forEach((item, index) => item.classList.toggle('active', index === panelCursor));
  items[panelCursor].scrollIntoView({ block: 'nearest' });
}
function adjustSetting(item: HTMLElement, direction: number) {
  if (item instanceof HTMLInputElement && item.type === 'range') {
    const step = Number(item.step) || 1;
    const next = Math.max(Number(item.min), Math.min(Number(item.max), Number(item.value) + step * direction));
    item.value = String(next);
    item.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (item instanceof HTMLSelectElement) {
    const next = item.selectedIndex + direction;
    if (next >= 0 && next < item.options.length) { item.selectedIndex = next; item.dispatchEvent(new Event('change', { bubbles: true })); }
  } else {
    activateSetting(item);
  }
}
function activateSetting(item: HTMLElement) {
  if (item instanceof HTMLInputElement && item.type === 'checkbox') { item.checked = !item.checked; item.dispatchEvent(new Event('change', { bubbles: true })); return; }
  item.click();
}
function panelKey(event: KeyboardEvent, now = Date.now()): boolean {
  if (!panel || panel === 'search') return false;
  const target = event.target as HTMLElement;
  if (target.matches('input[type=text], input[type=search], textarea')) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = event.key;
  const items = panelNavItems();
  if (key === '/' && (panel === 'toc' || panel === 'library')) {
    panelElement.querySelector<HTMLInputElement>('.panel-filter')?.focus();
    return true;
  }
  if (!items.length) return false;
  const move = (to: number) => { panelCursor = Math.max(0, Math.min(to, items.length - 1)); syncPanelCursor(); };
  if (key === 'j') { panelLastG = 0; move(panelCursor + 1); return true; }
  if (key === 'k') { panelLastG = 0; move(panelCursor - 1); return true; }
  if (key === 'G') { panelLastG = 0; move(items.length - 1); return true; }
  if (key === 'g') {
    if (panelLastG && now - panelLastG < 600) { panelLastG = 0; move(0); } else panelLastG = now;
    return true;
  }
  panelLastG = 0;
  if (panel !== 'settings' && key === 'Enter') { items[panelCursor]?.click(); return true; }
  if (panel === 'settings') {
    const item = items[panelCursor];
    if (key === 'h') { adjustSetting(item, -1); return true; }
    if (key === 'l') { adjustSetting(item, 1); return true; }
    if (key === ' ' || key === 'Enter') { activateSetting(item); return true; }
  }
  return false;
}

function openCommandLine() {
  markPending = null;
  cmdline.hidden = false;
  cmdlineInput.value = '';
  historyIndex = commandHistory.length;
  cmdlineInput.focus();
  cmdlineInput.setSelectionRange(0, 0);
}
function closeCommandLine() {
  cmdline.hidden = true;
  cmdlineInput.value = '';
  const search = panelElement.querySelector<HTMLInputElement>('.search-form input');
  if (panel === 'search' && search) search.focus({ preventScroll: true });
  else viewport.focus({ preventScroll: true });
}
function completeCommand() {
  const value = cmdlineInput.value;
  const options = commandNames.filter(name => name.startsWith(value) && name !== value);
  if (!options.length) return;
  let prefix = options[0];
  for (const name of options) { let i = 0; while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++; prefix = prefix.slice(0, i); }
  cmdlineInput.value = options.length === 1 ? options[0] : prefix;
}
function setFontSize(value: number) {
  const next = Math.max(10, Math.min(32, Math.round(value * 10) / 10));
  prefs.fontSize = next;
  settingsChanged();
  if (panel === 'settings') renderPanel();
  toast(`字号 ${next}px`);
}
async function runCommand(line: string) {
  const command = parseCommand(line);
  if (!command) return;
  switch (command.type) {
    case 'panel':
      if (command.panel === 'search' && command.query !== undefined) {
        query = command.query; searchVersion++;
        worker.postMessage({ query, version: searchVersion });
      }
      openPanel(command.panel);
      break;
    case 'quit':
      if (!command.force) {
        if (panel) { panel = null; renderPanel(); }
        else toast('阅读位置会自动保存；用 :qa! 退出应用。');
        break;
      }
      await saveCurrentProgress(); await persistPreferences(); await bridge.quit();
      break;
    case 'font': {
      const next = command.mode === 'increase' ? prefs.fontSize + command.value : command.mode === 'decrease' ? prefs.fontSize - command.value : command.value;
      setFontSize(next);
      break;
    }
    case 'set':
      if (Object.keys(command.values).length) { Object.assign(prefs, command.values); settingsChanged(); if (panel === 'settings') renderPanel(); }
      if (command.invalid.length) toast(`忽略无法识别的设置：${command.invalid.join(' ')}`);
      else if (Object.keys(command.values).length) toast('设置已更新。');
      break;
    case 'theme':
      prefs.theme = command.theme; settingsChanged();
      if (panel === 'settings') renderPanel();
      break;
    case 'chapter': if (book) { reader.chapter(command.index); panel = null; renderPanel(); } break;
    case 'percent': if (book) reader.percent(command.value); break;
    case 'search':
      query = command.query; searchVersion++;
      worker.postMessage({ query, version: searchVersion });
      openPanel('search');
      break;
    case 'open': await action('open'); break;
    case 'hide': await action('hide'); break;
    case 'reset': await action('reset'); break;
    case 'error': toast(command.message); break;
  }
}

function saveCurrentProgress() {
  clearTimeout(progressTimer);
  if (!book) return Promise.resolve();
  const id = book.id, position = reader.position();
  data.saved.progress[id] = position;
  progressQueue = progressQueue.catch(() => {}).then(() => bridge.saveProgress(id, position)).catch(fail);
  return progressQueue;
}
reader.onPosition = (position: Position) => {
  if (!book) return;
  const chapter = book.chapters[position.chapter];
  app.querySelector('.chapter-label')!.textContent = chapter?.title ?? '';
  const total = book.chapters.reduce((n, c) => n + c.text.length, 0);
  const before = book.chapters.slice(0, position.chapter).reduce((n, c) => n + c.text.length, 0);
  app.querySelector('.progress-label')!.textContent = `${Math.min(100, Math.round((before + position.offset) / Math.max(1, total) * 100))}%`;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => { void saveCurrentProgress(); }, 400);
};

function persistPreferences() {
  clearTimeout(settingsTimer);
  const snapshot = { ...prefs };
  preferencesQueue = preferencesQueue.catch(() => {}).then(async () => {
    const saved = await bridge.savePreferences(snapshot);
    data.saved.preferences = saved;
  }).catch(fail);
  return preferencesQueue;
}
function settingsChanged() { applyAppearance(); clearTimeout(settingsTimer); settingsTimer = setTimeout(() => { void persistPreferences(); }, 250); }

async function adopt(next: Book) {
  await saveCurrentProgress();
  await document.fonts.ready;
  book = next;
  data = await bridge.bootstrap();
  matches = []; matchIndex = -1; query = ''; searchVersion++;
  worker.postMessage({ book, version: searchVersion });
  welcome.hidden = true;
  markPending = null; panelFilter = ''; panelCursor = 0;
  app.querySelector<HTMLElement>('.window')!.dataset.reading = 'true';
  app.querySelector('.book-label')!.textContent = next.title;
  app.querySelector('.book-label')!.setAttribute('title', next.title);
  panel = null; renderPanel();
  reader.load(next, data.saved.progress[next.id] ?? { chapter: 0, offset: 0 });
  renderWelcome();
  viewport.focus({ preventScroll: true });
}
async function openPath(path: string, chosen = encoding) {
  if (busy) return;
  busy = true; app.classList.add('busy');
  try { await adopt(await bridge.openBook(path, chosen)); }
  catch (error) { fail(error); panel = 'library'; renderPanel(); }
  finally { busy = false; app.classList.remove('busy'); }
}
async function choose() {
  if (busy) return;
  busy = true; app.classList.add('busy');
  try { const next = await bridge.chooseBook(encoding); if (next) await adopt(next); }
  catch (error) { fail(error); if (panel !== 'library') openPanel('library'); }
  finally { busy = false; app.classList.remove('busy'); }
}
function updateSearchCount() {
  const count = panelElement.querySelector('.search-count');
  if (count) count.textContent = query ? `${Math.max(0, matchIndex + 1)}/${matches.length}${matches.length >= 10000 ? '+' : ''}` : '';
}
function nextMatch(direction: number) {
  if (!matches.length) { if (!query) openPanel('search'); else toast('没有匹配结果。'); return; }
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  reader.highlight(matches[matchIndex]); updateSearchCount();
}
worker.onmessage = (event: MessageEvent<{ version: number; matches: Match[] }>) => {
  if (event.data.version !== searchVersion) return;
  matches = event.data.matches;
  matchIndex = matches.findIndex(match => comparePosition(match, reader.position()) >= 0);
  if (matchIndex < 0 && matches.length) matchIndex = 0;
  reader.highlight(matches[matchIndex] ?? null);
  updateSearchCount();
};
worker.onerror = () => fail('搜索线程启动失败，请重新打开应用。');

function applyMark(mode: 'set' | 'jump', letter: string) {
  if (!book) return;
  const marks = bookMarks();
  if (mode === 'set') {
    marks[letter] = reader.position();
    void bridge.saveMarks(book.id, marks).catch(fail);
    toast(`书签 ${letter} 已记录。`);
  } else {
    const position = marks[letter];
    if (!position) { toast(`书签 ${letter} 未设置。`); return; }
    reader.go(position);
  }
}

async function action(name: string) {
  switch (name) {
    case 'open': await choose(); break;
    case 'settings': case 'toc': case 'library': case 'help': case 'search': openPanel(name); break;
    case 'close': panel = null; renderPanel(); break;
    case 'hide': await saveCurrentProgress(); await bridge.hideWindow(); break;
    case 'quit': await saveCurrentProgress(); await persistPreferences(); await bridge.quit(); break;
    case 'reset': prefs = { ...defaults, shortcut: prefs.shortcut, alwaysOnTop: prefs.alwaysOnTop }; settingsChanged(); renderPanel(); break;
    case 'reopen': if (book) await openPath(book.path); break;
    case 'sample': await adopt(await bridge.sampleBook()); break;
    case 'next': nextMatch(1); break;
    case 'previous': nextMatch(-1); break;
  }
}
app.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) return;
  if (target.dataset.action) void action(target.dataset.action).catch(fail);
  if (target.dataset.recent) {
    const recent = data.saved.recents.find(r => r.id === target.dataset.recent);
    if (recent) void openPath(recent.path, recent.encoding === 'EPUB' ? 'auto' : recent.encoding.toLowerCase());
  }
  if (target.dataset.chapter) { reader.chapter(Number(target.dataset.chapter)); panel = null; renderPanel(); }
  if (target.dataset.mark && book) {
    const position = bookMarks()[target.dataset.mark];
    if (position) { reader.go(position); panel = null; renderPanel(); }
  }
  if (target.dataset.theme) { prefs.theme = target.dataset.theme as Preferences['theme']; settingsChanged(); renderPanel(); }
});
panelElement.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.classList.contains('panel-filter')) {
    panelFilter = input.value; panelCursor = 0;
    const list = panelElement.querySelector<HTMLElement>('.panel-list');
    if (list) list.innerHTML = panel === 'toc' ? tocItems() : recentItems();
    syncPanelCursor();
  } else if (input.name === 'query') {
    query = input.value; searchVersion++;
    worker.postMessage({ query, version: searchVersion });
  } else if (input.type === 'range') {
    const key = input.name as 'backgroundOpacity' | 'textOpacity' | 'contrast' | 'fontSize' | 'lineHeight';
    prefs[key] = Number(input.value) / Number(input.dataset.scale);
    panelElement.querySelector(`output[data-output="${key}"]`)!.textContent = `${Math.round(Number(input.value) * 10) / 10}${input.dataset.suffix}`;
    settingsChanged();
  }
});
panelElement.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.name === 'encoding') encoding = input.value;
  if (input.name === 'alwaysOnTop') { prefs.alwaysOnTop = input.checked; settingsChanged(); }
  if (input.name === 'hideToolbar') { prefs.hideToolbar = input.checked; settingsChanged(); }
  if (input.name === 'fontFamily') { prefs.fontFamily = input.value as Preferences['fontFamily']; settingsChanged(); }
});
panelElement.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).classList.contains('panel-filter') && event.key === 'Enter') {
    event.preventDefault();
    (event.target as HTMLElement).blur();
    syncPanelCursor();
  }
});
panelElement.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (form.classList.contains('search-form')) { viewport.focus({ preventScroll: true }); return; }
  const shortcut = (form.elements.namedItem('shortcut') as HTMLInputElement).value.trim();
  clearTimeout(settingsTimer);
  preferencesQueue = preferencesQueue.catch(() => {}).then(async () => {
    const saved = await bridge.savePreferences({ ...prefs, shortcut });
    prefs.shortcut = saved.shortcut; data.saved.preferences = saved; toast('快捷键已保存。');
  }).catch(fail);
});

cmdlineInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommandLine(); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); historyIndex = Math.max(0, historyIndex - 1); cmdlineInput.value = commandHistory[historyIndex] ?? ''; return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); historyIndex = Math.min(commandHistory.length, historyIndex + 1); cmdlineInput.value = commandHistory[historyIndex] ?? ''; return; }
  if (event.key === 'Tab') { event.preventDefault(); completeCommand(); return; }
});
cmdline.addEventListener('submit', event => {
  event.preventDefault();
  const value = cmdlineInput.value.trim();
  closeCommandLine();
  if (value) { commandHistory.push(value); if (commandHistory.length > 100) commandHistory.shift(); }
  void runCommand(value).catch(fail);
});

function vimAction(result: KeyAction) {
  const { action: name, count } = result;
  const line = prefs.fontSize * prefs.lineHeight, page = viewport.clientHeight;
  switch (name) {
    case 'down': reader.scroll(line * count); break;
    case 'up': reader.scroll(-line * count); break;
    case 'halfDown': reader.scroll(page / 2 * count); break;
    case 'halfUp': reader.scroll(-page / 2 * count); break;
    case 'pageDown': reader.scroll((page - line) * count); break;
    case 'pageUp': reader.scroll(-(page - line) * count); break;
    case 'start': reader.start(); break;
    case 'end': if (count > 1) reader.percent(count); else reader.end(); break;
    case 'next': nextMatch(1); break;
    case 'previous': nextMatch(-1); break;
    case 'command': openCommandLine(); break;
    case 'escape': markPending = null; panel = null; renderPanel(); break;
    default: void action(name).catch(fail);
  }
}
document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (target.closest('.cmdline')) return;
  const editable = target.matches('input, textarea, select') || target.isContentEditable;
  if (book && !panel && !editable && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (markPending) {
      const letter = event.key.toLowerCase();
      if (/^[a-z]$/.test(letter)) applyMark(markPending, letter);
      markPending = null;
      event.preventDefault(); return;
    }
    if (event.key === 'm') { markPending = 'set'; event.preventDefault(); return; }
    if (event.key === "'") { markPending = 'jump'; event.preventDefault(); return; }
  } else if (markPending) markPending = null;
  if (panel && panelKey(event)) { event.preventDefault(); return; }
  const result = keys.action(event, editable);
  if (!result) return;
  // Reading shortcuts must not scroll the book behind an unrelated panel.
  if (panel && !['escape', 'settings', 'help', 'toc', 'open', 'search', 'command'].includes(result.action)) return;
  event.preventDefault(); vimAction(result);
});
app.querySelector('.drag-handle')!.addEventListener('mousedown', event => { if ((event as MouseEvent).button === 0) void bridge.drag().catch(fail); });
const windowElement = app.querySelector<HTMLElement>('.window')!;
const hotspot = app.querySelector<HTMLElement>('.toolbar-hotspot')!;
let revealTimer: ReturnType<typeof setTimeout>;
hotspot.addEventListener('mouseenter', () => {
  revealTimer = setTimeout(() => { windowElement.classList.add('toolbar-revealed'); }, 450);
});
hotspot.addEventListener('mouseleave', () => { clearTimeout(revealTimer); });
hotspot.addEventListener('mousedown', event => { if (event.button === 0) void bridge.drag().catch(fail); });
app.querySelector('.toolbar')!.addEventListener('mouseleave', () => windowElement.classList.remove('toolbar-revealed'));
windowElement.addEventListener('mouseleave', () => { clearTimeout(revealTimer); windowElement.classList.remove('toolbar-revealed'); });
windowElement.addEventListener('mousemove', event => {
  if (event.clientY - windowElement.getBoundingClientRect().top > 27) windowElement.classList.remove('toolbar-revealed');
});
for (const edge of app.querySelectorAll<HTMLElement>('[data-resize]')) {
  edge.addEventListener('mousedown', event => {
    if (event.button === 0) { event.preventDefault(); void bridge.resize(edge.dataset.resize as Parameters<typeof bridge.resize>[0]).catch(fail); }
  });
}

async function initialize() {
  data = await bridge.bootstrap(); prefs = { ...defaults, ...data.saved.preferences }; applyAppearance(); renderWelcome();
  await document.fonts.ready;
  if (data.warning) toast(data.warning, true);
  if (data.shortcutError) toast(data.shortcutError, true);
  if (bridge.native) {
    await getCurrentWindow().onDragDropEvent(event => {
      dropOverlay.hidden = event.payload.type !== 'enter' && event.payload.type !== 'over';
      if (event.payload.type === 'drop' && event.payload.paths[0]) { dropOverlay.hidden = true; void openPath(event.payload.paths[0]); }
    });
    await listen('reader-hiding', () => { void saveCurrentProgress(); void persistPreferences(); });
    await listen('reader-shown', () => { if (!panel) viewport.focus({ preventScroll: true }); });
    await listen<string>('reader-open-file', event => { void openPath(event.payload); });
  } else {
    app.querySelector('.brand')!.textContent = '摸鱼 · 预览';
    app.addEventListener('dragover', event => { event.preventDefault(); dropOverlay.hidden = false; });
    app.addEventListener('dragleave', event => { if (!app.contains(event.relatedTarget as Node)) dropOverlay.hidden = true; });
    app.addEventListener('drop', event => {
      event.preventDefault(); dropOverlay.hidden = true;
      const file = event.dataTransfer?.files[0];
      if (file) void bridge.previewFile(file, encoding).then(adopt).catch(fail);
    });
  }
  const recent = data.saved.recents.find(r => r.id === data.saved.lastBook);
  if (data.openPath && bridge.native) await openPath(data.openPath);
  else if (recent && bridge.native) await openPath(recent.path, recent.encoding === 'EPUB' ? 'auto' : recent.encoding.toLowerCase());
}
document.addEventListener('visibilitychange', () => { if (document.hidden && data) { void saveCurrentProgress(); void persistPreferences(); } });
window.addEventListener('beforeunload', () => { if (data) void saveCurrentProgress(); });
document.fonts.addEventListener('loadingdone', () => reader.refresh());
void initialize().catch(fail);

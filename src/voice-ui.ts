import { paragraphAt } from './model';
import type { Reader } from './reader';
import type { Book, Position, Preferences, VoiceStatus } from './types';
import { voiceTransport, type VoiceTransport } from './voice-transport';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const names: Record<VoiceStatus['phase'], string> = { idle: '', loading: '正在准备音频…', buffering: '缓冲中…', playing: '朗读中', paused: '已暂停', completed: '本章朗读结束', stopped: '已停止', error: '朗读失败' };
type Options = { book: () => Book | null; ready: () => boolean; preferences: () => Preferences; persist: () => Promise<unknown>; fail: (error: unknown) => void; changed?: () => void };

export class VoiceUI {
  private id = Date.now();
  private follow = true;
  private state: VoiceStatus = { requestId: this.id, bookId: '', chapter: 0, phase: 'idle', paragraphStart: null, paragraphEnd: null, offset: null, error: null };
  private bar: HTMLElement;
  private settings: HTMLElement;
  private menu: HTMLElement;
  private menuPosition: Position | null = null;
  private selection = '';
  private detach = () => { this.follow = false; this.render(); };

  constructor(private root: HTMLElement, private reader: Reader, private options: Options, private transport: VoiceTransport = voiceTransport) {
    this.bar = document.createElement('section'); this.bar.className = 'voice-bar'; this.bar.hidden = true; this.bar.setAttribute('aria-label', '朗读控制');
    this.bar.innerHTML = `<span class="voice-phase" role="status" aria-live="polite"></span><button data-voice="toggle" aria-label="暂停朗读" title="暂停／继续 (gp)">Ⅱ</button><button data-voice="stop" aria-label="停止朗读" title="停止 (gs)">■</button><button data-voice="follow" class="voice-return" title="回到朗读处并跟随 (gc)">回到朗读处</button><button data-voice="dismiss" aria-label="关闭朗读状态">×</button>`;
    this.settings = document.createElement('section'); this.settings.className = 'voice-settings'; this.settings.hidden = true; this.settings.setAttribute('aria-label', '朗读设置');
    this.menu = document.createElement('div'); this.menu.className = 'voice-menu'; this.menu.hidden = true; this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', '正文菜单');
    this.menu.innerHTML = `<button role="menuitem" data-voice="paragraph">从本段开始朗读</button><button role="menuitem" data-voice="copy">复制所选文字</button>`;
    root.append(this.bar, this.settings, this.menu);
    reader.onManualNavigation = this.detach;
    root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-voice]');
      if (!button) return;
      const action = button.dataset.voice!;
      if (action === 'close') this.closeSettings();
      else if (action === 'dismiss') { this.state.phase = 'idle'; this.render(); }
      else if (action === 'copy') { void this.copySelection().catch(options.fail); this.closeMenu(); }
      else if (action === 'paragraph') { const position = this.menuPosition; this.closeMenu(); if (position) void this.read(position).catch(options.fail); }
      else if (action === 'read') { this.closeSettings(); void this.read().catch(options.fail); }
      else if (action === 'follow') this.returnToSpeech();
      else void this.control(action).catch(options.fail);
    });
    reader.viewport.addEventListener('contextmenu', event => {
      if (!options.book()) return;
      const position = reader.positionForElement(event.target as Element);
      if (!position) return;
      event.preventDefault(); this.menuPosition = position; this.selection = window.getSelection()?.toString() ?? '';
      this.menu.querySelector<HTMLButtonElement>('[data-voice="copy"]')!.disabled = !this.selection;
      this.menu.querySelector<HTMLButtonElement>('[data-voice="paragraph"]')!.disabled = !transport.available;
      const rect = root.getBoundingClientRect();
      this.menu.hidden = false;
      this.menu.style.left = `${Math.max(4, Math.min(event.clientX - rect.left, rect.width - this.menu.offsetWidth - 4))}px`;
      this.menu.style.top = `${Math.max(4, Math.min(event.clientY - rect.top, rect.height - this.menu.offsetHeight - 4))}px`;
      (this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
    });
    document.addEventListener('pointerdown', event => {
      if (!this.menu.contains(event.target as Node)) this.closeMenu(false);
      if (!this.settings.hidden && !this.settings.contains(event.target as Node) && !(event.target as Element).closest('[data-action="voice"]')) this.closeSettings(false);
    });
    this.menu.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.closeMenu(); return; }
      if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Tab') this.closeMenu(false);
    });
    this.settings.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeSettings(); }
    });
    this.settings.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      const prefs = options.preferences();
      if (input.name === 'voiceSpeaker') prefs.voiceSpeaker = input.value as Preferences['voiceSpeaker'];
      if (input.name === 'voiceAutomatic') prefs.voiceAutomatic = input.checked;
      if (input.name === 'voiceEngineDir') prefs.voiceEngineDir = input.value.trim();
      if (input.name === 'voiceModelsDir') prefs.voiceModelsDir = input.value.trim();
      void options.persist().catch(options.fail);
    });
    void transport.subscribe(state => this.accept(state)).catch(options.fail);
  }
  get open() { return !this.settings.hidden || !this.menu.hidden; }
  private async copySelection() {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(this.selection); return; }
    const input = document.createElement('textarea'); input.value = this.selection; input.readOnly = true;
    input.style.position = 'fixed'; input.style.left = '-9999px'; document.body.append(input); input.select();
    try { if (!document.execCommand('copy')) throw new Error('无法复制，请选择文字后使用 Ctrl+C。'); }
    finally { input.remove(); }
  }
  closeOverlays() { this.closeMenu(false); this.closeSettings(false); }
  private closeMenu(focus = true) { if (this.menu.hidden) return; this.menu.hidden = true; if (focus) this.reader.viewport.focus({ preventScroll: true }); }
  private closeSettings(focus = true) { if (this.settings.hidden) return; this.settings.hidden = true; if (focus) this.reader.viewport.focus({ preventScroll: true }); }
  showSettings() {
    if (!this.settings.hidden) { this.closeSettings(); return; }
    this.closeMenu(false); const p = this.options.preferences();
    this.settings.innerHTML = `<div class="voice-heading"><strong>朗读</strong><button data-voice="close" aria-label="关闭朗读设置">×</button></div>
      ${this.transport.available ? '' : '<p class="note">本版朗读需要 Linux 桌面应用和 NVIDIA CUDA；浏览器预览不支持朗读。</p>'}
      <div class="voice-actions"><button data-voice="read"${!this.transport.available || !this.options.book() ? ' disabled' : ''}>从当前段开始 <kbd>gr</kbd></button><button data-voice="toggle"${!this.active ? ' disabled' : ''}>暂停／继续 <kbd>gp</kbd></button><button data-voice="stop"${!this.active ? ' disabled' : ''}>停止 <kbd>gs</kbd></button></div>
      <p class="note">从屏幕顶部所在段落的段首开始，读到本章结束。隐藏窗口后继续朗读。</p>
      <label class="setting"><span>声音</span><select name="voiceSpeaker" aria-label="朗读声音"><option value="Uncle_Fu"${p.voiceSpeaker === 'Uncle_Fu' ? ' selected' : ''}>男声 · Uncle Fu</option><option value="Serena"${p.voiceSpeaker === 'Serena' ? ' selected' : ''}>女声 · Serena</option></select></label>
      <label class="toggle-setting"><span>自动语气</span><input type="checkbox" name="voiceAutomatic"${p.voiceAutomatic ? ' checked' : ''}></label><p class="note">声音与语气设置在下一次开始时生效。</p>
      <details><summary>引擎位置</summary><label>引擎目录<input name="voiceEngineDir" aria-label="朗读引擎目录" value="${escape(p.voiceEngineDir)}" placeholder="留空自动查找"></label><label>模型目录<input name="voiceModelsDir" aria-label="朗读模型目录" value="${escape(p.voiceModelsDir)}" placeholder="留空自动查找"></label></details>`;
    this.settings.hidden = false; this.settings.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }
  get active() { return ['loading', 'buffering', 'playing', 'paused'].includes(this.state.phase); }
  async read(position = this.reader.speechStartPosition()) {
    if (!this.options.ready()) throw new Error('正在打开小说，请稍候。');
    const book = this.options.book(); if (!book) throw new Error('先打开一本小说。');
    if (!this.transport.available) throw new Error('本版朗读需要 Linux 桌面应用和 NVIDIA CUDA；浏览器预览不支持朗读。');
    const paragraph = paragraphAt(book, position); if (!paragraph) throw new Error('本章没有可朗读的正文。');
    const id = ++this.id; this.follow = true;
    this.state = { requestId: id, bookId: book.id, chapter: paragraph.chapter, phase: 'loading', paragraphStart: null, paragraphEnd: null, offset: null, error: null };
    this.reader.highlightSpeech(null); this.render();
    try {
      await this.options.persist();
      if (id !== this.id) return;
      this.accept(await this.transport.start(id, book.id, { chapter: paragraph.chapter, offset: paragraph.offset }));
    } catch (error) {
      if (id !== this.id) return;
      this.state.phase = 'error'; this.state.error = String(error); this.render(); throw error;
    }
  }
  async control(action: string) {
    if (action === 'stop') {
      const id = ++this.id; this.state.requestId = id; this.state.phase = 'stopped'; this.state.paragraphStart = this.state.paragraphEnd = this.state.offset = null;
      this.reader.highlightSpeech(null); this.render();
      if (this.transport.available) this.accept(await this.transport.control(id, action));
      return;
    }
    if (!this.active) throw new Error('尚未开始朗读，请使用 gr。');
    const id = this.id;
    this.accept(await this.transport.control(id, action));
  }
  async bookChanged() { this.closeOverlays(); await this.control('stop'); this.state.phase = 'idle'; this.render(); }
  accept(state: VoiceStatus) {
    if (state.requestId !== this.id || state.bookId !== this.options.book()?.id) return;
    const previous = this.state; this.state = state;
    const playing = this.active && state.paragraphStart !== null && state.paragraphEnd !== null;
    this.reader.highlightSpeech(playing ? { chapter: state.chapter, offset: state.paragraphStart!, end: state.paragraphEnd! } : null);
    if (playing && this.follow && (previous.offset !== state.offset || previous.paragraphStart === null)) {
      this.reader.revealSpeech({ chapter: state.chapter, offset: state.offset ?? state.paragraphStart! });
    }
    this.render();
    if (state.phase === 'error' && previous.phase !== 'error') this.options.fail(state.error ?? '朗读失败，请检查模型与音频设备。');
  }
  returnToSpeech() {
    if (this.state.paragraphStart === null) { this.options.fail('尚无播放位置。'); return; }
    this.follow = true;
    this.reader.revealSpeech({ chapter: this.state.chapter, offset: this.state.offset ?? this.state.paragraphStart }, true); this.render();
  }
  private render() {
    this.bar.hidden = ['idle', 'stopped'].includes(this.state.phase);
    this.root.dataset.voiceActive = String(!this.bar.hidden);
    this.root.dataset.voicePhase = this.state.phase;
    const phase = this.bar.querySelector<HTMLElement>('.voice-phase')!;
    const message = this.state.phase === 'error' && this.state.error ? `${names.error}：${this.state.error}` : names[this.state.phase];
    phase.textContent = message; phase.title = message;
    const toggle = this.bar.querySelector<HTMLButtonElement>('[data-voice="toggle"]')!;
    toggle.disabled = !this.active; toggle.textContent = this.state.phase === 'paused' ? '▶' : 'Ⅱ'; toggle.setAttribute('aria-label', this.state.phase === 'paused' ? '继续朗读' : '暂停朗读');
    this.bar.querySelector<HTMLButtonElement>('[data-voice="stop"]')!.hidden = !this.active;
    this.bar.querySelector<HTMLButtonElement>('[data-voice="dismiss"]')!.hidden = this.active;
    this.bar.querySelector<HTMLElement>('[data-voice="follow"]')!.hidden = !this.active || this.follow || this.state.paragraphStart === null;
    for (const button of this.settings.querySelectorAll<HTMLButtonElement>('[data-voice="toggle"], [data-voice="stop"]')) button.disabled = !this.active;
    this.options.changed?.();
  }
}

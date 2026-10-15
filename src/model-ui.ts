import * as bridge from './bridge';
import type { CatalogEntry, DownloadPhase, DownloadStatus, Preferences, VoiceBackendInfo, VoiceDevices, VoiceStatus } from './types';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cssEscape = (value: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'));

/** Phases that mean a transfer is actively running and can be paused/cancelled. */
const ACTIVE: DownloadPhase[] = ['checking', 'downloading', 'waiting_network', 'verifying', 'installing'];
const CANCELLABLE: DownloadPhase[] = ['checking', 'downloading', 'waiting_network', 'verifying', 'installing', 'paused'];
const PHASE_LABEL: Record<DownloadPhase, string> = {
  not_installed: '未安装', checking: '校验文件…', downloading: '下载中', paused: '已暂停', waiting_network: '等待网络…',
  verifying: '校验中…', installing: '安装中…', ready: '已就绪', error: '下载失败', cancelled: '已取消',
};
const BACKEND_LABEL: Record<string, string> = { auto: '自动', cpu: 'CPU', cuda: 'NVIDIA CUDA', vulkan: 'Vulkan' };
const POWER_LABEL: Record<Preferences['voicePowerMode'], string> = { eco: '省电', balanced: '均衡' };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
const backendLabel = (id: string | null | undefined) => (id ? BACKEND_LABEL[id] ?? id : '');

interface Options {
  preferences: () => Preferences;
  persist: () => Promise<unknown>;
  fail: (error: unknown) => void;
  /** Current voice status, used to surface the effective backend and fallback reason. */
  voiceStatus?: () => VoiceStatus | null;
}

/**
 * Settings section for speech backend, power mode and model downloads.
 *
 * It is mounted inside the existing settings panel: `renderPanel` rebuilds the panel's
 * HTML, so `attach` is called again after every rebuild while all state (catalog,
 * statuses, devices) is kept on the instance. The `model-progress` subscription is
 * created exactly once, and progress events patch individual cards in place instead of
 * re-rendering the panel, so slider/select focus is never lost.
 */
export class ModelsUI {
  private catalog: CatalogEntry[] = [];
  private statuses = new Map<string, DownloadStatus>();
  private devices: VoiceDevices = { backends: [] };
  private catalogLoaded = false;
  private devicesLoaded = false;
  private catalogError: string | null = null;
  private started = false;
  private container: HTMLElement | null = null;
  private busy = new Set<string>();
  private lastDeviceNote = '';

  constructor(private options: Options) {}

  /** Subscribe to model-progress once; all later attachments reuse the same listener. */
  private start() {
    if (this.started) return;
    this.started = true;
    void bridge.onModelProgress(status => {
      this.statuses.set(status.id, status);
      this.updateCard(status);
      if (status.phase === 'ready' && this.catalog.some(entry => entry.id === status.id && entry.kind === 'backend')) {
        void bridge.voiceDevices().then(devices => { this.devices = devices; this.devicesLoaded = true; this.syncDeviceView(); }).catch(this.options.fail);
      }
    }).catch(this.options.fail);
  }

  detach() { this.container = null; }

  attach(container: HTMLElement | null) {
    if (!container) { this.detach(); return; }
    this.start();
    this.container = container;
    container.onclick = event => this.handleClick(event);
    container.onchange = event => this.handleChange(event);
    this.render();
    void this.refresh().catch(this.options.fail);
  }

  /** Bring the model section into view (used when gr finds no ready model). */
  reveal() { this.container?.scrollIntoView({ block: 'nearest' }); }

  /** True when the selected model is ready, or when status is unknown (do not block speech). */
  async ensureModelReady(): Promise<boolean> {
    if (!bridge.native) return true;
    try { for (const status of await bridge.modelStatus()) this.statuses.set(status.id, status); }
    catch { return true; }
    const status = this.statuses.get(this.options.preferences().voiceModelId);
    return !status || status.phase === 'ready';
  }

  private async refresh(force = false) {
    if (!bridge.native) { this.render(); return; }
    if (force) { this.catalogLoaded = false; this.devicesLoaded = false; this.catalogError = null; }
    if (!this.catalogLoaded) {
      try { this.catalog = await bridge.modelCatalog(); this.catalogLoaded = true; this.catalogError = null; }
      catch (error) { this.catalogError = error instanceof Error ? error.message : String(error); }
    }
    try { for (const status of await bridge.modelStatus()) this.statuses.set(status.id, status); } catch { /* status is best-effort */ }
    if (!this.devicesLoaded) {
      try { this.devices = await bridge.voiceDevices(); this.devicesLoaded = true; } catch { /* devices are best-effort */ }
    }
    this.render();
  }

  private async syncStatuses() {
    try { for (const status of await bridge.modelStatus()) { this.statuses.set(status.id, status); this.updateCard(status); } }
    catch { /* leave the last known state in place */ }
  }

  private render() {
    if (!this.container) return;
    this.container.innerHTML = bridge.native ? this.nativeMarkup() : this.previewMarkup();
    this.lastDeviceNote = this.deviceNoteText();
  }

  private previewMarkup() {
    return `<p class="section-label">朗读后端</p>
      <label class="setting"><span>朗读后端</span><select name="voiceBackend" aria-label="朗读后端">${this.backendOptions()}</select></label>
      <label class="setting"><span>性能模式</span><select name="voicePowerMode" aria-label="性能模式">${this.powerOptions()}</select></label>
      <p class="note preview-note">${escape(bridge.desktopOnlyMessage)}选择会保存，但设备检测、模型目录与下载进度只在 Linux 桌面应用中提供。</p>
      <p class="section-label">朗读模型</p>
      <p class="note preview-note">浏览器预览不检测已安装模型、不显示下载进度，也不会发起任何下载。请使用桌面应用管理模型。</p>`;
  }

  private nativeMarkup() {
    const models = this.catalog.filter(entry => entry.kind === 'model');
    const backends = this.catalog.filter(entry => entry.kind === 'backend');
    const catalogNote = models.length
      ? this.modelSelect()
      : `<p class="note">未获取到模型目录${this.catalogError ? `：${escape(this.catalogError)}` : ''}。<button class="text-button" data-model-refresh>重新获取</button></p>`;
    return `<p class="section-label">朗读后端</p>
      ${this.backendSelect()}
      <label class="setting"><span>性能模式</span><select name="voicePowerMode" aria-label="性能模式">${this.powerOptions()}</select></label>
      ${this.deviceNote()}
      <p class="section-label">朗读模型</p>
      ${catalogNote}
      <div class="model-cards">${models.map(entry => this.card(entry)).join('')}</div>
      ${backends.length ? `<p class="section-label">加速组件</p><p class="note">加速组件独立于模型：即使未安装，模型仍可使用 CPU / Vulkan 运行。</p><div class="model-cards">${backends.map(entry => this.card(entry)).join('')}</div>` : ''}`;
  }

  private backendSelect() {
    return `<label class="setting"><span>朗读后端</span><select name="voiceBackend" aria-label="朗读后端">${this.backendOptions()}</select></label>`;
  }
  private backendOptions() {
    const selected = this.options.preferences().voiceBackend;
    return (['auto', 'cpu', 'cuda', 'vulkan'] as const).map(id => {
      const info = this.devices.backends.find(backend => backend.id === id);
      const unavailable = id !== 'auto' && info?.available === false;
      const reason = info?.reason ? ` title="${escape(info.reason)}"` : '';
      return `<option value="${id}"${id === selected ? ' selected' : ''}${unavailable ? ' disabled' : ''}${reason}>${escape(BACKEND_LABEL[id])}${unavailable ? '（不可用）' : ''}</option>`;
    }).join('');
  }
  private powerOptions() {
    const selected = this.options.preferences().voicePowerMode;
    return (['eco', 'balanced'] as const).map(id => `<option value="${id}"${id === selected ? ' selected' : ''}>${escape(POWER_LABEL[id])}</option>`).join('');
  }

  private deviceNoteText(): string {
    const status = this.options.voiceStatus?.() ?? null;
    const effective = status?.effectiveBackend ?? this.devices.effectiveBackend ?? null;
    const device = status?.device ?? this.devices.device ?? null;
    const fallback = status?.fallbackReason ?? null;
    if (!effective && !device && !fallback) return '';
    const parts: string[] = [];
    if (effective) parts.push(`实际后端：${backendLabel(effective)}`);
    if (device) parts.push(`设备：${device}`);
    let text = parts.join(' · ');
    const chosen = this.options.preferences().voiceBackend;
    if (fallback) text += `${text ? '；' : ''}回退原因：${fallback}`;
    else if (effective && chosen !== 'auto' && chosen !== effective) text += `${text ? '；' : ''}已从所选后端回退`;
    return text;
  }
  private deviceNote() {
    const text = this.deviceNoteText();
    return `<p class="note device-note" data-device-note${text ? '' : ' hidden'}>${escape(text)}</p>`;
  }

  private modelSelect() {
    const prefs = this.options.preferences();
    const models = this.catalog.filter(entry => entry.kind === 'model');
    const fallback = models.find(entry => entry.enabled) ?? models[0];
    const hasSelected = models.some(entry => entry.id === prefs.voiceModelId);
    const options = models.map(entry => {
      const selected = entry.id === prefs.voiceModelId || (!hasSelected && entry === fallback);
      const bits = [entry.label];
      if (entry.variant) bits.push(entry.variant);
      if (entry.experimental) bits.push('实验性');
      const size = this.catalogSize(entry);
      const usable = entry.enabled || this.statuses.get(entry.id)?.phase === 'ready';
      return `<option value="${escape(entry.id)}"${selected ? ' selected' : ''}${usable ? '' : ' disabled'}>${escape(bits.join(' · '))}${size ? ` · ${size}` : ''}${usable ? '' : '（可本地导入）'}</option>`;
    }).join('');
    return `<label class="setting"><span>朗读模型</span><select name="voiceModelId" aria-label="朗读模型">${options}</select></label>
      <p class="note">CPU 加载 F16 约需 4.2 GB，Q5_K 约需 2.4 GB，合成时还需额外内存。CPU 可能明显慢于实时；量化版本为实验性选项。</p>`;
  }

  private catalogSize(entry: CatalogEntry): string {
    const total = entry.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return total > 0 ? formatBytes(total) : '';
  }
  private percent(status: DownloadStatus | undefined): number {
    if (!status) return 0;
    if (status.phase === 'ready') return 100;
    if (!status.totalBytes) return 0;
    return Math.max(0, Math.min(100, (status.downloadedBytes / status.totalBytes) * 100));
  }
  private progressText(status: DownloadStatus | undefined): string {
    if (!status) return '';
    const percent = Math.round(this.percent(status));
    if (!status.totalBytes) return `${PHASE_LABEL[status.phase]}…`;
    return `${PHASE_LABEL[status.phase]} · ${percent}% · ${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalBytes)}`;
  }
  private actionState(phase: DownloadPhase, enabled: boolean) {
    const active = ACTIVE.includes(phase);
    return {
      download: !active && phase !== 'ready' && phase !== 'paused',
      pause: phase === 'downloading' || phase === 'waiting_network',
      resume: phase === 'paused',
      cancel: CANCELLABLE.includes(phase),
      import: !active,
      enabled,
    };
  }

  private recommendedAccel(): CatalogEntry | null {
    const entry = this.catalog.find(item => item.kind === 'backend' && item.enabled && this.statuses.get(item.id)?.phase !== 'ready');
    if (!entry) return null;
    const info = this.devices.backends.find(backend => backend.id === entry.id) ?? this.findCuda();
    if (!info || (!info.available && !info.downloadRecommended)) return null;
    return entry;
  }
  private findCuda(): VoiceBackendInfo | undefined {
    return this.devices.backends.find(backend => backend.id === 'cuda' || backend.id === 'nvidia');
  }

  private card(entry: CatalogEntry): string {
    const status = this.statuses.get(entry.id);
    const phase = status?.phase ?? 'not_installed';
    const actions = this.actionState(phase, entry.enabled);
    const recommended = entry.kind === 'model' ? this.recommendedAccel() : null;
    const size = this.catalogSize(entry) || (status ? formatBytes(status.totalBytes) : '—');
    const tags: string[] = [];
    if (entry.variant) tags.push(entry.variant);
    if (entry.experimental) tags.push('实验性');
    if (!entry.enabled) tags.push('不可用');
    const retry = phase === 'error' || phase === 'cancelled';
    return `<article class="model-card" data-model-id="${escape(entry.id)}" data-phase="${phase}">
      <div class="model-card-head"><strong>${escape(entry.label)}</strong>${tags.map(tag => `<span class="model-tag">${escape(tag)}</span>`).join('')}<span class="model-size">${escape(size)}</span></div>
      <p class="model-status" data-model-status>${escape(phase === 'not_installed' && status?.updateAvailable ? '有更新 · 将校验并复用已有文件' : PHASE_LABEL[phase])}</p>
      <div class="model-progress" data-model-progress${ACTIVE.includes(phase) || phase === 'paused' ? '' : ' hidden'}><span class="model-progress-track"><span class="model-progress-bar" data-model-bar style="width:${this.percent(status)}%"></span></span><span class="model-progress-text" data-model-progress-text>${escape(this.progressText(status))}</span></div>
      <p class="model-source" data-model-source${status?.source ? '' : ' hidden'}>${status?.source ? `来源：${escape(status.source)}` : ''}</p>
      <p class="model-error" data-model-error${status?.error ? '' : ' hidden'}>${escape(status?.error ?? '')}</p>
      <p class="model-path" data-model-path${status?.path ? '' : ' hidden'}>${escape(status?.path ?? '')}</p>
      <div class="model-actions">
        <button class="secondary" data-model-download${actions.download ? '' : ' hidden'}${actions.enabled ? '' : ' disabled'}>${retry ? '重试下载' : status?.updateAvailable ? '更新组件' : '下载'}</button>
        ${recommended ? `<label class="model-accel"><input type="checkbox" data-model-accel> 同时安装推荐 CUDA（${escape(this.catalogSize(recommended))}）</label>` : ''}
        <button class="secondary" data-model-pause${actions.pause ? '' : ' hidden'}>暂停</button>
        <button class="secondary" data-model-resume${actions.resume ? '' : ' hidden'}>继续</button>
        <button class="secondary" data-model-cancel${actions.cancel ? '' : ' hidden'}>取消</button>
        <button class="text-button" data-model-import${actions.import && phase !== 'ready' ? '' : ' hidden'}>本地导入</button>
      </div>
    </article>`;
  }

  private updateCard(status: DownloadStatus) {
    if (!this.container) return;
    const card = this.container.querySelector<HTMLElement>(`[data-model-id="${cssEscape(status.id)}"]`);
    if (!card) return;
    const entry = this.catalog.find(item => item.id === status.id);
    const phase = status.phase;
    const actions = this.actionState(phase, entry?.enabled ?? true);
    card.dataset.phase = phase;
    this.setText(card, '[data-model-status]', phase === 'not_installed' && status.updateAvailable ? '有更新 · 将校验并复用已有文件' : PHASE_LABEL[phase]);
    const progress = card.querySelector<HTMLElement>('[data-model-progress]');
    if (progress) {
      progress.hidden = !(ACTIVE.includes(phase) || phase === 'paused');
      const bar = progress.querySelector<HTMLElement>('[data-model-bar]');
      if (bar) bar.style.width = `${this.percent(status)}%`;
      this.setText(progress, '[data-model-progress-text]', this.progressText(status));
    }
    const source = card.querySelector<HTMLElement>('[data-model-source]');
    if (source) { source.hidden = !status.source; source.textContent = status.source ? `来源：${status.source}` : ''; }
    this.setText(card, '[data-model-error]', status.error ?? '', !status.error);
    this.setText(card, '[data-model-path]', status.path ?? '', !status.path);
    this.toggleAction(card, '[data-model-download]', actions.download);
    this.toggleAction(card, '[data-model-pause]', actions.pause);
    this.toggleAction(card, '[data-model-resume]', actions.resume);
    this.toggleAction(card, '[data-model-cancel]', actions.cancel);
    this.toggleAction(card, '[data-model-import]', actions.import && phase !== 'ready');
    const option = this.container.querySelector<HTMLOptionElement>(`select[name="voiceModelId"] option[value="${cssEscape(status.id)}"]`);
    if (option) option.disabled = !(entry?.enabled || phase === 'ready');
    const download = card.querySelector<HTMLButtonElement>('[data-model-download]');
    if (download) { download.disabled = !actions.enabled; download.textContent = phase === 'error' || phase === 'cancelled' ? '重试下载' : status.updateAvailable && phase !== 'ready' ? '更新组件' : '下载'; }
  }
  private setText(root: HTMLElement, selector: string, text: string, hidden = false) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element) { element.textContent = text; if (element.hasAttribute('data-model-error') || element.hasAttribute('data-model-path')) element.hidden = hidden; }
  }
  private toggleAction(card: HTMLElement, selector: string, visible: boolean) {
    const button = card.querySelector<HTMLElement>(selector);
    if (button) button.hidden = !visible;
  }

  private handleClick(event: Event) {
    const button = (event.target as Element).closest<HTMLElement>('[data-model-refresh],[data-model-download],[data-model-pause],[data-model-resume],[data-model-cancel],[data-model-import]');
    if (!button) return;
    event.preventDefault();
    if (button.hasAttribute('data-model-refresh')) { void this.refresh(true).catch(this.options.fail); return; }
    const card = button.closest<HTMLElement>('[data-model-id]');
    if (!card) return;
    const id = card.dataset.modelId!;
    if (button.hasAttribute('data-model-download')) void this.download(id, card).catch(this.options.fail);
    else if (button.hasAttribute('data-model-pause')) void this.control(id, 'pause').catch(this.options.fail);
    else if (button.hasAttribute('data-model-resume')) void this.control(id, 'resume').catch(this.options.fail);
    else if (button.hasAttribute('data-model-cancel')) void this.control(id, 'cancel').catch(this.options.fail);
    else void this.import(id).catch(this.options.fail);
  }

  private handleChange(event: Event) {
    const input = event.target as HTMLSelectElement;
    const prefs = this.options.preferences();
    if (input.name === 'voiceBackend') { prefs.voiceBackend = input.value as Preferences['voiceBackend']; void this.applyPreferences(true).catch(this.options.fail); }
    else if (input.name === 'voicePowerMode') { prefs.voicePowerMode = input.value as Preferences['voicePowerMode']; void this.applyPreferences(false).catch(this.options.fail); }
    else if (input.name === 'voiceModelId') { prefs.voiceModelId = input.value; void this.applyPreferences(false).catch(this.options.fail); }
  }

  private async applyPreferences(refreshDevices: boolean) {
    await this.options.persist();
    if (refreshDevices) {
      try { this.devices = await bridge.voiceDevices(); this.devicesLoaded = true; } catch { /* keep previous devices */ }
      this.syncDeviceView();
    }
  }

  /** Patch just the device note and backend option availability (never replaces the panel). */
  private syncDeviceView() {
    if (!this.container) return;
    const note = this.container.querySelector<HTMLElement>('[data-device-note]');
    const text = this.deviceNoteText();
    if (note) { note.hidden = !text; note.textContent = text; this.lastDeviceNote = text; }
    const select = this.container.querySelector<HTMLSelectElement>('select[name="voiceBackend"]');
    if (select) {
      for (const option of Array.from(select.options)) {
        const info = this.devices.backends.find(backend => backend.id === option.value);
        option.disabled = option.value !== 'auto' && info?.available === false;
        if (info?.reason) option.title = info.reason;
      }
    }
  }

  /** Called when the voice status changes so the fallback reason stays current. */
  onVoiceStatus() {
    if (!this.container) return;
    if (this.deviceNoteText() === this.lastDeviceNote) return;
    this.syncDeviceView();
  }

  private async download(id: string, card: HTMLElement) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const accel = this.recommendedAccel();
      const installAccel = Boolean(accel && card.querySelector<HTMLInputElement>('[data-model-accel]')?.checked);
      await bridge.modelDownload(id);
      if (installAccel && accel) {
        try { await bridge.modelDownload(accel.id); } catch (error) { this.options.fail(error); }
      }
      await this.syncStatuses();
    } finally { this.busy.delete(id); }
  }
  private async control(id: string, action: 'pause' | 'resume' | 'cancel') {
    await bridge.modelControl(id, action);
    await this.syncStatuses();
  }
  private async import(id: string) {
    const directory = await bridge.chooseDirectory();
    if (!directory) return;
    await bridge.modelImport(id, directory);
    await this.syncStatuses();
  }
}

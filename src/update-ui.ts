import * as bridge from './bridge';
import type { UpdateStatus } from './types';

export class UpdatesUI {
  private container: HTMLElement | null = null;
  private started = false;
  private waiting = false;
  private state: UpdateStatus = { phase:'idle', currentVersion:'', latestVersion:null, downloadedBytes:0, totalBytes:0, path:null, error:null, canInstall:false, installNote:'' };
  constructor(private options: { fail: (e:unknown)=>void; beforeInstall: ()=>Promise<void> }) {}
  detach() { this.container=null; }
  attach(container: HTMLElement | null) {
    this.container=container;
    if (!container) return;
    container.innerHTML=`<p class="section-label">应用更新</p><p class="note" data-update-status role="status" aria-live="polite"></p>
      <div class="action-row"><button class="secondary" data-update-action="check">检查更新</button><button class="secondary" data-update-action="download" hidden>下载新版 / 继续下载</button><button class="text-button" data-update-action="cancel" hidden>取消下载</button></div>
      <p class="note" data-update-note></p><p class="note model-path" data-update-path></p><p class="model-error" data-update-error hidden></p>
      <button class="secondary" data-update-action="install" hidden>安装更新并退出</button><p class="note" data-update-confirm hidden>会替换当前 AppImage 并保留旧版备份，然后退出；重新打开后使用新版。模型和阅读进度保留。</p>`;
    container.onclick=event=>{
      const button=(event.target as Element).closest<HTMLButtonElement>('[data-update-action]');
      if (button && !button.disabled) void this.act(button.dataset.updateAction!).catch(this.options.fail);
    };
    this.render();
    if (!this.started) {
      this.started=true;
      void bridge.onUpdateProgress(state=>{this.state=state;this.render();}).catch(this.options.fail);
    }
    void bridge.updateStatus().then(state=>{this.state=state;this.render();}).catch(this.options.fail);
  }
  private async act(action:string) {
    if (this.waiting && action!=='cancel') return;
    if (action==='cancel') { await bridge.updateCancel();return; }
    this.waiting=true;this.render();
    try {
      if (action==='check') this.state=await bridge.updateCheck();
      else if (action==='download') this.state=await bridge.updateDownload();
      else if (action==='install') { await this.options.beforeInstall();await bridge.updateInstall(); }
    } finally { this.waiting=false;this.render(); }
  }
  private render() {
    const c=this.container;if (!c)return;
    const s=this.state;
    const labels:Record<UpdateStatus['phase'],string>={idle:'点击检查 GitHub 上的稳定版本。',checking:'正在检查更新…',available:`发现新版 ${s.latestVersion??''}`,latest:'当前已是最新版本。',downloading:`下载更新中 · ${s.totalBytes ? Math.floor(s.downloadedBytes/s.totalBytes*100):0}%`,verifying:'正在校验更新包…',ready:'新版已下载，SHA-256 校验通过。',installed:'更新已安装，请重新打开应用。',error:'更新失败，可重试。',cancelled:'下载已取消，已保留进度。'};
    c.querySelector('[data-update-status]')!.textContent=(s.currentVersion?`当前 ${s.currentVersion} · `:'')+labels[s.phase];
    c.querySelector('[data-update-note]')!.textContent=bridge.native?s.installNote:'请在 Linux 桌面应用中检查更新。';
    c.querySelector('[data-update-path]')!.textContent=s.path??'';
    const error=c.querySelector<HTMLElement>('[data-update-error]')!;error.hidden=!s.error;error.textContent=s.error??'';
    const active=['checking','downloading','verifying'].includes(s.phase);
    const button=(action:string)=>c.querySelector<HTMLButtonElement>(`[data-update-action="${action}"]`)!;
    button('check').disabled=!bridge.native||this.waiting||active;
    button('download').hidden=!s.latestVersion||active||['ready','installed'].includes(s.phase);
    button('download').disabled=this.waiting;
    button('cancel').hidden=s.phase!=='downloading';
    button('install').hidden=s.phase!=='ready'||!s.canInstall;
    button('install').disabled=this.waiting;
    c.querySelector<HTMLElement>('[data-update-confirm]')!.hidden=button('install').hidden;
  }
}

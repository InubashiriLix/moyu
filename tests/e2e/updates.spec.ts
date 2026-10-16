import { test, expect, type Page } from '@playwright/test';
async function setup(page:Page,canInstall=false) {
  await page.route('**/src/bridge.ts*',async route=>{
    if(route.request().url().includes('real=1'))return route.continue();
    await route.fulfill({contentType:'text/javascript',body:`
      export * from '/src/bridge.ts?real=1';
      export const native=true;
      let status={phase:'idle',currentVersion:'0.4.1',latestVersion:null,downloadedBytes:0,totalBytes:100,path:null,error:null,canInstall:${canInstall},installNote:${JSON.stringify(canInstall?'可原地更新，保留备份。':'当前文件由 root 所有，请手动替换。')}};
      let callback=()=>{}; window.__updateActions=[];
      window.__updateEmit=p=>{status={...status,...p};callback({...status});return {...status};};
      export const updateStatus=async()=>({...status});
      export const onUpdateProgress=async cb=>{callback=cb;return ()=>{};};
      export const updateCheck=async()=>{window.__updateActions.push('check');return window.__updateEmit({phase:'available',latestVersion:'0.4.2'});};
      export const updateDownload=async()=>{window.__updateActions.push('download');return window.__updateEmit({phase:'ready',downloadedBytes:100,path:'/home/user/Moyu-updates/Moyu.AppImage'});};
      export const updateCancel=async()=>{window.__updateActions.push('cancel');window.__updateEmit({phase:'cancelled'});};
      export const updateInstall=async()=>{window.__updateActions.push('install');};
    `});
  });
  await page.goto('/');await page.keyboard.press('s');
  await expect(page.getByRole('button',{name:'检查更新',exact:true})).toBeVisible();
}
test('root-owned installation can check and download without offering an in-place install',async({page})=>{
  await setup(page);
  const section=page.locator('[data-update-settings]');
  await expect.poll(()=>page.evaluate(()=>(window as any).__updateActions)).toEqual([]);
  await section.getByRole('button',{name:'检查更新',exact:true}).click();
  await expect(section.locator('[data-update-status]')).toContainText('0.4.2');
  await section.getByRole('button',{name:'下载新版 / 继续下载',exact:true}).click();
  await expect(section.locator('[data-update-status]')).toContainText('SHA-256');
  await expect(section.locator('[data-update-path]')).toContainText('/home/user/');
  await expect(section.locator('[data-update-note]')).toContainText('root');
  await expect(section.getByRole('button',{name:'安装更新并退出',exact:true})).toBeHidden();
});
test('update progress preserves focus, cancellation retains resume and writable installs are explicit',async({page})=>{
  await setup(page,true);
  const section=page.locator('[data-update-settings]');
  await section.getByRole('button',{name:'检查更新',exact:true}).click();
  const voice=page.getByRole('combobox',{name:'朗读声音'});await voice.focus();
  await page.evaluate(()=>(window as any).__updateEmit({phase:'downloading',downloadedBytes:40}));
  await expect(section.locator('[data-update-status]')).toContainText('40%');await expect(voice).toBeFocused();
  await section.getByRole('button',{name:'取消下载',exact:true}).click();
  await expect(section.locator('[data-update-status]')).toContainText('保留进度');
  await section.getByRole('button',{name:'下载新版 / 继续下载',exact:true}).click();
  await expect(section.locator('[data-update-confirm]')).toContainText('备份');
  await section.getByRole('button',{name:'安装更新并退出',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__updateActions)).toEqual(['check','cancel','download','install']);
});

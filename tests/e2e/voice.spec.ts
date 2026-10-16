import { test, expect, type Page } from '@playwright/test';

// Replace only the transport module during tests. Production preview has no
// fake audio or configurable mock switch.
async function mockVoice(page: Page) {
  await page.route('**/src/voice-transport.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    let callback=()=>{};
    let state={requestId:0,bookId:'',chapter:0,phase:'idle',paragraphStart:null,paragraphEnd:null,offset:null,error:null};
    window.__voiceCalls=[];
    window.__voiceEmit=patch=>{state={...state,...patch};callback({...state});};
    export const setVoicePlatform=()=>{};
    export const voiceTransport={available:true,
      subscribe:async cb=>{callback=cb;return ()=>{};},
      start:async(requestId,bookId,position)=>{
        window.__voiceCalls.push({kind:'start',requestId,bookId,...position});
        state={requestId,bookId,chapter:position.chapter,phase:'playing',paragraphStart:position.offset,paragraphEnd:position.offset+5,offset:position.offset,error:null};
        callback({...state});return {...state};
      },
      control:async(requestId,action)=>{
        window.__voiceCalls.push({kind:action,requestId});
        state={...state,requestId,phase:action==='stop'?'stopped':action==='pause'?'paused':action==='resume'?'playing':state.phase==='paused'?'playing':'paused'};
        callback({...state});return {...state};
      }
    };
  ` }));
}
async function sample(page: Page, mock = true) {
  if (mock) await mockVoice(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开 / 最近阅读', exact: true }).click();
  await page.getByRole('button', { name: '打开阅读示例', exact: true }).click();
  await expect(page.locator('.welcome')).toBeHidden();
}
async function chord(page: Page, suffix: string) { await page.keyboard.press('g'); await page.keyboard.press(suffix); }
async function emit(page: Page, patch: object) { await page.evaluate(p => (window as any).__voiceEmit(p), patch); }
async function lastStart(page: Page) { return page.evaluate(() => (window as any).__voiceCalls.filter((c: any) => c.kind === 'start').at(-1)); }
async function top(page: Page) { return page.locator('.reader').evaluate(el => el.scrollTop); }

test('gr starts the original long paragraph; gp and gs reject late playback events', async ({ page }) => {
  await mockVoice(page); await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '打开小说', exact: false }).click()]);
  await chooser.setFiles({ name: '朗读定位.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章\n\n起点标记。' + '长'.repeat(700) + '目标位置。\n\n下一段。') });
  await expect(page.locator('.book-label')).toContainText('朗读定位');
  await page.keyboard.press('/'); await page.getByRole('searchbox').fill('目标位置');
  await expect(page.locator('mark')).toContainText('目标位置'); await page.keyboard.press('Escape');
  await chord(page, 'r'); await expect(page.locator('.voice-phase')).toHaveText('朗读中');
  expect((await lastStart(page)).offset).toBe(0);
  const request = await lastStart(page);
  await chord(page, 'p'); await expect(page.getByRole('button', { name: '继续朗读', exact: true })).toBeVisible();
  await chord(page, 'p'); await expect(page.locator('.voice-phase')).toHaveText('朗读中');
  await chord(page, 's'); await expect(page.locator('.voice-bar')).toBeHidden();
  await emit(page, { requestId: request.requestId, phase: 'playing', paragraphStart: 0, paragraphEnd: 500, offset: 0 });
  await expect(page.locator('.voice-bar')).toBeHidden(); await expect(page.locator('.speaking')).toHaveCount(0);
});

test('manual navigation detaches following; gc returns to the playback paragraph', async ({ page }) => {
  await sample(page); await chord(page, 'r');
  await expect(page.locator('.voice-phase')).toHaveText('朗读中');
  await page.keyboard.press('Control+d');
  await expect(page.getByRole('button', { name: '回到朗读处', exact: true })).toBeVisible();
  const before = await top(page);
  await emit(page, { paragraphStart: 0, paragraphEnd: 5, offset: 2 });
  expect(Math.abs((await top(page)) - before)).toBeLessThan(2);
  await chord(page, 'c');
  await expect(page.getByRole('button', { name: '回到朗读处', exact: true })).toBeHidden();
  await expect.poll(() => top(page)).toBeLessThan(before);
  await emit(page, { phase: 'completed' });
  await expect(page.locator('.voice-phase')).toHaveText('本章朗读结束'); await expect(page.locator('.speaking')).toHaveCount(0);
});

test('right click starts that paragraph and controls stay visible in a small window', async ({ page }, testInfo) => {
  await sample(page);
  await page.keyboard.press('/'); await page.getByRole('searchbox').fill('【1-4】');
  await expect(page.locator('mark')).toContainText('【1-4】'); await page.keyboard.press('Escape');
  const paragraph = page.locator('.text-block').filter({ hasText: '【1-4】' });
  await paragraph.click({ button: 'right', position: { x: 30, y: 10 } });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('voice-menu.png') });
  await page.getByRole('menuitem', { name: '从本段开始朗读' }).click();
  expect((await lastStart(page)).offset).toBeGreaterThan(0);
  await expect(page.getByRole('menu')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('voice-playing.png') });
  await page.setViewportSize({ width: 180, height: 120 });
  await expect(page.getByRole('button', { name: '暂停朗读', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止朗读', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
  await expect(page.locator('.voice-phase')).toHaveText('已暂停');
  await page.screenshot({ path: testInfo.outputPath('voice-small.png') });
});

test('text inputs and panels do not trigger speech, and speech commands work', async ({ page }) => {
  await sample(page);
  await page.keyboard.press('/'); await page.getByRole('searchbox').fill('gr gp gs');
  await expect(page.locator('.voice-bar')).toBeHidden();
  await page.keyboard.press('Escape'); await page.keyboard.press('t'); await chord(page, 'r');
  await expect(page.locator('.voice-bar')).toBeHidden();
  await page.keyboard.press('Escape'); await page.keyboard.press(':');
  await page.getByRole('textbox', { name: '命令行', exact: true }).fill('read'); await page.keyboard.press('Enter');
  await expect(page.locator('.voice-phase')).toHaveText('朗读中');
  await page.keyboard.press(':'); await page.getByRole('textbox', { name: '命令行', exact: true }).fill('stop'); await page.keyboard.press('Enter');
  await expect(page.locator('.voice-bar')).toBeHidden();
});

test('browser preview reports unavailable speech and keeps reading usable', async ({ page }) => {
  await sample(page, false); await chord(page, 'r');
  await expect(page.locator('.toast')).toContainText('浏览器预览不支持朗读');
  await page.keyboard.press('s'); await page.getByRole('button', { name: '朗读设置与控制' }).click();
  await expect(page.locator('.voice-settings')).toContainText('浏览器预览不支持朗读');
  await expect(page.getByRole('button', { name: '从当前段开始 gr' })).toBeDisabled();
  await page.keyboard.press('Escape'); const before = await top(page); await page.keyboard.press('j');
  await expect.poll(() => top(page)).toBeGreaterThan(before);
});

test('changing books stops playback and voice preferences survive appearance reset', async ({ page }, testInfo) => {
  await sample(page); await chord(page, 'r'); const old = await lastStart(page);
  await page.keyboard.press('s'); await page.getByRole('button', { name: '朗读设置与控制' }).click();
  await page.getByRole('combobox', { name: '朗读声音' }).selectOption('Serena');
  await page.locator('input[name="voiceAutomatic"]').uncheck(); await page.keyboard.press('Escape');
  await page.keyboard.press('s'); await page.getByRole('button', { name: '恢复默认外观' }).click();
  await page.getByRole('button', { name: '朗读设置与控制' }).click();
  await expect(page.getByRole('combobox', { name: '朗读声音' })).toHaveValue('Serena');
  await expect(page.locator('input[name="voiceAutomatic"]')).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('voice-settings.png') });
  await page.keyboard.press('Escape');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('o')]);
  await chooser.setFiles({ name: '另一本.txt', mimeType: 'text/plain', buffer: Buffer.from('新的第一段。\n\n新的第二段。') });
  await expect(page.locator('.book-label')).toContainText('另一本'); await expect(page.locator('.voice-bar')).toBeHidden();
  await emit(page, { requestId: old.requestId, bookId: old.bookId, phase: 'playing', paragraphStart: 0, paragraphEnd: 5, offset: 0 });
  await expect(page.locator('.speaking')).toHaveCount(0);
});

test('GPU incompatibility remains visible and a new request can recover', async ({ page }) => {
  await sample(page); await chord(page, 'r');
  const error = '当前朗读包不支持 GPU RTX 4060 Laptop (sm_89)；包内架构：120a。';
  await emit(page, { phase: 'error', error });
  await expect(page.locator('.voice-phase')).toContainText(error);
  await expect(page.locator('.voice-bar')).toBeVisible();
  await expect(page.locator('.speaking')).toHaveCount(0);
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await expect(page.locator('.voice-phase')).toContainText(error);
  await chord(page, 'r');
  await expect(page.locator('.voice-phase')).toHaveText('朗读中');
});

test('settings expose voice choice with hidden toolbar and preserve it after reload', async ({ page }, testInfo) => {
  await sample(page); await page.keyboard.press('s');
  const speaker = page.getByRole('combobox', { name: '朗读声音' });
  await expect(speaker).toBeVisible();
  await speaker.selectOption('Serena');
  await expect(speaker).toHaveValue('Serena');
  await page.screenshot({ path: testInfo.outputPath('voice-in-settings.png') });
  await page.getByRole('button', { name: '从当前段开始 gr' }).click();
  await expect(page.locator('.voice-phase')).toHaveText('朗读中');
  await page.keyboard.press('s');
  await page.getByRole('button', { name: '暂停／继续 gp' }).click();
  await expect(page.locator('.voice-phase')).toHaveText('已暂停');
  await page.getByRole('button', { name: '停止 gs' }).click();
  await expect(page.locator('.voice-bar')).toBeHidden();
  await page.reload(); await page.keyboard.press('s');
  await expect(page.getByRole('combobox', { name: '朗读声音' })).toHaveValue('Serena');
});

test('gv locates voice setting, h/l adjust it, gf/gm select and preserve the voice', async ({ page }) => {
  await sample(page); await chord(page, 'v');
  const speaker = page.getByRole('combobox', { name: '朗读声音' });
  await expect(speaker).toHaveClass(/active/);
  await page.keyboard.press('l'); await expect(speaker).toHaveValue('Serena');
  await page.keyboard.press('h'); await expect(speaker).toHaveValue('Uncle_Fu');
  await page.keyboard.press('Escape'); await chord(page, 'f');
  await expect(page.locator('.toast')).toContainText('已选择女声');
  await chord(page, 'v'); await expect(speaker).toHaveValue('Serena');
  await page.keyboard.press('Escape'); await chord(page, 'm');
  await expect(page.locator('.toast')).toContainText('已选择男声');
  await chord(page, 'v'); await expect(speaker).toHaveValue('Uncle_Fu');
});

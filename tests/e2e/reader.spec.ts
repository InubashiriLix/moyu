import { test, expect, type Page } from '@playwright/test';

async function sample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '打开 / 最近阅读', exact: true }).click();
  await page.getByRole('button', { name: '打开阅读示例', exact: true }).click();
  await expect(page.locator('.welcome')).toBeHidden();
  await expect(page.locator('.book-label')).toContainText('山间来信');
}
async function scrollTop(page: Page) { return page.locator('.reader').evaluate(el => el.scrollTop); }
async function topText(page: Page) {
  return page.locator('.reader').evaluate(view => {
    const top = view.getBoundingClientRect().top;
    return Array.from(view.querySelectorAll<HTMLElement>('.text-block')).find(el => {
      const rect = el.getBoundingClientRect(); return rect.top <= top + 2 && rect.bottom > top;
    })?.textContent;
  });
}

test('hides chrome over the text, reveals only at the top, and uses the requested mono font', async ({ page }) => {
  await sample(page);
  await page.mouse.move(180, 200);
  await expect(page.locator('.toolbar')).toBeHidden();
  expect(await page.locator('.reader').evaluate(el => getComputedStyle(el).fontFamily)).toContain('Moyu JetBrains Mono');
  await page.mouse.move(180, 6);
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.mouse.move(180, 200);
  await expect(page.locator('.toolbar')).toBeHidden();
  await page.keyboard.press('s');
  await page.locator('select[name="fontFamily"]').selectOption('serif');
  await page.locator('input[name="hideToolbar"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.toolbar')).toBeVisible();
  expect(await page.locator('.reader').evaluate(el => getComputedStyle(el).fontFamily)).toContain('Reader Serif');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认外观' }).click();
  await expect(page.locator('select[name="fontFamily"]')).toHaveValue('jetbrains');
  await expect(page.locator('input[name="hideToolbar"]')).toBeChecked();
});

test('opens a long book, scrolls with Vim, jumps chapters, and bounds DOM size', async ({ page }, testInfo) => {
  await sample(page);
  const initial = await scrollTop(page);
  await page.keyboard.press('j');
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(initial);
  await page.keyboard.press('Control+d');
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(initial + 100);
  await page.keyboard.press('G');
  await expect(page.locator('.chapter-label')).toContainText('第12章');
  expect(await page.locator('.text-block').count()).toBeLessThan(60);
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await expect(page.locator('.chapter-label')).toContainText('第1章');
  await page.keyboard.press('t');
  await page.locator('[data-chapter="5"]').click();
  await expect(page.locator('.chapter-label')).toContainText('第6章');
  await page.screenshot({ path: testInfo.outputPath('reading.png') });
});

test('searches across chapters while input does not trigger reading keys', async ({ page }) => {
  await sample(page);
  await page.keyboard.press('/');
  await page.getByRole('searchbox').fill('【8-25】');
  await expect(page.locator('.search-count')).toHaveText('1/1');
  await expect(page.locator('.chapter-label')).toContainText('第8章');
  await expect(page.locator('mark')).toContainText('【8-25】');
  const before = await scrollTop(page);
  await page.getByRole('searchbox').press('j');
  await expect(page.getByRole('searchbox')).toHaveValue('【8-25】j');
  // An unmatched search must leave the reading position alone.
  await expect(page.locator('.search-count')).toHaveText('0/0');
  expect(Math.abs(await scrollTop(page) - before)).toBeLessThan(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.panel')).toBeHidden();
});

test('changes independent opacity, preserves location after resize and font change', async ({ page }, testInfo) => {
  await sample(page);
  await page.keyboard.press('/');
  await page.getByRole('searchbox').fill('【4-20】');
  await expect(page.locator('.search-count')).toHaveText('1/1');
  await page.keyboard.press('Escape');
  const before = await topText(page);
  await page.setViewportSize({ width: 240, height: 360 });
  await expect.poll(() => topText(page)).toBe(before);
  await page.keyboard.press('s');
  const setRange = async (name: string, value: string) => {
    await page.locator(`input[name="${name}"]`).evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  };
  await setRange('backgroundOpacity', '20');
  await setRange('textOpacity', '75');
  await setRange('fontSize', '22');
  await expect(page.locator('output[data-output="backgroundOpacity"]')).toHaveText('20%');
  await expect(page.locator('output[data-output="textOpacity"]')).toHaveText('75%');
  await page.keyboard.press('Escape');
  await expect.poll(() => topText(page)).toBe(before);
  const style = await page.locator('.window').getAttribute('style');
  expect(style).toContain('0.2'); expect(style).toContain('0.75');
  await page.setViewportSize({ width: 360, height: 480 });
  await page.keyboard.press('s');
  await page.screenshot({ path: testInfo.outputPath('settings.png') });
});

test('persists progress, handles tiny window, and treats book HTML as literal text', async ({ page }) => {
  await page.goto('/');
  const text = '第一章\n\n<script>window.injected=true</script>\n\n' + Array.from({ length: 100 }, (_, i) => `第${i}段：安静地阅读。${'中文测试'.repeat(30)}`).join('\n\n');
  const upload = async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: /^打开小说/ }).click(),
    ]);
    await chooser.setFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  };
  await upload();
  await expect(page.locator('.text-block').filter({ hasText: '<script>' })).toBeVisible();
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await page.keyboard.press('Control+d'); await page.keyboard.press('Control+d');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moyu-browser-preview-v1')!).progress['preview:test.txt']?.offset ?? 0)).toBeGreaterThan(50);
  const before = await topText(page);
  await page.reload(); await upload();
  await expect.poll(() => topText(page)).toBe(before);
  await page.setViewportSize({ width: 180, height: 120 });
  await page.keyboard.press('s');
  await expect(page.getByRole('button', { name: '关闭面板' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(180);
});

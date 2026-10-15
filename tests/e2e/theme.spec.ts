import { test, expect } from '@playwright/test';

test('app theme keeps selects, options, notes and untyped inputs readable against opposite system theme',async({page},testInfo)=>{
  await page.goto('/');await page.keyboard.press('s');
  for(const theme of ['light','dark'] as const) {
    await page.emulateMedia({colorScheme:theme==='light'?'dark':'light'});
    await page.getByRole('button',{name:theme==='light'?'浅色':'深色',exact:true}).click();
    await expect(page.locator('.window')).toHaveAttribute('data-theme',theme);
    const select=page.getByRole('combobox',{name:'朗读声音'});
    await expect.poll(()=>select.evaluate(el=>getComputedStyle(el).colorScheme)).toBe(theme);
    const style=await select.evaluate(el=>{const s=getComputedStyle(el);return {scheme:s.colorScheme,color:s.color,background:s.backgroundColor};});
    expect(style.scheme).toBe(theme);
    expect(style.color).not.toBe(style.background);
    const note=page.locator('.panel .note').first();
    const ratio=await note.evaluate(el=>{
      const nums=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
      const lum=(s:string)=>{const [r,g,b]=nums(s);return .2126*r+.7152*g+.0722*b;};
      const fg=lum(getComputedStyle(el).color),bg=lum(getComputedStyle(el.closest('.panel')!).backgroundColor);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    const colors=await select.locator('option').first().evaluate(el=>{const s=getComputedStyle(el);return [s.color,s.backgroundColor];});
    expect(colors[0]).not.toBe(colors[1]);expect(colors[1]).not.toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button',{name:'朗读设置与控制',exact:true}).click();
    await page.locator('.voice-settings summary').click();
    const field=page.getByRole('textbox',{name:'朗读模型目录',exact:true});
    const input=await field.evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,bg:s.backgroundColor,scheme:s.colorScheme};});
    expect(input.scheme).toBe(theme);expect(input.bg).not.toBe('rgba(0, 0, 0, 0)');expect(input.color).not.toBe(input.bg);
    await page.screenshot({path:testInfo.outputPath(`settings-${theme}-opposite-system.png`)});
    await page.keyboard.press('Escape');await page.keyboard.press('s');
  }
});

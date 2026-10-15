import {test,expect,type Page} from '@playwright/test';
async function setup(page:Page,withCuda=false) {
  await page.route('**/src/bridge.ts*',async route=>{
    if(route.request().url().includes('real=1'))return route.continue();
    await route.fulfill({contentType:'text/javascript',body:`
      export * from '/src/bridge.ts?real=1';
      export const native=true;
      const id='qwen3-tts-1.7b-customvoice-f16';
      let status={id,phase:'not_installed',downloadedBytes:0,totalBytes:100,source:null,error:null,path:null};
      let callback=()=>{};
      window.__modelEmit=p=>{status={...status,...p};callback({...status});};
      export const modelCatalog=async()=>[{id,label:'Qwen3 F16',kind:'model',variant:'f16',revision:'r1',enabled:${withCuda},experimental:false,files:[{name:'model.gguf',size:100,sha256:'a'.repeat(64),chunks:[]}]}${withCuda?",{id:'cuda-linux-x86_64-abi1',label:'CUDA',kind:'backend',variant:'cuda',revision:'r1',enabled:true,experimental:true,files:[{name:'nv-worker',size:100,chunks:[]}]},{id:'qwen3-tts-1.7b-customvoice-q5_k',label:'Qwen3 Q5_K',kind:'model',variant:'q5_k',revision:'r1',enabled:true,experimental:true,files:[{name:'model.gguf',size:80,chunks:[]}]} ":''}];
      export const modelStatus=async()=>[{...status}];
      export const voiceDevices=async()=>({backends:[{id:'cpu',label:'CPU',available:true},{id:'cuda',label:'CUDA',available:false,downloadRecommended:${withCuda},reason:'未安装'},{id:'vulkan',label:'Vulkan',available:true}]});
      export const onModelProgress=async cb=>{callback=cb;return ()=>{};};
      export const chooseDirectory=async()=>'/local/models';
      export const modelImport=async()=>{window.__modelEmit({phase:'ready',downloadedBytes:100,path:'/local/installed'});};
      window.__modelDownloads=[];
      export const modelDownload=async id=>{window.__modelDownloads.push(id);};
      window.__modelControls=[];
      export const modelControl=async(id,action)=>{window.__modelControls.push({id,action});};
    `});
  });
  await page.goto('/');await page.keyboard.press('s');
  await expect(page.getByRole('combobox',{name:'朗读后端',exact:true})).toBeVisible();
}
test('settings offer CPU and energy mode and permit local import before mirrors publish',async({page})=>{
  await setup(page);
  await expect(page.getByRole('combobox',{name:'性能模式'})).toHaveValue('eco');
  await expect(page.getByRole('button',{name:'下载',exact:true})).toBeDisabled();
  const local=page.getByRole('button',{name:'本地导入',exact:true});await expect(local).toBeEnabled();await local.click();
  await expect(page.locator('[data-model-status]')).toContainText('已就绪');
  await expect(page.locator('select[name="voiceModelId"] option').first()).toBeEnabled();
});
test('NVIDIA users can download the model with the optional CUDA component',async({page})=>{
  await setup(page,true);
  const card=page.locator('[data-model-id="qwen3-tts-1.7b-customvoice-f16"]');
  await card.getByRole('checkbox',{name:/推荐 CUDA/}).check();
  await card.getByRole('button',{name:'下载',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__modelDownloads)).toEqual(['qwen3-tts-1.7b-customvoice-f16','cuda-linux-x86_64-abi1']);
});
test('progress events preserve control focus while updating source and errors',async({page})=>{
  await setup(page);const mode=page.getByRole('combobox',{name:'性能模式'});await mode.focus();
  await page.evaluate(()=> (window as any).__modelEmit({phase:'downloading',downloadedBytes:40,source:'github'}));
  await expect(page.locator('[data-model-progress-text]')).toContainText('40%');await expect(mode).toBeFocused();
  await page.evaluate(()=> (window as any).__modelEmit({phase:'waiting_network',error:'网络中断，保留进度'}));
  await expect(page.locator('[data-model-error]')).toContainText('保留进度');await expect(page.getByRole('button',{name:'暂停',exact:true})).toBeVisible();
});

test('appearance reset preserves backend, power and model preferences',async({page})=>{
  await setup(page,true);
  await page.getByRole('combobox',{name:'朗读后端',exact:true}).selectOption('cpu');
  await page.getByRole('combobox',{name:'性能模式'}).selectOption('balanced');
  await page.getByRole('combobox',{name:'朗读模型',exact:true}).selectOption('qwen3-tts-1.7b-customvoice-q5_k');
  await page.getByRole('button',{name:'恢复默认外观',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'朗读后端',exact:true})).toHaveValue('cpu');
  await expect(page.getByRole('combobox',{name:'性能模式'})).toHaveValue('balanced');
  await expect(page.getByRole('combobox',{name:'朗读模型',exact:true})).toHaveValue('qwen3-tts-1.7b-customvoice-q5_k');
});

test('download controls dispatch pause, resume and cancel without losing progress',async({page})=>{
  await setup(page,true);
  const card=page.locator('[data-model-id="qwen3-tts-1.7b-customvoice-f16"]');
  const emit=async(p:Record<string,unknown>)=>page.evaluate(p=>(window as any).__modelEmit(p),p);
  await emit({phase:'downloading',downloadedBytes:40,source:'huggingface'});
  await card.getByRole('button',{name:'暂停',exact:true}).click();
  await emit({phase:'paused'});
  await expect(card.locator('[data-model-progress-text]')).toContainText('40%');
  await card.getByRole('button',{name:'继续',exact:true}).click();
  await emit({phase:'downloading',downloadedBytes:50});
  await card.getByRole('button',{name:'取消',exact:true}).click();
  await emit({phase:'cancelled',downloadedBytes:0});
  await expect(card.getByRole('button',{name:'重试下载',exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'暂停',exact:true})).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>(window as any).__modelControls.map((x:any)=>x.action))).toEqual(['pause','resume','cancel']);
});

test('failed downloads can retry and verified installation replaces transfer controls',async({page})=>{
  await setup(page,true);
  const card=page.locator('[data-model-id="qwen3-tts-1.7b-customvoice-f16"]');
  await page.evaluate(()=>(window as any).__modelEmit({phase:'error',error:'文件校验失败'}));
  await expect(card.locator('[data-model-error]')).toContainText('文件校验失败');
  await card.getByRole('button',{name:'重试下载',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__modelDownloads)).toEqual(['qwen3-tts-1.7b-customvoice-f16']);
  await page.evaluate(()=>(window as any).__modelEmit({phase:'ready',error:null,downloadedBytes:100,path:'/models/verified'}));
  await expect(card.locator('[data-model-status]')).toHaveText('已就绪');
  await expect(card.locator('[data-model-path]')).toContainText('/models/verified');
  await expect(card.locator('[data-model-error]')).toBeHidden();
  await expect(card.getByRole('button',{name:'重试下载',exact:true})).toBeHidden();
  await expect(card.getByRole('button',{name:'本地导入',exact:true})).toBeHidden();
});

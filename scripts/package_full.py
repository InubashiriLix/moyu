#!/usr/bin/env python3
"""Build a complete offline AppImage without modifying NVIDIA redistributables."""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from stage_voice import sha, stage
from package_update import package_update
from package_reader_update import package_reader_update

def checksum(path):
    return f'{sha(path)}  {path.name}\n'

def split_asset(path, size=1900 * 1024**2):
    parts=[]
    with path.open('rb') as source:
        index=1
        while source.tell()<path.stat().st_size:
            part=path.with_name(path.name+f'.part{index:03d}')
            with part.open('wb') as target:
                remaining=size
                while remaining:
                    block=source.read(min(8*1024**2,remaining))
                    if not block:break
                    target.write(block);remaining-=len(block)
            parts.append(part);index+=1
    return parts

def source_archive(output,engine):
    # The modified C++ wrapper and pinned backend source accompany the binaries.
    # Never export credentials, .git, caches, generated artifacts or model data.
    allowed=('src','src-tauri/src','src-tauri/icons','src-tauri/capabilities','scripts','packaging','tests','.github','voice-engine','configs')
    files=[]
    for part in allowed:
        for path in (ROOT/part).rglob('*'):
            if not path.is_file() or path.is_symlink():continue
            relative=path.relative_to(ROOT)
            if any(p in ('staged','__pycache__','vendor','models','build','build-tests','artifacts') for p in relative.parts):continue
            files.append((path,Path('moyu')/relative))
    for name in ('README.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','vitest.config.ts','playwright.config.ts','.gitignore','index.html','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs','src-tauri/tauri.conf.json'):
        path=ROOT/name
        if path.is_file():files.append((path,Path('moyu')/name))
    for part in ('src','scripts','patches','tests','vendor/qwen3'):
        for path in (engine/part).rglob('*'):
            if not path.is_file() or path.is_symlink():continue
            relative=path.relative_to(engine)
            if any(p in ('.git','__pycache__','build','build-cli','node_modules') for p in relative.parts):continue
            files.append((path,Path('novel-voice')/relative))
    for name in ('CMakeLists.txt','README.md','DEPENDENCIES.md','vendor/miniaudio.h'):
        files.append((engine/name,Path('novel-voice')/name))
    with tarfile.open(output,'w:gz',compresslevel=6) as archive:
        for source,name in files:archive.add(source,arcname=str(name),recursive=False)
        revision=json.loads((engine/'models/gguf/manifest.json').read_text())['backend_commit']
        content=(revision+'\n').encode()
        entry=tarfile.TarInfo('novel-voice/vendor/qwen3/.nv-backend-revision');entry.size=len(content)
        archive.addfile(entry,io.BytesIO(content))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine',type=Path,default=(ROOT.parent/'novel-voice' if (ROOT.parent/'novel-voice').is_dir() else ROOT/'voice-engine'))
    parser.add_argument('--skip-gui-build',action='store_true')
    parser.add_argument('--skip-stage',action='store_true')
    parser.add_argument('--appimagetool',type=Path)
    args=parser.parse_args();engine=args.engine.resolve()
    if sys.platform!='linux':raise RuntimeError('The complete voice edition is Linux-only')
    patch=shutil.which('patchelf') or str(engine/'.venv-tools/bin/patchelf')
    if not Path(patch).is_file():raise RuntimeError('patchelf is required only on the packaging machine')
    payload=ROOT/'packaging/staged/voice'
    if not args.skip_stage:stage(engine,payload,Path(patch))
    env=os.environ.copy();env['PATH']=str(Path(patch).parent)+os.pathsep+env['PATH']
    env.update(APPIMAGE_EXTRACT_AND_RUN='1',NO_STRIP='1',CARGO_BUILD_JOBS=env.get('CARGO_BUILD_JOBS','4'))
    if not args.skip_gui_build:subprocess.run(['npm','run','tauri','--','build','--bundles','appimage'],cwd=ROOT,env=env,check=True)
    config=json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())
    version=config['version'];name=config['productName']
    base=ROOT/'src-tauri/target/release/bundle/appimage'
    candidates=list(base.glob('*.AppDir'))
    if len(candidates)!=1:raise RuntimeError(f'Expected one GUI AppDir in {base}')
    out=ROOT/'releases';out.mkdir(exist_ok=True)
    stem=f'Moyu_{version}_full_arch_rtx4060_rtx5060_x86_64'
    appdir=out/(stem+'.AppDir')
    if appdir.exists():
        if not (appdir/'.moyu-full-package').is_file():raise RuntimeError('Refusing to replace an unowned AppDir')
        shutil.rmtree(appdir)
    subprocess.run(['cp','-a','--reflink=auto',str(candidates[0]),str(appdir)],check=True)
    (appdir/'.moyu-full-package').touch()
    resource=appdir/'usr/lib'/name
    resource.mkdir(parents=True,exist_ok=True)
    subprocess.run(['cp','-a','--reflink=auto',str(payload),str(resource/'voice')],check=True)
    package_info=json.loads((payload/'bundle-manifest.json').read_text());package_info['app_version']=version
    (resource/'voice/bundle-manifest.json').write_text(json.dumps(package_info,indent=2)+'\n')
    font=Path('/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc')
    if not font.is_file():raise RuntimeError('Install noto-fonts-cjk on the build machine to include the Chinese font')
    fontdir=appdir/'usr/share/fonts';fontdir.mkdir(parents=True,exist_ok=True)
    subprocess.run(['cp','--reflink=auto',str(font),str(fontdir/font.name)],check=True)
    shutil.copytree('/usr/share/licenses/noto-fonts-cjk',resource/'voice/licenses/Noto-CJK',dirs_exist_ok=True)
    fontconfig=appdir/'usr/share/moyu-fontconfig';fontconfig.mkdir(parents=True,exist_ok=True)
    (fontconfig/'fonts.conf').write_text('<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir prefix="relative">../fonts</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>\n')
    hooks=appdir/'apprun-hooks';hooks.mkdir(exist_ok=True)
    (hooks/'moyu-fonts.sh').write_text('#!/usr/bin/env bash\nexport FONTCONFIG_FILE="$APPDIR/usr/share/moyu-fontconfig/fonts.conf"\n')
    launcher=appdir/'AppRun';launcher_text=launcher.read_text()
    marker='exec "$this_dir"/AppRun.wrapped "$@"'
    if marker not in launcher_text:raise RuntimeError('Unknown base AppRun wrapper; cannot install the font hook safely')
    launcher.write_text(launcher_text.replace(marker,'source "$this_dir"/apprun-hooks/moyu-fonts.sh\n\n'+marker))
    tools=list((Path.home()/'.cache/tauri').rglob('appimagetool*'))
    tool=args.appimagetool or next((p for p in tools if p.is_file() and os.access(p,os.X_OK)),None)
    if tool is None:
        extracted=ROOT/'.package-tools/plugin/squashfs-root/usr/bin/appimagetool'
        if not extracted.is_file():
            plugin=Path.home()/'.cache/tauri/linuxdeploy-plugin-appimage.AppImage'
            if not plugin.is_file():raise RuntimeError('Build the base GUI AppImage first or provide --appimagetool')
            extracted.parent.parent.parent.mkdir(parents=True,exist_ok=True)
            subprocess.run([str(plugin),'--appimage-extract'],cwd=ROOT/'.package-tools/plugin',stdout=subprocess.DEVNULL,check=True)
        tool=extracted
    env['ARCH']='x86_64'
    image=out/(stem+'.AppImage')
    temporary=image.with_name(image.name+'.partial')
    if temporary.exists():temporary.unlink()
    # CUDA binaries enter only after linuxdeploy finishes; their SHA256 remains
    # identical to the original SDK files, and no SDK headers/compiler is shipped.
    subprocess.run([str(tool),'--comp','zstd',str(appdir),str(temporary)],env=env,check=True)
    os.replace(temporary,image)
    image.chmod(0o755)
    source=out/(stem+'.source.tar.gz');source_archive(source,engine)
    assets=[source,package_update(payload,out),package_reader_update(appdir,out)]
    if image.stat().st_size>=2*1024**3:
        assets+=split_asset(image)
        combine=out/'assemble-full.sh'
        combine.write_text('#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "${BASH_SOURCE[0]}")"\nsha256sum --ignore-missing --check SHA256SUMS\ncat '+image.name+'.part??? > '+image.name+'.partial\nexpected=$(awk \'$2 == "'+image.name+'" {print $1}\' SHA256SUMS)\nprintf "%s  %s\\n" "$expected" "'+image.name+'.partial" | sha256sum --check --status\nmv '+image.name+'.partial '+image.name+'\nchmod +x '+image.name+'\necho "就绪：./'+image.name+'"\n')
        combine.chmod(0o755);assets.append(combine)
    else:assets.append(image)
    (out/'SHA256SUMS').write_text(''.join(checksum(p) for p in dict.fromkeys([image,*assets]) if p.is_file()))
    notes=out/'RELEASE-NOTES.txt'
    notes.write_text(f'Moyu {version} · 完整离线朗读版\n\n面向本次构建的 Arch Linux x86_64 与 RTX 4060 / RTX 5060。\nGPU 内核包含 sm_89 与 sm_120a；4060 Laptop 已由用户验证生成及播放，5060 已在构建机验证。\n包含 F16 主模型、音频解码模型、引擎、CUDA 运行库与 GUI 依赖。\n首次使用不下载模型，不需要 Python、CUDA SDK 或手工配置模型目录。\n系统仍需兼容的 NVIDIA 驱动（CUDA 13.x，580 系列或更新）；本机已测试 610.57。\n本包不宣称兼容 Ubuntu 或其他 GPU。\n\n运行 AppImage 后打开小说，gr 从屏幕顶部所在段落的段首开始，gp 暂停/继续，gs 停止，gc 回到朗读处。gv 打开声音设置，gf 选女声，gm 选男声；s 设置可直接选择声音。\n关闭窗口只隐藏，更新后请先用 :qa! 退出后台旧进程再启动新包。\n无 FUSE 环境可运行 AppImage 的 --appimage-extract-and-run。\n--voice-check 检查随包引擎；--voice-smoke 做无音频设备的真实 GPU 生成测试。\n\n如下载的是 part 分卷，将所有分卷、SHA256SUMS、assemble-full.sh 放在同一目录，运行 bash assemble-full.sh。\n完整 AppImage 是单文件；GitHub 单资产小于 2 GiB，因此发布时可能分卷。\n\n许可证位于提取后 usr/lib/{name}/voice/licenses，模型与运行库校验记录在 bundle-manifest.json。\nMoyu 与修改后的引擎/后端源码随 source.tar.gz 提供；系统动态库的来源与对应 Arch 构建版本见 SYSTEM-PACKAGES.txt。\n动态库可在提取后的 AppDir 中替换和重新链接；NVIDIA 组件适用自身 EULA。\n')
    release={'image':str(image),'image_bytes':image.stat().st_size,'image_sha256':sha(image),'assets':[str(p) for p in [*assets,out/'SHA256SUMS',notes]],'appdir':str(appdir)}
    (out/'release-manifest.json').write_text(json.dumps(release,indent=2)+'\n')
    print(json.dumps(release))

if __name__=='__main__':main()

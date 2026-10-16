#!/usr/bin/env python3
"""Package a verified native-engine update, reusing existing models/CUDA."""
import argparse
import json
from pathlib import Path
import shutil
import tarfile
from stage_voice import sha

ROOT = Path(__file__).resolve().parents[1]

def package_update(payload, output):
    manifest = json.loads((payload / 'bundle-manifest.json').read_text())
    architectures = manifest['cuda_architectures'].split(';')
    if '89-real' not in architectures or '120a-real' not in architectures:
        raise RuntimeError('Update must contain both 89-real and 120a-real')
    output.mkdir(parents=True, exist_ok=True)
    directory = output / 'moyu-engine-dual-update'
    if directory.exists():
        if not (directory / '.moyu-update').is_file():
            raise RuntimeError('Refusing to replace unowned update directory')
        shutil.rmtree(directory)
    directory.mkdir(); (directory / '.moyu-update').touch()
    (directory / 'runtime').mkdir()
    for source in (payload / 'runtime').iterdir():
        if source.name.startswith(('libcublas', 'libcudart')):
            continue
        shutil.copy2(source, directory / 'runtime' / source.name)
    shutil.copytree(payload / 'licenses', directory / 'licenses')
    shutil.copy2(payload / 'bundle-manifest.json', directory)
    shutil.copy2(ROOT / 'packaging/update-engine.sh', directory)
    cuda = [row for row in manifest['files'] if row['path'].startswith(('runtime/libcublas', 'runtime/libcudart'))]
    if {row['path'] for row in cuda} != {'runtime/libcudart.so.13', 'runtime/libcublas.so.13', 'runtime/libcublasLt.so.13'}:
        raise RuntimeError('Expected all three CUDA redistributable checksums')
    (directory / 'CUDA-SHA256SUMS').write_text(''.join(f"{row['sha256']}  {row['path']}\n" for row in cuda))
    (directory / 'README.txt').write_text('关闭 Moyu 后操作。先将旧 AppImage 用 --appimage-extract 提取到 squashfs-root。\n解压此更新包，在其目录运行 bash update-engine.sh /path/to/squashfs-root。\n随后运行 /path/to/squashfs-root/AppRun --voice-smoke 验证；正常启动用 AppRun。\n模型和 CUDA 库复用旧完整包；不会修改旧 AppImage。旧运行库保留为 runtime.before-dual。\n此更新只替换引擎，旧 GUI 版本号不变；新版界面随完整 v0.3.0 包提供。\n需要兼容的 Arch Linux 与 NVIDIA 驱动，4060 Laptop 已由用户验证 GPU 生成和朗读播放。\n')
    files = sorted(p for p in directory.rglob('*') if p.is_file())
    (directory / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.relative_to(directory)}\n' for p in files))
    archive = output / 'Moyu_voice_engine_sm89_sm120a_update.tar.gz'
    with tarfile.open(archive, 'w:gz') as target:
        target.add(directory, arcname=directory.name)
    print(json.dumps({'update': str(archive), 'bytes': archive.stat().st_size, 'sha256': sha(archive)}))
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', type=Path, default=ROOT / 'packaging/staged/voice')
    parser.add_argument('--output', type=Path, default=ROOT / 'releases')
    args = parser.parse_args()
    package_update(args.payload, args.output)

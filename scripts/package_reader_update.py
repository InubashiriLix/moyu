#!/usr/bin/env python3
"""Ship the reader UI separately so existing offline models can be reused."""
import argparse
from pathlib import Path
import shutil
import tarfile
from stage_voice import sha

ROOT = Path(__file__).resolve().parents[1]

def package_reader_update(appdir, output):
    binary = appdir / 'usr/bin/moyu'
    if not binary.is_file(): raise RuntimeError('Reader AppDir is missing')
    directory = output / 'moyu-reader-settings-update'
    if directory.exists():
        if not (directory / '.moyu-reader-update').is_file():
            raise RuntimeError('Refusing to replace an unowned directory')
        shutil.rmtree(directory)
    directory.mkdir(parents=True); (directory / '.moyu-reader-update').touch()
    shutil.copy2(binary, directory / 'moyu')
    shutil.copy2(ROOT / 'packaging/update-reader.sh', directory)
    (directory / 'README.txt').write_text('本包更新设置面板和 gv/gf/gm 键位，不包含或替换模型及推理引擎。\n先用 :qa! 彻底退出旧程序，再用现有双架构完整 AppImage 的 --appimage-extract 提取。\n运行 bash update-reader.sh /path/to/squashfs-root，随后从 squashfs-root/AppRun 启动。\n设置 s 可直接选择女声 Serena；gv 定位声音设置、gf 选女声、gm 选男声。\n声音偏好自动保存，下次 gr 开始时生效。旧可执行文件保留为 usr/bin/moyu.before-settings。\n本更新面向已有 Arch Linux 4060/5060 完整包，运行不需要 Python。\n')
    files = sorted(p for p in directory.iterdir() if p.is_file())
    (directory / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in files))
    archive = output / 'Moyu_reader_settings_update.tar.gz'
    with tarfile.open(archive, 'w:gz') as target: target.add(directory, arcname=directory.name)
    print(f'Reader update: {archive} ({archive.stat().st_size} bytes), SHA256 {sha(archive)}')
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--appdir', type=Path, default=ROOT / 'src-tauri/target/release/bundle/appimage/Moyu.AppDir')
    parser.add_argument('--output', type=Path, default=ROOT / 'releases')
    args = parser.parse_args(); package_reader_update(args.appdir, args.output)

#!/usr/bin/env bash
# Update the embedded UI in an extracted full package; keep models and engine.
set -euo pipefail
payload=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# != 1 ]]; then echo '用法：bash update-reader.sh /path/to/squashfs-root' >&2; exit 2; fi
appdir=$(cd "$1" && pwd)
binary="$appdir/usr/bin/moyu"
[[ -x "$appdir/AppRun" && -x "$binary" && -f "$appdir/usr/lib/Moyu/voice/runtime/libnovel_voice.so" ]] || { echo '目标必须是已提取的完整朗读包' >&2; exit 2; }
[[ ! -e "$binary.before-settings" && ! -e "$binary.settings-new" ]] || { echo '已存在更新备份，请检查后再更新；未覆盖文件' >&2; exit 2; }
(cd "$payload" && sha256sum --check SHA256SUMS)
cp -a "$payload/moyu" "$binary.settings-new"
cp -a --reflink=auto "$binary" "$binary.before-settings"
mv -f "$binary.settings-new" "$binary"
echo '界面更新完成。模型、引擎及声音偏好保留。'
echo "启动：$appdir/AppRun；先用 :qa! 退出后台旧程序。"

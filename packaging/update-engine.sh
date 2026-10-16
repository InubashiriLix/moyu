#!/usr/bin/env bash
# Apply only to an extracted, stopped Moyu AppDir. Never modify an AppImage.
set -euo pipefail
payload=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# != 1 ]]; then echo '用法：bash update-engine.sh /path/to/squashfs-root' >&2; exit 2; fi
appdir=$(cd "$1" && pwd)
voice="$appdir/usr/lib/Moyu/voice"
[[ -x "$appdir/AppRun" && -f "$voice/bundle-manifest.json" && -f "$voice/runtime/libnovel_voice.so" ]] || { echo '目标不是完整朗读版的 AppDir' >&2; exit 2; }
[[ -f "$voice/models/gguf/qwen3-tts-1.7b-customvoice-f16.gguf" ]] || { echo '目标缺少模型' >&2; exit 2; }
(cd "$payload" && sha256sum --check SHA256SUMS)
# Existing proprietary CUDA libraries must match this update exactly.
(cd "$voice" && sha256sum --check "$payload/CUDA-SHA256SUMS")
[[ ! -e "$voice/runtime.before-dual" && ! -e "$voice/runtime.dual-new" ]] || { echo '存在上次更新或备份，请先检查，未覆盖任何文件' >&2; exit 2; }
cp -a --reflink=auto "$voice/runtime" "$voice/runtime.dual-new"
cp -a "$payload/runtime/." "$voice/runtime.dual-new/"
cp -a "$voice/bundle-manifest.json" "$voice/bundle-manifest.before-dual.json"
swapped=0
restore() {
  if [[ $swapped == 1 ]]; then
    if [[ -d "$voice/runtime.before-dual" ]]; then
      rm -rf "$voice/runtime"
      mv "$voice/runtime.before-dual" "$voice/runtime"
      cp -a "$voice/bundle-manifest.before-dual.json" "$voice/bundle-manifest.json"
    fi
  fi
}
trap restore EXIT
swapped=1
mv "$voice/runtime" "$voice/runtime.before-dual"
mv "$voice/runtime.dual-new" "$voice/runtime"
cp -a "$payload/bundle-manifest.json" "$voice/bundle-manifest.json"
cp -a "$payload/licenses/." "$voice/licenses/"
swapped=0
trap - EXIT
echo "更新完成，原运行库保留在 $voice/runtime.before-dual"
echo "验证：$appdir/AppRun --voice-smoke"

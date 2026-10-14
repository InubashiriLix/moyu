#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"
backend_commit=74422bab4998ad69e0a67ba105654dadbeec9b3a
if [[ -d vendor/qwen3/.git ]]; then
  actual_commit=$(git -C vendor/qwen3 rev-parse HEAD)
elif [[ -f vendor/qwen3/.nv-backend-revision && -f vendor/qwen3/CMakeLists.txt ]]; then
  # The release source archive includes the pinned, patched backend without .git.
  actual_commit=$(cat vendor/qwen3/.nv-backend-revision)
else
  mkdir -p vendor
  git clone https://github.com/offgridai/qwen3-tts-cpp-streaming.git vendor/qwen3
  git -C vendor/qwen3 checkout "$backend_commit"
  actual_commit=$(git -C vendor/qwen3 rev-parse HEAD)
fi
if [[ "$actual_commit" != "$backend_commit" ]]; then
  echo "Backend revision differs from the pinned dependency. See DEPENDENCIES.md." >&2
  exit 1
fi
if [[ ! -f vendor/miniaudio.h ]]; then
  curl --fail --location --retry 2 https://raw.githubusercontent.com/mackron/miniaudio/0.11.23/miniaudio.h -o vendor/miniaudio.h
fi
echo '7e4f3f13c8fe66df2080ac3dd12a89193e3c2463cb7f067c798abd7331cd8ee6  vendor/miniaudio.h' | sha256sum --check --status
cuda_root=${NV_CUDA_ROOT:-"$project_dir/.venv-tools/lib/python3.12/site-packages/nvidia/cu13"}
if [[ ! -x "$cuda_root/bin/nvcc" ]]; then
  nvcc_path=$(command -v nvcc || true)
  if [[ -z "$nvcc_path" ]]; then echo "CUDA compiler missing; set NV_CUDA_ROOT or see README.md." >&2; exit 1; fi
  cuda_root=$(cd "$(dirname "$nvcc_path")/.." && pwd)
fi
host_cxx=${NV_CUDA_HOST_CXX:-"$project_dir/.toolchain/bin/x86_64-conda-linux-gnu-g++"}
if [[ ! -x "$host_cxx" ]]; then host_cxx=$(command -v g++); fi
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="${CC:-/usr/bin/gcc}" -DCMAKE_CXX_COMPILER="${CXX:-/usr/bin/g++}" \
  -DCMAKE_CUDA_COMPILER="$cuda_root/bin/nvcc" -DCMAKE_CUDA_HOST_COMPILER="$host_cxx" \
  -DCUDAToolkit_ROOT="$cuda_root" -DCMAKE_CUDA_ARCHITECTURES="${NV_CUDA_ARCH:-89-real;120a-real}" \
  -DGGML_CUDA_GRAPHS=ON
cmake --build build --parallel "${NV_BUILD_JOBS:-4}"

#!/usr/bin/env python3
"""Stage a relocatable full voice payload; never alter the engine build or SDK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

MODELS = ('qwen3-tts-1.7b-customvoice-f16.gguf', 'qwen3-tts-tokenizer-f16.gguf')
# These belong to the host operating system / installed GPU driver.
HOST = re.compile(r'^(lib(c|m|pthread|dl|rt|resolv|util|nss_\w+)\.so|ld-linux|libcuda\.so|libnvidia-)')

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['cp', '--reflink=auto', '--preserve=mode,timestamps', str(source.resolve()), str(target)], check=True)

def dependencies(path):
    output = run('ldd', str(path))
    if 'not found' in output:
        raise RuntimeError(f'Unresolved library in {path}:\n{output}')
    return {Path(match[1]).name: Path(match[2]) for match in re.finditer(r'^\s*(\S+)\s+=>\s+(/\S+)', output, re.M)}

def cuda_site(engine):
    roots = []
    if os.environ.get('NV_CUDA_ROOT'): roots.append(Path(os.environ['NV_CUDA_ROOT']))
    cache = engine / 'build-cuda/CMakeCache.txt'
    if cache.is_file():
        roots += [Path(line.split('=', 1)[1]) for line in cache.read_text().splitlines()
                  if line.startswith('CUDAToolkit_ROOT:')]
    for root in roots:
        site = root.parent.parent
        if list(site.glob('nvidia_cuda_nvcc-*.dist-info')): return site
    return engine / '.venv-tools/lib/python3.12/site-packages'

def stage(engine, output, patchelf):
    build = engine / ('build-cuda/bin' if (engine / 'build-cuda/bin/nv-worker').is_file() else 'build/bin')
    source_models = engine / 'models/gguf'
    manifest = json.loads((source_models / 'manifest.json').read_text())
    artifacts = {row['file']: row for row in manifest['artifacts']}
    for name in MODELS:
        path = source_models / name
        row = artifacts[name]
        if path.stat().st_size != row['size'] or sha(path) != row['sha256']:
            raise RuntimeError(f'Model checksum mismatch: {name}')
    if output.exists():
        if not (output / '.moyu-owned-stage').is_file() and not (output / 'bundle-manifest.json').is_file():
            raise RuntimeError(f'Refusing to replace an unowned directory: {output}')
        shutil.rmtree(output)
    runtime = output / 'runtime'
    models = output / 'models/gguf'
    licenses = output / 'licenses'
    runtime.mkdir(parents=True); models.mkdir(parents=True); licenses.mkdir(parents=True)
    (output / '.moyu-owned-stage').touch()
    sources = {}
    for name in ('libnovel_voice.so', 'nv-worker', 'novel-voice'):
        path = build / name
        if not path.is_file():
            raise RuntimeError(f'Build the engine first: missing {path}')
        sources[name] = path
        for soname, library in dependencies(path).items():
            if not HOST.match(soname):
                sources[soname] = library
    for name, source in sources.items():
        if Path(name).name != name: raise RuntimeError(f'Invalid library name: {name}')
        copy(source, runtime / name)
        # Keep NVIDIA binaries unmodified. The top-level RPATH covers their
        # dependencies; only our own binaries and GGML receive relative RPATHs.
        if name in ('libnovel_voice.so', 'nv-worker', 'novel-voice') or name.startswith('libggml'):
            subprocess.run([str(patchelf), '--force-rpath', '--set-rpath', '$ORIGIN', str(runtime / name)], check=True)
    for name in MODELS:
        copy(source_models / name, models / name)
    model_manifest = {key: value for key, value in manifest.items() if key != 'backend_dir'}
    model_manifest['artifacts'] = [artifacts[name] for name in MODELS]
    (models / 'manifest.json').write_text(json.dumps(model_manifest, ensure_ascii=False, indent=2) + '\n')
    copy(engine / 'vendor/qwen3/LICENSE', licenses / 'Qwen3-cpp-Apache-2.0.txt')
    copy(engine / 'vendor/qwen3/engine/ggml/LICENSE', licenses / 'GGML-MIT.txt')
    # miniaudio ships its license inside the single header.
    header = (engine / 'vendor/miniaudio.h').read_text()
    start = header.rfind('ALTERNATIVE 1')
    if start < 0:
        raise RuntimeError('Cannot locate miniaudio license')
    (licenses / 'miniaudio.txt').write_text(header[start:])
    copy(engine / 'vendor/qwen3/LICENSE', licenses / 'Qwen-models-Apache-2.0.txt')
    site = cuda_site(engine)
    cuda_license = next(site.glob('nvidia_cuda_nvcc-*.dist-info/licenses/License.txt'), None)
    if cuda_license is None:
        raise RuntimeError('CUDA redistributable license is missing')
    copy(cuda_license, licenses / 'NVIDIA-CUDA-EULA.txt')
    package_rows = {}
    # Preserve notices for the GUI's transitive libraries as well as the voice
    # runtime. Linuxdeploy handles copying GUI binaries in the next phase.
    gui = Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/moyu'
    libraries = list(sources.values())
    if gui.is_file(): libraries += list(dependencies(gui).values())
    for source in libraries:
        result = subprocess.run(['pacman', '-Qoq', str(source.resolve())], capture_output=True, text=True)
        if result.returncode:
            continue
        for package in result.stdout.splitlines():
            if package in package_rows: continue
            metadata = run('pacman', '-Qi', package)
            package_rows[package] = '\n'.join(line for line in metadata.splitlines()
                if re.match(r'^(Name|Version|Architecture|URL|Licenses)\s*:', line))
            directory = Path('/usr/share/licenses') / package
            if directory.is_dir(): shutil.copytree(directory, licenses / 'system' / package, symlinks=False)
    # Arch's generic SPDX texts cover libraries without a package-specific copy.
    spdx = Path('/usr/share/licenses/spdx')
    if spdx.is_dir(): shutil.copytree(spdx, licenses / 'system/spdx', symlinks=False)
    (licenses / 'SYSTEM-PACKAGES.txt').write_text('\n\n'.join(package_rows.values()) + '\n')
    notices = {
        'models': {'license': 'Apache-2.0', 'revisions': manifest['revisions'], 'source': 'https://huggingface.co/Qwen'},
        'backend': {'commit': manifest['backend_commit'], 'source': 'https://github.com/offgridai/qwen3-tts-cpp-streaming'},
        'cuda': {'license': 'NVIDIA CUDA EULA', 'source': 'https://docs.nvidia.com/cuda/eula/index.html', 'redistributed': ['libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13']},
        'source_builds': 'https://gitlab.archlinux.org/archlinux/packaging/packages',
    }
    (licenses / 'THIRD-PARTY-NOTICES.json').write_text(json.dumps(notices, indent=2) + '\n')
    cache = (engine / 'build/CMakeCache.txt').read_text()
    architecture = re.search(r'^CMAKE_CUDA_ARCHITECTURES:\w+=(.+)$', cache, re.M)
    release = {
        'edition': 'full-offline', 'platform': 'linux-x86_64', 'build_system': 'Arch Linux',
        'cuda_architectures': architecture[1] if architecture else 'unknown',
        'tested_gpu': 'NVIDIA GeForce RTX 5060', 'minimum_driver_branch': 580,
        'build_glibc': run('getconf', 'GNU_LIBC_VERSION'),
        'engine_abi': 1, 'model': 'qwen3-tts-1.7b-customvoice-f16', 'speaker': 'Uncle_Fu',
        'host_requirements': ['compatible Linux system', 'NVIDIA GPU and driver'],
        'files': [],
    }
    for path in sorted(output.rglob('*')):
        if path.is_file():
            release['files'].append({'path': str(path.relative_to(output)), 'size': path.stat().st_size, 'sha256': sha(path)})
    (output / 'bundle-manifest.json').write_text(json.dumps(release, indent=2) + '\n')
    # Check the actual ELF resolver after relocation. No developer SDK/build
    # directory is allowed to satisfy a dependency in the staged payload.
    for name in ('libnovel_voice.so', 'nv-worker', 'novel-voice'):
        for soname, path in dependencies(runtime / name).items():
            if not HOST.match(soname) and path.parent.resolve() != runtime.resolve():
                raise RuntimeError(f'Runtime escaped the bundle: {soname} -> {path}')
    print(json.dumps({'staged': str(output), 'bytes': sum(row['size'] for row in release['files']), 'files': len(release['files'])}))

# ---------------------------------------------------------------------------
# Light edition: CPU/Vulkan workers ship in the box, CUDA stays downloadable.
# ---------------------------------------------------------------------------

CUDA = re.compile(r'^(libcuda\.so|libnvidia-|libcudart|libcublas|libcufft|libcurand|libcusolver|libcusparse|libnvrtc|libnvjitlink|libnvjpeg|libggml-cuda)')
GGML = re.compile(r'^libggml')
# Host-provided libraries for the light payload: the C/C++ runtime plus the
# Vulkan loader and window-system libraries supplied by the graphics driver.
HOST_LIGHT = re.compile(r'^(lib(c|m|pthread|dl|rt|resolv|util|nss_\w+|stdc\+\+|gcc_s|atomic|gomp)\.so|ld-linux|libvulkan\.so|libGL\.so|libEGL\.so|libGLX|libdrm\.so|libwayland-|libX11\.so|libxcb\.so)')
LIGHT_BACKENDS = ('cpu', 'vulkan')

def transitive_libraries(roots):
    """Resolve every non-host dependency reachable from ``roots``."""
    found = {}
    queue = list(roots)
    processed = set()
    while queue:
        path = queue.pop()
        if path in processed: continue
        processed.add(path)
        for soname, library in dependencies(path).items():
            if HOST_LIGHT.match(soname) or soname in found: continue
            found[soname] = library
            queue.append(library)
    return found

def _engine_licenses(engine, licenses, include_cuda):
    copy(engine / 'vendor/qwen3/LICENSE', licenses / 'Qwen3-cpp-Apache-2.0.txt')
    copy(engine / 'vendor/qwen3/engine/ggml/LICENSE', licenses / 'GGML-MIT.txt')
    header = (engine / 'vendor/miniaudio.h').read_text()
    start = header.rfind('ALTERNATIVE 1')
    if start < 0: raise RuntimeError('Cannot locate miniaudio license')
    (licenses / 'miniaudio.txt').write_text(header[start:])
    copy(engine / 'vendor/qwen3/LICENSE', licenses / 'Qwen-models-Apache-2.0.txt')
    if include_cuda:
        site = cuda_site(engine)
        cuda_license = next(site.glob('nvidia_cuda_nvcc-*.dist-info/licenses/License.txt'), None)
        if cuda_license is None:
            raise RuntimeError('CUDA redistributable license is missing')
        copy(cuda_license, licenses / 'NVIDIA-CUDA-EULA.txt')

def _system_licenses(licenses, libraries):
    package_rows = {}
    for source in libraries:
        result = subprocess.run(['pacman', '-Qoq', str(Path(source).resolve())], capture_output=True, text=True)
        if result.returncode:
            continue
        for package in result.stdout.splitlines():
            if package in package_rows: continue
            metadata = run('pacman', '-Qi', package)
            package_rows[package] = '\n'.join(line for line in metadata.splitlines()
                if re.match(r'^(Name|Version|Architecture|URL|Licenses)\s*:', line))
            directory = Path('/usr/share/licenses') / package
            if directory.is_dir(): shutil.copytree(directory, licenses / 'system' / package, symlinks=False)
    spdx = Path('/usr/share/licenses/spdx')
    if spdx.is_dir(): shutil.copytree(spdx, licenses / 'system/spdx', symlinks=False)
    (licenses / 'SYSTEM-PACKAGES.txt').write_text('\n\n'.join(package_rows.values()) + '\n')

def stage_light(engine, output, patchelf, backends=('cpu', 'vulkan')):
    """Stage the default payload: session library plus CPU/Vulkan workers.

    No GGUF files and no CUDA runtime are included. The CUDA build is exported
    separately as a downloadable component, so this never requires a CUDA SDK
    or NVIDIA's redistribution license.
    """
    backends = tuple(backends)
    if not backends:
        raise RuntimeError('stage_light needs at least one backend')
    for backend in backends:
        if backend not in LIGHT_BACKENDS:
            raise RuntimeError(f'{backend} is not a light backend; CUDA ships as a downloadable component')

    def build_bin(backend):
        candidate = engine / f'build-{backend}' / 'bin'
        if (candidate / 'nv-worker').is_file():
            return candidate
        # A plain build/bin is accepted for the primary backend only.
        generic = engine / 'build' / 'bin'
        if backend == backends[0] and (generic / 'nv-worker').is_file():
            return generic
        raise RuntimeError(f'Build the {backend} engine first: missing {candidate}/nv-worker')

    session_build = build_bin(backends[0])
    session = session_build / 'libnovel_voice.so'
    if not session.is_file():
        raise RuntimeError(f'Build the engine first: missing {session}')

    if output.exists():
        if not (output / '.moyu-owned-stage').is_file() and not (output / 'bundle-manifest.json').is_file():
            raise RuntimeError(f'Refusing to replace an unowned directory: {output}')
        shutil.rmtree(output)
    runtime = output / 'runtime'
    licenses = output / 'licenses'
    runtime.mkdir(parents=True); licenses.mkdir(parents=True)
    (output / '.moyu-owned-stage').touch()

    # The generic session library is what the GUI loads; it must stay free of
    # GGML and CUDA so a single copy serves every backend.
    for soname in dependencies(session):
        if GGML.match(soname) or CUDA.match(soname):
            raise RuntimeError(f'libnovel_voice.so must be GGML/CUDA free; it depends on {soname}')
    for soname, library in transitive_libraries([session]).items():
        if CUDA.match(soname):
            raise RuntimeError(f'libnovel_voice.so must not depend on CUDA library {soname}')
        copy(library, runtime / soname)
    copy(session, runtime / 'libnovel_voice.so')
    subprocess.run([str(patchelf), '--force-rpath', '--set-rpath', '$ORIGIN', str(runtime / 'libnovel_voice.so')], check=True)

    backends_dir = runtime / 'backends'
    for backend in backends:
        build = build_bin(backend)
        target = backends_dir / backend
        target.mkdir(parents=True)
        libraries = transitive_libraries([build / 'nv-worker'])
        for soname, library in libraries.items():
            if CUDA.match(soname):
                raise RuntimeError(f'{backend} worker must not resolve CUDA library {soname} in the light payload')
        copy(build / 'nv-worker', target / 'nv-worker')
        for soname, library in libraries.items():
            copy(library, target / soname)
        # Only our own binary and the GGML libraries receive a relative RPATH.
        subprocess.run([str(patchelf), '--force-rpath', '--set-rpath', '$ORIGIN', str(target / 'nv-worker')], check=True)
        for soname in libraries:
            if CUDA.match(soname) or 'nvidia' in soname.lower():
                raise RuntimeError(f'refusing to modify NVIDIA library {soname}')
            subprocess.run([str(patchelf), '--force-rpath', '--set-rpath', '$ORIGIN', str(target / soname)], check=True)

    # Keep a downloadable-model manifest, but never the GGUF bytes themselves.
    optimized = engine / 'build-cpu-avx2/bin/nv-worker'
    if 'cpu' in backends and optimized.is_file():
        target = backends_dir / 'cpu/avx2'
        target.mkdir(parents=True)
        libraries = transitive_libraries([optimized])
        copy(optimized, target / 'nv-worker')
        for soname, library in libraries.items():
            if CUDA.match(soname): raise RuntimeError('CPU optimized variant depends on CUDA')
            copy(library, target / soname)
        for path in target.iterdir():
            subprocess.run([str(patchelf), '--force-rpath', '--set-rpath', '$ORIGIN', str(path)], check=True)

    models = output / 'models/gguf'
    models.mkdir(parents=True)
    source_manifest = engine / 'models/gguf/manifest.json'
    if source_manifest.is_file():
        manifest = json.loads(source_manifest.read_text())
        manifest.pop('backend_dir', None)
        (models / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    _engine_licenses(engine, licenses, include_cuda=False)
    bundled = list((runtime).rglob('*'))
    _system_licenses(licenses, [path for path in bundled if path.is_file()])
    (licenses / 'THIRD-PARTY-NOTICES.json').write_text(json.dumps({
        'models': {'license': 'Apache-2.0', 'source': 'https://huggingface.co/Qwen', 'bundled': False, 'downloaded_via_catalog': True},
        'backend': {'source': 'https://github.com/offgridai/qwen3-tts-cpp-streaming'},
        'cuda': {'license': 'NVIDIA CUDA EULA', 'redistributed': False, 'downloadable_component': 'cuda-linux-x86_64-abi1'},
    }, indent=2) + '\n')

    release = {
        'edition': 'light', 'platform': 'linux-x86_64', 'engine_abi': 1,
        'backends': list(backends),
        'host_requirements': ['compatible Linux x86_64 system', 'x86-64 CPU with SSE2 baseline'],
        'cuda': {'bundled': False, 'downloadable': True, 'component': 'cuda-linux-x86_64-abi1'},
        'runtime': {'session': 'runtime/libnovel_voice.so',
                    'workers': {b: f'runtime/backends/{b}/nv-worker' for b in backends}},
        'model': 'qwen3-tts-1.7b-customvoice-f16',
        'speaker': 'Uncle_Fu',
        'files': [],
    }
    if 'vulkan' in backends:
        release['host_requirements'].append('Vulkan 1.2 capable GPU and driver for the Vulkan backend')
    for path in sorted(output.rglob('*')):
        if path.is_file():
            release['files'].append({'path': str(path.relative_to(output)), 'size': path.stat().st_size, 'sha256': sha(path)})
    (output / 'bundle-manifest.json').write_text(json.dumps(release, indent=2) + '\n')

    # After relocation every worker must resolve inside its own backend directory
    # (or the host). A leaked build path or CUDA dependency is fatal.
    for backend in backends:
        target = backends_dir / backend
        for soname, path in dependencies(target / 'nv-worker').items():
            if HOST_LIGHT.match(soname): continue
            if CUDA.match(soname):
                raise RuntimeError(f'{backend} worker resolves CUDA library {soname}')
            if path.parent.resolve() != target.resolve():
                raise RuntimeError(f'{backend} worker escaped the bundle: {soname} -> {path}')
    print(json.dumps({'staged': str(output), 'edition': 'light', 'backends': list(backends),
                      'bytes': sum(row['size'] for row in release['files']), 'files': len(release['files'])}))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    # The formal engine lives in-tree at ../voice-engine (relative to this
    # script). Never default to the out-of-tree prototype checkout.
    parser.add_argument('--engine', type=Path, default=Path(__file__).resolve().parents[1] / 'voice-engine')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'packaging/staged/voice')
    parser.add_argument('--patchelf', type=Path)
    parser.add_argument('--offline', action='store_true', help='stage the full offline payload including GGUF models and CUDA')
    parser.add_argument('--backends', default='cpu,vulkan', help='light backends (default cpu,vulkan)')
    args = parser.parse_args()
    patch = args.patchelf or shutil.which('patchelf') or args.engine / '.venv-tools/bin/patchelf'
    if not Path(patch).is_file(): raise RuntimeError('Install patchelf as a packaging tool first')
    if args.offline:
        stage(args.engine.resolve(), args.output.resolve(), Path(patch))
    else:
        stage_light(args.engine.resolve(), args.output.resolve(), Path(patch),
                    backends=[b for b in args.backends.split(',') if b])

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Stage the optional CUDA worker as flat, individually verified files."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
from stage_voice import copy, dependencies, HOST_LIGHT, cuda_site, sha

DRIVER = re.compile(r'^(libcuda\.so|libnvidia-)')

def stage_component(engine, output, patchelf):
    worker = engine / 'build-cuda/bin/nv-worker'
    if not worker.is_file(): raise RuntimeError('Build NV_BACKEND=cuda first')
    files = {'nv-worker': worker}
    pending = [worker]
    while pending:
        for name, source in dependencies(pending.pop()).items():
            if HOST_LIGHT.match(name) or DRIVER.match(name) or name in files: continue
            files[name] = source
            pending.append(source)
    if output.exists():
        if not (output / '.moyu-owned-component').is_file(): raise RuntimeError('Refusing to replace unowned component directory')
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / '.moyu-owned-component').touch()
    original = {}
    for name, source in files.items():
        copy(source, output / name)
        if name == 'nv-worker' or name.startswith('libggml'):
            subprocess.run([str(patchelf),'--force-rpath','--set-rpath','$ORIGIN',str(output / name)],check=True)
        else:
            original[name] = sha(source)
            if sha(output / name) != original[name]: raise RuntimeError('Redistributable bytes changed')
    licenses = {
        'Qwen3-cpp-Apache-2.0.txt': engine / 'vendor/qwen3/LICENSE',
        'GGML-MIT.txt': engine / 'vendor/qwen3/engine/ggml/LICENSE',
    }
    sdk = next(cuda_site(engine).glob('nvidia_cuda_nvcc-*.dist-info/licenses/License.txt'),None)
    if sdk is None: raise RuntimeError('CUDA redistributable license missing')
    licenses['NVIDIA-CUDA-EULA.txt'] = sdk
    for name, path in licenses.items(): copy(path, output / name)
    for name, path in dependencies(output / 'nv-worker').items():
        if HOST_LIGHT.match(name) or DRIVER.match(name): continue
        if path.parent.resolve()!=output.resolve(): raise RuntimeError(f'Component dependency escaped: {name}')
    print(json.dumps({'component':str(output),'files':len(files)+len(licenses),'bytes':sum(p.stat().st_size for p in output.iterdir() if p.is_file()),'unmodifiedRedistributables':original}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine',type=Path,default=Path(__file__).resolve().parents[1]/'voice-engine')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--patchelf',type=Path,required=True)
    args=parser.parse_args()
    stage_component(args.engine.resolve(),args.output.resolve(),args.patchelf.resolve())

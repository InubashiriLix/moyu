"""Exercise update integrity checks against a disposable AppDir."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from package_update import package_update, sha

class EngineUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.app = base / 'AppDir'; self.voice = self.app / 'usr/lib/Moyu/voice'
        self.payload = base / 'payload'; self.output = base / 'output'
        for root in (self.voice, self.payload):
            (root / 'runtime').mkdir(parents=True)
            (root / 'licenses').mkdir()
            (root / 'runtime/libnovel_voice.so').write_text('old' if root == self.voice else 'new')
            for name in ('libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13'):
                (root / 'runtime' / name).write_text(name)
            (root / 'bundle-manifest.json').write_text('{}')
        (self.app / 'AppRun').write_text('#!/bin/sh\nexit 0\n'); (self.app / 'AppRun').chmod(0o755)
        (self.voice / 'models/gguf').mkdir(parents=True)
        (self.voice / 'models/gguf/qwen3-tts-1.7b-customvoice-f16.gguf').write_text('existing model')
        rows = [{'path': str(p.relative_to(self.payload)), 'sha256': sha(p)} for p in (self.payload / 'runtime').iterdir()]
        (self.payload / 'bundle-manifest.json').write_text(json.dumps({'cuda_architectures': '89-real;120a-real', 'files': rows}))
        package_update(self.payload, self.output)
        self.update = self.output / 'moyu-engine-dual-update'

    def run_update(self):
        return subprocess.run(['bash', str(self.update / 'update-engine.sh'), str(self.app)], capture_output=True, text=True)

    def test_valid_update_keeps_models_and_backup(self):
        result = self.run_update(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.voice / 'runtime/libnovel_voice.so').read_text(), 'new')
        self.assertEqual((self.voice / 'runtime.before-dual/libnovel_voice.so').read_text(), 'old')
        self.assertEqual((self.voice / 'models/gguf/qwen3-tts-1.7b-customvoice-f16.gguf').read_text(), 'existing model')
        self.assertNotEqual(self.run_update().returncode, 0)

    def test_corrupt_update_rejected_before_mutation(self):
        (self.update / 'runtime/libnovel_voice.so').write_text('corrupted')
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertEqual((self.voice / 'runtime/libnovel_voice.so').read_text(), 'old')
        self.assertFalse((self.voice / 'runtime.before-dual').exists())

    def test_incompatible_cuda_rejected_before_mutation(self):
        (self.voice / 'runtime/libcudart.so.13').write_text('different CUDA version')
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertEqual((self.voice / 'runtime/libnovel_voice.so').read_text(), 'old')
        self.assertFalse((self.voice / 'runtime.before-dual').exists())

if __name__ == '__main__':
    unittest.main()

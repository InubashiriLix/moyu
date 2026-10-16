import importlib.util
import tempfile
import unittest
from pathlib import Path
import numpy as np
import gguf

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("prepare", ROOT / "scripts/prepare_models.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

class ModelToolsTest(unittest.TestCase):
    def test_complete_and_truncated_gguf(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            writer = gguf.GGUFWriter(path, "test")
            writer.add_tensor("weight", np.ones((32, 32), dtype=np.float16))
            writer.write_header_to_file()
            writer.write_kv_data_to_file()
            writer.write_tensors_to_file()
            writer.close()
            self.assertTrue(prepare.is_valid_gguf(path))
            path.write_bytes(path.read_bytes()[:-2])
            self.assertFalse(prepare.is_valid_gguf(path))
            path.write_bytes(b"GGUF")
            self.assertFalse(prepare.is_valid_gguf(path))

    def test_dry_run_keeps_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "model.gguf"
            partial = output.with_name(output.name + ".tmp")
            partial.write_bytes(b"existing partial")
            prepare._atomic(lambda p: None, output, True)
            self.assertEqual(partial.read_bytes(), b"existing partial")
            self.assertFalse(output.exists())

    def test_failed_converter_does_not_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "model.gguf"
            def runner(path):
                path.write_bytes(b"GGUF")
            with self.assertRaises(RuntimeError):
                prepare._atomic(runner, output, False)
            self.assertFalse(output.exists())

if __name__ == "__main__":
    unittest.main()

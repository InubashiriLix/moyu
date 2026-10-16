#!/usr/bin/env python3
"""Prepare the official Qwen3-TTS models and convert them to GGUF.

Pinned sources (each downloaded at an exact revision):
  Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice @ 0c0e3051f131929182e2c023b9537f8b1c68adfe
      -> qwen3-tts-1.7b-customvoice-f16.gguf + q5_k quant
  Qwen/Qwen3-TTS-Tokenizer-12Hz        @ 7dd38ad4e9bad454aae9cd937d0cd577604fe229
      -> qwen3-tts-tokenizer-f16.gguf

Only safetensors/config/tokenizer files are downloaded (the embedded
speech_tokenizer is excluded; it lives in models/source/tokenizer). External
tools run via subprocess argument lists only (never a shell). GGUF outputs are
written to a temp path and atomically renamed after a GGUF-magic check; valid
existing outputs are reused. manifest.json records SHA256 sums, sizes,
revisions and backend commit. Defaults assume this file is <root>/scripts/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Excludes the embedded speech_tokenizer duplicate (ships as its own repo).
ALLOW_PATTERNS = ["config.json", "generation_config.json", "model.safetensors",
                  "vocab.json", "merges.txt", "tokenizer_config.json",
                  "preprocessor_config.json"]
GGUF_MAGIC = b"GGUF"

MODELS = [
    {"name": "customvoice", "repo_id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
     "revision": "0c0e3051f131929182e2c023b9537f8b1c68adfe",
     "f16": "qwen3-tts-1.7b-customvoice-f16.gguf",
     "quant": "qwen3-tts-1.7b-customvoice-q5_k.gguf"},
    {"name": "tokenizer", "repo_id": "Qwen/Qwen3-TTS-Tokenizer-12Hz",
     "revision": "7dd38ad4e9bad454aae9cd937d0cd577604fe229",
     "f16": "qwen3-tts-tokenizer-f16.gguf", "quant": None},
]


def log(message: str) -> None:
    print(f"[prepare_models] {message}", flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_valid_gguf(path: Path) -> bool:
    try:
        import gguf
        reader = gguf.GGUFReader(path)
        if not reader.tensors:
            return False
        size=path.stat().st_size
        return all(t.data_offset + t.n_bytes <= size for t in reader.tensors)
    except (OSError, ValueError, IndexError, OverflowError):
        return False


def run(argv, dry_run: bool) -> None:
    log("run: " + " ".join(str(arg) for arg in argv))
    if not dry_run:
        subprocess.run([str(arg) for arg in argv], check=True)


def download(spec: dict, source: Path, dry_run: bool) -> None:
    log(f"download {spec['repo_id']}@{spec['revision']} -> {source}")
    if dry_run:
        return
    from huggingface_hub import snapshot_download
    source.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=spec["repo_id"], revision=spec["revision"],
                      local_dir=str(source), allow_patterns=ALLOW_PATTERNS)


def _atomic(runner, output: Path, dry_run: bool) -> bool:
    """Run a converter against output.tmp, then publish it atomically."""
    tmp = output.with_name(output.name + ".tmp")
    if dry_run:
        runner(tmp)
        return True
    output.parent.mkdir(parents=True, exist_ok=True)
    if tmp.exists():
        tmp.unlink()
    runner(tmp)
    if not is_valid_gguf(tmp):
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"produced invalid GGUF: {tmp}")
    os.replace(tmp, output)
    log(f"wrote {output}")
    return True


def convert(converter: Path, source: Path, output: Path, dry_run: bool) -> None:
    if is_valid_gguf(output):
        log(f"reuse existing {output}")
        return
    _atomic(lambda tmp: run([sys.executable, converter, "--input", source,
                             "--output", tmp, "--type", "f16"], dry_run),
            output, dry_run)


def quantize(quantizer: Path, source: Path, output: Path, dry_run: bool) -> None:
    if is_valid_gguf(output):
        log(f"reuse existing {output}")
        return
    _atomic(lambda tmp: run([quantizer, source, tmp, "q5_k"], dry_run),
            output, dry_run)


def backend_commit(backend_dir: Path) -> "str | None":
    try:
        result = subprocess.run(
            ["git", "-C", str(backend_dir), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True)
        return result.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def build_manifest(artifacts, backend_dir: Path, revisions: dict) -> dict:
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "backend_dir": str(backend_dir),
        "backend_commit": backend_commit(backend_dir),
        "backend_patches": {
            p.name:sha256_file(p) for p in (ROOT / "patches").glob("*.patch")
        },
        "revisions": revisions,
        "artifacts": [
            {"file": path.name, "kind": kind, "size": path.stat().st_size,
             "sha256": sha256_file(path)}
            for path, kind in artifacts if is_valid_gguf(path)
        ],
    }


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--output-dir", type=Path, default=None,
                        help="GGUF output dir (default: <models-dir>/gguf)")
    parser.add_argument("--backend-dir", type=Path,
                        default=ROOT / "vendor" / "qwen3")
    parser.add_argument("--converter", type=Path,
                        default=None)
    parser.add_argument("--tokenizer-converter", type=Path,
                        default=None)
    parser.add_argument("--quantizer", type=Path,
                        default=ROOT / "build" / "vendor" / "qwen3" / "engine"
                        / "tts_engine_quantize")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    args.converter = args.converter or args.backend_dir / "tools" / "convert_tts_to_gguf.py"
    args.tokenizer_converter = args.tokenizer_converter or args.backend_dir / "tools" / "convert_tokenizer_to_gguf.py"
    output_dir = args.output_dir or (args.models_dir / "gguf")
    if args.dry_run:
        log("dry run: no downloads, no conversion")

    artifacts, revisions = [], {}
    for spec in MODELS:
        source = args.models_dir / "source" / spec["name"]
        revisions[spec["repo_id"]] = spec["revision"]
        if not args.skip_download:
            download(spec, source, args.dry_run)

        f16 = output_dir / spec["f16"]
        converter = (args.converter if spec["name"] == "customvoice"
                     else args.tokenizer_converter)
        convert(converter, source, f16, args.dry_run)
        artifacts.append((f16, "f16"))
        if spec["quant"]:
            quant = output_dir / spec["quant"]
            quantize(args.quantizer, f16, quant, args.dry_run)
            artifacts.append((quant, "q5_k"))

    if args.dry_run:
        return 0

    manifest_path = output_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(build_manifest(artifacts, args.backend_dir, revisions),
                   indent=2) + "\n")
    log(f"manifest -> {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

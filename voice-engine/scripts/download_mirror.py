#!/usr/bin/env python3
"""Download official ModelScope mirrors, verifying the pinned HF LFS SHA256."""
import concurrent.futures
import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
SPECS = [
    ("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "0c0e3051f131929182e2c023b9537f8b1c68adfe", "customvoice"),
    ("Qwen/Qwen3-TTS-Tokenizer-12Hz", "7dd38ad4e9bad454aae9cd937d0cd577604fe229", "tokenizer"),
]

def download(repo, revision, directory):
    source = ROOT / "models/source" / directory
    source.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/{revision}", timeout=30) as r:
        tree = json.load(r)
    weights = next(x for x in tree if x["path"] == "model.safetensors")
    size, expected = weights["size"], weights["lfs"]["oid"]
    final = source / "model.safetensors"
    temporary = source / "model.safetensors.mirror-partial"
    if final.exists():
        with final.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() == expected:
                print("reuse", repo, flush=True)
                return
    print("mirror download", repo, size, "bytes", flush=True)
    url = f"https://www.modelscope.cn/models/{repo}/resolve/master/model.safetensors"
    fd = os.open(temporary, os.O_CREAT | os.O_RDWR | os.O_TRUNC, 0o600)
    os.ftruncate(fd, size)
    chunk = 32 * 1024 * 1024
    def part(begin):
        end = min(begin + chunk, size) - 1
        for attempt in range(4):
            pos = begin
            try:
                request = urllib.request.Request(url, headers={"Range": f"bytes={begin}-{end}"})
                with urllib.request.urlopen(request, timeout=40) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {begin}-{end}/{size}":
                        raise RuntimeError("mirror returned the wrong byte range")
                    while pos <= end:
                        data = response.read(min(1024 * 1024, end - pos + 1))
                        if not data:
                            raise RuntimeError("mirror returned a truncated range")
                        done = 0
                        while done < len(data):
                            done += os.pwrite(fd, data[done:], pos + done)
                        pos += len(data)
                return end - begin + 1
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(attempt + 1)
    try:
        total = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(part, b) for b in range(0, size, chunk)]
            for future in concurrent.futures.as_completed(futures):
                total += future.result()
                print(f"{directory}: {total / size:.1%}", flush=True)
        os.fsync(fd)
    finally:
        os.close(fd)
    with temporary.open("rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if actual != expected:
        raise RuntimeError("mirror SHA256 does not match the pinned official HF model")
    os.replace(temporary, final)
    print("verified", repo, expected, flush=True)
    for filename in ["config.json", "generation_config.json", "vocab.json", "merges.txt", "tokenizer_config.json", "preprocessor_config.json", "configuration.json"]:
        if (source / filename).exists() or not any(x["path"] == filename for x in tree):
            continue
        with urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/{revision}/{filename}", timeout=30) as response:
            (source / filename).write_bytes(response.read())

if __name__ == "__main__":
    for spec in SPECS:
        download(*spec)

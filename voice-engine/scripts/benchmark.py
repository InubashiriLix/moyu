#!/usr/bin/env python3
"""Measure the real native engine. 100% CPU means one logical core."""
import argparse
import json
import math
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path
import psutil

CASES = {
    "narration": "清晨的雾还没有散。林远推开木窗，看见山路尽头站着一个陌生人。那人没有敲门，只把一封信放在石阶上，便转身走进了雾里。",
    "dialogue": "他低声说道：“先别开门，听听外面的动静。”她靠近窗边，平静地问：“你认识那个人吗？”他摇了摇头，握紧手里的信。",
    "tense": "脚步声突然停了。他紧张地屏住呼吸，背靠着冰冷的墙壁。门外的人慢慢转动把手，低声说道：“我知道你就在里面。”",
    "sad": "她哽咽着说：“我以为你还会回来。”桌上的茶已经凉了。窗外又下起了雨，她把那封没有寄出的信，轻轻收进抽屉。",
    "numbers": "林远在二零二六年十月十四日收到消息。信上写着：下午三点半，第三号站台。他拿出一百零五元，买了一张去重庆的车票。",
}

def gpu():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,power.draw", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3, check=True)
        fields = r.stdout.splitlines()[0].split(",")
        return float(fields[0]), float(fields[1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None

class Sampler:
    def __init__(self, process):
        self.process = psutil.Process(process.pid)
        self.times, self.rss, self.memory, self.power = {}, 0, 0, 0
        self.initial_times = {}
        try:
            for p in [self.process] + self.process.children(recursive=True):
                t=p.cpu_times();self.initial_times[(p.pid,p.create_time())]=t.user+t.system
        except psutil.Error:
            pass
        self.baseline = gpu()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample)
        self.thread.start()

    def sample(self):
        while not self.stop.is_set():
            rss = 0
            try:
                processes = [self.process] + self.process.children(recursive=True)
                for p in processes:
                    try:
                        rss += p.memory_info().rss
                        t = p.cpu_times()
                        self.times[(p.pid, p.create_time())] = t.user + t.system
                    except psutil.Error:
                        pass
                self.rss = max(self.rss, rss)
            except psutil.Error:
                pass
            g = gpu()
            if g:
                self.memory = max(self.memory, g[0])
                self.power = max(self.power, g[1])
            self.stop.wait(.2)

    def finish(self, elapsed):
        self.stop.set()
        self.thread.join()
        cpu = sum(max(0, value-self.initial_times.get(key,0)) for key,value in self.times.items())
        return {"cpu_seconds": cpu, "mean_cpu_percent_one_core": 100 * cpu / elapsed if elapsed else 0,
                "peak_tree_rss_mib": self.rss / 2**20, "baseline_gpu_memory_mib": self.baseline[0] if self.baseline else None,
                "peak_gpu_memory_mib": self.memory, "peak_gpu_power_watts": self.power,
                "sampling_interval_seconds": .2}

def run_case(args, name, text):
    output = args.out_dir / name
    wav, metrics = output.with_suffix(".wav"), output.with_suffix(".metrics.json")
    command = [str(args.executable.resolve()), "--models-dir", str(args.models_dir.resolve()), "--model", args.model,
               "--no-cache", "--output", str(wav), "--metrics", str(metrics), "--seed", "42"]
    if not args.playback:
        command += ["--no-play"]
    if name == "long":
        source = output.with_suffix(".txt")
        source.write_text(text, encoding="utf-8")
        command += ["--input", str(source)]
    else:
        command += ["--text", text]
    t0 = time.monotonic()
    with output.with_suffix(".log").open("w") as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        sampler = Sampler(process)
        try:
            deadline=t0+args.timeout
            while process.poll() is None:
                remaining=deadline-time.monotonic()
                if remaining<=0:
                    raise subprocess.TimeoutExpired(command,args.timeout)
                try:
                    process.wait(timeout=min(2,remaining))
                except subprocess.TimeoutExpired:
                    elapsed=time.monotonic()-t0
                    partial=Path(str(wav)+".partial")
                    produced=max(0,(partial.stat().st_size-44)/48000) if partial.exists() else 0
                    cpu=sum(max(0,value-sampler.initial_times.get(key,0)) for key,value in sampler.times.copy().items())
                    live={"elapsed_seconds":elapsed,"audio_generated_seconds":produced,
                          "mean_cpu_percent_one_core":100*cpu/elapsed,"peak_tree_rss_mib":sampler.rss/2**20,
                          "peak_gpu_memory_mib":sampler.memory,"running":True}
                    output.with_suffix(".live.json").write_text(json.dumps(live)+"\n")
            code=process.returncode
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            code = -1
        elapsed = time.monotonic() - t0
        result = sampler.finish(elapsed)
    result.update(case=name, command=command, returncode=code, wall_seconds=elapsed, mode="cold_process", warm_measured=False)
    if metrics.exists():
        result["engine"] = json.loads(metrics.read_text())
    if code == 0 and wav.exists():
        with wave.open(str(wav), "rb") as f:
            audio = f.getnframes() / f.getframerate()
        result["audio_seconds"] = audio
        result["cold_end_to_end_rtf"] = elapsed / audio if audio else None
        synthesis = result.get("engine", {}).get("synthesis_seconds")
        result["synthesis_rtf_including_backpressure"] = synthesis / audio if audio and synthesis is not None else None
        if name == "long":
            result["long_duration_pass"] = audio >= args.long_minutes * 60
    output.with_suffix(".json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"case": name, "returncode": code, "wall_seconds": elapsed, "audio_seconds": result.get("audio_seconds")}, ensure_ascii=False))
    return result

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--executable", type=Path, required=True)
    p.add_argument("--models-dir", type=Path, required=True)
    p.add_argument("--model", default="qwen3-tts-1.7b-customvoice-f16")
    p.add_argument("--out-dir", type=Path, default=Path("artifacts/benchmarks"))
    p.add_argument("--cases", choices=["all", *CASES], default="all")
    p.add_argument("--timeout", type=float, default=300)
    p.add_argument("--long-minutes", type=float, default=0)
    p.add_argument("--repeat-count", type=int, default=0,
                   help="Use an exact paragraph repeat count for a reproducible long test")
    p.add_argument("--playback", action="store_true", help="Measure bounded playback too; route to a test sink if desired")
    a = p.parse_args()
    if a.timeout <= 0 or a.long_minutes < 0 or a.repeat_count<0:
        p.error("timeout must be positive; long-minutes must not be negative")
    a.out_dir.mkdir(parents=True, exist_ok=True)
    if a.long_minutes:
        if a.repeat_count:
            text=(CASES[a.cases if a.cases!="all" else "narration"]+"\n")*a.repeat_count
        else:
            text = CASES["narration"] + "\n" + CASES["dialogue"] + "\n"
            text *= math.ceil(a.long_minutes * 60 * 6 / len(text))
        results = [run_case(a, "long", text)]
    else:
        results = [run_case(a, name, text) for name, text in CASES.items() if a.cases in ("all", name)]
    return 0 if all(r["returncode"] == 0 for r in results) else 1

if __name__ == "__main__":
    raise SystemExit(main())

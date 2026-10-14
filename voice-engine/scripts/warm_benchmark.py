#!/usr/bin/env python3
"""Compare two uncached requests in the same real CLI session."""
import argparse
import json
import select
import shutil
import subprocess
import time
from pathlib import Path
from benchmark import Sampler, CASES

def completed(process, timeout):
    limit=time.monotonic()+timeout
    while time.monotonic()<limit:
        if not select.select([process.stdout],[],[],min(1,limit-time.monotonic()))[0]:
            if process.poll() is not None:
                raise RuntimeError("session exited before completion")
            continue
        line=process.stdout.readline()
        if not line:
            raise RuntimeError("session output closed")
        state=json.loads(line).get("state")
        if state in (3,4,5):
            if state!=3:
                raise RuntimeError(f"session failed with state {state}")
            return
    raise TimeoutError("session request timed out")

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--executable",type=Path,required=True)
    p.add_argument("--models-dir",type=Path,required=True)
    p.add_argument("--model",default="qwen3-tts-1.7b-customvoice-f16")
    p.add_argument("--case",choices=list(CASES),default="narration")
    p.add_argument("--out-dir",type=Path,default=Path("artifacts/warm"))
    p.add_argument("--timeout",type=float,default=180)
    a=p.parse_args();a.out_dir.mkdir(parents=True,exist_ok=True)
    wav=a.out_dir/"request.wav";metrics=a.out_dir/"request.metrics.json"
    cmd=[str(a.executable.resolve()),"--models-dir",str(a.models_dir.resolve()),"--model",a.model,"--text",CASES[a.case],
         "--no-play","--no-cache","--session","--output",str(wav),"--metrics",str(metrics)]
    with (a.out_dir/"session.log").open("w") as log:
        process=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1)
        try:
            results=[]
            for name in ("cold","warm"):
                sample=Sampler(process);start=time.monotonic()
                try:
                    if name=="warm":process.stdin.write("start\n");process.stdin.flush()
                    completed(process,a.timeout)
                finally:
                    resources=sample.finish(time.monotonic()-start)
                engine=json.loads(metrics.read_text())
                if name=="warm" and engine["cold_start"]:raise RuntimeError("worker was reloaded: not a warm measurement")
                result={"mode":name,"engine":engine,**resources}
                result["synthesis_rtf"]=engine["synthesis_seconds"]/engine["audio_seconds"]
                results.append(result)
                shutil.copyfile(wav,a.out_dir/(name+".wav"))
            process.stdin.write("quit\n");process.stdin.flush();process.wait(timeout=10)
            (a.out_dir/"comparison.json").write_text(json.dumps(results,ensure_ascii=False,indent=2)+"\n")
            print(json.dumps(results,ensure_ascii=False))
        finally:
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            process.stdin.close();process.stdout.close()
    return 0

if __name__=="__main__":raise SystemExit(main())

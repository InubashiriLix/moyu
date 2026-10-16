#include "../engine/nv_engine.h"
#include "../text/text.hpp"
#include <csignal>
#include <fstream>
#include <iostream>
#include <filesystem>
#include <map>
#include <memory>
#include <poll.h>
#include <thread>
#include <unistd.h>
namespace {
volatile sig_atomic_t interrupted=0;
void signal_handler(int){interrupted=1;}
void write_metrics(nv_session* s,const std::string& path){
 if(path.empty())return;auto m=nv_get_metrics(s);std::ofstream f(path+".tmp");
 char runtime[4096]{};auto bytes=nv_get_runtime_info_json(s,runtime,sizeof(runtime));
 f<<"{\"wall_seconds\":"<<m.wall_seconds<<",\"first_pcm_seconds\":"<<m.first_pcm_seconds
  <<",\"load_seconds\":"<<m.load_seconds<<",\"synthesis_seconds\":"<<m.synthesis_seconds
  <<",\"audio_seconds\":"<<m.audio_seconds<<",\"cache_hits\":"<<m.cache_hits
  <<",\"underrun_samples\":"<<m.underrun_samples<<",\"cold_start\":"<<m.cold_start<<",\"cancelled\":"<<m.cancelled
  <<",\"runtime\":"<<(bytes>0&&bytes<=sizeof(runtime)?runtime:"{}")<<"}\n";
 f.close();if(!f)throw std::runtime_error("cannot write metrics");std::filesystem::rename(path+".tmp",path);
}
std::string read_input(const std::map<std::string,std::string>& values){
 if(values.count("--text"))return values.at("--text");
 std::ifstream f(values.at("--input"),std::ios::binary);if(!f)throw std::runtime_error("cannot read input");
 f.seekg(0,std::ios::end);auto n=f.tellg();if(n<0||n>64*1024*1024)throw std::runtime_error("input exceeds 64 MiB");
 std::string s(static_cast<size_t>(n),'\0');f.seekg(0);if(n&&!f.read(s.data(),n))throw std::runtime_error("input read failed");
 if(s.compare(0,3,"\xef\xbb\xbf")==0)s.erase(0,3);return s;
}
int integer(const std::string& s){size_t p;auto v=std::stoi(s,&p);if(p!=s.size())throw std::runtime_error("invalid integer");return v;}
}
int main(int argc,char** argv){
 try{
  const std::string valued=" --text --input --models-dir --model --speaker --instruction --output --cache-dir --idle-seconds --threads --seed --metrics --backend --power-mode --backends-dir ";
  const std::string flags=" --no-play --no-cache --neutral --plan --session --help ";
  std::map<std::string,std::string> v;for(int i=1;i<argc;++i){std::string key=argv[i];
   if(v.count(key))throw std::runtime_error("duplicate option: "+key);
   if(valued.find(" "+key+" ")!=std::string::npos){if(++i>=argc)throw std::runtime_error("missing value: "+key);v[key]=argv[i];}
   else if(flags.find(" "+key+" ")!=std::string::npos)v[key]="1";else throw std::runtime_error("unknown option: "+key);
  }
  if(v.count("--help")){
   std::cout<<"novel-voice --text TEXT | --input UTF8.txt [--models-dir DIR] [--model STEM]\n"
    <<"  --speaker Uncle_Fu|Serena --instruction TEXT --neutral --plan\n"
    <<"  --output WAV --no-play --no-cache --cache-dir DIR --metrics JSON\n"
    <<"  --backend auto|cpu|vulkan|cuda --power-mode eco|balanced --backends-dir DIR\n"
    <<"  --threads 1..8 --seed INTEGER --idle-seconds INTEGER --session\n"
    <<"Session commands: start, pause, resume, stop, status, wait, quit.\n";return 0;
  }
  if(v.count("--text")+v.count("--input")!=1)throw std::runtime_error("provide exactly one of --text or --input");
  auto text=read_input(v);if(text.find('\0')!=std::string::npos)throw std::runtime_error("NUL is not allowed in text");
  nv::TextOptions o;o.automatic=!v.count("--neutral");if(v.count("--instruction"))o.instruction_override=v["--instruction"];
  auto segments=nv::segment_text(text,o);if(segments.empty())throw std::runtime_error("text is empty");
  if(v.count("--plan")){for(auto& p:segments)std::cout<<p.byte_begin<<'\t'<<p.byte_end<<'\t'<<p.emotion<<'\t'<<p.instruction<<'\t'<<p.text<<'\n';return 0;}
  nv_config c=nv_default_config();
  if(v.count("--models-dir"))c.models_dir=v["--models-dir"].c_str();
  else {auto root=std::filesystem::canonical("/proc/self/exe").parent_path().parent_path().parent_path();v["--models-dir"]=(root/"models/gguf").string();c.models_dir=v["--models-dir"].c_str();}
  if(v.count("--model"))c.model=v["--model"].c_str();if(v.count("--speaker"))c.speaker=v["--speaker"].c_str();
  if(v.count("--cache-dir"))c.cache_dir=v["--cache-dir"].c_str();if(v.count("--output"))c.output_wav=v["--output"].c_str();
  c.playback=!v.count("--no-play");c.cache_enabled=!v.count("--no-cache");
  if(v.count("--threads"))c.threads=integer(v["--threads"]);if(v.count("--idle-seconds"))c.idle_seconds=integer(v["--idle-seconds"]);
  if(!v.count("--threads")&&v.count("--power-mode")&&v["--power-mode"]=="balanced")c.threads=4;
  if(v.count("--seed")){size_t p;c.seed=std::stoll(v["--seed"],&p);if(p!=v["--seed"].size())throw std::runtime_error("invalid seed");}
  std::unique_ptr<nv_session,decltype(&nv_destroy)> session(nv_create(&c,nullptr,nullptr,[](const char* e,void*){std::cerr<<"error: "<<e<<'\n';},nullptr),nv_destroy);
  if(!session)throw std::runtime_error("cannot create session");auto* s=session.get();
  auto backend=v.count("--backend")?v["--backend"]:"auto";
  auto power=v.count("--power-mode")?v["--power-mode"]:"eco";
  if(backend!="auto"&&backend!="cpu"&&backend!="cuda"&&backend!="vulkan")throw std::runtime_error("invalid backend");
  if(power!="eco"&&power!="balanced")throw std::runtime_error("invalid power mode");
  nv_runtime_options runtime{sizeof(nv_runtime_options),1,backend=="cpu"?1:backend=="cuda"?2:backend=="vulkan"?3:0,power=="balanced"?1:0,v.count("--backends-dir")?v["--backends-dir"].c_str():nullptr};
  if(!nv_set_runtime_options(s,&runtime))throw std::runtime_error("cannot configure backend");
  nv_request r{};r.text=text.c_str();r.automatic=o.automatic;r.instruction=o.instruction_override.c_str();
  if(!nv_submit(s,&r))throw std::runtime_error("cannot submit text");
  std::signal(SIGINT,signal_handler);std::signal(SIGTERM,signal_handler);
  bool interactive=v.count("--session"),quit=false;int reported=-1;
  while(!quit){
   if(interrupted){nv_stop(s);break;}
   auto state=nv_get_state(s);
   if(state!=NV_RUNNING&&state!=NV_PAUSED){
    if(reported!=state){nv_wait(s);write_metrics(s,v.count("--metrics")?v["--metrics"]:"");reported=state;if(interactive)std::cout<<"{\"state\":"<<state<<"}\n"<<std::flush;}
    if(!interactive)break;
   }
   if(interactive){pollfd fd{STDIN_FILENO,POLLIN,0};int ready=poll(&fd,1,50);
    if(ready>0&&(fd.revents&(POLLIN|POLLHUP))){
     // Read bytes without iostream read-ahead so pipes with multiple commands work.
     static std::string pending;char b;ssize_t n=read(STDIN_FILENO,&b,1);
     if(n<=0){quit=true;continue;}if(b!='\n'){pending+=b;if(pending.size()>4096)throw std::runtime_error("session command too long");continue;}
     auto cmd=pending;pending.clear();if(!cmd.empty()&&cmd.back()=='\r')cmd.pop_back();
     if(cmd=="pause")nv_pause(s);else if(cmd=="resume")nv_resume(s);else if(cmd=="stop")nv_stop(s);
     else if(cmd=="start"){if(nv_submit(s,&r))reported=-1;else std::cerr<<"session is busy\n";}
     else if(cmd=="wait"){nv_wait(s);write_metrics(s,v.count("--metrics")?v["--metrics"]:"");std::cout<<"{\"state\":"<<nv_get_state(s)<<"}\n"<<std::flush;}
     else if(cmd=="status")std::cout<<"{\"state\":"<<nv_get_state(s)<<"}\n"<<std::flush;
     else if(cmd=="quit")quit=true;else if(!cmd.empty())std::cerr<<"unknown session command\n";
    }
   }else std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  if(nv_get_state(s)==NV_RUNNING||nv_get_state(s)==NV_PAUSED)nv_stop(s);
  int state=nv_wait(s);write_metrics(s,v.count("--metrics")?v["--metrics"]:"");
  if(state==NV_ERROR)std::cerr<<nv_last_error(s)<<'\n';return state==NV_COMPLETED?0:state==NV_CANCELLED?130:1;
 }catch(const std::exception& e){std::cerr<<"error: "<<e.what()<<'\n';return 2;}
}

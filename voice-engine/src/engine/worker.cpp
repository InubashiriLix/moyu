#include "worker.hpp"
#include "ipc.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <vector>
#include <dlfcn.h>
extern char** environ;
namespace nv {
Worker::Worker(std::string d,std::string m,int t):models_dir_(std::move(d)),model_(std::move(m)),threads_(t){}
Worker::~Worker(){terminate();}
void Worker::set_error(const std::string& s){std::lock_guard<std::mutex> l(mutex_);error_=s;}
std::string Worker::error() const{std::lock_guard<std::mutex> l(mutex_);return error_;}
bool Worker::running() const{std::lock_guard<std::mutex> l(mutex_);return pid_>0;}
void Worker::pause(bool p){std::lock_guard<std::mutex> l(mutex_);if(pid_>0)kill(pid_,p?SIGSTOP:SIGCONT);}
bool Worker::start(){
    int own;
    {
        std::lock_guard<std::mutex> l(mutex_);
        if(pid_>0)return true;
        int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair)){error_="socketpair failed";return false;}
        // Locate helper beside the shared library, so embedding does not depend on caller cwd.
        Dl_info info{};dladdr(reinterpret_cast<void*>(&ipc::transfer),&info);
        auto dir=info.dli_fname?std::filesystem::absolute(info.dli_fname).parent_path():std::filesystem::current_path();
        std::string path=(dir/"nv-worker").string(), t=std::to_string(threads_);
        posix_spawn_file_actions_t actions;posix_spawn_file_actions_init(&actions);
        // fd 3 may already be one socket: close the parent end before dup2.
        if(pair[0]!=3)posix_spawn_file_actions_addclose(&actions,pair[0]);
        posix_spawn_file_actions_adddup2(&actions,pair[1],3);
        if(pair[1]!=3)posix_spawn_file_actions_addclose(&actions,pair[1]);
        char* argv[]={path.data(),models_dir_.data(),model_.data(),t.data(),nullptr};
        int rc=posix_spawn(&pid_,path.c_str(),&actions,nullptr,argv,environ);
        posix_spawn_file_actions_destroy(&actions);close(pair[1]);
        if(rc){close(pair[0]);pid_=-1;error_="cannot start nv-worker: "+std::to_string(rc);return false;}
        fd_=pair[0];own=dup(fd_);
    }
    ipc::Header h{};bool ok=own>=0&&ipc::read(own,&h,sizeof h);
    if(ok&&h.type==ipc::error&&h.bytes<=65536){std::string s(h.bytes,'\0');ipc::read(own,s.data(),s.size());set_error(s);ok=false;}
    else if(!ok||h.type!=ipc::ready||h.bytes){set_error("worker failed during CUDA/model initialization; see stderr");ok=false;}
    if(own>=0)close(own);if(!ok)terminate();return ok;
}
bool Worker::synthesize(const std::string& text,const std::string& speaker,const std::string& instruction,int64_t seed,
                       const std::function<bool(const float*,size_t,int)>& cb){
    if(!start())return false;
    int fd;{std::lock_guard<std::mutex> l(mutex_);fd=fd_>=0?dup(fd_):-1;}
    if(fd<0){set_error("worker stopped");return false;}
    bool ok=ipc::message(fd,ipc::request)&&ipc::string_write(fd,text)&&ipc::string_write(fd,speaker)&&ipc::string_write(fd,instruction)&&ipc::write(fd,&seed,sizeof seed);
    bool done=false;
    while(ok&&!done){
        ipc::Header h;if(!ipc::read(fd,&h,sizeof h)){ok=false;break;}
        if(h.type==ipc::done&&h.bytes==0){done=true;break;}
        if(h.type==ipc::error&&h.bytes<=65536){std::string s(h.bytes,'\0');ipc::read(fd,s.data(),s.size());set_error(s);ok=false;break;}
        if(h.type!=ipc::pcm||h.bytes==0||h.bytes%sizeof(float)||h.bytes>480000*sizeof(float)){set_error("invalid worker PCM packet");ok=false;break;}
        std::vector<float> samples(h.bytes/sizeof(float));
        if(!ipc::read(fd,samples.data(),h.bytes)){ok=false;break;}
        for(float v:samples)if(!std::isfinite(v)){ok=false;set_error("nonfinite PCM");break;}
        if(ok&&!cb(samples.data(),samples.size(),24000)){set_error("cancelled");ok=false;}
    }
    close(fd);if(!ok){if(error().empty())set_error("worker disconnected");terminate();}return ok&&done;
}
void Worker::terminate(){
    pid_t pid;{std::lock_guard<std::mutex> l(mutex_);pid=pid_;pid_=-1;if(fd_>=0){shutdown(fd_,SHUT_RDWR);close(fd_);fd_=-1;}}
    if(pid>0){kill(pid,SIGKILL);while(waitpid(pid,nullptr,0)<0&&errno==EINTR){}}
}
}

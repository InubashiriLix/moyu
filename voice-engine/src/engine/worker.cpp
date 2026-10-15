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
#include <fstream>
#include <array>
#include <cstring>
extern char** environ;
namespace nv {
namespace {
bool identical_files(const std::filesystem::path& a,const std::filesystem::path& b){
    std::error_code ec;auto n=std::filesystem::file_size(a,ec);if(ec)return false;
    if(std::filesystem::file_size(b,ec)!=n||ec)return false;
    std::ifstream left(a,std::ios::binary),right(b,std::ios::binary);if(!left||!right)return false;
    std::array<char,16384> l{},r{};
    while(left&&right){left.read(l.data(),l.size());right.read(r.data(),r.size());
        if(left.gcount()!=right.gcount()||std::memcmp(l.data(),r.data(),std::size_t(left.gcount())))return false;
    }
    return left.eof()&&right.eof();
}
// Select our matching optimized CPU backend for GPU fallback operations too.
// Byte-identical ggml-base libraries ensure both builds use the same core ABI.
std::string optimized_cpu_library(const std::string& binary,const std::string& root){
#if defined(__x86_64__) && defined(__GNUC__)
    __builtin_cpu_init();
    if(!__builtin_cpu_supports("avx2")||!__builtin_cpu_supports("fma")||!__builtin_cpu_supports("f16c"))return {};
    Dl_info info{};dladdr(reinterpret_cast<void*>(&ipc::transfer),&info);
    if(!info.dli_fname)return {};
    auto dir=std::filesystem::absolute(info.dli_fname).parent_path();
    std::vector<std::filesystem::path> roots;
    if(!root.empty())roots.emplace_back(root);
    roots.push_back(dir/"backends");
    for(const auto& r:roots){
        auto cpu=r/"cpu"/"avx2";
        auto library=cpu/"libggml-cpu.so.0";
        auto value=library.string();
        if(value.find_first_of(" :\t\n\r")!=std::string::npos)continue;
        if(std::filesystem::is_regular_file(library)&&identical_files(cpu/"libggml-base.so.0",std::filesystem::path(binary).parent_path()/"libggml-base.so.0"))return value;
    }
#endif
    return {};
}
}
Worker::Worker(std::string d,std::string m,int t,std::string b,std::string r,bool eco,const std::atomic<bool>* cancelled):models_dir_(std::move(d)),model_(std::move(m)),threads_(t),requested_(std::move(b)),root_(std::move(r)),eco_(eco){cancelled_=cancelled;}
Worker::~Worker(){terminate();}
void Worker::set_error(const std::string& s){std::lock_guard<std::mutex> l(mutex_);error_=s;}
std::string Worker::error() const{std::lock_guard<std::mutex> l(mutex_);return error_;}
bool Worker::running() const{std::lock_guard<std::mutex> l(mutex_);return pid_>0;}
void Worker::pause(bool p){std::lock_guard<std::mutex> l(mutex_);if(pid_>0)kill(pid_,p?SIGSTOP:SIGCONT);}
std::string Worker::backend() const{std::lock_guard<std::mutex> l(mutex_);return active_;}
std::string Worker::device() const{std::lock_guard<std::mutex> l(mutex_);return device_;}
std::string Worker::fallback_reason() const{std::lock_guard<std::mutex> l(mutex_);return fallback_;}
bool Worker::start(){
    if(cancelled_&&*cancelled_)return false;
    if(running())return true;
    Dl_info info{};dladdr(reinterpret_cast<void*>(&ipc::transfer),&info);
    auto dir=info.dli_fname?std::filesystem::absolute(info.dli_fname).parent_path():std::filesystem::current_path();
    std::vector<std::string> candidates=requested_=="auto"?std::vector<std::string>{"cuda","vulkan","cpu"}:std::vector<std::string>{requested_};
    std::string failures=fallback_reason();bool found=false;
    for(const auto& b:candidates){
        if(rejected_.count(b))continue;
        if(cancelled_&&*cancelled_)return false;
        std::vector<std::filesystem::path> roots;
        if(!root_.empty())roots.emplace_back(root_);
        roots.push_back(dir/"backends");
        for(const auto& r:roots){
            auto path=r/b/"nv-worker";
#if defined(__x86_64__) && defined(__GNUC__)
            if(b=="cpu"){
                __builtin_cpu_init();
                auto optimized=r/b/"avx2"/"nv-worker";
                if(__builtin_cpu_supports("avx2")&&__builtin_cpu_supports("fma")&&__builtin_cpu_supports("f16c")&&std::filesystem::is_regular_file(optimized))path=optimized;
            }
#endif
            if(!std::filesystem::is_regular_file(path))continue;
            found=true;
            if(start_candidate(path.string(),b)){std::lock_guard<std::mutex> l(mutex_);fallback_=failures;return true;}
            if(!failures.empty())failures+="; ";failures+=b+": "+error();
        }
    }
    if(std::filesystem::is_regular_file(dir/"nv-worker")){
#ifdef NV_BUILD_BACKEND
        const std::string built=NV_BUILD_BACKEND;
#else
        const std::string built="legacy";
#endif
        if(!rejected_.count(built)&&(requested_=="auto"||requested_==built||built=="legacy")){
            if(start_candidate((dir/"nv-worker").string(),built)){std::lock_guard<std::mutex> l(mutex_);fallback_=failures;return true;}
            failures+=error();
        }
    }
    set_error(failures.empty()?"没有可用朗读后端，请安装 CPU/Vulkan 基础或对应加速组件":failures);return false;
}
bool Worker::start_candidate(const std::string& binary,const std::string& selected){
    int own;
    {
        std::lock_guard<std::mutex> l(mutex_);
        if(cancelled_&&*cancelled_)return false;
        if(pid_>0)return true;
        int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair)){error_="socketpair failed";return false;}
        std::string path=binary, backend=selected;
        std::string t=std::to_string(eco_?std::min(threads_,selected=="cpu"?1:2):threads_);
        posix_spawn_file_actions_t actions;posix_spawn_file_actions_init(&actions);
        // fd 3 may already be one socket: close the parent end before dup2.
        if(pair[0]!=3)posix_spawn_file_actions_addclose(&actions,pair[0]);
        posix_spawn_file_actions_adddup2(&actions,pair[1],3);
        if(pair[1]!=3)posix_spawn_file_actions_addclose(&actions,pair[1]);
        char* argv[]={path.data(),models_dir_.data(),model_.data(),t.data(),backend.data(),nullptr};
        std::vector<std::string> child_env;std::vector<char*> envp;
        auto optimized=selected=="cuda"||selected=="vulkan"?optimized_cpu_library(binary,root_):std::string{};
        if(!optimized.empty()){
            std::string previous;
            for(char** p=environ;*p;++p){
                if(std::strncmp(*p,"LD_PRELOAD=",11)==0)previous=*p+11;
                else child_env.emplace_back(*p);
            }
            child_env.push_back("LD_PRELOAD="+optimized+(previous.empty()?"":":"+previous));
            for(auto& value:child_env)envp.push_back(value.data());envp.push_back(nullptr);
        }
        int rc=posix_spawn(&pid_,path.c_str(),&actions,nullptr,argv,envp.empty()?environ:envp.data());
        posix_spawn_file_actions_destroy(&actions);close(pair[1]);
        if(rc){close(pair[0]);pid_=-1;error_="cannot start nv-worker: "+std::to_string(rc);return false;}
        fd_=pair[0];own=dup(fd_);
    }
    ipc::Header h{};bool ok=own>=0&&ipc::read(own,&h,sizeof h);
    if(ok&&h.type==ipc::error&&h.bytes<=65536){std::string s(h.bytes,'\0');ipc::read(own,s.data(),s.size());set_error(s);ok=false;}
    else if(!ok||h.type!=ipc::ready||h.bytes>4096){set_error("worker failed during backend/model initialization; see stderr");ok=false;}
    else {std::string device(h.bytes,'\0');if(h.bytes&&!ipc::read(own,device.data(),device.size()))ok=false;
        if(ok){std::lock_guard<std::mutex> l(mutex_);active_=selected;device_=device.empty()?selected:device;error_.clear();}}
    if(own>=0)close(own);if(!ok)terminate();return ok;
}
bool Worker::synthesize(const std::string& text,const std::string& speaker,const std::string& instruction,int64_t seed,
                       const std::function<bool(const float*,size_t,int)>& cb){
    if(!start())return false;
    int fd;{std::lock_guard<std::mutex> l(mutex_);fd=fd_>=0?dup(fd_):-1;}
    if(fd<0){set_error("worker stopped");return false;}
    bool ok=ipc::message(fd,ipc::request)&&ipc::string_write(fd,text)&&ipc::string_write(fd,speaker)&&ipc::string_write(fd,instruction)&&ipc::write(fd,&seed,sizeof seed);
    bool done=false,emitted=false;
    while(ok&&!done){
        ipc::Header h;if(!ipc::read(fd,&h,sizeof h)){ok=false;break;}
        if(h.type==ipc::done&&h.bytes==0){done=true;break;}
        if(h.type==ipc::error&&h.bytes<=65536){std::string s(h.bytes,'\0');ipc::read(fd,s.data(),s.size());set_error(s);ok=false;break;}
        if(h.type!=ipc::pcm||h.bytes==0||h.bytes%sizeof(float)||h.bytes>480000*sizeof(float)){set_error("invalid worker PCM packet");ok=false;break;}
        std::vector<float> samples(h.bytes/sizeof(float));
        if(!ipc::read(fd,samples.data(),h.bytes)){ok=false;break;}
        for(float v:samples)if(!std::isfinite(v)){ok=false;set_error("nonfinite PCM");break;}
        if(ok){emitted=true;if(!cb(samples.data(),samples.size(),24000)){set_error("cancelled");ok=false;}}
    }
    close(fd);if(!ok){if(error().empty())set_error("worker disconnected");terminate();}
    if(!ok&&!emitted&&requested_=="auto"&&(backend()=="cuda"||backend()=="vulkan")&&!(cancelled_&&*cancelled_)){
        auto failed=backend();auto why=error();rejected_.insert(failed);
        {std::lock_guard<std::mutex> l(mutex_);if(!fallback_.empty())fallback_+="; ";fallback_+=failed+": "+why;}
        return synthesize(text,speaker,instruction,seed,cb);
    }
    return ok&&done;
}
void Worker::terminate(){
    pid_t pid;{std::lock_guard<std::mutex> l(mutex_);pid=pid_;pid_=-1;if(fd_>=0){shutdown(fd_,SHUT_RDWR);close(fd_);fd_=-1;}}
    if(pid>0){kill(pid,SIGKILL);while(waitpid(pid,nullptr,0)<0&&errno==EINTR){}}
}
}

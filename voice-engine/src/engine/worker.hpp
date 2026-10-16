#pragma once
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <set>
#include <sys/types.h>
namespace nv {
class Worker {
public:
    Worker(std::string models_dir,std::string model,int threads=2,std::string backend="auto",std::string root="",bool eco=false,const std::atomic<bool>* cancelled=nullptr);
    ~Worker();
    bool start();
    bool synthesize(const std::string&,const std::string&,const std::string&,int64_t,
                    const std::function<bool(const float*,size_t,int)>&);
    void terminate();
    void pause(bool paused);
    bool running() const;
    std::string error() const;
    std::string backend() const;
    std::string device() const;
    std::string fallback_reason() const;
private:
    std::string models_dir_,model_;int threads_; mutable std::mutex mutex_;
    pid_t pid_=-1;int fd_=-1;std::string error_;
    const std::atomic<bool>* cancelled_=nullptr;
    std::string requested_,root_,active_,device_,fallback_; bool eco_=false;
    std::set<std::string> rejected_;
    bool start_candidate(const std::string&,const std::string&);
    void set_error(const std::string&);
};
}

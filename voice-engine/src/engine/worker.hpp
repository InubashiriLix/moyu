#pragma once
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <sys/types.h>
namespace nv {
class Worker {
public:
    Worker(std::string models_dir,std::string model,int threads=2);
    ~Worker();
    bool start();
    bool synthesize(const std::string&,const std::string&,const std::string&,int64_t,
                    const std::function<bool(const float*,size_t,int)>&);
    void terminate();
    void pause(bool paused);
    bool running() const;
    std::string error() const;
private:
    std::string models_dir_,model_;int threads_; mutable std::mutex mutex_;
    pid_t pid_=-1;int fd_=-1;std::string error_;
    void set_error(const std::string&);
};
}

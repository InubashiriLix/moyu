// Test-only worker. This target is never installed or used by the CLI.
#include "../src/engine/ipc.hpp"
#include <chrono>
#include <thread>
#include <vector>
#include <cstdlib>
int main(int argc,char** argv){
 if(const char* delay=std::getenv("NV_FAKE_LOAD_MS"))std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(delay)));
 int fd=3;
 if(const char* rejected=std::getenv("NV_FAKE_REJECT_BACKEND"))if(argc>4&&std::string(argv[4])==rejected){nv::ipc::text(fd,nv::ipc::error,"intentional unsupported backend");return 1;}
 if(const char* error=std::getenv("NV_FAKE_START_ERROR")){nv::ipc::text(fd,nv::ipc::error,error);return 1;}
 if(!nv::ipc::message(fd,nv::ipc::ready))return 1;
 for(;;){
    nv::ipc::Header h;if(!nv::ipc::read(fd,&h,sizeof h))return 0;
    std::string text,speaker,instruction;int64_t seed;
    if(h.type!=nv::ipc::request||!nv::ipc::string_read(fd,text)||!nv::ipc::string_read(fd,speaker)||!nv::ipc::string_read(fd,instruction)||!nv::ipc::read(fd,&seed,sizeof seed))return 1;
    if(text=="FAIL"){nv::ipc::text(fd,nv::ipc::error,"intentional test failure");return 1;}
    std::vector<float> pcm(2400,.125f);
    for(int i=0;i<20;++i){if(!nv::ipc::message(fd,nv::ipc::pcm,pcm.data(),uint32_t(pcm.size()*sizeof(float))))return 0;std::this_thread::sleep_for(std::chrono::milliseconds(20));}
    if(!nv::ipc::message(fd,nv::ipc::done))return 1;
 }
}

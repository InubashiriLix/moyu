#include "../src/engine/nv_engine.h"
#include <atomic>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>
#include <unistd.h>
#define CHECK(x) do{if(!(x))throw std::runtime_error(#x);}while(0)
using namespace std::chrono_literals;
struct Samples {std::atomic<size_t> count{0};std::atomic<bool> reject{false};};
int pcm(const float* p,size_t n,int rate,void* user){auto*s=static_cast<Samples*>(user);CHECK(rate==24000);for(size_t i=0;i<n;++i)CHECK(p[i]==.125f);s->count+=n;return !s->reject;}
void wait_samples(Samples& samples){auto until=std::chrono::steady_clock::now()+3s;while(samples.count<4800&&std::chrono::steady_clock::now()<until)std::this_thread::sleep_for(5ms);CHECK(samples.count>=4800);}
int main(){
 try{
    auto dir=std::filesystem::temp_directory_path()/("nv-session-test-"+std::to_string(getpid()));std::filesystem::create_directories(dir);
    auto out=(dir/"output.wav").string(),cache=(dir/"cache").string();Samples samples;
    auto c=nv_default_config();c.playback=0;c.cache_enabled=0;c.idle_seconds=1;c.output_wav=out.c_str();c.cache_dir=cache.c_str();
    using Ptr=std::unique_ptr<nv_session,decltype(&nv_destroy)>;Ptr s(nv_create(&c,pcm,nullptr,nullptr,&samples),nv_destroy);CHECK(s);
    nv_request r{};r.text="山谷里没有声音。";r.automatic=1;
    CHECK(nv_submit(s.get(),&r));CHECK(!nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);
    CHECK(nv_get_metrics(s.get()).cold_start==1);samples.count=0;
    CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(nv_get_metrics(s.get()).cold_start==0);
    samples.count=0;CHECK(nv_submit(s.get(),&r));wait_samples(samples);nv_pause(s.get());std::this_thread::sleep_for(50ms);auto paused=samples.count.load();
    std::this_thread::sleep_for(100ms);CHECK(samples.count==paused);CHECK(nv_get_state(s.get())==NV_PAUSED);nv_resume(s.get());CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);
    samples.count=0;CHECK(nv_submit(s.get(),&r));wait_samples(samples);nv_pause(s.get());std::this_thread::sleep_for(1400ms);nv_resume(s.get());CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);
    samples.count=0;CHECK(nv_submit(s.get(),&r));wait_samples(samples);auto start=std::chrono::steady_clock::now();nv_stop(s.get());CHECK(nv_wait(s.get())==NV_CANCELLED);CHECK(std::chrono::steady_clock::now()-start<1s);CHECK(std::filesystem::exists(out+".partial"));
    r.text="FAIL";CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_ERROR);CHECK(std::string(nv_last_error(s.get())).find("intentional")!=std::string::npos);
    r.text="\xed\xa0\x80";CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_ERROR);
    s.reset();c.cache_enabled=1;s.reset(nv_create(&c,pcm,nullptr,nullptr,&samples));r.text="缓存这一句。";samples.count=0;
    CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_COMPLETED);samples.count=0;
    CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);CHECK(nv_get_metrics(s.get()).cache_hits==1);
    samples.reject=true;CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_CANCELLED);
    s.reset();c.cache_enabled=0;samples.reject=false;samples.count=0;
    setenv("NV_FAKE_START_ERROR","GPU sm_89 unsupported; compiled sm_120a",1);
    s.reset(nv_create(&c,pcm,nullptr,nullptr,&samples));r.text="不兼容设备应明确失败。";
    CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_ERROR);
    CHECK(std::string(nv_last_error(s.get())).find("sm_89 unsupported")!=std::string::npos);
    CHECK(samples.count==0);unsetenv("NV_FAKE_START_ERROR");
    CHECK(nv_submit(s.get(),&r));CHECK(nv_wait(s.get())==NV_COMPLETED);
    s.reset();samples.count=0;
    setenv("NV_FAKE_LOAD_MS","2000",1);
    s.reset(nv_create(&c,pcm,nullptr,nullptr,&samples));r.text="加载期间长暂停也能恢复。";
    CHECK(nv_submit(s.get(),&r));std::this_thread::sleep_for(100ms);nv_pause(s.get());
    std::this_thread::sleep_for(1400ms);CHECK(nv_get_state(s.get())==NV_PAUSED);CHECK(samples.count==0);
    nv_resume(s.get());CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);
    unsetenv("NV_FAKE_LOAD_MS");
    s.reset();samples.count=0;
    auto backends=dir/"backends";
    auto fake=std::filesystem::canonical("/proc/self/exe").parent_path()/"nv-worker";
    for(auto backend:{"cuda","cpu"}){std::filesystem::create_directories(backends/backend);std::filesystem::create_symlink(fake,backends/backend/"nv-worker");}
    setenv("NV_FAKE_REJECT_BACKEND","cuda",1);
    s.reset(nv_create(&c,pcm,nullptr,nullptr,&samples));
    auto backend_path=backends.string();nv_runtime_options runtime{sizeof(nv_runtime_options),1,0,0,backend_path.c_str()};
    CHECK(nv_set_runtime_options(s.get(),&runtime));r.text="无 GPU 时回退。";
    CHECK(nv_submit(s.get(),&r));std::this_thread::sleep_for(100ms);CHECK(samples.count==0);
    CHECK(nv_wait(s.get())==NV_COMPLETED);CHECK(samples.count==48000);
    char info[4096];CHECK(nv_get_runtime_info_json(s.get(),info,sizeof(info))<sizeof(info));
    CHECK(std::string(info).find("\"effectiveBackend\":\"cpu\"")!=std::string::npos);
    CHECK(std::string(info).find("unsupported backend")!=std::string::npos);unsetenv("NV_FAKE_REJECT_BACKEND");
    s.reset();std::filesystem::remove_all(dir);std::cout<<"session checks passed\n";return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}

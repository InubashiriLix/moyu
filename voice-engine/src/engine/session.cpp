#include "session_internal.hpp"
#include <cstdlib>
#include <cmath>
#include <filesystem>
#include <stdexcept>
#include <algorithm>
#include <cstring>
#include <sstream>
using Clock=std::chrono::steady_clock;
extern "C" {
int nv_engine_abi_version(){return 1;}
static std::string json_quote(const std::string& s){std::string r="\"";for(unsigned char c:s){if(c=='\\'||c=='\"'){r+='\\';r+=char(c);}else if(c=='\n')r+="\\n";else if(c=='\r')r+="\\r";else if(c=='\t')r+="\\t";else if(c<32)r+=' ';else r+=char(c);}return r+"\"";}
int nv_set_runtime_options(nv_session* s,const nv_runtime_options* o){
    if(!s||!o||o->version!=1||o->struct_size<sizeof(nv_runtime_options)||o->backend<0||o->backend>3||o->power_mode<0||o->power_mode>1)return 0;
    std::lock_guard<std::mutex> lock(s->control);if(s->state==NV_RUNNING||s->state==NV_PAUSED)return 0;
    static const char* names[]={"auto","cpu","cuda","vulkan"};
    s->backend=names[o->backend];s->backends_dir=o->backends_dir?o->backends_dir:"";s->eco=o->power_mode==0;s->runtime_configured=true;
    s->config.idle_seconds=s->eco?std::min(s->requested_idle,15):s->requested_idle;
    s->config.threads=s->eco?std::min(s->requested_threads,2):s->requested_threads;
    s->worker=std::make_unique<nv::Worker>(s->models,s->model,s->config.threads,s->backend,s->backends_dir,s->eco,&s->cancelled);return 1;
}
size_t nv_get_runtime_info_json(nv_session* s,char* out,size_t capacity){
    if(!s)return 0;std::lock_guard<std::mutex> lock(s->control);
    auto b=s->worker?s->worker->backend():"";auto d=s->worker?s->worker->device():"";auto reason=s->worker?s->worker->fallback_reason():"";
    auto value=std::string("{\"effectiveBackend\":")+json_quote(b)+",\"device\":"+json_quote(d)+",\"fallbackReason\":"+json_quote(reason)+",\"powerMode\":"+json_quote(s->eco?"eco":"balanced")+"}";
    if(out&&capacity>value.size())std::memcpy(out,value.c_str(),value.size()+1);return value.size()+1;
}

nv_playback_position nv_get_playback_position(nv_session* s){
    nv_playback_position p{};p.sample_rate=24000;
    if(!s)return p;
    std::lock_guard<std::mutex> lock(s->mutex);
    if(!s->playback)return p;
    p.consumed_samples=s->playback->consumed();
    p.buffering=s->state==NV_RUNNING&&s->playback->buffering();
    if(!p.consumed_samples)return p;
    auto mark=std::lower_bound(s->audio_marks.begin(),s->audio_marks.end(),p.consumed_samples,
        [](const nv_session::AudioMark& m,std::uint64_t sample){return m.sample<sample;});
    if(mark!=s->audio_marks.begin()){
        --mark;p.byte_begin=mark->begin;p.byte_end=mark->end;p.valid=1;
    }
    return p;
}
nv_config nv_default_config(){
    nv_config c{};c.models_dir="models/gguf";c.model="qwen3-tts-1.7b-customvoice-f16";c.speaker="Uncle_Fu";
    c.threads=2;c.playback=1;c.cache_enabled=1;c.idle_seconds=60;c.preroll_seconds=1;c.max_buffer_seconds=30;c.seed=42;return c;
}
nv_session* nv_create(const nv_config* supplied,nv_pcm_callback pcm,nv_progress_callback progress,nv_error_callback err,void* user){
    std::unique_ptr<nv_session> s;
    try{
        auto c=supplied?*supplied:nv_default_config();
        if(c.threads<1||c.threads>8||c.seed<0||c.idle_seconds<1||!std::isfinite(c.preroll_seconds)||!std::isfinite(c.max_buffer_seconds)||
           c.preroll_seconds<=0||c.max_buffer_seconds<c.preroll_seconds||c.max_buffer_seconds>30)
            throw std::invalid_argument("invalid thread, idle, or audio buffer configuration");
        s=std::make_unique<nv_session>();s->config=c;s->requested_threads=c.threads;s->requested_idle=c.idle_seconds;
        s->models=c.models_dir?c.models_dir:"models/gguf";s->model=c.model?c.model:"qwen3-tts-1.7b-customvoice-f16";
        s->speaker=c.speaker?c.speaker:"Uncle_Fu";s->output=c.output_wav?c.output_wav:"";
        if(c.cache_dir)s->cache_dir=c.cache_dir;
        else {const char* x=getenv("XDG_CACHE_HOME"),* h=getenv("HOME");s->cache_dir=std::string(x?x:h?h:".")+(x?"/novel-voice":"/.cache/novel-voice");}
        s->pcm=pcm;s->progress=progress;s->on_error=err;s->user=user;
        s->worker=std::make_unique<nv::Worker>(s->models,s->model,c.threads,"auto","",false,&s->cancelled);
        auto* p=s.get();s->timer=std::thread([p]{
            while(!p->closing){
                std::unique_lock<std::mutex> l(p->mutex);p->cv.wait_for(l,std::chrono::milliseconds(200));
                bool idle=p->state!=NV_RUNNING&&Clock::now()-p->last_active>=std::chrono::seconds(p->config.idle_seconds);
                l.unlock();
                if(idle){std::lock_guard<std::mutex> c(p->control);if(p->state!=NV_RUNNING){
                    if(p->state==NV_PAUSED&&p->worker->running())p->reload_after_pause=true;
                    p->worker->terminate();
                }}
            }
        });return s.release();
    }catch(const std::exception& e){if(err)err(e.what(),user);return nullptr;}
}
int nv_submit(nv_session* s,const nv_request* r){
    if(!s||!r||!r->text)return 0;
    std::lock_guard<std::mutex> c(s->control);
    if(s->state==NV_RUNNING||s->state==NV_PAUSED)return 0;
    if(s->job.joinable())s->job.join();
    try{
        std::string text=r->text;nv::TextOptions o;o.automatic=r->automatic!=0;
        o.preceding_context=r->preceding_context?r->preceding_context:"";o.following_context=r->following_context?r->following_context:"";
        o.instruction_override=r->instruction?r->instruction:"";
        {std::lock_guard<std::mutex> l(s->mutex);s->error.clear();s->metrics={};s->audio_marks.clear();s->last_active=Clock::now();if(s->playback)s->playback->clear();}
        s->cancelled=false;s->paused=false;s->reload_after_pause=false;s->state=NV_RUNNING;
        s->job=std::thread(nv_run,s,std::move(text),std::move(o),r->speaker?r->speaker:s->speaker);return 1;
    }catch(const std::exception& e){std::lock_guard<std::mutex> l(s->mutex);s->error=e.what();s->state=NV_ERROR;return 0;}
}
void nv_pause(nv_session* s){if(s&&s->state==NV_RUNNING){s->paused=true;s->state=NV_PAUSED;s->worker->pause(true);std::lock_guard<std::mutex> l(s->mutex);s->last_active=Clock::now();if(s->playback)s->playback->pause(true);}}
void nv_resume(nv_session* s){if(s&&s->state==NV_PAUSED){s->paused=false;s->worker->pause(false);s->state=NV_RUNNING;{std::lock_guard<std::mutex> l(s->mutex);if(s->playback)s->playback->pause(false);}s->cv.notify_all();}}
void nv_stop(nv_session* s){if(!s)return;s->cancelled=true;s->paused=false;s->worker->terminate();{std::lock_guard<std::mutex> l(s->mutex);if(s->playback)s->playback->clear();}s->cv.notify_all();}
int nv_wait(nv_session* s){if(!s)return NV_ERROR;std::lock_guard<std::mutex> c(s->control);if(s->job.joinable())s->job.join();return s->state;}
int nv_get_state(nv_session* s){return s?s->state.load():NV_ERROR;}
nv_metrics nv_get_metrics(nv_session* s){if(!s)return {};std::lock_guard<std::mutex> l(s->mutex);return s->metrics;}
const char* nv_last_error(nv_session* s){thread_local std::string e;if(!s)e="invalid session";else{std::lock_guard<std::mutex> l(s->mutex);e=s->error;}return e.c_str();}
void nv_destroy(nv_session* s){if(!s)return;nv_stop(s);nv_wait(s);s->closing=true;s->cv.notify_all();if(s->timer.joinable())s->timer.join();delete s;}
}

#pragma once
#include "nv_engine.h"
#include "worker.hpp"
#include "../text/text.hpp"
#include "../audio/audio.hpp"
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <mutex>
#include <thread>
struct nv_session {
    std::string models,model,speaker,cache_dir,output,error;
    nv_config config{};
    nv_pcm_callback pcm=nullptr;nv_progress_callback progress=nullptr;nv_error_callback on_error=nullptr;void* user=nullptr;
    std::unique_ptr<nv::Worker> worker;
    std::unique_ptr<nv::Playback> playback;
    bool playback_open=false;
    std::mutex mutex,control;std::condition_variable cv;std::thread job,timer;
    std::atomic<int> state{NV_IDLE};std::atomic<bool> cancelled{false},paused{false},closing{false};
    std::atomic<bool> reload_after_pause{false};
    nv_metrics metrics{};
    struct AudioMark {std::uint64_t sample;std::size_t begin,end;};
    std::vector<AudioMark> audio_marks;
    std::chrono::steady_clock::time_point last_active=std::chrono::steady_clock::now();
};
void nv_run(nv_session*,std::string text,nv::TextOptions,std::string speaker);

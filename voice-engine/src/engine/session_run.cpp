// session_run.cpp -- single-session synthesis driver (one segment at a time).
#include "session_internal.hpp"
#include <exception>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include <fstream>
#include <stdexcept>
#include <cstdio>
#include <array>
#include <regex>

namespace {
constexpr std::size_t kRate = 24000;
constexpr std::size_t kMaxCached = 1440000;  // 60 s * 24 kHz: cache only full fits
constexpr const char* kBackendCommit = "74422b";
constexpr const char* kStreamingProfile = "streaming-v2-serial-decode";
using Clock = std::chrono::steady_clock;
double secs(const Clock::time_point& a) { return std::chrono::duration<double>(Clock::now() - a).count(); }
// Path + size + mtime. Parent later folds the full manifest SHA into the key.
std::string fingerprint(const std::string& path) {
    std::error_code ec;
    auto sz = std::filesystem::file_size(path, ec);
    if (ec) return path + ":missing";
    auto mt = std::filesystem::last_write_time(path, ec);
    long long m = ec ? 0 : static_cast<long long>(mt.time_since_epoch().count());
    return std::filesystem::path(path).filename().string() + ":" + std::to_string(static_cast<unsigned long long>(sz)) + ":" + std::to_string(m);
}
}  // namespace

// Segmentation owns options + per-segment instruction/emotion; neighboring
// context (options.preceding/following_context) is supplied by the parent.
void nv_run(nv_session* s, std::string text, nv::TextOptions options, std::string speaker) {
    if (!s) return;
    nv_metrics m{};
    int state = NV_COMPLETED;
    std::string err, spk = speaker.empty() ? s->speaker : speaker;
    const auto t0 = Clock::now();
    std::unique_ptr<nv::WavWriter> wav;
    std::unique_ptr<nv::Cache> cache;
    std::vector<nv::Segment> segs;
    std::vector<float> collect;
    bool collecting = false, first = false, user_stop = false;
    bool gpu_realtime = false; // measured during this request, never assumed from GPU name
    std::size_t total = 0;
    auto cancelled = [&] { return s->cancelled.load(std::memory_order_relaxed); };
    auto report = [&](const std::string& e) { if (err.empty()) err = e; if (s->on_error) s->on_error(e.c_str(), s->user); };

    // Every chunk passes here exactly once: no duplicated PCM.
    auto deliver = [&](const float* p, std::size_t n, int rate) -> bool {
        if (cancelled()) return false;
        {   // block while paused (cancel wakes), stopped atomically by atomic flag
            std::unique_lock<std::mutex> lk(s->mutex);
            s->cv.wait(lk, [&] { return !s->paused.load(std::memory_order_relaxed) || cancelled(); });
        }
        if (cancelled()) return false;
        if (!first) { first = true; m.first_pcm_seconds = secs(t0); }  // first PCM handed out (not proven audible)
        if (wav) wav->append(p, n);
        if (collecting) {  // bounded cache accumulation; overlong segments stay streaming
            if (collect.size() + n <= kMaxCached) collect.insert(collect.end(), p, p + n);
            else collecting = false;
        }
        if (s->playback && !s->playback->push(p, n, cancelled)) return false;
        total += n;
        if (s->pcm && !s->pcm(p, n, rate, s->user)) { user_stop = true; return false; }
        return true;
    };

    try {
        if (!s->output.empty()) wav = std::make_unique<nv::WavWriter>(s->output);
        if (s->config.playback) {
            std::lock_guard<std::mutex> lock(s->mutex);
            if (!s->playback) s->playback = std::make_unique<nv::Playback>(s->config.preroll_seconds, s->config.max_buffer_seconds);
            else s->playback->clear();
            std::string e;
            // open only once per session; reuse the existing audio device.
            if (!s->playback_open && !s->playback->open(e)) throw std::runtime_error("playback: " + e);
            s->playback_open=true;
            s->playback->pause(s->paused);
        }
        if (s->config.cache_enabled && !s->cache_dir.empty())
            cache = std::make_unique<nv::Cache>(s->cache_dir);

        segs = nv::segment_text(text, options);
        std::string mf = s->model;
        if (mf.find(".gguf") == std::string::npos) mf += ".gguf";
        const std::string modelFp = fingerprint(s->models + "/" + mf);
        const std::string tokFp = fingerprint(s->models + "/qwen3-tts-tokenizer-f16.gguf");
        std::ifstream manifest(s->models + "/manifest.json");
        std::string manifest_data((std::istreambuf_iterator<char>(manifest)),{});
        if(manifest_data.size()>65536)throw std::runtime_error("model manifest is too large");
        manifest_data=std::regex_replace(manifest_data,std::regex("\"(backend_dir|generated_at)\"\\s*:\\s*\"[^\"]*\"\\s*,?"),"");
        const std::string manifestFp=nv::Cache::key({manifest_data});
        const int threads = s->config.threads > 0 ? s->config.threads : 2;

        for (const nv::Segment& seg : segs) {
            if (cancelled()) { state = NV_CANCELLED; break; }
            {std::lock_guard<std::mutex> lock(s->mutex);s->audio_marks.push_back({total,seg.byte_begin,seg.byte_end});}
            const std::string instruction = seg.instruction;
            std::string key;
            collect.clear();
            collecting = cache != nullptr;
            const bool hit = cache && (key = nv::Cache::key({s->model, modelFp, tokFp, spk,
                                        seg.text, instruction, std::to_string(static_cast<long long>(s->config.seed)),
                                        manifestFp,kBackendCommit, kStreamingProfile,"temperature=.75 top_k=16 top_p=.9 repetition=1.02 max_tokens=2048"}),
                                       cache->read(key, collect));
            if (hit) {
                collecting=false; // replay must not append the cache buffer to itself.
                ++m.cache_hits;  // cached segments need no worker load
                if (!collect.empty() && !deliver(collect.data(), collect.size(), static_cast<int>(kRate))) {
                    state = NV_CANCELLED; break;
                }
            } else {
                collect.clear();
                collecting = cache != nullptr;
                if (!s->worker) s->worker = std::make_unique<nv::Worker>(s->models, s->model, threads,s->backend,s->backends_dir,s->eco,&s->cancelled);
                m.cold_start |= s->worker->running() ? 0 : 1;
                if (!s->worker->running()) gpu_realtime = false;
                const auto tl = Clock::now();
                bool started = false;
                for (;;) {
                    if (cancelled()) break;
                    started = s->worker->start();  // only reached on a cache miss
                    if (started || !s->reload_after_pause.exchange(false)) break;
                    // A long pause may unload the worker before its ready
                    // handshake. Wait for resume and retry the cold load.
                    std::unique_lock<std::mutex> lock(s->mutex);
                    s->cv.wait(lock, [&] { return !s->paused || cancelled(); });
                }
                m.load_seconds += secs(tl);
                if (!started) {
                    if(cancelled())state=NV_CANCELLED;
                    else {report("worker start failed: " + s->worker->error());state=NV_ERROR;}
                    break;
                }
                if (s->paused) s->worker->pause(true);
                const auto ts = Clock::now();
                std::size_t delivered=0;bool ok=false;
                for(;;){
                    std::size_t regenerated=0,skip=delivered;
                    // Deterministic replay after a long pause regenerates the
                    // unfinished segment; skip PCM already delivered.
                    // Probe GPU throughput before exposing decoder fragments. Fast
                    // GPUs then stream subsequent segments immediately, so a short
                    // paragraph need not wait for the following long one to finish.
                    const bool cpu = s->runtime_configured && s->worker->backend() == "cpu";
                    const bool adaptive = s->config.playback && !cpu;
                    const bool prepared = cpu || (adaptive && !gpu_realtime);
                    auto make_spool = [] {
                        auto* file = std::tmpfile();
                        if (!file) throw std::runtime_error("cannot create audio staging file");
                        return file;
                    };
                    std::unique_ptr<FILE, decltype(&std::fclose)> spool(prepared ? make_spool() : nullptr, &std::fclose);
                    std::size_t staged = 0, observed = 0, first_chunk = 0;
                    Clock::time_point first_chunk_at;
                    bool hold_remainder = false, streaming_armed = false;
                    std::size_t underruns_seen = 0;
                    auto flush = [&] {
                        if (!spool) return true;
                        if (std::fseek(spool.get(), 0, SEEK_SET)) throw std::runtime_error("audio staging rewind failed");
                        std::array<float, 8192> samples{};
                        while (staged && !cancelled()) {
                            const auto count = std::min(staged, samples.size());
                            if (std::fread(samples.data(), sizeof(float), count, spool.get()) != count)
                                throw std::runtime_error("audio staging read failed");
                            if (!deliver(samples.data(), count, int(kRate))) return false;
                            delivered += count; staged -= count;
                        }
                        if (cancelled()) return false;
                        spool.reset();
                        if (adaptive && !s->playback->buffering()) {
                            streaming_armed = true;
                            underruns_seen = s->playback->underruns();
                        }
                        return true;
                    };
                    auto fast_enough = [&] {
                        // Exclude prefill/first-vocoder latency; require a measured
                        // half-second window and a 5% production margin.
                        const double elapsed = secs(first_chunk_at);
                        return observed > first_chunk && elapsed >= .5 &&
                            elapsed * kRate <= double(observed - first_chunk) * .95;
                    };
                    ok = s->worker->synthesize(seg.text, spk, instruction, s->config.seed,
                      [&](const float* p, std::size_t n, int rate) {
                        const auto before = regenerated; regenerated += n;
                        const auto drop = before < skip ? std::min(n, skip - before) : 0;
                        if (n == drop) return !cancelled();
                        const auto count = n - drop;
                        if (!observed) { first_chunk_at = Clock::now(); first_chunk = count; }
                        observed += count;
                        const bool now_cpu = s->runtime_configured && s->worker->backend() == "cpu";
                        if (now_cpu) { gpu_realtime = false; hold_remainder = true; }
                        if (adaptive && streaming_armed && s->playback->underruns() > underruns_seen) {
                            // If load changes after calibration, hold the rest of
                            // this segment, rather than repeatedly chopping words.
                            gpu_realtime = false; hold_remainder = true;
                        }
                        if (!spool && (now_cpu || hold_remainder)) spool.reset(make_spool());
                        if (spool) {
                            if (cancelled()) return false;
                            if (staged + count > 16777216) throw std::runtime_error("segment exceeds audio staging limit");
                            if (std::fwrite(p + drop, sizeof(float), count, spool.get()) != count)
                                throw std::runtime_error("audio staging write failed");
                            staged += count;
                            if (adaptive && !hold_remainder && observed >= 2 * kRate && fast_enough()) {
                                gpu_realtime = true;
                                return flush();
                            }
                            return true;
                        }
                        if (!deliver(p + drop, count, rate)) return false;
                        delivered += count;
                        if (adaptive && !streaming_armed && !s->playback->buffering()) {
                            streaming_armed = true;
                            underruns_seen = s->playback->underruns();
                        }
                        return true;
                      });
                    // A short complete sentence can calibrate the next segment
                    // too; it need not contain the two-second early-release lead.
                    if (ok && adaptive && !hold_remainder && fast_enough()) gpu_realtime = true;
                    if (ok && !cancelled()) ok = flush();
                    const bool reload = s->reload_after_pause.exchange(false);
                    if (ok || !reload || cancelled() || user_stop) break;
                    std::unique_lock<std::mutex> lock(s->mutex);
                    s->cv.wait(lock,[&]{return !s->paused||cancelled();});lock.unlock();
                    if(cancelled())break;
                    m.cold_start=1;
                }
                m.synthesis_seconds += secs(ts);  // includes backpressure and pauses (frank)
                if (cancelled() || user_stop) { state = NV_CANCELLED; break; }
                if (!ok) { report("synthesis failed: " + s->worker->error()); state = NV_ERROR; break; }
                if (collecting && !collect.empty()) cache->store(key, collect);
            }
            if (s->progress) s->progress(seg.byte_end, text.size(), s->user);
        }

        if (state == NV_COMPLETED) {
            if (s->playback) {  // drain queued audio, then seal the WAV
                s->playback->finish();
                if (!s->playback->drain(cancelled)) state = NV_CANCELLED;
            }
            if (state == NV_COMPLETED && wav) wav->complete();
        } else if (s->playback) {
            s->playback->clear();  // error/cancel keeps the .partial WAV as-is
        }
    } catch (const std::exception& e) {
        report(e.what()); state = NV_ERROR;
    } catch (...) {
        report("unknown error"); state = NV_ERROR;
    }

    m.audio_seconds = static_cast<double>(total) / static_cast<double>(kRate);
    m.wall_seconds = secs(t0);
    m.cancelled = state == NV_CANCELLED ? 1 : 0;
    if (s->playback) m.underrun_samples = s->playback->underruns();
    {
        std::lock_guard<std::mutex> lk(s->mutex);
        s->metrics = m;                       // all metrics access is guarded
        if (!err.empty()) s->error = err;
        s->last_active = Clock::now();
    }
    s->state.store(state, std::memory_order_relaxed);  // state only set once, after drain
    s->cv.notify_all();
}

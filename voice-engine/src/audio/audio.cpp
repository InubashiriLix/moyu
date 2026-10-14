// audio.cpp -- low-level float32 mono 24 kHz playback + WAV writer.
//
// This is the ONLY translation unit that defines MINIAUDIO_IMPLEMENTATION.
#include "audio.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#define MINIAUDIO_IMPLEMENTATION
#include "../../vendor/miniaudio.h"

namespace nv {
namespace {
constexpr std::uint32_t kSampleRate = 24000;
constexpr std::size_t kPrerollDefaultFrames =
    static_cast<std::size_t>(1.0 * kSampleRate);       // 1s preroll
constexpr std::size_t kMaxDefaultFrames =
    static_cast<std::size_t>(15.0 * kSampleRate);      // 15s bounded ring
constexpr auto kWaitSlice = std::chrono::milliseconds(20);

std::size_t secondsToFrames(double s, double fallback) {
    if (!(s > 0.0) || !std::isfinite(s)) s = fallback;
    return static_cast<std::size_t>(s * kSampleRate);
}
}  // namespace

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
struct Playback::Impl {
    std::size_t cap_frames;      // bounded ring capacity (samples)
    std::size_t preroll_frames;  // frames required before playback starts

    std::vector<float> ring;     // 24 kHz mono float32 samples
    std::size_t head = 0;
    std::size_t tail = 0;
    std::size_t count = 0;

    mutable std::mutex mtx;
    std::condition_variable cv;
    bool paused = false;
    bool primed = false;         // preroll satisfied (or short final chunk)
    bool eof = false;            // finish() called
    std::size_t underruns = 0;   // counted only after primed, before eof/pause
    std::uint64_t consumed_frames = 0;
    std::atomic<bool> stopping{false};

    ma_device device{};
    bool device_inited = false;

    Impl(double preroll_seconds, double max_seconds)
        : cap_frames(secondsToFrames(max_seconds, 15.0)),
          preroll_frames(secondsToFrames(preroll_seconds, 1.0)) {
        if (cap_frames < kPrerollDefaultFrames) cap_frames = kPrerollDefaultFrames;
        if (preroll_frames > cap_frames) preroll_frames = cap_frames;
        ring.assign(cap_frames, 0.0f);
    }

    ~Impl() {
        // Uninit miniaudio outside of the lock. The callback observes `stopping`
        // and returns immediately.
        stopping.store(true);
        if (device_inited) {
            ma_device_uninit(&device);  // stops + joins the audio callback
            device_inited = false;
        }
    }

    static void dataCallback(ma_device* dev, void* out, const void*, ma_uint32 frames) {
        auto* self = static_cast<Impl*>(dev->pUserData);
        if (!self) return;
        self->render(static_cast<float*>(out), frames);
    }

    void render(float* out, std::size_t frames) {
        if (stopping.load(std::memory_order_relaxed)) {
            std::memset(out, 0, frames * sizeof(float));
            return;
        }
        std::unique_lock<std::mutex> lk(mtx);
        // Before preroll, after pause: emit silence, never consume, never count.
        if (paused || !primed) {
            std::memset(out, 0, frames * sizeof(float));
            return;
        }
        std::size_t got = std::min<std::size_t>(frames, count);
        for (std::size_t i = 0; i < got; ++i) out[i] = ring[(head + i) % cap_frames];
        head = (head + got) % cap_frames;
        count -= got;
        consumed_frames += got;
        if (got < frames) {
            std::memset(out + got, 0, (frames - got) * sizeof(float));
            if (!eof) underruns += (frames - got);  // real underrun only
        }
        if (got) cv.notify_all();  // freed space for producers / drain()
    }

    bool open(std::string& error) {
        ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
        cfg.playback.format = ma_format_f32;
        cfg.playback.channels = 1;
        cfg.sampleRate = kSampleRate;
        cfg.performanceProfile = ma_performance_profile_low_latency;
        cfg.dataCallback = &Impl::dataCallback;
        cfg.pUserData = this;
        ma_result r = ma_device_init(nullptr, &cfg, &device);
        if (r != MA_SUCCESS) {
            error = std::string("ma_device_init failed: ") + ma_result_description(r);
            return false;
        }
        device_inited = true;
        r = ma_device_start(&device);
        if (r != MA_SUCCESS) {
            ma_device_uninit(&device);
            device_inited = false;
            error = std::string("ma_device_start failed: ") + ma_result_description(r);
            return false;
        }
        return true;
    }

    bool push(const float* data, std::size_t n, const std::function<bool()>& cancelled) {
        if (!data || n == 0) return true;
        std::size_t remaining = n;
        const float* p = data;
        std::unique_lock<std::mutex> lk(mtx);
        while (remaining > 0) {
            if (cancelled && cancelled()) return false;
            std::size_t space = cap_frames - count;
            if (space == 0) {
                cv.wait_for(lk, kWaitSlice);  // cancellable, every 20ms
                continue;
            }
            std::size_t chunk = std::min(space, remaining);  // split oversized
            for (std::size_t i = 0; i < chunk; ++i) {
                ring[(tail + i) % cap_frames] = p[i];
            }
            tail = (tail + chunk) % cap_frames;
            count += chunk;
            p += chunk;
            remaining -= chunk;
            if (!primed && count >= preroll_frames) {
                primed = true;
                cv.notify_all();
            }
            lk.unlock();  // let the audio callback run between chunks
            lk.lock();
        }
        return true;
    }

    void pause(bool p) {
        std::unique_lock<std::mutex> lk(mtx);
        paused = p;
        cv.notify_all();
    }

    void finish() {
        std::unique_lock<std::mutex> lk(mtx);
        eof = true;
        if (!primed && count > 0) primed = true;  // short ending chunk still plays
        cv.notify_all();
    }

    bool drain(const std::function<bool()>& cancelled) {
        std::unique_lock<std::mutex> lk(mtx);
        while (!(eof && count == 0)) {
            if (cancelled && cancelled()) return false;
            cv.wait_for(lk, kWaitSlice);
        }
        return true;
    }

    void clear() {
        std::unique_lock<std::mutex> lk(mtx);
        head = tail = count = 0;
        consumed_frames = underruns = 0;
        primed = false;
        eof = false;
        cv.notify_all();
    }

    std::size_t underrunCount() const {
        std::unique_lock<std::mutex> lk(mtx);
        return underruns;
    }
};

Playback::Playback(double preroll_seconds, double max_seconds)
    : impl_(new Impl(preroll_seconds, max_seconds)) {}
Playback::~Playback() = default;

bool Playback::open(std::string& error) { return impl_->open(error); }
bool Playback::push(const float* data, std::size_t n,
                    const std::function<bool()>& cancelled) {
    return impl_->push(data, n, cancelled);
}
void Playback::pause(bool p) { impl_->pause(p); }
void Playback::finish() { impl_->finish(); }
bool Playback::drain(const std::function<bool()>& cancelled) {
    return impl_->drain(cancelled);
}
void Playback::clear() { impl_->clear(); }
std::size_t Playback::underruns() const { return impl_->underrunCount(); }
std::uint64_t Playback::consumed() const {
    std::lock_guard<std::mutex> lock(impl_->mtx);
    return impl_->consumed_frames;
}
bool Playback::buffering() const {
    std::lock_guard<std::mutex> lock(impl_->mtx);
    return !impl_->paused && (!impl_->primed || (!impl_->eof && impl_->count == 0));
}

// ---------------------------------------------------------------------------
// WavWriter -- PCM16 mono 24 kHz, atomic replace of <path>.partial -> <path>
// ---------------------------------------------------------------------------
struct WavWriter::Impl {
    std::string final_path;
    std::string partial_path;
    std::FILE* fp = nullptr;
    std::uint64_t data_bytes = 0;
    bool finalized = false;
    bool failed = false;
    static constexpr std::uint64_t kMaxDataBytes = 0xFFFFFFFFull - 44ull;  // < 4 GiB

    static void put32(std::uint8_t* d, std::uint32_t v) {
        d[0] = v & 0xFF; d[1] = (v >> 8) & 0xFF; d[2] = (v >> 16) & 0xFF; d[3] = (v >> 24) & 0xFF;
    }
    static void put16(std::uint8_t* d, std::uint16_t v) {
        d[0] = v & 0xFF; d[1] = (v >> 8) & 0xFF;
    }

    static void writeHeader(std::FILE* f, std::uint32_t data_bytes) {
        std::uint8_t h[44];
        std::memcpy(h, "RIFF", 4);
        put32(h + 4, 36u + data_bytes);
        std::memcpy(h + 8, "WAVE", 4);
        std::memcpy(h + 12, "fmt ", 4);
        put32(h + 16, 16);                    // fmt chunk size
        put16(h + 20, 1);                     // PCM
        put16(h + 22, 1);                     // mono
        put32(h + 24, kSampleRate);           // sample rate
        put32(h + 28, kSampleRate * 2);       // byte rate = rate * ch * bytes/sample
        put16(h + 32, 2);                     // block align
        put16(h + 34, 16);                    // bits per sample
        std::memcpy(h + 36, "data", 4);
        put32(h + 40, data_bytes);
        std::fwrite(h, 1, 44, f);
    }

    explicit Impl(const std::string& path) : final_path(path), partial_path(path + ".partial") {
        fp = std::fopen(partial_path.c_str(), "wb");
        if (!fp) {
            failed = true;
            throw std::runtime_error("WavWriter: cannot open " + partial_path);
        }
        writeHeader(fp, 0);
    }

    ~Impl() {
        // Non-throwing: on incomplete writer the .partial file is retained and
        // no final path is produced.
        if (fp) {
            std::fclose(fp);
            fp = nullptr;
        }
    }

    void append(const float* data, std::size_t n) {
        if (failed || finalized) throw std::runtime_error("WavWriter: append after finalize");
        if (!data || n == 0) return;
        for (std::size_t i = 0; i < n; ++i) {
            if (!std::isfinite(data[i]))  // reject NaN / Inf
                throw std::invalid_argument("WavWriter: non-finite sample");
        }
        if (data_bytes + n * 2ull > kMaxDataBytes)
            throw std::length_error("WavWriter: exceeds 4 GiB WAV limit");
        std::vector<std::int16_t> pcm(n);
        for (std::size_t i = 0; i < n; ++i) {
            float v = data[i];
            if (v > 1.0f) v = 1.0f;
            else if (v < -1.0f) v = -1.0f;
            pcm[i] = static_cast<std::int16_t>(std::lrintf(v * 32767.0f));
        }
        if (std::fwrite(pcm.data(), sizeof(std::int16_t), n, fp) != n) {
            failed = true;
            throw std::runtime_error("WavWriter: short write");
        }
        data_bytes += n * 2ull;
    }

    void complete() {
        if (finalized) return;
        if (failed || !fp) throw std::runtime_error("WavWriter: cannot complete");
        if (std::fflush(fp) != 0 || std::fseek(fp, 0, SEEK_SET) != 0) {
            failed = true;
            throw std::runtime_error("WavWriter: rewind failed");
        }
        writeHeader(fp, static_cast<std::uint32_t>(data_bytes));  // fix RIFF sizes
        if (std::fclose(fp) != 0) {
            fp = nullptr;
            failed = true;
            throw std::runtime_error("WavWriter: close failed");
        }
        fp = nullptr;
        if (std::rename(partial_path.c_str(), final_path.c_str()) != 0) {
            failed = true;
            throw std::runtime_error("WavWriter: rename to final path failed");
        }
        finalized = true;
    }
};

WavWriter::WavWriter(const std::string& path) : impl_(new Impl(path)) {}
WavWriter::~WavWriter() = default;
void WavWriter::append(const float* data, std::size_t n) { impl_->append(data, n); }
void WavWriter::complete() { impl_->complete(); }

}  // namespace nv

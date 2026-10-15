// Exercise the actual session scheduler and playback clock without a device.
// The worker deliberately generates slower than real time (3s for 2s audio).
#include "../src/engine/session_internal.hpp"
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <unistd.h>

using namespace std::chrono_literals;
using Clock = std::chrono::steady_clock;
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
struct Samples { std::atomic<std::size_t> count{0}; };
int pcm(const float* p, std::size_t n, int rate, void* user) {
    if (rate != 24000) return 0;
    for (std::size_t i = 0; i < n; ++i) if (p[i] != .125f) return 0;
    static_cast<Samples*>(user)->count += n;
    return 1;
}
using Session = std::unique_ptr<nv_session, decltype(&nv_destroy)>;

int main() {
    try {
        auto dir = std::filesystem::temp_directory_path() / ("nv-continuity-" + std::to_string(getpid()));
        auto worker = std::filesystem::canonical("/proc/self/exe").parent_path() / "nv-worker";
        for (const auto* backend : {"cpu", "cuda", "vulkan"}) {
            std::filesystem::create_directories(dir / backend);
            std::filesystem::create_symlink(worker, dir / backend / "nv-worker");
        }
        auto root = dir.string();
        auto c = nv_default_config(); c.cache_enabled = 0; c.idle_seconds = 1;
        nv_request r{}; r.text = "苏羽哭了, 哭的很小声"; r.automatic = 1;
        setenv("NV_FAKE_CHUNK_MS", "150", 1);
        for (int backend : {2, 3, 1}) {
            Samples samples;
            Session s(nv_create(&c, pcm, nullptr, nullptr, &samples), nv_destroy); CHECK(s);
            nv_runtime_options runtime{sizeof(runtime), 1, backend, 0, root.c_str()};
            CHECK(nv_set_runtime_options(s.get(), &runtime));
            // The CUDA case also exercises a segment larger than the ring:
            // the producer must remain cancellable under playback backpressure.
            s->playback = std::make_unique<nv::Playback>(1, backend == 2 ? 1 : 30);
            s->playback_open = true; // drive render() ourselves, never open a device
            CHECK(nv_submit(s.get(), &r));
            std::this_thread::sleep_for(1600ms);
            CHECK(samples.count == 0); // incomplete sentence is still being prepared
            std::vector<float> out(240);
            const auto limit = Clock::now() + 6s;
            bool began = false;
            while (nv_get_state(s.get()) == NV_RUNNING && Clock::now() < limit) {
                s->playback->render(out.data(), out.size());
                if (s->playback->consumed()) began = true;
                if (began) CHECK(!s->playback->buffering());
                std::this_thread::sleep_for(1ms); // accelerated virtual audio clock
            }
            CHECK(nv_get_state(s.get()) == NV_COMPLETED);
            CHECK(nv_wait(s.get()) == NV_COMPLETED);
            CHECK(samples.count == 48000);
            CHECK(s->playback->consumed() == 48000);
            CHECK(nv_get_metrics(s.get()).underrun_samples == 0);

            samples.count = 0;
            CHECK(nv_submit(s.get(), &r));
            std::this_thread::sleep_for(100ms);
            const auto stop = Clock::now(); nv_stop(s.get());
            CHECK(nv_wait(s.get()) == NV_CANCELLED);
            CHECK(Clock::now() - stop < 1s);
            CHECK(samples.count == 0); // stopping preparation cannot leak stale PCM
        }
        {
            Samples samples;
            Session s(nv_create(&c, pcm, nullptr, nullptr, &samples), nv_destroy); CHECK(s);
            nv_runtime_options runtime{sizeof(runtime), 1, 2, 0, root.c_str()};
            CHECK(nv_set_runtime_options(s.get(), &runtime));
            s->playback = std::make_unique<nv::Playback>(1, 30); s->playback_open = true;
            CHECK(nv_submit(s.get(), &r));
            std::this_thread::sleep_for(100ms); nv_pause(s.get());
            std::this_thread::sleep_for(1400ms); // unload the unfinished worker
            CHECK(samples.count == 0);
            CHECK(nv_get_state(s.get()) == NV_PAUSED);
            nv_resume(s.get());
            std::vector<float> out(240);
            const auto limit = Clock::now() + 6s;
            while (nv_get_state(s.get()) == NV_RUNNING && Clock::now() < limit) {
                s->playback->render(out.data(), out.size());
                std::this_thread::sleep_for(1ms);
            }
            CHECK(nv_get_state(s.get()) == NV_COMPLETED);
            CHECK(nv_wait(s.get()) == NV_COMPLETED);
            CHECK(samples.count == 48000); // no partial replay / duplicate samples
            CHECK(s->playback->consumed() == 48000);
            CHECK(nv_get_metrics(s.get()).underrun_samples == 0);
        }
        unsetenv("NV_FAKE_CHUNK_MS");
        std::filesystem::remove_all(dir);
        std::cout << "slow CPU/CUDA/Vulkan playback continuity checks passed\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}

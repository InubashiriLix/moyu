// nv-worker: worker process for the Qwen3 streaming TTS engine.
// argv[1]=modelsDir argv[2]=model stem argv[3]=threads. IPC on dedicated fd 3.
#include <offgrid_tts/Qwen3StreamingTts.h>
#include <ggml-cuda.h>
#include <cuda_runtime_api.h>

#include <csignal>
#include <cstdlib>
#include <exception>
#include <string>
#include <sys/prctl.h>
#include <poll.h>
#include <thread>

#include "ipc.hpp"

namespace {
constexpr int kFd = 3;

int fail(const std::string& msg) {
    nv::ipc::text(kFd, nv::ipc::error, msg);
    return 1;
}

bool send_pcm(const TtsStreamChunk& chunk) {
    const auto* bytes = reinterpret_cast<const char*>(chunk.samples.data());
    const uint32_t n = uint32_t(chunk.samples.size() * sizeof(float));
    return nv::ipc::message(kFd, nv::ipc::pcm, bytes, n);
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) return 2;
    dup2(STDERR_FILENO, STDOUT_FILENO);
    // PDEATHSIG tracks the spawning thread on Linux, which may finish before
    // the reusable session. Watch the private socket instead of that thread.
    std::thread([]{for(;;){pollfd p{kFd,POLLRDHUP,0};if(poll(&p,1,200)>0&&(p.revents&(POLLHUP|POLLRDHUP|POLLERR)))_exit(0);}}).detach();
    setenv("OMP_NUM_THREADS", argv[3], 1);
    // Production failures must not invoke system debuggers/Python. Explicit
    // GGML_NO_BACKTRACE=0 enables debugging by removing GGML's presence flag.
    const char* trace = std::getenv("GGML_NO_BACKTRACE");
    if (trace && std::string(trace) == "0") unsetenv("GGML_NO_BACKTRACE");
    else setenv("GGML_NO_BACKTRACE", "1", 0);

    const std::string models_dir = argv[1];
    std::string identifier = argv[2];
    if (identifier.find(".gguf") == std::string::npos) identifier += ".gguf";

    try {
        // Sleeping synchronization avoids burning a CPU core while CUDA runs.
        if(!std::getenv("NV_SPIN_WAIT"))cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync);
        if (ggml_backend_cuda_get_device_count() <= 0) return fail("no CUDA device available");

        if (!ggml_backend_cuda_device_has_kernel(0)) {
            cudaDeviceProp gpu{};
            const cudaError_t rc = cudaGetDeviceProperties(&gpu, 0);
            if (rc != cudaSuccess) return fail(std::string("CUDA 设备检查失败：") + cudaGetErrorString(rc));
            return fail(std::string("当前朗读包不支持 GPU ") + gpu.name + " (sm_" +
                std::to_string(gpu.major) + std::to_string(gpu.minor) +
                ")；包内架构：" NV_SUPPORTED_ARCHS "。请使用匹配 GPU 的引擎更新包。");
        }

        Qwen3StreamingTts tts;
        if (!tts.load(models_dir, identifier)) return fail("load failed: " + tts.last_error());

        const TtsModelCapabilities& caps = tts.capabilities();
        if (!caps.loaded) return fail("model not loaded");
        if (!caps.supports_instruction || !caps.supports_named_speakers)
            return fail("model lacks instruction/named-speaker support");

        if (!nv::ipc::message(kFd, nv::ipc::ready)) return 0;

        for (;;) {
            nv::ipc::Header header;
            if (!nv::ipc::read(kFd, &header, sizeof header)) return 0;  // EOF: clean exit
            if (header.type != nv::ipc::request || header.bytes) return fail("unexpected message type");

            std::string text, speaker, instruction;
            if (!nv::ipc::string_read(kFd, text) || !nv::ipc::string_read(kFd, speaker) ||
                !nv::ipc::string_read(kFd, instruction))
                return fail("malformed request strings");

            int64_t seed = 0;
            if (!nv::ipc::read(kFd, &seed, sizeof seed)) return 0;

            TtsStreamOptions options;
            options.model_identifier = identifier;
            options.speaker = speaker;
            options.instruction = instruction;
            options.language_id = 2055; // Chinese; 2050 is English in this codec.
            options.seed = seed;
            options.play_streaming = false;
            options.print_progress = false;
            options.print_timing = false;
            if(std::getenv("NV_PROFILE")){options.print_timing=true;options.dump_first_frame_profile=true;}
            options.max_audio_tokens = 2048;
            options.async_streaming_decode = false;

            bool disconnected = false;
            const bool ok = tts.synthesize_streaming(
                text, options, [&](const TtsStreamChunk& chunk) {
                    if (disconnected) return false;
                    if (!send_pcm(chunk)) {
                        disconnected = true;
                        return false;
                    }
                    return true;
                });
            if (disconnected) return 0;
            if (!ok) return fail(tts.last_error().empty() ? "synthesis failed" : tts.last_error());
            if (!nv::ipc::message(kFd, nv::ipc::done)) return 0;
        }
    } catch (const std::exception& e) {
        return fail(e.what());
    } catch (...) {
        return fail("unknown error");
    }
}

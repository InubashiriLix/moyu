// nv-worker: worker process for the Qwen3 streaming TTS engine.
// argv[1]=modelsDir argv[2]=model stem argv[3]=threads argv[4]=selected backend.
// IPC on dedicated fd 3. `nv-worker --probe` prints backend/device JSON to
// stdout (exit 0 available / nonzero unavailable) without loading any model.
#include <offgrid_tts/Qwen3StreamingTts.h>
#include <ggml-backend.h>
#ifdef NV_USE_CUDA
#include <ggml-cuda.h>
#include <cuda_runtime_api.h>
#endif

#include <csignal>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>
#include <sys/prctl.h>
#include <poll.h>
#include <thread>

#include "ipc.hpp"

#ifndef NV_BACKEND
#define NV_BACKEND "cpu"
#endif
#ifndef NV_SUPPORTED_ARCHS
#define NV_SUPPORTED_ARCHS "unknown"
#endif

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

std::string json_escape(const std::string& s) {
    std::string o;
    for (char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char b[8];
                    snprintf(b, sizeof b, "\\u%04x", (unsigned char)c);
                    o += b;
                } else {
                    o += c;
                }
        }
    }
    return o;
}
// Resolve the exact registry device for the compiled backend without loading
// any model. CPU uses the CPU device type; GPU backends must match their
// registry name, so a CUDA build never silently picks a Vulkan GPU (or an
// unrelated GPU backend) and vice versa.
bool registry_device(const std::string& backend, ggml_backend_dev_t& dev) {
    if (backend == "cpu") {
        dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
        return dev != nullptr;
    }
    const size_t n = ggml_backend_dev_count();
    for (size_t i = 0; i < n; ++i) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(d);
        const char* name = reg ? ggml_backend_reg_name(reg) : nullptr;
        if (!name) continue;
        std::string lower(name);
        for (char& c : lower) c = char(std::tolower((unsigned char)c));
        if (lower.find(backend) != std::string::npos) {
            const char* description_text=ggml_backend_dev_description(d);
            std::string description=description_text?description_text:"";
            for(char& c:description)c=char(std::tolower((unsigned char)c));
            if(backend=="vulkan"&&(description.find("llvmpipe")!=std::string::npos||description.find("lavapipe")!=std::string::npos||description.find("swiftshader")!=std::string::npos))continue;
            dev = d; return true;
        }
    }
    dev = nullptr;
    return false;
}

std::string device_string(const std::string& backend) {
    ggml_backend_dev_t dev = nullptr;
    if (registry_device(backend, dev) && dev) {
        const char* desc = ggml_backend_dev_description(dev);
        if (desc && *desc) return desc;
        const char* name = ggml_backend_dev_name(dev);
        if (name && *name) return name;
    }
    return backend;
}

#ifdef NV_USE_CUDA
// CUDA-only kernel compatibility check: a package ships sm_* images only for
// the architectures it was compiled with, so reject a GPU with no matching
// cubin before any model weight is loaded. cudaSetDeviceFlags keeps the worker
// sleeping (not spinning) while kernels run.
bool cuda_usable(std::string* why) {
    if (!std::getenv("NV_SPIN_WAIT")) cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync);
    if (ggml_backend_cuda_get_device_count() <= 0) {
        if (why) *why = "no CUDA device available";
        return false;
    }
    if (!ggml_backend_cuda_device_has_kernel(0)) {
        cudaDeviceProp gpu{};
        const cudaError_t rc = cudaGetDeviceProperties(&gpu, 0);
        if (rc != cudaSuccess) {
            if (why) *why = std::string("CUDA 设备检查失败：") + cudaGetErrorString(rc);
            return false;
        }
        if (why) *why = std::string("当前朗读包不支持 GPU ") + gpu.name + " (sm_" +
            std::to_string(gpu.major) + std::to_string(gpu.minor) +
            ")；包内架构：" NV_SUPPORTED_ARCHS "。请使用匹配 GPU 的引擎更新包。";
        return false;
    }
    return true;
}
#endif

int probe() {
    const std::string backend = NV_BACKEND;
    ggml_backend_dev_t dev = nullptr;
    bool available = registry_device(backend, dev);
    std::string device = available ? device_string(backend) : std::string();
#ifdef NV_USE_CUDA
    if (backend == "cuda") {
        std::string why;
        if (!cuda_usable(&why)) {
            available = false;
            if (!why.empty()) device = why;
        }
    }
#endif
    printf("{\"backend\":\"%s\",\"device\":\"%s\",\"available\":%s}\n",
           json_escape(backend).c_str(), json_escape(device).c_str(),
           available ? "true" : "false");
    fflush(stdout);
    return available ? 0 : 1;
}
}  // namespace
int main(int argc, char** argv) {
#ifdef NV_USE_CUDA
    if (!std::getenv("NV_SPIN_WAIT")) cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync);
#endif
    ggml_backend_load_all();
    if (argc >= 2 && std::string(argv[1]) == "--probe") return probe();
    if (argc < 4) return 2;

    const std::string models_dir = argv[1];
    std::string identifier = argv[2];
    if (identifier.find(".gguf") == std::string::npos) identifier += ".gguf";

    // Pin the engine to the backend this binary was compiled for (argv[4] is
    // informational) so model init never probes a mismatched GPU, and hand the
    // requested thread count to the engine CPU backends.
    const std::string backend = NV_BACKEND;
    setenv("NV_BACKEND", backend.c_str(), 1);
    setenv("NV_THREADS", argv[3], 1);
    setenv("OMP_NUM_THREADS", argv[3], 1);

    dup2(STDERR_FILENO, STDOUT_FILENO);
    // PDEATHSIG tracks the spawning thread on Linux, which may finish before
    // the reusable session. Watch the private socket instead of that thread.
    std::thread([]{for(;;){pollfd p{kFd,POLLRDHUP,0};if(poll(&p,1,200)>0&&(p.revents&(POLLHUP|POLLRDHUP|POLLERR)))_exit(0);}}).detach();
    // Production failures must not invoke system debuggers/Python. Explicit
    // GGML_NO_BACKTRACE=0 enables debugging by removing GGML's presence flag.
    const char* trace = std::getenv("GGML_NO_BACKTRACE");
    if (trace && std::string(trace) == "0") unsetenv("GGML_NO_BACKTRACE");
    else setenv("GGML_NO_BACKTRACE", "1", 0);

    try {
        ggml_backend_dev_t selected=nullptr;
        if(!registry_device(backend,selected))return fail("没有兼容的 "+backend+" 硬件设备");
        setenv("NV_DEVICE_NAME",ggml_backend_dev_name(selected),1);
        const std::string device = device_string(backend);
#ifdef NV_USE_CUDA
        if (backend == "cuda") { std::string why; if (!cuda_usable(&why)) return fail(why); }
#endif
        Qwen3StreamingTts tts;
        if (!tts.load(models_dir, identifier)) return fail("load failed: " + tts.last_error());

        const TtsModelCapabilities& caps = tts.capabilities();
        if (!caps.loaded) return fail("model not loaded");
        if (!caps.supports_instruction || !caps.supports_named_speakers)
            return fail("model lacks instruction/named-speaker support");

        // The ready packet carries the actual registry device description so the
        // session can report the real accelerator instead of the requested one.
        if (!nv::ipc::text(kFd, nv::ipc::ready, device)) return 0;

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

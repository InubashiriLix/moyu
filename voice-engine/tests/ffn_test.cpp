#include "transformer/transformer_internal.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#ifdef GGML_USE_CUDA
#include "ggml-cuda.h"
#endif
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

static void require(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

// Compare native projections with F32 multiplication of the exact stored
// weights. This catches both accidental dequantization nodes and precision loss.
static void check(ggml_backend_t backend, ggml_type type, int width, int batch) {
    constexpr int rows = 256;
    auto* ctx = ggml_init({16 * 1024 * 1024, nullptr, true});
    require(ctx != nullptr, "context");
    auto* w = ggml_new_tensor_2d(ctx, type, width, rows);
    auto* reference_w = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, width, rows);
    auto* x = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, width, batch);
    auto* out = qwen3_tts::transformer_internal::project_ffn_down(ctx, w, x);
    auto* ref = ggml_mul_mat(ctx, reference_w, x);
    ggml_mul_mat_set_prec(ref, GGML_PREC_F32);
    if (ggml_is_quantized(type)) require(out->src[0] == w, "quantized weight was cast");
#ifdef GGML_USE_CUDA
    if (ggml_is_quantized(type) || batch == 1) require(out->src[0] == w, "CUDA weight was cast");
    else require(out->src[0]->type == GGML_TYPE_F32, "prefill precision path changed");
#else
    if (type == GGML_TYPE_F16) require(out->src[0]->type == GGML_TYPE_F32, "CPU F16 path changed");
#endif
    auto* graph = ggml_new_graph(ctx);
    ggml_build_forward_expand(graph, out);
    ggml_build_forward_expand(graph, ref);
    auto buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
    require(buffer != nullptr, "buffer");
    std::vector<float> original(width * rows), decoded(original.size()), input(width * batch);
    for (size_t i = 0; i < original.size(); ++i)
        original[i] = std::sin(float(i) * .123f) * .05f + std::cos(float(i) * .321f) * .03f;
    for (size_t i = 0; i < input.size(); ++i)
        input[i] = std::sin(float(i) * .073f) + std::cos(float(i) * .097f);
    // Activations outside F16's finite range must still use F32. A native
    // weight optimization must not silently downcast them along with weights.
    if (type == GGML_TYPE_F16)
        for (size_t i = 0; i < input.size(); i += 3) input[i] *= 100000.f;
    std::vector<unsigned char> stored(ggml_nbytes(w));
    ggml_quantize_chunk(type, original.data(), stored.data(), 0, rows, width, nullptr);
    ggml_get_type_traits(type)->to_float(stored.data(), decoded.data(), decoded.size());
    ggml_backend_tensor_set(w, stored.data(), 0, stored.size());
    ggml_backend_tensor_set(reference_w, decoded.data(), 0, decoded.size() * sizeof(float));
    ggml_backend_tensor_set(x, input.data(), 0, input.size() * sizeof(float));
    require(ggml_backend_graph_compute(backend, graph) == GGML_STATUS_SUCCESS, "compute");
    std::vector<float> actual(rows * batch), expected(actual.size());
    ggml_backend_tensor_get(out, actual.data(), 0, actual.size() * sizeof(float));
    ggml_backend_tensor_get(ref, expected.data(), 0, expected.size() * sizeof(float));
    double diff = 0, scale = 0;
    for (size_t i = 0; i < actual.size(); ++i) {
        require(std::isfinite(actual[i]), "non-finite projection");
        diff += double(actual[i] - expected[i]) * (actual[i] - expected[i]);
        scale += double(expected[i]) * expected[i];
    }
    const double relative = std::sqrt(diff / (scale + 1e-30));
    std::printf("%s %s width=%d batch=%d relative-L2=%.8f\n", ggml_backend_name(backend),
        ggml_type_name(type), width, batch, relative);
#ifdef GGML_USE_CUDA
    const double tolerance = type == GGML_TYPE_F16 ? .00002 : .02;
#else
    const double tolerance = type == GGML_TYPE_F16 ? .001 : .02;
#endif
    require(relative < tolerance, "projection precision regression");
    ggml_backend_buffer_free(buffer);
    ggml_free(ctx);
}

int main() {
    try {
        auto cpu = ggml_backend_cpu_init();
        ggml_backend_cpu_set_n_threads(cpu, 2);
        // In a CUDA build the helper is native on both backends. F16 CPU
        // activation quantization is expected to differ slightly from CUDA.
#ifndef GGML_USE_CUDA
        for (auto type : {GGML_TYPE_F16, GGML_TYPE_Q5_K})
            for (int batch : {1, 8}) check(cpu, type, 2048, batch);
#else
        for (int batch : {1, 8}) check(cpu, GGML_TYPE_Q5_K, 2048, batch);
#endif
        ggml_backend_free(cpu);
#ifdef GGML_USE_CUDA
        auto cuda = ggml_backend_cuda_init(0);
        require(cuda != nullptr, "CUDA device required for this test");
        for (auto type : {GGML_TYPE_F16, GGML_TYPE_Q5_K})
            for (int width : {2048, 6144})
                for (int batch : {1, 8}) check(cuda, type, width, batch);
        ggml_backend_free(cuda);
#endif
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "%s\n", e.what());
        return 1;
    }
}

# 固定依赖

- Qwen3 C++ streaming backend: https://github.com/offgridai/qwen3-tts-cpp-streaming
  commit `74422bab4998ad69e0a67ba105654dadbeec9b3a`，Apache-2.0；包含 GGML 源码。
  构建时应用 `patches/linux-playback-metrics.patch`，修复上游 Windows 专用指标访问器在 Linux 下无法编译的问题。语音生成逻辑不变。
- miniaudio: https://github.com/mackron/miniaudio ，版本 `0.11.23`，MIT-0 / public domain。
- Qwen 模型仅在模型准备时下载；具体修订和校验值保存在模型目录 manifest。
- CUDA 编译工具链是开发依赖，不随引擎库打包；CUDA 驱动是运行依赖。

依赖许可证保留在下载目录内。运行时不调用云端模型或 DeepSeek。

- `patches/cuda-device-compatibility.patch` 在 GGML 中加入部署检查探针，使用与计算内核相同的编译目标，在模型加载前检验 CUDA 内核可用性。

- `patches/backend-selection.patch` 固定 CPU/CUDA/Vulkan 设备选择，限制主后端与 CPU 回退线程数，移除宿主 `-march=native` 编译选项，并将上游 CUDA 专用调用限于 CUDA 构建。

- `patches/native-ffn-matmul.patch` 让量化 FFN 权重直接参与矩阵乘法，避免 CUDA 不支持的 Q5_K→F32 整矩阵转换逐 token 回退 CPU。CUDA 的 F16 FFN 同样直接读取半精度权重，并显式使用 F32 累加；CPU/Vulkan 的浮点模型路径保持原样。

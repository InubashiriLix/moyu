# Novel Voice · 小说语音引擎

Linux x86_64 本地中文朗读引擎，使用 C++17、GGML 和 Qwen3-TTS 1.7B CustomVoice。支持 CPU、Vulkan 和可选 CUDA 工作进程，运行时不需要 Python、PyTorch 或云端服务。

默认 F16 模型、男声 Uncle_Fu，可选女声 Serena；Q5_K 为实验性省空间选项。轻量规则根据明确语气、对话及标点生成独立风格指令，不能可靠理解角色身份、讽刺或隐含情绪。

## 构建

需要 CMake 3.24+、Ninja、C/C++ 编译器和 OpenSSL 开发文件。Vulkan 构建另需 Vulkan 开发文件和 glslc，CUDA 构建另需支持目标架构的 CUDA SDK 及兼容宿主编译器。

```sh
NV_BACKEND=cpu scripts/build.sh
NV_BACKEND=cpu NV_CPU_VARIANT=avx2 scripts/build.sh
NV_BACKEND=vulkan scripts/build.sh
NV_BACKEND=cuda NV_CUDA_ROOT=/path/to/cuda NV_CUDA_HOST_CXX=/path/to/g++ scripts/build.sh
```

产物分别位于 build-cpu、build-cpu-avx2、build-vulkan 和 build-cuda。CPU 基线不启用 SSE4.2、AVX、AVX2、F16C 或宿主 native 编译选项；AVX2 变体独立提供。会话库检测 CPU 支持 AVX2、FMA、F16C 后才启动优化工作进程。CUDA 默认编译目标为 `75-real;80-real;86-real;89;120a-real`，包含 compute_89 PTX，可通过 NV_CUDA_ARCH 覆盖。构建固定版本后端，补丁及许可证见 DEPENDENCIES.md。

## 模型与运行

Moyu 默认包通过设置页下载或导入模型。模型目录需要对应主模型和 qwen3-tts-tokenizer-f16.gguf；下载器会检查所有文件的完整 SHA-256 后再原子安装。手工转换可使用 scripts/prepare_models.py，Python 与转换依赖只用于开发准备。

```sh
build-cpu/bin/novel-voice --text '她轻声说：“雨停了。”' --models-dir /path/to/models --speaker Serena --backend cpu
build-vulkan/bin/novel-voice --input novel.txt --models-dir /path/to/models --backend vulkan
build-cuda/bin/novel-voice --text '我们出发吧。' --models-dir /path/to/models --backend cuda --no-play --output sample.wav
```

`--backends-dir DIR` 指定包含 cpu、vulkan、cuda 子目录的工作进程根目录，`--backend auto` 依次尝试 CUDA、Vulkan、CPU。CPU 优化变体位于 cpu/avx2。独立构建还支持会话库同目录的 nv-worker。

`--power-mode eco` 为默认模式：CPU 1 个合成线程，GPU 2 个辅助线程，空闲或长暂停 15 秒后卸载。balanced 使用 4 个线程、60 秒卸载。主后端及额外 CPU 回退后端均设置实际 GGML 线程数。CPU 先准备完整句段再正常速播放。CUDA / Vulkan 先测量实际音频产出速度；有余量时积攒约 2 秒音频后恢复流式播放，后续句段直接边生成边播放，避免短段结束后等待长段全部完成。速度不足时先准备完整句段；已经流式播放后发生欠载则暂存当前句段剩余音频并重新测量。慢机器仍可能在句段之间等待，不保证实时朗读。CPU F16 加载约 4.2 GB，Q5_K 约 2.4 GB，合成峰值随文本与缓冲而变化。

GPU 初始化失败时，自动模式会尝试下一个后端；合成阶段仅在尚未交出本句任何 PCM 时允许回退。已交出 PCM 后的失败明确报错，避免重播。Vulkan 软件光栅器不作为硬件加速设备。支持 AVX2/FMA/F16C 的 CPU 也会为 GPU 的辅助计算选择优化 CPU 后端，前提是两种构建的 ggml-base 文件逐字节一致；否则保留基线后端。选择只影响工作进程。CUDA 启动前检查实际内核镜像是否兼容，生产进程禁用 GGML 自动调用 GDB；不调用 Python 调试器。

`--plan` 显示分段与风格，无需模型。输入为 UTF-8 TXT，最多 64 MiB；EPUB 解析由 Moyu 提供。`--neutral` 关闭自动风格，`--no-cache` 关闭缓存，`--metrics FILE` 保存生成时长及实际后端。`--no-play` 不打开音频设备，也不会播放声音。

`--session` 接受 start、pause、resume、stop、status、wait、quit。Ctrl+C 停止并释放工作进程。使用 `--help` 查看选项。

## 资源与接口

会话最多使用一个模型工作进程；不同 GPU 后端按顺序尝试。播放初始预缓冲 1 秒，环形缓冲默认最多 30 秒（约 2.75 MiB PCM）；欠载后重新积攒缓冲再恢复，反复欠载时加倍恢复阈值且不超过环形缓冲容量。所有本地播放后端的单句磁盘暂存最多约 64 MiB，句段播放时并行准备后续句段。片段缓存位于 XDG_CACHE_HOME/novel-voice，默认上限 512 MiB，单条缓存最多 60 秒 PCM。暂停超过闲置期限会卸载模型，恢复时重新生成并跳过已经交出的样本。输出 WAV 使用 .partial，成功后才改为正式文件。

src/engine/nv_engine.h 提供 ABI 1：创建、配置、提交、PCM 回调、播放位置、暂停、恢复、停止及销毁。新增 nv_set_runtime_options 配置版本化后端选项，nv_get_runtime_info_json 返回实际后端、设备及回退原因。PCM 为 24 kHz 单声道 float32，回调数据只在回调期间有效；不要在回调中销毁、等待或提交同一会话。

GPU 速度判断排除首块音频前的模型预填充耗时，测量窗口至少 0.5 秒，要求音频产出相对播放至少有 5% 余量；只对当前请求保留结果，模型冷启动后重新测量。GPU 的 `--no-play` 导出保持流式回调。短句中的逗号、冒号与成对引号不会造成额外分段。

高亮依赖 nv_get_playback_position 的实际消费时钟，生成进度不能证明用户已经听到相应文字。首包计时也不等于扬声器实际出声时间；播放模式耗时包含背压及暂停。

## 验证

```sh
cmake -S . -B build-tests -G Ninja -DNV_BUILD_ENGINE=OFF -DCMAKE_BUILD_TYPE=Debug
cmake --build build-tests --parallel 4
ctest --test-dir build-tests --output-on-failure
build-cpu/bin/nv-worker --probe
build-vulkan/bin/nv-worker --probe
build-cuda/bin/nv-worker --probe
```

探针不加载模型或打开音频设备。会话替身只存在于测试目录，不安装到发行包。当前实现已在 i5-14600KF / RTX 5060 上验证 CPU、Vulkan、CUDA 真实合成与禁用 GPU 后的 CPU 回退；其他 CPU / GPU 型号尚未实机验证，不能把架构镜像清单当作完整硬件兼容性证明。GPU 测试顺序运行，播放测试使用私有静音输出。

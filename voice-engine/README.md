# Novel Voice · 小说语音引擎

独立的 Linux 本地中文小说朗读引擎：Qwen3-TTS 1.7B CustomVoice、原生 C++17 / GGML / CUDA，增量输出音频。正式运行不调用 Python、云端 API 或额外语言模型。

默认 F16 模型、普通话男声 `Uncle_Fu`，可选女声 `Serena`。在当前 RTX 5060 的实测中，Q5_K 路径比 F16 明显慢，因此不按文件大小选择默认模型。根据明确语气描述、对话及标点生成轻量风格指令；正文与指令分开。模型自行处理文本韵律，规则无法可靠判断讽刺、隐含情绪或角色身份。

## 本机使用

```bash
cd /home/inubashiri/Projects/novel-voice
build/bin/novel-voice --text '他低声说：“先别开门。”' --output sample.wav
build/bin/novel-voice --input novel.txt --speaker Serena
build/bin/novel-voice --text '雨停了，她推开窗。' --instruction '温柔自然地朗读'
build/bin/novel-voice --input novel.txt --plan
```

`--plan` 只显示分段、UTF-8 字节位置及风格，无需模型。输入支持 UTF-8 TXT，可带 BOM；文件上限 64MiB。不负责 EPUB 解析，后续由 Moyu 提供文本。

`--no-play --output chapter.wav` 只导出；`--no-cache` 禁用缓存；`--neutral` 禁用自动风格规则。`--metrics result.json` 保存计时与缓存统计。具体选项见 `--help`。

`--session` 保持会话，标准输入接受 `start`、`pause`、`resume`、`stop`、`status`、`wait`、`quit`。初始文本自动开始，`start` 重读相同文本；新文本提交通过 C ABI。`wait` 阻塞直到该请求结束。Ctrl+C 会停止并释放工作进程。状态输出为 JSON，状态值见头文件。

## 资源与生命周期

- 每个会话最多一个独立 GPU 工作进程；默认两个 CPU 线程配置。
- 音频播放默认预缓冲 1 秒，最多排队 15 秒，生产者受到背压限制。
- 完整片段缓存默认位于 `$XDG_CACHE_HOME/novel-voice`，或 `~/.cache/novel-voice`，上限 512MiB；单片段缓存收集最多 60 秒音频。
- 空闲或暂停 60 秒后卸载工作进程。长时间暂停恢复时，用固定 seed 再生成未完成片段，并跳过已经输出的样本；首次恢复需要重新加载模型。
- 保存音频时流式写入 `.partial`，成功结束才发布最终 WAV。取消或错误不会将未完成音频标成成功。
- CUDA、模型、音频设备失败会明确报错；不会自动切换为 CPU 推理。无音频设备时可使用 `--no-play`。

缓存身份包含模型及解码器文件指纹、模型 manifest 摘要、后端版本、文本、声音、风格和采样配置。模型应通过准备工具发布后保持只读；替换模型时重新生成 manifest。

## 构建与准备模型

需要 CMake 3.24+、Ninja、OpenSSL 开发文件、CUDA 12.8+（本机使用 13.0）、CUDA 支持的宿主 C++ 编译器。默认目标为 `89-real;120a-real`，包含 RTX 4060（包括 Laptop）及 RTX 5060 的原生内核。可通过 `NV_CUDA_ARCH` 覆盖；仅为新架构编译的内核不能在旧 GPU 上运行。系统编译器用于普通 C++，`NV_CUDA_HOST_CXX` 单独指定 NVCC 的宿主编译器。

```bash
bash scripts/build.sh
uv venv --python 3.12 .venv-tools
uv pip install --python .venv-tools/bin/python -r scripts/requirements-tools.txt
uv pip install --python .venv-tools/bin/python torch --index-url https://download.pytorch.org/whl/cpu
.venv-tools/bin/python scripts/prepare_models.py
```

模型准备只下载两个固定官方版本，输出到 `models/gguf`，其中 F16 是默认模型，Q5_K 保留为更小文件的对照选项（`--model qwen3-tts-1.7b-customvoice-q5_k`）。下载较慢时可先运行 `scripts/download_mirror.py`，它使用官方 ModelScope 镜像，并验证固定 Hugging Face LFS SHA256；之后运行准备脚本时加 `--skip-download`。

若本机无 CUDA SDK，可在工具虚拟环境安装 `cuda-toolkit[cublas,cudart,nvcc,cccl]==13.0.2`。NVIDIA pip SDK 位于 `nvidia/cu13`；其 `lib` 内需要常规 `libcudart.so`、`libcublas.so`、`libcublasLt.so` 链接及 `lib64 -> lib`。可改用标准 CUDA SDK 并设置 `NV_CUDA_ROOT`。本机兼容 GCC 13 位于 `.toolchain`，不修改系统编译器。

依赖版本及许可证见 [DEPENDENCIES.md](DEPENDENCIES.md)。权重、工具环境和编译产物不进入 Git。

## 接口与验证

[nv_engine.h](src/engine/nv_engine.h) 提供 C ABI：创建、提交文本与可选上下文、PCM/进度/错误回调、暂停、继续、停止、等待及释放。音频是 24kHz 单声道 float32；保存为 PCM16 WAV。PCM 回调数据只在回调期间有效。进度回调参数是已生成文本的 UTF-8 字节终点与全文字节长度；阅读高亮应结合消费端播放时钟。不要在回调中销毁、等待或提交同一个会话，不要跨 C ABI 抛出异常。

`nv_engine_abi_version()` 返回 1；`nv_get_playback_position()` 返回音频设备回调实际消费的样本数、对应生成片段的原文 UTF-8 字节范围及缓冲状态。首段播放前 `valid=0`，预缓冲、暂停和欠载静音不增加消费计数。设备自身的输出延迟不包含在内。Moyu 据此映射到原文段落；不要使用生成进度提前移动正文高亮。

本机串行解码已完成 30 分 13 秒真实音频连续播放（报告 `artifacts/serial-long-playback/long.json`），无崩溃、无欠载；进程树 RSS 峰值 922MiB、显存 4206MiB、平均 CPU 约 0.65 个逻辑核。播放使用私有 PulseAudio 空设备，仅证明播放链路与资源表现，未评估主观听感。热启动短段复测首包 0.46 秒、纯生成 RTF 约 0.81，尚未达到 0.7 目标；长测试的耗时包含播放背压。

```bash
cmake -S . -B build-tests -G Ninja -DNV_BUILD_ENGINE=OFF -DCMAKE_BUILD_TYPE=Debug
cmake --build build-tests --parallel 4
ctest --test-dir build-tests --output-on-failure
.venv-tools/bin/python -m unittest discover -s tests -p '*_test.py'
.venv-tools/bin/python scripts/benchmark.py --executable build/bin/novel-voice --models-dir models/gguf
```

会话单元测试的替身仅存在于 `build-tests/test-bin`，不安装，也不供正式 CLI 使用。真实模型测试与替身控制测试分别记录，不能用替身证明语音质量或 GPU 性能。

基准报告以 100% CPU 为一个逻辑核心，采样进程树 RSS、GPU 显存和功耗。`first_pcm_seconds` 是首个可用音频包延迟，不等同首个实际听到声音；冷启动包括加载。播放模式的合成耗时包含背压等待，不能用于声称纯推理速度。

性能目标：热启动首包 ≤2 秒，合成耗时/音频时长 ≤0.7，进程树 RAM ≤3GiB、显存 ≤6GiB、平均 CPU ≤一个逻辑核心。以本机报告为准，不把模型参数量、其他显卡数据或缓存播放当成实测。

启动前会验证实际 CUDA 内核可用性，不兼容设备通过 C ABI 返回明确错误，不加载模型。生产 worker 默认设置 `GGML_NO_BACKTRACE=1`，避免崩溃时调用系统 GDB；开发调试可设置 `GGML_NO_BACKTRACE=0`。

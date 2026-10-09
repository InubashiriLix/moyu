# 验证记录

2026-10-09，macOS 27.0.1 / Apple Silicon，Node.js 24.21.0，Rust 1.98.1。

| 检查 | 结果 |
| --- | --- |
| TypeScript 检查与生产前端构建 | 通过 |
| 前端单元测试 | 5 项通过 |
| Rust 单元测试 | 9 项通过；外部 EPUB 测试另用实际文件执行 |
| Chromium 交互测试 | 5 项通过 |
| WebKit 交互测试 | 5 项通过 |
| Rust Clippy（warnings 为错误） | 通过 |
| Rust 格式检查 | 通过 |
| npm 依赖审计 | 0 个已报告漏洞 |
| macOS ARM64 `.app` / `.dmg` | 成功构建 |
| macOS 应用 ad-hoc 签名完整性 | `codesign --verify --deep --strict` 通过 |

实际指定的 EPUB 由 Rust 解析器成功打开：100 章、170,138 个文字字符。运行中应用的保存状态也已包含该书和阅读进度；原文件没有修改。

交互测试覆盖长篇分段渲染、Vim 滚动、章节跳转、搜索、输入框和键位冲突、缩放与修改字号后的文本位置、透明度独立控制、进度恢复、180 × 120 小窗口，以及 TXT 中 HTML 不被执行。新增测试检查工具栏在正文区域隐藏、仅最上沿停留后显示、字体选择和默认外观恢复。已人工查看 WebKit 生成的阅读与设置截图，未见重叠或横向溢出。

字体为本机 JetBrainsMono Nerd Font Mono Regular 的 WOFF2 转换：JetBrains Mono 2.304 / Nerd Fonts 3.5.1，保留全部字形和元数据；字体许可证包含在源代码与应用资源中。

原生 UI 自动操作被工具审批拒绝，原因是 `Computer Use was not approved to use Moyu`。因此未自动验证 macOS 的实际拖动、边缘缩放、系统全局快捷键或透明窗口合成；浏览器测试不能证明这些系统能力。

当前没有 Linux / niri 运行环境，也未执行远程 CI。已提供 Ubuntu 24.04 / macOS 构建工作流，以及 niri、Hyprland、Sway 配置。Linux 安装包尚未在这台机器生成，niri 的隐藏 / 恢复、浮动、窗口大小及透明效果需要按 README 在实际环境验收。

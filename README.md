# Moyu · 摸鱼

一个 Linux / macOS 本地小说阅读器：小窗口、Vim 键位、背景与文字独立透明、可调对比度。第一版优先支持 macOS 和原生 Wayland + niri。

## 使用

打开 `.txt` / `.epub`，或把文件拖入窗口。关闭窗口只会隐藏；通过快捷键、macOS 菜单栏入口或再次启动应用恢复。在设置中选择“退出应用”真正退出。支持 macOS 13+。

阅读时顶部栏与底部进度默认完全隐藏，鼠标在最上沿停留 450 ms 才显示；移出工具栏即隐藏。顶部隐藏区域仍可拖动窗口，`o / s / t` 可直接打开文件、设置和目录。设置中可取消“隐藏顶部栏”。

默认使用 JetBrainsMono Nerd Font Mono，随包提供 WOFF2 字体并优先复用本机同名字体。JetBrains Mono 不含中文字形，中文优先回退到 Noto Sans Mono CJK SC / Sarasa Mono SC，macOS 则回退到 PingFang SC。Linux 如需中文等宽外观，安装对应的 CJK 等宽字体。也可在设置中选择系统等宽或宋体 / 衬线字体。[JetBrains 字体说明](https://www.jetbrains.com/lp/mono/)、[字体许可证](src/assets/fonts/OFL.txt)。

| 操作 | 键位 |
| --- | --- |
| 上下滚动 | `k` / `j` |
| 上下半页 | `Ctrl+u` / `Ctrl+d` |
| 上下一页 | `Ctrl+b` / `Ctrl+f` |
| 书首 / 书尾 | `gg` / `G` |
| 数字前缀 | `5j` / `3k`；`50G` 跳到全书 50% |
| 搜索整本书 | `/` |
| 下一个 / 上一个结果 | `n` / `N` |
| 打开 / 设置 / 目录 | `o` / `s` / `t` |
| 记录 / 跳转书签 | `m{a-z}` / `'{a-z}` |
| 命令行 | `:` |
| 帮助 / 关闭面板 | `?` / `Esc` |
| macOS / X11 全局隐藏与恢复 | `Ctrl+Alt+M`（可修改） |

### 命令行（`:`）

按 `:` 打开底部命令行，`↑`/`↓` 翻历史，`Tab` 补全，`Enter` 执行，`Esc` 取消。

| 命令 | 作用 |
| --- | --- |
| `:index` / `:toc` | 打开目录 |
| `:set` | 打开设置 |
| `:set fontsize=20 theme=dark` | 直接修改设置（`fontsize`/`lineheight`/`contrast`/`bgopacity`/`textopacity`/`theme`/`ontop`/`hidebar`/`fontfamily`） |
| `:font increase` / `:font decrease` | 字号 ±1 |
| `:font 20` / `:font +2` / `:font -2` | 字号赋值 / 增量 |
| `:marks` | 书签列表（面板内按 `d` 删除） |
| `:delmark a` / `:delmarks` | 删除指定书签；不带字母则清空本书书签 |
| `:chapter 3` | 跳到第 3 章 |
| `:42` | 跳到全书 42% |
| `:search 关键词` | 搜索并预填 |
| `:library` | 最近阅读 |
| `:theme dark` / `:theme light` | 切换主题 |
| `:hide` | 隐藏窗口 |
| `:reset` | 恢复默认外观 |
| `:q` | 关闭当前面板（不退出应用） |
| `:qa!` / `:wq` | 保存进度与偏好并退出应用 |

面板内可用 `j`/`k` 选择、`gg`/`G` 跳首尾、`Enter` 确认；设置页 `h`/`l` 调节滑块与选项、`Space` 切换开关；目录与最近阅读按 `/` 过滤标题。

搜索是字面量匹配，忽略大小写，最多显示 10,000 个结果。输入框中不会触发阅读键位。拖动顶部窄栏移动，拖动边缘缩放；最小尺寸 180 × 120。

背景透明度和文字透明度独立调节。对比度改变文字与背景的明暗差；设定在纯色底色上计算，透出桌面后的实际效果取决于桌面内容。设置面板保持不透明；“恢复默认外观”保留全局快捷键和置顶选择。

## niri / Wayland

应用原生使用 Wayland，不通过 XWayland 绕过限制。启用固定 GTK app-id `app.moyu.reader`，便于窗口规则匹配。

把 [configs/niri.kdl](configs/niri.kdl) 的规则与绑定合并到 niri 配置。`moyu` 必须在 PATH 上；也可以改成 AppImage 的绝对路径。应用不会自动改写配置。niri 25.01+ 支持浮动窗口，较新的规则可用性以本机 `niri validate` 为准。

```kdl
window-rule {
    match app-id=r#"^app\.moyu\.reader$"#
    open-floating true
    draw-border-with-background false
    focus-ring { off; }
    border { off; }
    on-xdg-activate "focus"
}
binds {
    Ctrl+Alt+M repeat=false { spawn "moyu" "--toggle"; }
}
```

`moyu --toggle`、`moyu --show`、`moyu --hide` 将命令转发给运行中的实例。未运行时 toggle/show 启动阅读器，hide 立即退出而不创建窗口。二次启动不会打开第二个阅读窗口。Linux 单实例通信需要正常的用户 D-Bus 会话。

也可以用 `moyu "/path/to/novel.epub"` 直接打开一本书；已有实例会在同一个窗口中打开它。

在 niri 中，浮动窗口覆盖平铺窗口，但仍可能被其他浮动窗口或全屏窗口覆盖；不保证跨工作区固定。Wayland 的窗口位置、激活与层级由合成器决定，应用保存窗口大小，位置由 niri 管理。niri 的 Mod+拖动 / Mod+右键拖动也可移动或缩放窗口。

另提供 [Hyprland](configs/hyprland.conf) 与 [Sway](configs/sway.conf) 示例。Wayland 通过合成器快捷键执行命令，不依赖全局快捷键 Portal。macOS / X11 使用应用原生全局快捷键与置顶接口。

参考：[niri 窗口规则](https://niri-wm.github.io/niri/Configuration%3A-Window-Rules.html)、[浮动窗口](https://github.com/niri-wm/niri/blob/main/docs/wiki/Floating-Windows.md)、[按键绑定](https://niri-wm.github.io/niri/Configuration%3A-Key-Bindings.html)。

## 文件与保存

- TXT 自动识别 UTF-8、带 BOM 的 UTF-16、部分无 BOM UTF-16，以及 GB18030 / GBK。在“打开小说”面板可手动选择编码，并重新打开当前 TXT。短文本和无 BOM UTF-16 的编码无法总是可靠判断，出现乱码时手动指定。
- TXT 根据简短的“第…章 / 回 / 节 / 卷”及英文 Chapter 标题生成目录，保留序言。
- EPUB 按 spine 顺序提取文字，使用 EPUB 3 导航或 EPUB 2 NCX 标题。目录粒度为 spine 文档；同一文档内的多个目录锚点不细分。忽略插图、复杂排版与非线性附录，不支持 DRM。
- 文件上限 64 MB；EPUB 读取资源的解压总量上限 100 MB。不执行小说脚本、不请求书籍中的远程资源。
- 记住最近 20 本书、各书的章节与文本偏移、书签（`m{a-z}`）、外观、窗口大小，以及 macOS / X11 窗口位置。窗口缩放和字号修改按文本位置恢复，不依赖像素位置。
- 数据保存在系统应用数据目录下的 `app.moyu.reader/state.json`。macOS 通常是 `~/Library/Application Support/app.moyu.reader/`；Linux 通常是 `${XDG_DATA_HOME:-~/.local/share}/app.moyu.reader/`。原文件保留在原位置，书籍身份基于规范化绝对路径；移动文件后需要重新打开。
- 滚动停止后 400 ms 保存进度，隐藏 / 退出前立即保存。状态原子写入；损坏状态保留备份后恢复默认。文件缺失时在窗口中提示重新选择。

## 开发与打包

需要 Node.js 24+、Rust stable（至少 1.90）和 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run desktop
```

Ubuntu 24.04 的构建依赖：

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

构建当前平台安装包：

```sh
# macOS
npm run tauri -- build --bundles app,dmg
# Linux
npm run tauri -- build --bundles appimage,deb
```

产物位于 `src-tauri/target/release/bundle/`。macOS 透明窗口使用 Tauri 的私有 API 配置，当前面向个人使用和直接分发，不走 Mac App Store。本地产物采用 ad-hoc 签名，未使用开发者证书或做公证，macOS 可能需要由你允许打开。正式分发可覆盖 signingIdentity 并配置开发者证书。

Linux AppImage 应在目标兼容的 Linux 基础系统上构建；当前 CI 使用 Ubuntu 24.04，不承诺更老系统兼容。AppImage 缺少 FUSE 时可用 `./Moyu.AppImage --appimage-extract-and-run` 启动。不同包架构需分别构建。

`npm run dev` 是浏览器界面预览，支持本地 TXT 与原创示例；EPUB 和系统窗口功能仅在桌面应用提供。浏览器预览只用于前端验证。

## 验证

```sh
npm run build
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npx playwright install chromium webkit
npm run test:e2e
```

CI 在 macOS 与 Ubuntu 上进行测试并生成平台安装包，但它不能代替真实合成器验收。

在 niri 上需手动完成：用 `niri validate` 检查配置；用 `niri msg windows` 确认 app-id 和浮动状态；打开 TXT / EPUB；调整文字与背景透明度；移动、缩放及修改字号；切换焦点后用快捷键隐藏 / 恢复；确认二次启动仍只有一个阅读窗口；退出后确认进度恢复；检查全屏 / 多工作区行为。当前开发机器是 macOS，不能把浏览器测试视为 niri 实测。

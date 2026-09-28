Sardina anime v0.7.2 的 Windows x64 开发预览。

## 下载与安装

支持 Windows 10 / 11 x64，无需另行安装 Node.js 或 pnpm。

- **windows-x64-setup.exe**：安装向导，可选择安装位置，创建应用快捷方式。
- **windows-x64.zip**：完整解压到任意目录，运行 `Sardina anime.exe`。不要仅拷贝 EXE，需保留旁边的资源文件。
- **SHA256SUMS-windows.txt**：两个产物的 SHA-256 校验值。

本开发预览未做 Authenticode 代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。安装前请确认文件来自本仓库的 Release。

## Windows 支持

- 包含 Electron、SQLite 原生模块、本地引擎和界面资源。
- 使用 Windows 原生标题栏及最小化、最大化、关闭按钮，支持 Ctrl+K 搜索。
- 追番、进度和设置保存在 `%APPDATA%\Revanime\`，安装版和 ZIP 版共用资料；卸载保留资料。
- 功能基于 v0.7.2：七个来源、MP4/HLS 播放、追番和历史、评分、JSON 备份、girigiri 弹幕。

Windows 构建来自当前发布标签中的代码。macOS 安装包见 [v0.7.2 Release](https://github.com/zzzfu411/Sardina-anime/releases/tag/v0.7.2)。上游来源可用性取决于各站点，详见 [来源清单](https://github.com/zzzfu411/Sardina-anime/blob/main/docs/SOURCES.md)。

## 构建与验收

在 Windows x64、Node.js 24、pnpm 9.15.9 下执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm package:win
pnpm verify:desktop
```

验收使用独立临时资料目录，检查无 Node.js PATH 下独立启动、渲染器隔离、七个来源、本地引擎复用、主要页面、主题保存、快捷键、模拟恢复事件及原创 MP4/HLS 测试视频实际解码。

GitHub Actions 可从“Windows release”手动构建并下载产物；推送 `v*-windows.*` 标签会在验证通过后发布 Windows 预览版本。当前没有代码签名或自动更新。

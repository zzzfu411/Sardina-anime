# Sardina Anime

面向 macOS、Windows 与本机浏览器的本地动漫检索、追番与续播播放器：由 React + Electron 客户端与仅监听回环地址的 Fastify + SQLite 引擎组成。

[English](README.md) · 简体中文 · [Releases](https://github.com/zzzfu411/Sardina-anime/releases)

| 浅色主题 | 深色主题 |
| --- | --- |
| ![浅色主题](docs/images/home-light.png) | ![深色主题](docs/images/home-dark.png) |

## 核心特性

- **多源检索与目录** — 已接入 `girigiri`、`AniCh`、`AkiAnime`、`二矿`、`咕咕`、`乐豆`、`稀饭`，支持封面推荐、年份/题材组合筛选、每周放送表与 SSE 搜索（遇到原站图片验证码时转发由用户手动输入，不调用 OCR）。
- **MP4 与 HLS 播放** — 通过回环媒体会话代理（`/api/v1/media`）按需转发单段 `Range` 请求，支持多线路切换并保留播放进度、倍速、全屏、画中画与自动连播下一集。
- **弹幕与多源评分** — 支持开关 `girigiri` 弹幕（字号、透明度与时间轴同步）与进入时在线人数快照；集成 Bangumi 官方评分与来源站评分，支持手动修正条目关联。
- **本机 SQLite 资料库** — 在本机 SQLite（`REVANIME_DATA_DIR`）中统一保存追番状态（想看 / 在看 / 看完 / 暂停）、更新提醒与每 5 秒落盘的观看进度，桌面端与本地网页共用同一资料库，支持版本化 JSON 导出与恢复前自动备份。

## 安装与运行

预构建开发预览包已内置运行环境，无需安装 Node.js 或 pnpm：

- **Windows 10/11（x64）** — [安装程序 `.exe`](https://github.com/zzzfu411/Sardina-anime/releases/download/v0.7.2-windows.1/Sardina-anime-0.7.2-windows-x64-setup.exe) · [免安装 `.zip`](https://github.com/zzzfu411/Sardina-anime/releases/download/v0.7.2-windows.1/Sardina-anime-0.7.2-windows-x64.zip) · [v0.7.2-windows.1 说明与校验值](https://github.com/zzzfu411/Sardina-anime/releases/tag/v0.7.2-windows.1)（未做 Authenticode 签名，详见 [docs/WINDOWS-RELEASE.md](docs/WINDOWS-RELEASE.md)）
- **macOS 12+（Apple Silicon）** — [`.dmg` 镜像](https://github.com/zzzfu411/Sardina-anime/releases/download/v0.7.2/Sardina-anime-0.7.2-arm64.dmg) · [`.zip` 压缩包](https://github.com/zzzfu411/Sardina-anime/releases/download/v0.7.2/Sardina-anime-0.7.2-arm64.zip) · [v0.7.2 说明与校验值](https://github.com/zzzfu411/Sardina-anime/releases/tag/v0.7.2)（未做 Developer ID 签名与公证，首次拦截可参照 [Apple 打开说明](https://support.apple.com/zh-cn/102445)）

从源码运行需安装 **Node.js 24** 与 **pnpm 9.15.9**：

```sh
git clone https://github.com/zzzfu411/Sardina-anime.git
cd Sardina-anime
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` 会启动仅监听 `127.0.0.1` 的引擎并打开已授权浏览器页面（macOS 构建后也可直接双击 [Start Web.command](<Start Web.command>)）。资料默认保存在 macOS `~/Library/Application Support/Revanime/` 或 Windows `%APPDATA%\Revanime\`（保留旧目录名以兼容历史数据，可通过 `REVANIME_DATA_DIR` 覆盖）。

```sh
pnpm desktop         # 启动 Electron 开发窗口
pnpm package:mac     # 在 Apple Silicon Mac 上打包 DMG / ZIP
pnpm package:win     # 在 Windows x64 上打包安装程序 / ZIP
pnpm verify:desktop  # 使用隔离资料目录验证当前平台打包产物
```

## 开发与文档

```sh
pnpm check     # TypeScript 类型检查 + Vitest 样本与引擎测试 + 生产构建
pnpm test:e2e  # Playwright Chromium 端到端测试（使用隔离资料与原创测试视频）
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 工程分层、单实例文件锁生命周期与 `/api/v1` 本地接口约定
- [docs/SOURCES.md](docs/SOURCES.md) 与 [docs/ADDING_SOURCES.md](docs/ADDING_SOURCES.md) — 来源覆盖范围与 `AnimeSource` 适配器接入指南（[types.ts](packages/engine/src/sources/types.ts)）
- [docs/DANMAKU.md](docs/DANMAKU.md) 与 [docs/RATINGS.md](docs/RATINGS.md) — 弹幕协议、人数租约与 Bangumi 评分关联规则
- [docs/VALIDATION.md](docs/VALIDATION.md) — 真实播放链路与桌面打包验收记录

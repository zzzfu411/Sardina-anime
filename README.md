<p align="center">
  <img src="apps/web/public/brand/sardina-anime-right.png" width="168" alt="Sardina 小鱼">
</p>

<h1 align="center">Sardina anime</h1>

<p align="center">在本机找番、追番，接着上次的进度看。</p>
<p align="center">macOS Apple Silicon · 本地网页版 · v0.7.2 开发预览</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#运行">运行</a> ·
  <a href="#本地-api">API</a> ·
  <a href="docs/ADDING_SOURCES.md">接入来源</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <img src="docs/images/home-light.png" alt="Sardina anime 首页：推荐、番剧索引和每周放送" width="100%">
</picture>

## 功能

| 功能 | 说明 |
| --- | --- |
| **找番** | 来源推荐、关键词搜索、年份与题材筛选、每周放送。 |
| **播放** | MP4 / HLS、换线与续播、倍速、全屏、画中画、自动下一集。 |
| **追番** | 想看 / 在看 / 看完 / 暂停，更新提醒，观看历史与批量管理。 |
| **弹幕** | girigiri 弹幕，支持字号、透明度及播放同步；显示进入本集、本线路时的人数。 |
| **评分** | Bangumi 官方评分与来源评分，支持手动关联条目。 |
| **本机资料** | SQLite 保存追番和进度，JSON 导出、恢复与恢复前备份；浅色、深色及跟随系统。 |

已接入 **girigiri、AniCh、AkiAnime、二矿、咕咕、乐豆、稀饭**。各来源支持范围见[来源清单](docs/SOURCES.md)。弹幕默认关闭，观看人数是进入时的快照；详见[弹幕说明](docs/DANMAKU.md)。

## 运行

需要 [Node.js 24](https://nodejs.org/) 和 [pnpm 9.15.9](https://pnpm.io/installation)。

```sh
git clone https://github.com/zzzfu411/Sardina-anime.git
cd Sardina-anime
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

启动命令会打开已授权的浏览器页面。引擎只监听 `127.0.0.1`，网页与桌面端共用本机资料库。完成安装和构建后，macOS 也可双击 `Start Web.command`。

```sh
pnpm desktop       # 启动 Electron 开发窗口
pnpm package:mac   # 在 Apple Silicon Mac 上生成 DMG / ZIP
```

资料默认保存在 `~/Library/Application Support/Revanime/`；保留旧目录名以兼容已有数据。可用 `REVANIME_DATA_DIR` 指定其他目录，迁移资料请使用设置中的导出与恢复。

## 本地 API

统一前缀为 `/api/v1`，需要启动入口建立的会话 Cookie 或本机 Bearer 令牌。

| 接口 | 用途 |
| --- | --- |
| `GET /sources` | 来源、能力与启用状态 |
| `GET /search?q=…&sourceId=…` | 单来源搜索，SSE 返回结果 |
| `GET /catalog` · `GET /schedule` | 番剧索引与放送安排 |
| `GET /sources/:id/detail?itemId=…` | 详情、线路与剧集 |
| `POST /playbacks` | 创建播放会话，返回本地媒体地址 |
| `GET /playbacks/:id/danmaku` | 读取当前播放会话的弹幕 |
| `/library` · `/history` · `/settings` · `/backup` | 追番、进度、设置与备份 |

完整约定见[架构与 API](docs/ARCHITECTURE.md)。来源扩展实现 `AnimeSource` 的 `search`、`getDetail`、`resolve`；可选能力包括推荐、索引、放送、弹幕和观看人数。见[接口定义](packages/engine/src/sources/types.ts)。

## 开发

**React + Vite** 提供界面，**Electron** 提供桌面窗口，**Fastify + SQLite** 负责本地服务与资料。

```sh
pnpm typecheck
pnpm test           # 固定样本与本地引擎测试
pnpm build
pnpm test:e2e       # 需要 Google Chrome；使用隔离资料与原创测试视频
```

[界面设计](docs/design.md) · [来源接入](docs/ADDING_SOURCES.md) · [验收记录](docs/VALIDATION.md)

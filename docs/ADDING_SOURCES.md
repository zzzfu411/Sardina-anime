# 添加自己的来源

首版适配器随应用代码发布，不下载或执行远程脚本。只参考已有研究资料中的请求与数据结构，不运行解包应用中的广告、登录或未知脚本。

## 最小步骤

1. 在 `packages/engine/src/sources/` 新建 TypeScript 类，实现 `AnimeSource`。
2. 声明稳定 `id`、版本、功能及允许访问的目录/解析域名；网络请求使用 `ctx.http` 并传入 `ctx.signal` 和域名列表。
3. `search()` 返回该来源自己的页码与 `hasMore`；使用游标的来源同时返回 `nextCursor`，下一次读取 `input.cursor`；不支持分页的来源明确返回 false。不能从当前条目数猜测分页状态。
4. `getDetail()` 返回真实线路和剧集定位。不要生成来源没有返回的剧集，亦不要把编码参数当成视频地址。
5. `resolve()` 在开始观看时获取临时地址及必要请求头。地址和凭据只能留在引擎，不写入 `EpisodeLocator`、历史或备份。
6. 将类加入 `Registry`，增加正常、空响应、损坏响应、结构变化与取消的固定样本测试。
7. 独立验证搜索 → 详情 → 选集 → 解析 → 实际播放，至少十个不同剧集、覆盖多个番剧，再进行整集、拖动与续播检查。
8. 将失败原因和作用范围写进 `docs/validation/`，确认后更新 `release.ts`。不能用一次目录 200 替代完整验证。

```ts
class ExampleSource implements AnimeSource {
  manifest = {
    id: 'example',
    name: 'Example',
    version: '1.0.0',
    description: '来源能力说明',
    allowedHosts: ['api.example.org'],
    capabilities: ['search', 'play'] as const,
  };
  // search(input, ctx), getDetail(ref, ctx), resolve(episode, ctx)
}
```

接口定义以 `packages/core/src/types.ts` 和 `packages/engine/src/sources/types.ts` 为准。`ctx.http` 为每个来源独立提供 Cookie 会话；搜索缓存、超时和脱敏日志由 Registry 管理。发生访问要求、缺少媒体或结构变化时抛出带稳定错误码的 `AppError`。

## 人工搜索验证码

girigiri 额外实现 `getSearchCaptcha(ctx)` 和 `submitSearchCaptcha(code, ctx)`。`search()` 检测到验证码页时抛出 `CAPTCHA_REQUIRED`，图片方法返回原始 `Buffer` 与校验后的图片类型，提交方法只发送用户输入；数字错误时抛出 `CAPTCHA_INCORRECT`。引擎负责隔离每个搜索页的 Cookie、注册图片、处理刷新和取消，前端通过 `challenge` 事件展示输入框。当前契约限四位数字，不应直接套用到其他类型验证，也不应添加自动识别或尝试数字的循环。详见 [架构约定](ARCHITECTURE.md)。

## 现有来源的注意事项

- AniCh 的搜索/剧集为 Protobuf，播放接口为整数数组包装的 Protobuf。剧集可能从 29 或 78 开始，必须使用返回的实际 sort 值。无效长度、wire 类型、溢出 varint 会拒绝。
- AniCh 的目录与搜索使用返回消息根字段 3 作为下一页 `skip`，不是 `(page - 1) * pageSize`。第一页传 0，后续页面必须带续页标记；目录声明 `catalogPagination: 'cursor'`，界面只允许依次翻页。
- 索引适配器可提供 `getCatalog(input, ctx)`，在清单中声明 `catalog` 与 `catalogFilters`。仅展示验证过的筛选项；不要把第一页数据的前端过滤冒充全片库筛选。有确定来源时才返回 `total/pageCount`。
- 周期表适配器可提供 `getSchedule(weekday, ctx)` 并声明 `schedule`。返回真实来源条目、星期和检查时间。Aki 的目录链接是 `/bgmdetail/ID.html`，周期表链接是 `/bgmplay/ID-线路-集.html`；两者都需要提取公开番剧 ID，不能使用另一个编号体系的 `vod_id`。
- Aki 的 `player_aaaa` 与解析器 `config` 是数据对象，允许 JSON5 尾逗号，但不能使用 `eval`。公开解析服务可能返回状态 100 且无地址，此时属于媒体缺失。
- 首版仅开放 Aki 的 YDY / 超高画三线。目录还包含其他线路，但它们未通过验证，因此不进入用户选集页。
- girigiri 使用 `ani.yeuxark.com`。搜索遇验证码返回 `CAPTCHA_REQUIRED`，由用户输入验证码后继续；公开索引、周期表和选集独立可用。分页读取页面底部的真实总数与页数，不能使用顶部错误的页数。`player_aaaa` 只按数据解析，不执行 JavaScript。
- 咕咕参考 `gugu.js` 重写公开应用协议：AES-CBC 响应、详情选集和 `vodParse`。仅开放已验证的 `yunjie` 新线，旧 A 线返回“点数不足”。播放时重新拉取详情中的解析参数，前端与持久化数据只保存 `from + nid` 定位。
- 乐豆参考 `yzx.js`，保留 `ji` 剧集标识；播放时重新获取列表并计算 `jiIndex`。AES-GCM 认证失败、分类不符、剧集消失均明确报错。匿名设备标识随机生成，临时会话只保存在内存中，不复制研究脚本中的固定个人设备资料。
- 咕咕与乐豆的列表接口没有可靠总数，适配器实际读取下一页并比较条目 ID 后决定 `hasMore`，不按当前条目数量推测。乐豆的综合搜索必须按 `typeName=动漫` 过滤；已经限定动漫的分类接口允许省略 `typeName`。
- 稀饭使用公开 Supabase project key 调用网站目录和播放接口，不携带用户 JWT。仅接入来源 ID 4 / `xfxf1`，检查返回的番剧、剧集和线路与所选一致；账号/考试限制以及未到开放时间的剧集不会开放。上游 `season_number` 是系列顺序，不能直接当成标题的第几季。
- 个别已验证 CDN 使用非标准端口，可由适配器在 `ResolvedMedia.allowedPortOrigins` 声明精确 HTTPS origin，例如稀饭的 `https://bjdownload.pan.wo.cn:30443`。该字段不接受前端输入，也不跳过 DNS、私网地址或重定向校验；不要全局放宽端口。
- 未移植的来源及具体限制见 [完整清单](SOURCES.md)。通用 QuickJS 宿主、`ENC1` 加密脚本不在本版执行。

## 更新依赖与桌面锁

根依赖由 pnpm 锁定。升级引擎的生产依赖时，同步更新 `scripts/package.ts` 的依赖列表及 `apps/desktop/runtime-package-lock.json`，并分别验证 Node ABI 与 Electron ABI。不要把打包生成的 Electron SQLite 覆盖到根 `node_modules`。

不将私人密钥、设备标识或来源账户资料提交到工程。需要用户登录的来源必须先设计明确的授权与退出流程，不从解包文件复制第三方凭据。

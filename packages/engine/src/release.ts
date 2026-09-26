/** Observed samples, not an uptime promise. Full records are in docs/validation/. */
export const sourceValidation: Record<
  string,
  { checkedAt: string; attempted: number; started: number; fullEpisode: boolean; scope: string }
> = {
  anich: {
    checkedAt: '2026-09-22',
    attempted: 10,
    started: 10,
    fullEpisode: true,
    scope: '自动选择线路；另有一次目录请求失败',
  },
  aki: {
    checkedAt: '2026-09-22',
    attempted: 10,
    started: 8,
    fullEpisode: true,
    scope: '超高画三线 / YDY；两集上游未提供媒体',
  },
  girigiri: {
    checkedAt: '2026-09-23',
    attempted: 10,
    started: 10,
    fullEpisode: true,
    scope: '公开索引与 HLS；关键词搜索验证码由用户手动输入',
  },
  gugu: {
    checkedAt: '2026-09-23',
    attempted: 10,
    started: 8,
    fullEpisode: true,
    scope: 'yunjie 新线；两集解析器未返回媒体，旧 A 线不开放',
  },
  ledou: {
    checkedAt: '2026-09-23',
    attempted: 10,
    started: 10,
    fullEpisode: true,
    scope: '动漫主线 HLS；另有一个资源未解出视频帧，保留为失败样本',
  },
  xifan: {
    checkedAt: '2026-09-23',
    attempted: 10,
    started: 10,
    fullEpisode: false,
    scope: '公开新番主线 1；整集在约 9 分半中断且地址刷新失败，仍待整集验证',
  },
};

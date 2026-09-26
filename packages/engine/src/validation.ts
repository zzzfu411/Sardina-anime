import { z } from 'zod';
import { AppError } from './errors';

export const refSchema = z.object({ sourceId: z.string().min(1).max(40), id: z.string().min(1).max(200) });
export const locatorSchema = z.object({
  sourceId: z.string().min(1).max(40),
  animeId: z.string().min(1).max(200),
  lineId: z.string().min(1).max(100),
  episodeId: z.string().min(1).max(100),
});
export const cardSchema = refSchema.extend({
  title: z.string().min(1).max(500),
  poster: z.string().max(4096).optional(),
  description: z.string().max(10000).optional(),
  kind: z.enum(['tv', 'movie', 'ova', 'special', 'unknown']),
  year: z.number().int().min(1900).max(2200).optional(),
  season: z.number().int().min(0).max(1000).optional(),
  remarks: z.string().max(1000).optional(),
  aliases: z.array(z.string().max(500)).max(100).optional(),
  externalIds: z.record(z.string().max(100), z.string().max(200)).optional(),
  ratings: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        score: z.number().finite().gt(0).max(10),
        total: z.number().int().positive().optional(),
        origin: z.enum(['source', 'bangumi-snapshot']),
      }),
    )
    .max(5)
    .optional(),
});
export const episodeSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(1000),
  number: z.number().nonnegative().nullable(),
  kind: z.enum(['episode', 'special', 'movie']),
  locator: locatorSchema,
});
export const statusSchema = z.enum(['planned', 'watching', 'completed', 'paused']);
export const historyInputSchema = z.object({
  card: cardSchema,
  episode: episodeSchema,
  position: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  capturedAt: z.string().datetime(),
  completed: z.boolean().optional(),
});
export const historyWriteSchema = historyInputSchema.extend({
  version: z
    .object({
      profile: z.string().min(1).max(100).optional(),
      all: z.number().int().nonnegative(),
      series: z.number().int().nonnegative(),
      episode: z.number().int().nonnegative(),
    })
    .optional(),
});
export const sourcePreferenceSchema = z.object({
  generation: z.string().min(1).max(100).optional(),
  module: z.enum(['search', 'home', 'catalog', 'schedule']),
  sourceId: refSchema.shape.sourceId,
});
export const settingsSchema = z.object({
  generation: z.string().min(1).max(100).optional(),
  autoNext: z.boolean(),
  playbackRate: z.number().min(0.5).max(3),
  volume: z.number().min(0).max(1),
  appearance: z.enum(['dark', 'light', 'system']).optional(),
  danmaku: z
    .object({
      enabled: z.boolean(),
      opacity: z.number().min(0.25).max(1),
      fontScale: z.number().min(0.75).max(1.5),
    })
    .optional(),
  sourcePreferences: z
    .object({
      search: refSchema.shape.sourceId.optional(),
      home: refSchema.shape.sourceId.optional(),
      catalog: refSchema.shape.sourceId.optional(),
      schedule: refSchema.shape.sourceId.optional(),
    })
    .optional(),
  revision: z.number().int().nonnegative().optional().default(0),
});
const libraryEpisodeSchema = refSchema.extend({
  key: z.string().min(1).max(10000),
  label: z.string().max(1000),
  number: z.number().finite().nonnegative().nullable(),
  kind: z.enum(['episode', 'special', 'movie']),
  locator: locatorSchema,
});
export const librarySchema = z.object({
  id: z.string().min(1).max(100),
  card: cardSchema,
  refs: z.array(refSchema).min(1).max(30),
  status: statusSchema,
  addedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  latestCount: z.number().int().nonnegative(),
  seenCount: z.number().int().nonnegative(),
  checkedAt: z.string().datetime().optional(),
  contentUpdatedAt: z.string().datetime().optional(),
  updateError: z.string().max(1000).optional(),
  revision: z.string().min(1).max(100).optional(),
  associationRevision: z.string().min(1).max(100).optional(),
  episodeSnapshots: z
    .array(
      refSchema.extend({
        episodes: z.array(libraryEpisodeSchema).max(10000),
        checkedAt: z.string().datetime(),
      }),
    )
    .max(30)
    .optional(),
  updates: z
    .array(libraryEpisodeSchema.extend({ addedAt: z.string().datetime() }))
    .max(10000)
    .optional(),
  unidentifiedUpdateCount: z.number().int().nonnegative().optional(),
});
export const historySchema = historyInputSchema
  .extend({
    key: z.string().min(1).max(1000),
    updatedAt: z.string().datetime(),
  })
  .partial({ capturedAt: true });
export const sourceSettingsSchema = z.object({
  id: z.string().min(1).max(40),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(99),
});
export const backupSchema = z.object({
  format: z.literal('revanime'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  library: z.array(librarySchema).max(10000),
  history: z.array(historySchema).max(50000),
  settings: settingsSchema.omit({ generation: true }),
  sourceSettings: z.array(sourceSettingsSchema).max(100).optional(),
  bangumiLinks: z
    .array(refSchema.extend({ subjectId: z.string().regex(/^[1-9]\d{0,8}$/) }))
    .max(10000)
    .optional(),
  searchHistory: z
    .array(z.object({ keyword: z.string().trim().min(1).max(150), searchedAt: z.string().datetime() }))
    .max(20)
    .optional(),
});
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'INVALID_INPUT',
      `参数无效：${result.error.issues[0]?.path.join('.') || '请求内容'}`,
      400,
    );
  return result.data;
}

import { z } from 'zod'

// 仅解析历史 Session 的重试记录；不再注册额外重试策略。
export const TOOL_INPUT_JSON_RETRY_POLICY = 'harness-platform/decision-extraction-json/v1'
export const toolInputJsonRetrySchema = z.object({
  turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
  provider: z.string(), retry: z.number().int().nonnegative(), retryId: z.string(),
})

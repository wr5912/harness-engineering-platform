import { createAgent, tool } from 'langchain'
import { z } from 'zod'

const convert = tool(({ value, from, to }) => {
  if (from === to) return { value, unit: to }
  return { value: from === 'm' ? value * 100 : value / 100, unit: to }
}, { name: 'convert_length', description: '米与厘米换算', schema: z.object({ value: z.number().nonnegative(), from: z.enum(['m', 'cm']), to: z.enum(['m', 'cm']) }) })

export const sourceModel = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash', reasoningEffort: 'off' }
export function buildAgent(model: Parameters<typeof createAgent>[0]['model']) {
  return createAgent({ model, tools: [convert], systemPrompt: '必须用工具换算米和厘米。缺少单位先询问；不支持的单位明确说明。最终只输出符合约定的 JSON。', responseFormat: z.object({ value: z.number(), unit: z.enum(['m', 'cm']), explanation: z.string() }) })
}

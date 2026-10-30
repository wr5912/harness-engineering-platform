import { z } from 'zod'

export const automaticCaseIds = ['U-IDENTITY-001', 'U-ROLE-001'] as const
const caseText = z.string().trim().min(1).max(24000)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 24000, '业务用例正文不能超过 24000 字节')
  .refine(value => !/\bsk-[A-Za-z0-9_-]{12,}\b|(?:api[_-]?key|password|secret|authorization|cookie|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i.test(value), '业务用例正文包含凭据样式，请移除后再提交')
export const businessCaseSchema = z.object({
  id: z.string().regex(/^U-[A-Z0-9-]+$/, '业务用例 ID 必须以 U- 开头，只能包含大写字母、数字和连字符，例如 U-CHAT-GREET').refine(id => !automaticCaseIds.some(value => value === id), 'U-IDENTITY-001 和 U-ROLE-001 由平台自动创建；业务用例不能重新定义'),
  title: z.string().trim().min(1).max(240).refine(value => !/\r|\n/.test(value), '业务用例标题必须为单行'),
  inputs: z.union([caseText, z.array(caseText).min(1).max(20)]),
  expected_behavior: caseText.refine(value => !/^#{1,6}\s/m.test(value), '业务用例预期正文不能包含额外 Markdown 标题'),
  fast: z.boolean().default(false),
}).strict()
/** 新建智能体与工具参数共用可执行业务用例合同。 */
export const businessCasesSchema = z.array(businessCaseSchema).min(1).max(30)
  .refine(cases => new Set(cases.map(item => item.id)).size === cases.length, '业务用例 ID 不得重复')

/** 与权威评测解析器相同：每轮独立成块，换行仍属于同一轮输入。 */
export function businessCasesMarkdown(cases: z.infer<typeof businessCasesSchema>): string {
  return cases.map(item => {
    const turns = Array.isArray(item.inputs) ? item.inputs : [item.inputs]
    const inputs = turns.map((turn, index) => `**用户输入${turns.length > 1 ? ` ${index + 1}` : ''}**\n\n${turn.split(/\r?\n/).map(line => `> ${line}`).join('\n')}`).join('\n\n')
    return `\n#### ${item.id} ${item.title}\n\n${item.fast ? '**评估档位：** \`fast\`\n\n' : ''}${inputs}\n\n**预期**\n\n${item.expected_behavior}\n`
  }).join('\n')
}

import { z } from 'zod'

export const automaticCaseIds = ['U-IDENTITY-001', 'U-ROLE-001'] as const
const caseText = z.string().trim().min(1).max(24000)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 24000, '业务用例正文不能超过 24000 字节')
  .refine(value => !/\bsk-[A-Za-z0-9_-]{12,}\b|(?:api[_-]?key|password|secret|authorization|cookie|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i.test(value), '业务用例正文包含凭据样式，请移除后再提交')
export const businessCaseSchema = z.object({
  id: z.string().regex(/^U-[A-Z0-9-]+$/, '业务用例 ID 必须以 U- 开头，只能包含大写字母、数字和连字符，例如 U-CHAT-GREET').refine(id => !automaticCaseIds.some(value => value === id), 'U-IDENTITY-001 和 U-ROLE-001 由平台自动创建；业务用例不能重新定义'),
  title: z.string().trim().min(1).max(240).refine(value => !/\r|\n/.test(value), '业务用例标题必须为单行'),
  inputs: caseText,
  expected_behavior: caseText.refine(value => !/^#{1,6}\s/m.test(value), '业务用例预期正文不能包含额外 Markdown 标题'),
  fast: z.boolean().default(false),
}).strict()
/** 新建智能体与工具参数共用可执行业务用例合同。 */
export const businessCasesSchema = z.array(businessCaseSchema).min(1).max(30)
  .refine(cases => new Set(cases.map(item => item.id)).size === cases.length, '业务用例 ID 不得重复')

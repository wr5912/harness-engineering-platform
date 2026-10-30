import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import type { HarnessModelSelection } from './harness-runtime.ts'

export const name = 'harness-model-binding'
export const inject = ['systemPrompt']
interface Config { presetId: string; selection?: HarnessModelSelection; roleFile?: string; roleSha256?: string }

/** Preset 作用域只应用当前版本的运行投影；不改 Session 或部署默认模型。 */
export function apply(ctx: any, config: Config): void {
  if (!config || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.presetId)) throw new Error('Harness 角色绑定无效')
  const selected = config.selection ? Object.freeze({ ...config.selection }) : undefined
  if (selected && (!selected.provider || !selected.model)) throw new Error('Harness 角色模型绑定缺失')
  if (config.roleFile) {
    if (!config.roleFile.startsWith('/opt/harness-candidate/') || config.roleFile.split('/').includes('..')
      || lstatSync(config.roleFile).isSymbolicLink() || !lstatSync(config.roleFile).isFile()) throw new Error('Harness 角色指令文件无效')
    const text = readFileSync(config.roleFile, 'utf8')
    if (createHash('sha256').update(text).digest('hex') !== config.roleSha256) throw new Error('Harness 角色指令已变化，请重新启动实例')
    ctx.systemPrompt.section({ name: 'harness:role-instructions', order: 650, interpolate: false, text })
  }
  if (!selected) return
  // 原生控制器先安装 Session model-selection，随后才装载 Preset；外层 after-next 保持请求和提示词一致。
  ctx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: () => Promise<any>) => {
    const assembled = await next()
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
  }, { prepend: true })
  ctx.on('agent/request', async (_payload: any, next: () => Promise<any>) => {
    const { reasoningEffort: _inherited, ...resolved } = await next()
    return { ...resolved, provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
  }, { prepend: true })
}

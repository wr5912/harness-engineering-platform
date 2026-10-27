import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export interface NativeSkill {
  name: string
  path?: string
  content: string
  invocation?: { modelInvocable: boolean }
}
export interface NativeSkills {
  get(name: string, options: { cwd: string; scope?: any; signal?: AbortSignal }): Promise<NativeSkill | undefined>
}
export const managementSkills = ['workspace-management', 'task-builder', 'agent-maintenance', 'mcp-composition', 'compute-variant-research', 'decision-sample-extraction', 'harness-evolution', 'harness-experiment-fusion', 'research-eval', 'legacy-asset-intake', 'reviewing-agent-skills', 'user-facing-output'] as const
const coreSkills = ['workspace-management', 'user-facing-output']
export const managementSkillRoot = (root: string) => join(root, '.agents/skills')
const digest = (content: string) => createHash('sha256').update(content).digest('hex')

/** 引导入口已并入工作区管理；只规范当前上下文，不改写历史 Session 事件。 */
export function normalizeManagementContext(context: Record<string, any>) {
  return context.skill === 'harness-guided-workflow' ? { ...context, skill: 'workspace-management' } : context
}

/** 只接受当前数据工作区中的真实资产；重名程序技能或外部软链接不能替代它。 */
function realWorkspaceFile(root: string, path: string) {
  const base = realpathSync(root)
  const actual = realpathSync(path)
  const child = relative(base, actual)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || resolve(base, child) !== actual) throw new Error('资产超出当前数据工作区')
  return actual
}
export function managementPrinciples(root: string) {
  const path = realWorkspaceFile(root, join(root, 'AGENTS.md'))
  const content = readFileSync(path, 'utf8').trim()
  if (!content) throw new Error('管理助手 AGENTS.md 没有正文')
  return { path, content, sha256: digest(content) }
}
export async function managementSkill(root: string, skills: NativeSkills, name: string, scope?: any, signal?: AbortSignal) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称无效')
  const expected = realWorkspaceFile(root, join(managementSkillRoot(root), name, 'SKILL.md'))
  const withinSkills = relative(join(realpathSync(root), '.agents/skills'), expected)
  if (withinSkills === '..' || withinSkills.startsWith(`..${sep}`) || resolve(join(realpathSync(root), '.agents/skills'), withinSkills) !== expected) throw new Error('技能不在当前数据工作区 .agents/skills 中')
  const skill = await skills.get(name, { cwd: root, scope, signal })
  if (!skill?.path || realWorkspaceFile(root, skill.path) !== expected || !skill.content?.trim() || skill.name !== name || skill.invocation?.modelInvocable === false) throw new Error(`技能 ${name} 未从当前数据工作区装载`)
  return { ...skill, path: expected, sha256: digest(skill.content) }
}
/** 平台管理还可使用 workspace.json 已声明扩展提供的业务技能；核心资产来源保持固定。 */
export async function taskBusinessSkill(root: string, skills: NativeSkills, name: string, scope?: any, signal?: AbortSignal) {
  try { return await managementSkill(root, skills, name, scope, signal) }
  catch (error) { if (managementSkills.includes(name as typeof managementSkills[number])) throw error }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称无效')
  const descriptor = join(root, 'workspace.json')
  const extensions = existsSync(descriptor) ? JSON.parse(readFileSync(descriptor, 'utf8')).extensions ?? [] : []
  const skill = await skills.get(name, { cwd: root, scope, signal })
  if (!Array.isArray(extensions) || !skill?.path || skill.name !== name || !skill.content?.trim() || skill.invocation?.modelInvocable === false) throw new Error('扩展技能未装载')
  const actual = realWorkspaceFile(root, skill.path)
  const declared = extensions.some((extension: any) => {
    const path = extension?.path
    if (typeof path !== 'string' || !path.startsWith('extensions/') || path.split('/').includes('..')) return false
    const base = join(realpathSync(root), path, 'skills')
    const child = relative(base, actual)
    return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && resolve(base, child) === actual
  })
  if (!declared) throw new Error('技能不属于当前工作区已声明的业务扩展')
  return { ...skill, path: actual, sha256: digest(skill.content) }
}
export async function assistantConfiguration(root: string, skills: NativeSkills, context: Record<string, any> = {}, scope?: any, signal?: AbortSignal) {
  const assets: { name: string; ready: boolean; path: string; sha256?: string }[] = []
  try { const source = managementPrinciples(root); assets.push({ name: 'AGENTS.md', ready: true, path: source.path, sha256: source.sha256 }) }
  catch { assets.push({ name: 'AGENTS.md', ready: false, path: join(root, 'AGENTS.md') }) }
  assets.push(...await Promise.all(managementSkills.map(async name => {
    try { const source = await managementSkill(root, skills, name, scope, signal); return { name, ready: true, path: source.path, sha256: source.sha256 } }
    catch { signal?.throwIfAborted(); return { name, ready: false, path: join(managementSkillRoot(root), name, 'SKILL.md') } }
  })))
  const missing = assets.filter(item => !item.ready).map(item => item.name)
  const coreMissing = missing.filter(name => name === 'AGENTS.md' || coreSkills.includes(name))
  const normalized = normalizeManagementContext(context)
  const requested = typeof normalized.skill === 'string' ? normalized.skill : 'workspace-management'
  const requestedReady = assets.some(item => item.name === requested && item.ready)
  const ready = coreMissing.length === 0 && requestedReady
  const message = coreMissing.length ? `当前工作区未配置平台管理助手，缺少或无法装载：${coreMissing.join('、')}。请连接或克隆包含管理助手业务资产的数据仓库。`
    : !requestedReady ? `当前工作区未配置此任务所需的技能：${requested}。请恢复数据仓库中对应的 .agents/skills 资产。` : ''
  return { ready, core_ready: coreMissing.length === 0, missing, requested_skill: requested, message, assets,
    tasks: Object.fromEntries(managementSkills.map(name => [name, coreMissing.length === 0 && !missing.includes(name)])) }
}
export async function assertAssistantConfigured(root: string, skills: NativeSkills, context: Record<string, any> = {}, scope?: any, signal?: AbortSignal) {
  const state = await assistantConfiguration(root, skills, context, scope, signal)
  if (!state.ready) throw new Error(state.message)
  return state
}

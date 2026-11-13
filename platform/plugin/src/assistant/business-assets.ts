import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { managerHome } from '../manager-home.ts'
import { managerWorkspaceRoot } from '../workspace.ts'

export interface NativeSkill {
  name: string
  path?: string
  content: string
  invocation?: { modelInvocable: boolean }
}
export interface NativeSkills {
  get(name: string, options: { cwd: string; scope?: any; signal?: AbortSignal }): Promise<NativeSkill | undefined>
}
export const managementSkills = ['workspace-management', 'task-builder', 'agent-maintenance', 'agent-migration', 'mcp-composition', 'compute-variant-research', 'decision-sample-extraction', 'harness-evolution', 'harness-experiment-fusion', 'research-eval', 'legacy-asset-intake', 'reviewing-agent-skills', 'user-facing-output'] as const
const coreSkills = ['workspace-management', 'user-facing-output']
export const managementSkillRoot = (root: string) => join(managerHome(root), '.agents/skills')
const digest = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex')

/** 引导入口已并入工作区管理；只规范当前上下文，不改写历史 Session 事件。 */
export function normalizeManagementContext(context: Record<string, any>) {
  return context.skill === 'harness-guided-workflow' ? { ...context, skill: 'workspace-management' } : context
}

/** 管理能力从该工作区绑定的 DSH HOME 装载。 */
function realWorkspaceFile(root: string, path: string) {
  const base = realpathSync(root)
  const actual = realpathSync(path)
  const child = relative(base, actual)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || resolve(base, child) !== actual) throw new Error('资产超出管理助手 HOME')
  return actual
}
export function managementPrinciples(root: string) {
  const home = managerHome(root)
  const path = realWorkspaceFile(home, join(home, 'AGENTS.md'))
  const source = readFileSync(path)
  const content = source.toString('utf8').trim()
  if (!content) throw new Error('管理助手 AGENTS.md 没有正文')
  return { path, content, sha256: digest(source) }
}
export async function managementSkill(root: string, skills: NativeSkills, name: string, scope?: any, signal?: AbortSignal) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称无效')
  const home = managerHome(root)
  const expected = realWorkspaceFile(home, join(managementSkillRoot(root), name, 'SKILL.md'))
  const skillRoot = join(realpathSync(home), '.agents/skills')
  const withinSkills = relative(skillRoot, expected)
  if (withinSkills === '..' || withinSkills.startsWith(`..${sep}`) || resolve(skillRoot, withinSkills) !== expected) throw new Error('技能不在管理助手 HOME .agents/skills 中')
  const skill = await skills.get(name, { cwd: managerWorkspaceRoot(root), scope, signal })
  if (!skill?.path || realWorkspaceFile(home, skill.path) !== expected || !skill.content?.trim() || skill.name !== name || skill.invocation?.modelInvocable === false) throw new Error(`技能 ${name} 未从管理助手 HOME 装载`)
  return { ...skill, path: expected, sha256: digest(readFileSync(expected)) }
}
export async function assistantConfiguration(root: string, skills: NativeSkills, context: Record<string, any> = {}, scope?: any, signal?: AbortSignal) {
  const assets: { name: string; ready: boolean; path: string; sha256?: string }[] = []
  try { const source = managementPrinciples(root); assets.push({ name: 'AGENTS.md', ready: true, path: source.path, sha256: source.sha256 }) }
  catch { assets.push({ name: 'AGENTS.md', ready: false, path: join(managerHome(root), 'AGENTS.md') }) }
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
  const message = coreMissing.length ? `当前工作区未配置平台管理助手，缺少或无法装载：${coreMissing.join('、')}。请配置平台管理助手 DSH HOME。`
    : !requestedReady ? `当前工作区未配置此任务所需的技能：${requested}。请恢复管理助手 HOME 中对应的 .agents/skills 资产。` : ''
  return { ready, core_ready: coreMissing.length === 0, missing, requested_skill: requested, message, assets,
    tasks: Object.fromEntries(managementSkills.map(name => [name, coreMissing.length === 0 && !missing.includes(name)])) }
}

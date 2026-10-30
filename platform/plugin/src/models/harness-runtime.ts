import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DEFAULT_SCHEMA, Type, dump, load } from 'js-yaml'

export type HarnessModelSelection = { provider: string; model: string; reasoningEffort?: string }
export interface HarnessRuntime {
  harness_sha256: string
  main_preset: string
  preset_files: Record<string, string>
  model_bindings?: { main: HarnessModelSelection; presets: Record<string, HarnessModelSelection> }
  project_workspace?: { path: string }
  role_instructions: Record<string, string>
}
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/
const CANDIDATE_MOUNT = '/opt/harness-candidate'
export const MODEL_BINDING_CONTAINER = '/opt/harness-model-runtime/model-binding-runtime.mjs'
const presetSchema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (value: string | null) => new String(value ?? ''),
  predicate: (value: unknown) => value instanceof String, represent: (value: String) => String(value),
} as any))
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness 运行声明必须是对象')
  return value as Record<string, any>
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Harness 路径必须位于 Candidate 内')
  return value
}
function model(value: unknown): HarnessModelSelection {
  const selected = object(value)
  if (Object.keys(selected).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))
    || typeof selected.provider !== 'string' || !MODEL.test(selected.provider) || typeof selected.model !== 'string' || !MODEL.test(selected.model)
    || selected.reasoningEffort !== undefined && (typeof selected.reasoningEffort !== 'string' || !selected.reasoningEffort || selected.reasoningEffort.length > 128)) {
    throw new Error('model_bindings 必须声明原生 provider、model 和可选 reasoningEffort')
  }
  return { provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
}

/** 装载与平台投影共用同一声明解析；不加载来源代码或 Runtime HOME。 */
export function parseHarnessRuntime(text: string): HarnessRuntime | undefined {
  const harness = object(load(text))
  if (harness.model_bindings === undefined && harness.project_workspace === undefined && harness.role_instructions === undefined) return undefined
  const assets = object(harness.loadable_assets), main = assets.preset_id
  if (typeof main !== 'string' || !ID.test(main)) throw new Error('Harness 主 Preset ID 无效')
  const runtime: HarnessRuntime = { harness_sha256: createHash('sha256').update(text).digest('hex'), main_preset: main,
    preset_files: { [main]: path(`dsh/presets/${assets.preset_file ?? `${main}/agent.cordis.yml`}`) }, role_instructions: {} }
  if (harness.model_bindings !== undefined) {
    const bindings = object(harness.model_bindings)
    if (Object.keys(bindings).some(key => !['main', 'presets'].includes(key))) throw new Error('model_bindings 只支持 main 与 presets')
    const presets: Record<string, HarnessModelSelection> = {}
    for (const [id, value] of Object.entries(bindings.presets === undefined ? {} : object(bindings.presets))) {
      if (!ID.test(id) || id === main) throw new Error('子 Preset 绑定 ID 无效，主模型只在 main 维护')
      presets[id] = model(value)
      runtime.preset_files[id] = `dsh/presets/${id}/agent.cordis.yml`
    }
    runtime.model_bindings = { main: model(bindings.main), presets }
  }
  if (harness.project_workspace !== undefined) {
    const workspace = object(harness.project_workspace)
    if (Object.keys(workspace).some(key => key !== 'path')) throw new Error('project_workspace 只支持 Candidate 内的 path')
    runtime.project_workspace = { path: path(workspace.path) }
  }
  for (const [id, file] of Object.entries(harness.role_instructions === undefined ? {} : object(harness.role_instructions))) {
    if (!ID.test(id)) throw new Error('角色指令的 Preset ID 无效')
    runtime.role_instructions[id] = path(file)
    runtime.preset_files[id] ??= `dsh/presets/${id}/agent.cordis.yml`
  }
  return runtime
}

export function assertCandidatePath(candidate: string, file: string, directory = false): string {
  const root = resolve(candidate), target = resolve(root, path(file))
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Candidate 必须是普通目录')
  let cursor = root
  for (const part of relative(root, target).split('/')) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Candidate 路径不能包含符号链接：${file}`)
  }
  const info = lstatSync(target)
  if (directory ? !info.isDirectory() : !info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`Candidate 资产不可读取：${file}`)
  return target
}

export function resolveHarnessRuntime(assetRoot: string, agentId: string, candidatePath?: string): HarnessRuntime | undefined {
  if (!candidatePath) return undefined
  const candidate = resolve(candidatePath), root = resolve(assetRoot)
  if (!candidate.startsWith(`${root}/evolution/experiments/`) || !candidate.endsWith('/candidate')) throw new Error('运行来源必须是所选工作区的 Candidate')
  const change = object(load(readFileSync(assertCandidatePath(dirname(candidate), 'change.yaml'), 'utf8')))
  if (change.agent_id !== agentId) throw new Error('运行绑定的来源 Agent 不一致')
  const runtime = parseHarnessRuntime(readFileSync(assertCandidatePath(candidate, 'harness.yaml'), 'utf8'))
  if (!runtime) return undefined
  for (const file of Object.values(runtime.preset_files)) assertCandidatePath(candidate, file)
  for (const file of Object.values(runtime.role_instructions)) assertCandidatePath(candidate, file)
  if (runtime.project_workspace) assertCandidatePath(candidate, runtime.project_workspace.path, true)
  return runtime
}

function assertPlainTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('运行投影不接受符号链接或特殊文件')
    if (entry.isDirectory()) assertPlainTree(file)
  }
}

/** 生成只读原生 Preset 投影；来源配置和模型绑定均不回写。 */
export function projectHarnessPresets(candidate: string, destination: string, runtime: HarnessRuntime): void {
  const source = assertCandidatePath(candidate, 'dsh/presets', true)
  assertPlainTree(source)
  if (existsSync(destination)) throw new Error('Preset 投影目标已存在')
  cpSync(source, destination, { recursive: true })
  const allBindings: Record<string, HarnessModelSelection> = runtime.model_bindings ? { [runtime.main_preset]: runtime.model_bindings.main, ...runtime.model_bindings.presets } : {}
  for (const [id, file] of Object.entries(runtime.preset_files)) {
    const target = join(destination, relative('dsh/presets', file)), rows = load(readFileSync(target, 'utf8'), { schema: presetSchema })
    if (!Array.isArray(rows)) throw new Error(`Preset 配置必须是插件列表：${id}`)
    const projectRows = (plugins: any[]): any[] => plugins.map(value => {
      if (!value || typeof value !== 'object' || value.disabled === true) return value
      const config = value.config
      if (value.group === true && Array.isArray(config)) return { ...value, config: projectRows(config) }
      if (config?.harnessModelRole !== undefined) {
        const role = config.harnessModelRole
        if (typeof value.name !== 'string' || !/^(?:file:\/\/)?\/opt\/dsh-managed\/[a-zA-Z0-9_./-]+\.mjs$/.test(value.name)
          || value.name.split('/').includes('..') || typeof role !== 'string' || !Object.hasOwn(allBindings, role)) throw new Error('Managed 委派插件必须引用已声明的 harnessModelRole')
        if (config.agentPreset !== undefined && config.agentPreset !== role) throw new Error('委派 Preset 与 harnessModelRole 不一致')
        const options = config.agentOptions ?? {}
        if (!options || typeof options !== 'object' || Array.isArray(options)
          || ['provider', 'model', 'reasoningEffort'].some(key => Object.hasOwn(options, key))) throw new Error('委派模型只在 harness.yaml 的 model_bindings 中维护')
        return { ...value, config: { ...config, agentPreset: role, agentOptions: { ...options, ...allBindings[role] } } }
      }
      const delegate = value.name === '@deepseek-ai/dsh-tool-subagent' || typeof value.name === 'string' && /\/tool-subagent\/(?:lib\/)?index\.(?:js|mjs|ts)$/.test(value.name)
      // 固定 Preset 的原生委派工具在创建前拿到完整模型，使持久 descriptor 与请求一致。
      if (delegate && config?.agentPreset && allBindings[config.agentPreset]) {
        const { reasoningEffort: _oldEffort, ...options } = config.agentOptions ?? {}
        return { ...value, config: { ...config, agentOptions: { ...options, ...allBindings[config.agentPreset] }, modelSelectionSettings: false } }
      }
      if (delegate && Array.isArray(config?.allowedAgentPresets) && config.allowedAgentPresets.some((preset: string) => allBindings[preset])) {
        throw new Error('绑定不同模型的委派请生成每个角色独立的固定 agentPreset 工具')
      }
      return value
    })
    const projected = projectRows(rows)
    const role = runtime.role_instructions[id], selection = allBindings[id]
    if (role || selection) {
      if (projected.some(value => value?.id === 'harness-model-binding')) throw new Error('来源 Preset 不应维护生成的 harness-model-binding 投影')
      const roleText = role ? readFileSync(assertCandidatePath(candidate, role), 'utf8') : undefined
      projected.push({ id: 'harness-model-binding', name: `file://${MODEL_BINDING_CONTAINER}`, config: {
        presetId: id, ...(selection ? { selection } : {}), ...(role ? { roleFile: `${CANDIDATE_MOUNT}/${role}`,
          roleSha256: createHash('sha256').update(roleText!).digest('hex') } : {}),
      } })
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, dump(projected, { schema: presetSchema, noRefs: true, lineWidth: -1 } as any))
  }
}

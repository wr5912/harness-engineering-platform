import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(new URL('../plugin/package.json', import.meta.url))
const yaml = () => require('js-yaml') as { load(text: string, options?: object): any; dump(value: unknown, options?: object): string; DEFAULT_SCHEMA: { extend(types: unknown[]): unknown }; Type: new (name: string, options: object) => unknown }
export const repositoryNames = { platform: 'harness-engineering-platform', data: 'harness-engineering-platform-data', platform_manager_dsh_home: 'platform-manager-dsh-home', business_agents: 'business-agents' } as const
export type RepositoryKey = keyof typeof repositoryNames
export interface RepositoryInput { url: string; ref?: string; commit?: string }
export interface RepositoryState extends RepositoryInput { commit: string; path: string }
export interface LabManifest {
  schema_version: 1
  initializer_version: 2
  created_at: string
  repositories: Record<RepositoryKey, RepositoryState>
  paths: { dsh_home: string; business_agents_root: string }
}
export interface InitOptions {
  destination: string
  repositories: Partial<Record<RepositoryKey, RepositoryInput>>
  allowFloatingRef?: boolean
  checkOnly?: boolean
  reuse?: boolean
}
export interface Finding { code: string; path?: string; message: string }
const commitPattern = /^[0-9a-f]{40}$/
const keys = Object.keys(repositoryNames) as RepositoryKey[]
function fail(message: string): never { throw new Error(message) }
function git(cwd: string | undefined, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...(cwd ? ['-C', cwd] : []), ...args], { encoding: 'utf8', timeout: ['clone', 'fetch'].includes(args[0]) ? 900_000 : 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0 || result.error) {
    const detail = (result.error?.message || result.stderr || '').trim().split('\n').slice(-4).join('\n')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@')
    fail(`Git ${args[0]} 失败${detail ? '：' + detail : '，请核对仓库地址、认证和版本'}`)
  }
  return result.stdout.trim()
}
function clean(root: string) {
  if (git(root, ['status', '--porcelain', '--untracked-files=all'])) fail(`工作树存在未提交修改：${root}`)
}
function repositoryUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || value.startsWith('-')) fail('仓库地址无效')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value)
    if (!['http:', 'https:', 'ssh:', 'file:'].includes(url.protocol) || url.password || url.username && url.protocol !== 'ssh:' || url.search || url.hash) fail('仓库地址不得包含凭据、查询参数或片段')
  } else if (!isAbsolute(value) && !/^git@[a-zA-Z0-9.-]+:[\w./-]+$/.test(value)) fail('仓库地址须为绝对本地路径、file/http/https/ssh URL 或 git@ SSH 地址')
  return value
}
function inputOf(input: RepositoryInput): RepositoryInput {
  const url = repositoryUrl(input?.url)
  if (input.commit !== undefined && !commitPattern.test(input.commit)) fail('commit 必须是完整的 40 位小写 Git SHA')
  if (input.ref !== undefined && (!input.ref || input.ref.startsWith('-') || !/^[\w./-]+$/.test(input.ref) || input.ref.includes('..'))) fail('ref 无效')
  return { url, ...(input.ref ? { ref: input.ref } : {}), ...(input.commit ? { commit: input.commit } : {}) }
}
function readYaml(path: string): any {
  try { return yaml().load(readFileSync(path, 'utf8')) }
  catch { return fail(`YAML 无法读取或格式无效：${path}`) }
}
function writeYaml(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try { writeFileSync(temporary, yaml().dump(value, { noRefs: true, lineWidth: 140 }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}
function safeDirectory(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) fail(`目录不能经过符号链接或普通文件：${current}`)
    if (dirname(current) === current) break
  }
}
function normalizeLock(value: any): Partial<RepositoryInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('仓库锁定格式无效')
  return { url: value.url ?? value.repository ?? value.source_repository, ref: value.ref ?? value.source_ref, commit: value.commit ?? value.source_commit }
}
export function repositoryLocks(dataRoot: string): Partial<Record<RepositoryKey, Partial<RepositoryInput>>> {
  const result: Partial<Record<RepositoryKey, Partial<RepositoryInput>>> = {}
  const combined = join(dataRoot, 'locks/repositories.yaml')
  if (existsSync(combined)) {
    const value = readYaml(combined)
    for (const key of keys) if (value?.repositories?.[key] ?? value?.[key]) result[key] = normalizeLock(value.repositories?.[key] ?? value[key])
  }
  for (const key of keys) {
    const path = join(dataRoot, 'locks', `${repositoryNames[key]}.yaml`)
    if (existsSync(path)) {
      const item = normalizeLock(readYaml(path))
      if (result[key] && Object.entries(item).some(([field, value]) => value !== undefined && result[key]?.[field as keyof RepositoryInput] !== undefined && result[key]?.[field as keyof RepositoryInput] !== value)) fail(`仓库锁定内容冲突：${key}`)
      result[key] = { ...result[key], ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) }
    }
  }
  return result
}
function withLock(input: RepositoryInput, lock?: Partial<RepositoryInput>): RepositoryInput {
  if (!lock) return input
  for (const field of ['url', 'ref', 'commit'] as const) if (lock[field] !== undefined && input[field] !== undefined && lock[field] !== input[field]) fail(`输入与仓库锁定的 ${field} 不一致`)
  return inputOf({ ...input, ...Object.fromEntries(Object.entries(lock).filter(([, value]) => value !== undefined)) })
}
function inspectRepository(root: string, input: RepositoryInput, reuse: boolean): RepositoryState | undefined {
  if (!existsSync(root)) return undefined
  safeDirectory(root)
  if (!readdirSync(root).length) return undefined
  if (!existsSync(join(root, '.git'))) fail(`目标目录非空且不是 Git 工作树：${root}`)
  if (!reuse) fail(`已有仓库需要 --reuse：${root}`)
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== realpathSync(root)) fail(`仓库根目录不匹配：${root}`)
  clean(root)
  const identity = (url: string) => url.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git\/?$/, '').replace(/\/$/, '')
  const matches = git(root, ['remote']).split('\n').filter(Boolean).some(remote => identity(git(root, ['remote', 'get-url', remote])) === identity(input.url))
  if (!matches) fail(`已有仓库来源不匹配：${root}`)
  const commit = git(root, ['rev-parse', 'HEAD'])
  if (input.commit && input.commit !== commit) fail(`已有仓库提交不同，请先查看 update --plan-only：${root}`)
  if (input.ref && !input.commit) {
    const value = git(root, ['rev-parse', '--verify', `${input.ref}^{commit}`])
    if (value !== commit) fail(`已有仓库 ref 与当前提交不一致：${root}`)
  }
  return { ...input, commit, path: root }
}
function resolveRemote(input: RepositoryInput): string {
  if (input.commit) return input.commit
  const ref = input.ref ?? 'HEAD'
  const rows = git(undefined, ['ls-remote', input.url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]).split('\n').filter(Boolean).map(line => line.split(/\s+/))
  const peeled = rows.find(row => row[1]?.endsWith('^{}'))
  const found = peeled?.[0] ?? rows[0]?.[0]
  if (!found || !commitPattern.test(found)) fail('仓库 ref 不存在或仓库尚无提交')
  if (input.commit && found !== input.commit) fail('仓库 ref 与指定 commit 不一致')
  return found
}
function remoteRepositoryLocks(input: RepositoryInput): Partial<Record<RepositoryKey, Partial<RepositoryInput>>> {
  const temporary = mkdtempSync(join(tmpdir(), 'hep-lab-lock-'))
  try {
    const commit = resolveRemote(input)
    git(undefined, ['clone', '--no-checkout', '--', input.url, temporary])
    try { git(temporary, ['cat-file', '-e', `${commit}^{commit}`]) }
    catch { git(temporary, ['fetch', '--no-tags', 'origin', commit]) }
    git(temporary, ['checkout', '--detach', commit])
    return repositoryLocks(temporary)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
function completeInputs(root: string, provided: Partial<Record<RepositoryKey, RepositoryInput>>, allowFloatingRef: boolean, checkOnly: boolean) {
  const dataInput = provided.data
  if (!dataInput) fail('至少需要 --data-repository；其余仓库可从数据仓库 locks/repositories.yaml 推导')
  const normalized: Partial<Record<RepositoryKey, RepositoryInput>> = {}
  for (const key of keys) if (provided[key]) normalized[key] = inputOf(provided[key]!)
  let locks = existsSync(join(root, repositoryNames.data, '.git')) ? repositoryLocks(join(root, repositoryNames.data)) : {}
  const missing = keys.some(key => !normalized[key])
  if (missing && !Object.keys(locks).length) {
    if (checkOnly) fail('check-only 缺少本地数据仓库锁定文件，不能 clone/fetch；请补齐四仓库参数或先准备数据仓库')
    locks = remoteRepositoryLocks(normalized.data!)
  }
  for (const key of keys) {
    const current = normalized[key]
    const lock = locks[key]
    if (!current && !lock) fail(`${key} 未提供且数据仓库锁定文件中没有对应来源`)
    normalized[key] = withLock(current ?? inputOf(lock!), lock)
  }
  if (!allowFloatingRef) for (const key of keys) if (!normalized[key]!.commit) fail(`${key} 缺少 commit 锁定；开发环境可显式使用 --allow-floating-ref`)
  return normalized as Record<RepositoryKey, RepositoryInput>
}
function manifestPath(lab: string) { return join(resolve(lab), 'hep-lab.yaml') }
function legacyMetadataPath(lab: string) { return join(resolve(lab), '.hep-lab') }
function checkWorkspaceMetadata(lab: string) {
  if (!existsSync(legacyMetadataPath(lab))) return
  // 工作区控制仓维护开发上下文；与 hep-lab.yaml 的运行清单独立。
  const source = join(legacyMetadataPath(lab), 'sources.json')
  try { if (JSON.parse(readFileSync(source, 'utf8')).schema_version === 1) return } catch {}
  fail('检测到已移除的 .hep-lab 元数据目录，或缺少工作区 sources.json；请核对来源后迁移')
}
export function readLab(lab: string): LabManifest {
  const root = resolve(lab)
  safeDirectory(root)
  checkWorkspaceMetadata(root)
  const manifest = readYaml(manifestPath(root)) as LabManifest
  if (manifest?.schema_version !== 1 || manifest.initializer_version !== 2 || !manifest.repositories) fail('hep-lab 清单版本不受支持，请重新初始化')
  for (const key of keys) {
    const item = manifest.repositories[key]
    inputOf(item)
    if (!commitPattern.test(item?.commit) || item.path !== join(root, repositoryNames[key])) fail(`hep-lab 仓库清单路径或提交无效：${key}`)
  }
  if (manifest.paths?.dsh_home !== join(root, repositoryNames.platform_manager_dsh_home)
    || manifest.paths.business_agents_root !== join(root, repositoryNames.business_agents)) fail('hep-lab 运行路径无效')
  return manifest
}
export function statusLab(lab: string) {
  const manifest = readLab(lab)
  return { manifest, repositories: Object.fromEntries(keys.map(key => {
    const item = manifest.repositories[key]
    try {
      const current = git(item.path, ['rev-parse', 'HEAD'])
      const dirty = Boolean(git(item.path, ['status', '--porcelain', '--untracked-files=all']))
      return [key, { ...item, current_commit: current, dirty, matches_lock: current === item.commit }]
    } catch { return [key, { ...item, available: false, matches_lock: false }] }
  })) }
}
function tracked(root: string): string[] { return git(root, ['ls-files', '-z']).split('\0').filter(Boolean) }
function nestedRepositories(root: string): string[] {
  const found: string[] = [], pending = [root]
  let visited = 0
  while (pending.length) for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
    if (++visited > 100_000) fail('仓库结构扫描超过 100000 个节点')
    if (!entry.isDirectory() || ['node_modules', '.local', '.git'].includes(entry.name)) continue
    const directory = join(entry.parentPath, entry.name)
    if (existsSync(join(directory, '.git'))) found.push(directory)
    else pending.push(directory)
  }
  return found
}
function sensitivePath(path: string) {
  return path.split('/').some(part => /^\.env(?:\.|$)/.test(part) && !['.env.example', '.env.template'].includes(part) || /^(?:\.credentials(?:\.|$)|\.openai-.*auth|id_rsa$|id_ed25519$)/.test(part)
    || /\.(?:llm-api-key|pem|key|p12|pfx)$/.test(part) || ['node_modules', 'sessions', 'attachments', 'storages', 'cache', 'logs', '__pycache__'].includes(part))
}
export function inspectLab(manifest: LabManifest) {
  const issues: Finding[] = [], warnings: Finding[] = []
  for (const key of keys) {
    const item = manifest.repositories[key]
    try {
      inspectRepository(item.path, item, true)
    } catch (error) { issues.push({ code: 'repository_state', path: item.path, message: error instanceof Error ? error.message : '仓库无法核对' }) }
    try {
      for (const path of nestedRepositories(item.path)) issues.push({ code: 'nested_repository', path, message: '仓库内不允许嵌套 Git 工作树' })
      for (const path of tracked(item.path)) {
        if (key !== 'platform' && key !== 'data' && sensitivePath(path)) issues.push({ code: 'runtime_or_secret_path', path: join(item.path, path), message: '运行状态、凭据及依赖目录不得提交' })
        if (key !== 'platform' && key !== 'data' && /\.(?:ya?ml|json|env|ts|mts|mjs|js|md)$/.test(path)) {
          const file = join(item.path, path)
          if (lstatSync(file).isFile() && lstatSync(file).size <= 2 * 1024 * 1024 && /\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(file, 'utf8'))) issues.push({ code: 'secret_content', path: file, message: '文件包含疑似密钥，未输出内容' })
        }
      }
    } catch (error) { issues.push({ code: 'repository_state', path: item.path, message: error instanceof Error ? error.message : '仓库无法核对' }) }
  }
  const data = manifest.repositories.data.path, business = manifest.repositories.business_agents
  try {
    const locks = repositoryLocks(data)
    for (const key of keys) withLock(manifest.repositories[key], locks[key])
  } catch (error) { issues.push({ code: 'lock_mismatch', message: (error as Error).message }) }
  const registry = join(data, 'registry/agents'), ids = new Set<string>()
  if (!existsSync(registry)) warnings.push({ code: 'registry_missing', path: registry, message: '未找到业务仓库登记，未完成 Agent 引用校验' })
  else for (const file of readdirSync(registry).filter(name => /\.ya?ml$/.test(name)).sort()) {
    try {
      const item = readYaml(join(registry, file)), id = item?.agent_id, path = item?.agent_path ?? item?.source_path
      if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) fail('Agent ID 无效或重复')
      ids.add(id)
      if (item.source_repository !== business.url || item.source_commit !== business.commit) fail('Agent 来源仓库或提交与锁定不一致')
      if (typeof path !== 'string' || !(path === `agents/${id}` || path.startsWith(`agents/${id}/`)) || path.includes('..') || path.includes('\\') || !existsSync(join(business.path, path, 'harness.yaml'))) fail('Agent 源码路径无效或不存在')
    } catch (error) { issues.push({ code: 'agent_reference', path: join(registry, file), message: (error as Error).message }) }
  }
  if (existsSync(join(data, 'agents/platform-owned')) || existsSync(join(data, 'dsh-home-profile'))) issues.push({ code: 'duplicate_source_root', path: data, message: '数据仓库仍存在应迁移的业务源码或管理 HOME 路径' })
  const home = manifest.paths.dsh_home
  if (!existsSync(join(home, 'profiles'))) issues.push({ code: 'dsh_home', path: home, message: 'DSH Home 缺少原生 profiles 目录' })
  const runtimeVersion = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, DSH_HOME: home } })
  const actual = runtimeVersion.status === 0 ? runtimeVersion.stdout.trim() : undefined
  let expected: string | undefined
  try { expected = JSON.parse(readFileSync(join(manifest.repositories.platform.path, 'platform/plugin/package.json'), 'utf8')).peerDependencies?.['@deepseek-ai/dsh-agent'] } catch { /* 无插件清单的 fixture 不作兼容声明。 */ }
  inspectProfiles(home, expected, issues, warnings)
  if (!actual) warnings.push({ code: 'dsh_unavailable', message: '无法读取 dsh 版本，运行兼容性尚未核对' })
  else if (expected && actual !== expected) issues.push({ code: 'dsh_version', message: `DSH ${actual} 与平台要求 ${expected} 不一致` })
  return { valid: issues.length === 0, issues, warnings, agent_count: ids.size, runtime: { expected_version: expected, actual_version: actual, startup_smoke: 'not_run', business_evaluation: 'not_run' } }
}
/** 静态读取原生 Profile；!!js 只保留文本，绝不执行配置表达式。 */
function inspectProfiles(home: string, expected: string | undefined, issues: Finding[], warnings: Finding[]) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return
  const entry = process.env.HARNESS_DSH_ENTRY || (process.env.PATH ?? '').split(delimiter).map(path => join(path, 'dsh')).find(path => existsSync(path))
  let resolveBundle: ((name: string, profile: string) => unknown) | undefined
  try {
    if (entry) {
      const anchor = realpathSync(entry), native = createRequire(anchor)('@deepseek-ai/dsh-app-boot')
      resolveBundle = (name, profile) => native.resolveBundleDir('dsh', name, anchor, profile)
    }
  } catch { /* 未安装 DSH 时仍可静态检查 Profile 本地依赖。 */ }
  const library = yaml(), schema = library.DEFAULT_SCHEMA.extend([new library.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value: string) => value })])
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const profile = join(profiles, entry.name), manifestPath = join(profile, 'package.json')
    if (!existsSync(manifestPath)) { issues.push({ code: 'profile_manifest', path: profile, message: 'Profile 缺少 package.json' }); continue }
    try {
      let value: any
      try { value = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { fail('Profile package.json 格式无效') }
      if (!Array.isArray(value.dsh?.profile?.bundles)) fail('Profile 未声明原生 bundle 清单')
      for (const [name, spec] of Object.entries(value.dependencies ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-') && expected && spec !== expected) fail(`Profile 的 ${name} 与平台 DSH 版本不一致`)
        if (typeof spec === 'string' && /^(?:file:|link:)\//.test(spec)) fail('稳定 Profile 不得依赖机器绝对路径')
      }
      const resolver = createRequire(manifestPath)
      for (const name of value.dsh.profile.bundles) {
        if (typeof name !== 'string') fail('Profile bundle 名称无效')
        try {
          if (resolveBundle) resolveBundle(name, profile)
          else if (!(resolver.resolve.paths(name) ?? []).some(path => existsSync(join(path, name, 'package.json')))) throw new Error('bundle not installed')
        } catch { warnings.push({ code: 'profile_dependency_pending', path: profile, message: `Profile bundle ${name} 尚未安装；请运行平台 prepare` }) }
      }
      for (const file of ['cordis.yml', 'cordis.patch.yml'].filter(name => existsSync(join(profile, name)))) {
        const path = join(profile, file), source = readFileSync(path, 'utf8')
        if (/\{\{HARNESS_[A-Z_]+\}\}/.test(source)) fail('Profile 含未解析的路径模板')
        let parsed: any
        try { parsed = library.load(source, { schema }) } catch { fail('Profile YAML 格式无效') }
        if (parsed !== undefined && !Array.isArray(parsed)) fail('原生 Cordis Profile 应为 patch 数组')
        const visit = (items: any[]) => {
          for (const item of items) {
            if (!item || typeof item !== 'object') continue
            if (typeof item.name === 'string' && isAbsolute(item.name) && !existsSync(item.name)) fail('Profile 插件引用文件不存在')
            if (Array.isArray(item.insert)) visit(item.insert)
          }
        }
        if (parsed) visit(parsed)
      }
    } catch (error) { issues.push({ code: 'profile_configuration', path: profile, message: (error as Error).message }) }
  }
}
export function doctorLab(lab: string) { return inspectLab(readLab(lab)) }
export function initializeLab(options: InitOptions) {
  const root = resolve(options.destination)
  safeDirectory(root)
  checkWorkspaceMetadata(root)
  const existingManifest = existsSync(manifestPath(root)) ? readLab(root) : undefined
  const allowed = new Set([...Object.values(repositoryNames), 'hep-lab.yaml', '.hep-lab', '.git', '.gitignore', '.agents', 'AGENTS.md', 'README.md', 'tools', 'skills'])
  if (existsSync(root) && readdirSync(root).some(name => !allowed.has(name))) fail('目标目录含非 hep-lab 内容，请使用空目录')
  const inputs = completeInputs(root, options.repositories, Boolean(options.allowFloatingRef), Boolean(options.checkOnly))
  let locks = existsSync(join(root, repositoryNames.data, '.git')) ? repositoryLocks(join(root, repositoryNames.data)) : {}
  const states = {} as Record<RepositoryKey, RepositoryState>
  // 在任何写入前检查全部已存在工作树，避免后续失败覆盖用户改动。
  for (const key of keys) {
    inputs[key] = withLock(inputs[key], locks[key])
    const state = inspectRepository(join(root, repositoryNames[key]), inputs[key], Boolean(options.reuse))
    if (state) states[key] = state
  }
  for (const key of keys) {
    if (!inputs[key].commit && !options.allowFloatingRef) fail(`${key} 缺少 commit 锁定；开发环境可显式使用 --allow-floating-ref`)
    const commit = resolveRemote(inputs[key])
    if (states[key] && states[key].commit !== commit) fail(`已有仓库与远端 ref 不一致：${key}`)
    inputs[key] = { ...inputs[key], commit }
  }
  if (options.checkOnly) return { check_only: true, repositories: inputs, existing: Object.keys(states) }
  mkdirSync(root, { recursive: true })
  // 先检出数据，再校验其锁定；锁冲突仅保留新检出的数据，不继续其他仓库。
  for (const key of ['data', ...keys.filter(key => key !== 'data')] as RepositoryKey[]) {
    if (!states[key]) {
      const path = join(root, repositoryNames[key])
      git(undefined, ['clone', '--no-checkout', '--', inputs[key].url, path])
      try { git(path, ['cat-file', '-e', `${inputs[key].commit}^{commit}`]) }
      catch { git(path, ['fetch', '--no-tags', 'origin', inputs[key].commit!]) }
      git(path, ['checkout', '--detach', inputs[key].commit!])
      states[key] = { ...inputs[key], path, commit: inputs[key].commit! }
    }
    if (key === 'data') {
      locks = repositoryLocks(states.data.path)
      for (const candidate of keys) inputs[candidate] = withLock(inputs[candidate], locks[candidate])
    }
  }
  const manifest: LabManifest = { schema_version: 1, initializer_version: 2, created_at: existingManifest?.created_at ?? new Date().toISOString(), repositories: Object.fromEntries(keys.map(key => [key, states[key]])) as Record<RepositoryKey, RepositoryState>,
    paths: { dsh_home: join(root, repositoryNames.platform_manager_dsh_home), business_agents_root: join(root, repositoryNames.business_agents) } }
  const validation = inspectLab(manifest)
  writeYaml(manifestPath(root), { ...manifest, validation })
  return { manifest, validation, start: { command: join(states.platform.path, 'platform/dsh-platform'), args: ['start'], environment: { HARNESS_PROGRAM_ROOT: states.platform.path, HARNESS_ASSET_ROOT: states.data.path, HARNESS_MANAGER_DSH_HOME: manifest.paths.dsh_home } } }
}
export function planUpdate(lab: string) {
  const manifest = readLab(lab)
  return { plan_only: true, repositories: keys.map(key => {
    const item = manifest.repositories[key]
    clean(item.path)
    const current = git(item.path, ['rev-parse', 'HEAD'])
    const remote = resolveRemote({ url: item.url, ...(item.ref ? { ref: item.ref } : { commit: item.commit }) })
    return { repository: key, current_commit: current, locked_commit: item.commit, proposed_commit: remote, changed: remote !== current }
  }) }
}

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const defaultRepository = 'git@github.com:wr5912/harness-engineering-platform-data.git'
export const defaultAccount = { username: 'admin', password: 'admin123' }
export type Check = { id: string; label: string; status: 'ok' | 'missing' | 'invalid'; detail: string }
export type SetupRequest = { action: 'existing' | 'clone' | 'new'; root: string; repositoryUrl?: string; previewRevision?: string; account?: { username: string; password: string } }
const configurations: Record<string, { label: string; value: () => unknown; valid: (value: any) => boolean }> = {
  'workspace.json': { label: '工作区身份', value: () => ({ schemaVersion: 1, id: `workspace-${randomUUID()}`, legacyRoots: [], extensions: [] }), valid: v => v?.schemaVersion === 1 && typeof v.id === 'string' && /^workspace-[a-zA-Z0-9-]+$/.test(v.id) && Array.isArray(v.legacyRoots ?? []) && (v.legacyRoots ?? []).every((p: unknown) => typeof p === 'string' && isAbsolute(p)) },
  'config/sites.json': { label: '站点配置', value: () => ({ assistant: '/assistant/', platform: '/hep/' }), valid: v => ['assistant', 'platform'].every(k => typeof v?.[k] === 'string' && /^\/[a-z][a-z0-9-]*\/$/.test(v[k])) },
  'config/mcp-compositions.json': { label: '组合目录', value: () => ({ schema_version: '1.0', compositions: [] }), valid: v => v?.schema_version === '1.0' && Array.isArray(v.compositions) },
}
const accountFile = '.local/credentials/admin.json'
const accountValid = (v: any) => typeof v?.username === 'string' && Boolean(v.username.trim()) && v.username.length <= 256 && typeof v.password === 'string' && Boolean(v.password) && v.password.length <= 1024
export function selectedRoot(value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写数据工作区目录')
  const path = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) throw new Error('数据工作区必须是绝对路径或 ~/ 路径')
  return resolve(path)
}

function readable(path: string, root: string) {
  for (let current = path; current !== dirname(root); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('初始化文件路径不能通过符号链接指向其他位置')
    if (current === root) break
  }
}

async function git(args: string[], cwd?: string) {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, timeout: 120_000, maxBuffer: 1024 * 1024 })
}

export async function inspectWorkspace(rootValue: string) {
  const root = selectedRoot(rootValue)
  const checks: Check[] = []
  for (const command of ['dsh', 'pnpm']) {
    const available = (process.env.PATH || '').split(':').some(directory => { try { accessSync(join(directory, command), constants.X_OK); return true } catch { return false } })
    checks.push({ id: command, label: `${command} 命令`, status: available ? 'ok' : 'missing', detail: available ? '可从 PATH 读取' : `请安装 ${command} 并加入启动器 PATH` })
  }
  let gitAvailable = true
  try { await git(['--version']) } catch { gitAvailable = false }
  checks.push({ id: 'git', label: 'Git 命令', status: gitAvailable ? 'ok' : 'missing', detail: gitAvailable ? '已安装' : '请先安装 Git 并加入 PATH' })
  let repository = false
  if (existsSync(root) && gitAvailable) {
    try { repository = resolve((await git(['rev-parse', '--show-toplevel'], root)).stdout.trim()) === root } catch { /* 非 Git 目录可在明确初始化操作中创建。 */ }
  }
  checks.push({ id: 'repository', label: '独立 Git 工作区', status: repository ? 'ok' : 'missing', detail: repository ? root : '目录尚未建立独立 Git 仓库' })
  for (const [relative, spec] of Object.entries(configurations)) {
    const path = join(root, relative)
    let status: Check['status'] = 'missing'
    if (existsSync(path)) {
      try { readable(path, root); status = spec.valid(JSON.parse(readFileSync(path, 'utf8'))) ? 'ok' : 'invalid' } catch { status = 'invalid' }
    }
    checks.push({ id: relative, label: spec.label, status, detail: status === 'invalid' ? `${relative} 无效；保留原文件，请先修复` : relative })
  }
  let accountStatus: Check['status'] = 'missing'
  if (existsSync(join(root, accountFile))) {
    try { readable(join(root, accountFile), root); accountStatus = accountValid(JSON.parse(readFileSync(join(root, accountFile), 'utf8'))) ? 'ok' : 'invalid' } catch { accountStatus = 'invalid' }
  }
  checks.push({ id: 'account', label: '本地平台账号', status: accountStatus, detail: accountStatus === 'ok' ? '已配置，将复用现有账号' : accountStatus === 'invalid' ? '账号文件无效，请先修复；不会覆盖' : '首次初始化使用默认账号，也可修改' })
  let extensions: { id: string; path: string }[] = []
  if (checks.find(c => c.id === 'workspace.json')?.status === 'ok') {
    const declared = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')).extensions ?? []
    const valid = Array.isArray(declared) && new Set(declared.map(e => e?.id)).size === declared.length && declared.every(e => e && typeof e.id === 'string' && /^[a-z][a-z0-9-]*$/.test(e.id) && typeof e.path === 'string' && e.path.startsWith('extensions/') && !e.path.split('/').includes('..') && existsSync(join(root, e.path, 'build.mjs')))
    checks.push({ id: 'extensions', label: '声明的工作区扩展', status: valid ? 'ok' : 'invalid', detail: valid ? '仅在明确执行初始化后构建装载已声明扩展' : '扩展声明或构建入口无效；请先修复' })
    if (valid) extensions = declared.map(e => ({ id: e.id, path: e.path }))
  }
  const normalUrl = checks.find(c => c.id === 'config/sites.json')?.status === 'ok'
    ? JSON.parse(readFileSync(join(root, 'config/sites.json'), 'utf8')).platform : '/hep/'
  return { root, checks, extensions, normalUrl, needsAccount: accountStatus === 'missing', ready: checks.every(c => c.status === 'ok') }
}

export function extensionDigest(root: string, extensions: { id: string; path: string }[]) {
  const digest = createHash('sha256').update(JSON.stringify(extensions))
  function visit(path: string) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('扩展源码包含符号链接，请先核对并使用实体源码')
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!['node_modules', '.git', '.local', '__pycache__'].includes(name)) visit(join(path, name))
    } else if (stat.isFile()) digest.update(path.slice(root.length)).update('\0').update(readFileSync(path))
  }
  for (const extension of extensions) visit(join(root, extension.path))
  return digest.digest('hex')
}

function repositoryUrl(value?: string) {
  const url = value?.trim() || defaultRepository
  if (isAbsolute(url)) return url
  if (/^[a-z][a-z0-9-]*@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(url)) return url
  try {
    const parsed = new URL(url)
    if (['https:', 'ssh:'].includes(parsed.protocol) && !parsed.password && !parsed.search && !parsed.hash && (!parsed.username || parsed.protocol === 'ssh:' && parsed.username === 'git')) return url
  } catch { /* 返回统一错误，不回显可能包含凭据的输入。 */ }
  throw new Error('仓库地址须为 SSH、无凭据的 HTTPS 地址或本地 Git 绝对目录；请通过已有 Git 认证访问私有仓库')
}

function missingIgnoreRules(root: string) {
  const file = join(root, '.gitignore')
  readable(file, root)
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = content.split(/\r?\n/).map(line => line.trim())
  // 将缺失规则追加在末尾，避免已有的反向匹配重新暴露本地状态或模型密钥。
  const lastException = lines.reduce((last, line, index) => line.startsWith('!') ? index : last, -1)
  const missing = ['.local/', '*.llm-api-key'].filter(rule => lines.lastIndexOf(rule) < 0 || lines.lastIndexOf(rule) < lastException)
  return { content, missing }
}

export async function previewWorkspace(input: SetupRequest) {
  if (!input || !['existing', 'clone', 'new'].includes(input.action)) throw new Error('请选择已有工作区、克隆仓库或新建工作区')
  const state = await inspectWorkspace(input.root)
  const { root } = state
  readable(root, root)
  if (existsSync(root) && !lstatSync(root).isDirectory()) throw new Error('目标路径不是目录')
  const populated = existsSync(root) && readdirSync(root).length > 0
  if (input.action !== 'existing' && populated) throw new Error('克隆或新建只能使用不存在或空的目录，不会覆盖已有内容')
  if (input.action === 'existing' && (!populated || !existsSync(join(root, 'workspace.json')) && !existsSync(join(root, 'config')) && !existsSync(join(root, 'agents')))) throw new Error('请选择已有数据工作区；空目录请使用新建或克隆')
  if (input.action === 'clone') repositoryUrl(input.repositoryUrl)
  const plannedChanges = input.action === 'clone' ? ['克隆完整 Git 历史到临时目录，检查结构后移动到目标位置'] : []
  if (state.checks.find(c => c.id === 'repository')?.status !== 'ok' && input.action !== 'clone') plannedChanges.push('在目标数据目录执行 git init，不添加或提交已有文件')
  for (const c of state.checks) if (c.status === 'missing' && c.id in configurations) plannedChanges.push(`仅在不存在时创建 ${c.id}`)
  const ignore = missingIgnoreRules(root)
  if (ignore.missing.length) plannedChanges.push(`保留已有 .gitignore，追加必要忽略规则：${ignore.missing.join('、')}`)
  if (state.needsAccount) plannedChanges.push('仅在不存在时创建本地账号文件 .local/credentials/admin.json（权限 0600）')
  plannedChanges.push('运行平台 prepare，构建并装载工作区明确声明的扩展，然后启动平台')
  const extensionsDigest = extensionDigest(root, state.extensions)
  const revision = createHash('sha256').update(JSON.stringify({ root, action: input.action, repositoryUrl: input.action === 'clone' ? repositoryUrl(input.repositoryUrl) : undefined,
    checks: state.checks, normalUrl: state.normalUrl, extensionsDigest, gitignore: ignore.content, workspace: existsSync(join(root, 'workspace.json')) ? readFileSync(join(root, 'workspace.json'), 'utf8') : null })).digest('hex')
  return { ...state, action: input.action, plannedChanges, revision, extensionsDigest, canApply: state.checks.every(c => c.status !== 'invalid') && state.checks.find(c => c.id === 'git')?.status === 'ok' }
}

function writeMissing(root: string, relative: string, value: unknown) {
  const file = join(root, relative)
  readable(file, root)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

export async function initializeWorkspace(input: SetupRequest) {
  const plan = await previewWorkspace(input)
  if (!plan.canApply) throw new Error('已有文件无效或 Git 不可用；请修复后重新预览')
  const account = input.account ?? defaultAccount
  if (plan.needsAccount && !accountValid(account)) throw new Error('请填写有效的首次登录账号与密码')
  const { root } = plan
  let working = root, staging: string | undefined
  try {
    if (input.action === 'clone') {
      mkdirSync(dirname(root), { recursive: true })
      staging = mkdtempSync(join(dirname(root), '.harness-clone-'))
      working = join(staging, 'workspace')
      try { await git(['clone', '--', repositoryUrl(input.repositoryUrl), working]) } catch { throw new Error('克隆失败；请检查仓库地址、网络与本机 Git 认证，原目标未改动') }
      const cloned = await inspectWorkspace(working)
      if (cloned.checks.find(c => c.id === 'repository')?.status !== 'ok' || cloned.checks.some(c => c.status === 'invalid')) throw new Error('克隆内容不符合工作区结构；原目标未改动')
    } else {
      mkdirSync(root, { recursive: true })
      if (plan.checks.find(c => c.id === 'repository')?.status !== 'ok') await git(['init', '--', root])
    }
    for (const [relative, spec] of Object.entries(configurations)) writeMissing(working, relative, spec.value())
    const ignore = missingIgnoreRules(working)
    if (ignore.missing.length) appendFileSync(join(working, '.gitignore'), `${ignore.content && !ignore.content.endsWith('\n') ? '\n' : ''}${ignore.missing.join('\n')}\n`)
    if (!existsSync(join(working, accountFile))) writeMissing(working, accountFile, { username: account.username, password: account.password })
    const prepared = await inspectWorkspace(working)
    if (!prepared.ready) throw new Error('初始化后的工作区仍不完整，请修复后重试')
    if (staging) {
      // rename 只允许替换空目录；若预览后目标已出现内容，保留双方数据并拒绝。
      if (existsSync(root) && readdirSync(root).length) throw new Error('目标目录在预览后已有内容，已停止克隆迁入')
      renameSync(working, root)
    }
    return root
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }) }
}

export function rememberWorkspace(root: string) {
  const file = join(homedir(), '.config/harness-engineering-platform/workspace.json')
  if (!existsSync(file) && root === join(homedir(), 'harness-engineering-platform-data')) return
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ assetRoot: root }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temporary, file)
}

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

interface UpdateFile { path: string; expectedSha256: string | null; sha256: string; content: string }
interface Update { agentId: string; experimentId: string; instance: string; files: UpdateFile[] }
interface Target { prefix: string; dataRoot: string; dryRun?: boolean }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

function validate(update: Update) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(update.agentId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(update.instance)
    || !new RegExp(`^EXP-${update.agentId}-[0-9]+(?:-r[0-9a-f]{12})?$`).test(update.experimentId)) throw new Error('智能体、Experiment 或实例身份无效')
  if (!Array.isArray(update.files) || !update.files.length || new Set(update.files.map(file => file.path)).size !== update.files.length) throw new Error('更新清单为空或包含重复路径')
  for (const file of update.files) {
    if (typeof file.path !== 'string' || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || file.path !== 'change.yaml' && !file.path.startsWith('candidate/dsh/')
      || /[\\\r\n\x00]|(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)credentials?(?:\/|$)|\.llm-api-key$|\.(?:pem|key)$/i.test(file.path)) throw new Error('更新仅接受该版本的 dsh 资产与 change.yaml，不包含凭据或运行状态')
    if (file.expectedSha256 !== null && !/^[0-9a-f]{64}$/.test(file.expectedSha256)) throw new Error('每个文件必须提供预期远端 SHA256，新增文件使用 null')
  }
}

function safeFile(root: string, relative: string) {
  const file = join(root, relative)
  let current = root
  for (const part of relative.split('/')) {
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`更新路径包含符号链接：${relative}`)
  }
  if (!file.startsWith(root + sep) || existsSync(file) && !lstatSync(file).isFile()) throw new Error(`更新路径不是普通文件：${relative}`)
  return file
}

export function prepareAgentUpdate(dataRoot: string, manifestFile: string): Update {
  const update = readJson(manifestFile) as Update
  validate(update)
  const root = realpathSync(join(dataRoot, 'evolution/experiments', update.experimentId))
  return { ...update, files: update.files.map(file => {
    const bytes = readFileSync(safeFile(root, file.path))
    return { path: file.path, expectedSha256: file.expectedSha256, sha256: hash(bytes), content: bytes.toString('base64') }
  }) }
}

function atomic(file: string, content: Uint8Array, mode: number) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, content, { mode }); chmodSync(temporary, mode); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}

/** 原子替换挂载目录中的文件；只交付资产，实际装载与业务验证另行核验。 */
export function applyAgentUpdate(target: Target, update: Update) {
  validate(update)
  if (![target.prefix, target.dataRoot].every(path => path.startsWith('/') && !/[\r\n\x00]/.test(path))) throw new Error('远端安装路径必须是绝对路径')
  const prefix = realpathSync(target.prefix), dataRoot = realpathSync(target.dataRoot)
  if (!existsSync(join(prefix, '.local/installation.json'))) throw new Error('程序根缺少安装清单')
  const instance = readJson(join(dataRoot, '.local/instances', update.instance, 'instance.json'))
  if (instance.agent_id !== update.agentId || instance.source_kind !== 'experiment' || instance.source_id !== `experiment:${update.experimentId}`
    || realpathSync(instance.asset_root) !== dataRoot) throw new Error('实例的智能体、版本或数据根与更新清单不符')
  const experiment = realpathSync(join(dataRoot, 'evolution/experiments', update.experimentId))
  const files = update.files.map(file => {
    const path = safeFile(experiment, file.path), bytes = Buffer.from(file.content, 'base64')
    if (hash(bytes) !== file.sha256) throw new Error(`更新内容摘要不符：${file.path}`)
    const before = existsSync(path) ? readFileSync(path) : null, beforeSha256 = before === null ? null : hash(before)
    if (beforeSha256 !== file.sha256 && beforeSha256 !== file.expectedSha256) throw new Error(`远端资产已变化，未覆盖：${file.path}`)
    return { ...file, path, bytes, before, beforeSha256, mode: before === null ? 0o644 : statSync(path).mode & 0o777 }
  })
  const changed = files.filter(file => file.beforeSha256 !== file.sha256)
  const report = { instance: update.instance, experimentId: update.experimentId, status: target.dryRun ? 'planned' : 'unchanged', activation: 'pending',
    files: files.map(file => ({ path: file.path.slice(experiment.length + 1), beforeSha256: file.beforeSha256, sha256: file.sha256, changed: file.beforeSha256 !== file.sha256 })),
    bytes: changed.reduce((total, file) => total + file.bytes.length, 0), backup: undefined as string | undefined }
  if (target.dryRun || !changed.length) return report
  const backup = join(prefix, '.local/deploy-agent-updates', randomUUID())
  mkdirSync(backup, { recursive: true, mode: 0o700 }); chmodSync(backup, 0o700)
  report.backup = backup; report.status = 'applying'
  changed.forEach((file, index) => { if (file.before !== null) writeFileSync(join(backup, String(index)), file.before, { mode: 0o600 }) })
  save(join(backup, 'files.json'), changed.map((file, index) => ({ path: file.path, snapshot: file.before === null ? null : String(index), mode: file.mode, sha256: file.beforeSha256 })))
  save(join(backup, 'receipt.json'), report)
  const written: typeof changed = []
  try {
    for (const file of changed) {
      const current = existsSync(file.path) ? hash(readFileSync(file.path)) : null
      if (current !== file.beforeSha256) throw new Error(`更新期间资产已变化：${file.path}`)
      atomic(file.path, file.bytes, file.mode); written.push(file)
    }
    if (files.some(file => hash(readFileSync(file.path)) !== file.sha256)) throw new Error('更新后摘要核对失败')
    report.status = 'updated'; save(join(backup, 'receipt.json'), report)
    return report
  } catch (error) {
    let restored = true
    for (const file of written.reverse()) {
      try {
        if (!existsSync(file.path) || hash(readFileSync(file.path)) !== file.sha256) { restored = false; continue }
        if (file.before === null) rmSync(file.path); else atomic(file.path, file.before, file.mode)
      } catch { restored = false }
    }
    report.status = restored ? 'rolled-back' : 'recovery-required'; save(join(backup, 'receipt.json'), report)
    throw new Error(`资产更新失败，${restored ? '已恢复原文件' : '需要根据备份恢复'}；回执：${backup}；${error instanceof Error ? error.message : '写入失败'}`)
  }
}

export function updateAgentRemote(ssh: string, target: Target, update: Update) {
  if (!/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(ssh)) throw new Error('SSH 目标无效')
  const source = readFileSync(new URL('./agent-update.mts', import.meta.url), 'utf8')
  const script = source + `\ntry { console.log(JSON.stringify(applyAgentUpdate(${JSON.stringify(target)}, ${JSON.stringify(update)}), null, 2)) } catch(e) { console.error(e.message); process.exitCode = 1 }\n`
  const result = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ssh,
    `${quote(join(resolve(target.prefix), 'runtime/node/bin/node'))} --input-type=module-typescript -`], { input: script, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120_000 })
  if (result.error) throw new Error(`SSH 更新未完成：${result.error.message}；请先核对远端回执再重试`)
  return result.status ?? 1
}

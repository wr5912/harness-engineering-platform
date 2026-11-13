import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { dataStatePaths, isDataState } from './state.mts'

type Target = { prefix: string; dataRoot: string; dryRun?: boolean; installDeps?: boolean; minimalData?: boolean; start?: boolean; cancelPrepare?: number }
type File = { path: string; before: string | null; accepted?: (string | null)[]; content: string | null; mode: number }
type Repository = { root: string; before: string; commit: string; bundle?: string; files: File[] }
type Update = { repositories: Repository[]; artifacts: File[]; blobs?: Record<string, string>; sourceDataCommit?: string; dependencies?: { directory: string; archive: string; remove: string[]; bins: Record<string,string> }[] }
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
function run(command: string, args: string[], cwd?: string, input?: string | Buffer): Buffer {
  const result = spawnSync(command, args, { cwd, input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, HEP_OFFLINE: '1', GIT_TERMINAL_PROMPT: '0', CI: 'true', pnpm_config_verify_deps_before_run: 'false' } })
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败：${result.error?.message || result.stderr.toString().slice(-1500)}`)
  return result.stdout
}
const git = (root: string, ...args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args])
const head = (root: string) => git(root, 'rev-parse', 'HEAD').toString().trim()
function safe(root: string, path: string) {
  if (!path || path.split('/').some(part => !part || part === '..' || part === '.' || part === '.git') || /[\\\r\n\0]/.test(path)) throw new Error(`更新路径无效：${path}`)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`更新路径包含符号链接：${path}`)
  }
  if (existsSync(current) && !statSync(current).isFile()) throw new Error(`更新路径不是文件：${path}`)
  return current
}
const digest = (path: string) => existsSync(path) ? hash(readFileSync(path)) : null
const artifactPath = (path: string) => /^(platform\/plugin\/(lib|business)|runtime\/adapters\/dsh-web\/lib)\//.test(path) && !path.endsWith('.ts')

function readBlobs(root: string, ids: string[]) {
  const objects = new Map<string, Buffer>()
  if (!ids.length) return objects
  const sizes = run('git', ['-C', root, 'cat-file', '--batch-check'], undefined, ids.join('\n') + '\n').toString().trim().split('\n')
  let batch: string[] = [], total = 0
  function flush() {
    if (!batch.length) return
    const bytes = run('git', ['-C', root, 'cat-file', '--batch'], undefined, batch.join('\n') + '\n')
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset), [id, type, length] = bytes.subarray(offset, end).toString().split(' ')
      if (type !== 'blob') throw new Error('增量对象不是普通文件')
      const size = Number(length); offset = end + 1
      objects.set(id, bytes.subarray(offset, offset + size)); offset += size + 1
    }
    batch = []; total = 0
  }
  for (const line of sizes) {
    const [id, type, length] = line.split(' '), size = Number(length)
    if (type !== 'blob' || !Number.isSafeInteger(size)) throw new Error('增量对象不是普通文件')
    if (total + size > 64 * 1024 * 1024) flush()
    batch.push(id); total += size
  }
  flush()
  return objects
}

/** 分条编码，避免完整数据仓库超过 V8 单字符串长度上限。 */
export function encodeUpdate(update: Update) {
  const header = { ...update, blobs: {}, repositories: update.repositories.map(repo => ({ ...repo, bundle: undefined })) }
  const parts = [gzipSync(JSON.stringify({ header }) + '\n')]
  for (const [index, repo] of update.repositories.entries()) if (repo.bundle) parts.push(gzipSync(JSON.stringify({ bundle: [index, repo.bundle] }) + '\n'))
  for (const entry of Object.entries(update.blobs ?? {})) parts.push(gzipSync(JSON.stringify({ blob: entry }) + '\n'))
  return Buffer.concat(parts)
}

export function decodeUpdate(compressed: Buffer): Update {
  const bytes = gunzipSync(compressed)
  let update: Update | undefined, offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    if (end < 0) throw new Error('增量包记录不完整')
    const record = JSON.parse(bytes.subarray(offset, end).toString()); offset = end + 1
    if (record.header) update = record.header
    else if (record.bundle && update) update.repositories[record.bundle[0]].bundle = record.bundle[1]
    else if (record.blob && update) update.blobs![record.blob[0]] = record.blob[1]
    else throw new Error('增量包记录无效')
  }
  if (!update) throw new Error('增量包为空')
  return update
}

/** 仅终止本工具启动且卡住的离线 prepare 子树，不触及平台和业务进程。 */
export function cancelPreparation(target: Target, pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || target.dryRun) throw new Error('取消准备需要有效 PID，且不能与 dry-run 同用')
  const command = (id: number) => readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').filter(Boolean)
  const parent = (id: number) => Number(readFileSync(`/proc/${id}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)?.[1])
  const args = command(pid), owner = command(parent(parent(pid)))
  const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  if (!args.includes(join(target.prefix, 'platform/dsh-platform-internal.py')) || args.slice(-2).join(' ') !== 'prepare --offline'
    || !owner.includes('--input-type=module-typescript') || !environment.includes(`HARNESS_ASSET_ROOT=${target.dataRoot}`)) throw new Error('PID 不是此安装中由增量工具启动的离线准备进程')
  const children = new Map<number, number[]>()
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) try {
    const id = Number(entry), ppid = parent(id); children.set(ppid, [...children.get(ppid) ?? [], id])
  } catch { /* 短命进程可在枚举期间退出。 */ }
  function stop(id: number) { for (const child of children.get(id) ?? []) stop(child); try { process.kill(id, 'SIGTERM') } catch (error: any) { if (error.code !== 'ESRCH') throw error } }
  stop(pid)
  return { status: 'prepare-cancelled', pid }
}

export function inspectUpdate(target: Target) {
  if (![target.prefix, target.dataRoot].every(path => path.startsWith('/') && !/[\r\n\0]/.test(path))) throw new Error('安装路径必须为绝对路径')
  const manifest = JSON.parse(readFileSync(join(target.prefix, '.local/installation.json'), 'utf8'))
  if (manifest.schemaVersion !== 1) throw new Error('安装清单无效')
  const artifacts: Record<string, { sha256: string; mode: number }> = {}
  const revalidated: string[] = []
  for (const entry of manifest.files.filter((entry: any) => entry.path.startsWith('program/') && artifactPath(entry.path.slice(8)))) {
    const path = entry.path.slice(8), absolute = safe(target.prefix, path)
    const current = digest(absolute)
    if (current !== entry.sha256) {
      if (current === null) throw new Error(`现有制品与安装清单不符：${path}`)
      revalidated.push(path)
    }
    artifacts[path] = { sha256: current!, mode: entry.mode }
  }
  if (revalidated.length) {
    const plugin = revalidated.some(path => !path.startsWith('runtime/adapters/dsh-web/lib/'))
    const adapter = plugin ? 'platform/plugin' : 'runtime/adapters/dsh-web'
    const scope = plugin ? ['platform/plugin', 'plugins/mcp-manager', 'runtime/adapters/dsh-web'] : [adapter]
    if (git(target.prefix, 'diff', '--name-only', 'HEAD', '--', ...scope).length || git(target.prefix, 'ls-files', '--others', '--exclude-standard', '--', ...scope).length) throw new Error('适配器源码有现场修改，不能重新核验制品')
    const temporary = mkdtempSync(join(tmpdir(), 'hep-web-verify-'))
    try {
      // 原生实例预检会原地构建；只接受可由未改动源码和现场依赖重新生成的制品。
      run(process.execPath, [join(target.prefix, adapter, 'build.mjs'), '--out-dir', temporary], join(target.prefix, adapter))
      for (const path of revalidated) {
        const relative = plugin && path.startsWith('runtime/') ? `dsh-web/${basename(path)}` : plugin && path.startsWith('platform/plugin/business/') ? `business/${path.slice('platform/plugin/business/'.length)}` : basename(path)
        if (digest(join(temporary, relative)) !== artifacts[path].sha256) throw new Error(`现有制品与安装清单不符，且无法复现：${path}`)
      }
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  }
  function collect(directory: string) {
    if (!existsSync(join(target.prefix, directory))) return
    for (const entry of readdirSync(join(target.prefix, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) collect(path)
      else if (artifactPath(path) && !artifacts[path]) {
        const absolute = safe(target.prefix, path)
        artifacts[path] = { sha256: hash(readFileSync(absolute)), mode: statSync(absolute).mode & 0o777 }
      }
    }
  }
  // 历史安装可能在 prepare 时生成清单外制品；仍按当前摘要核对并保留备份。
  for (const directory of ['platform/plugin/lib', 'platform/plugin/business', 'runtime/adapters/dsh-web/lib']) collect(directory)
  const dependencyBases: Record<string, string> = {}, repairDependencies: string[] = [], dependencyDamage: Record<string, string[]> = {}
  const dependencies = Object.fromEntries(['platform/plugin', 'runtime/adapters/dsh-web'].map(directory => {
    let modules = join(target.prefix, directory, 'node_modules')
    if (existsSync(join(target.prefix, directory, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(target.prefix, directory, 'package.json'), 'utf8'))
      const complete = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).every(name => existsSync(join(modules, name)))
      const prefix = `program/${directory}/node_modules/`
      const damaged = manifest.files.filter((entry: any) => entry.path.startsWith(prefix)).filter((entry: any) => {
        const path = join(modules, entry.path.slice(prefix.length)), stat = lstatSync(path, { throwIfNoEntry: false })
        return !stat || (entry.type === 'symlink' ? !stat.isSymbolicLink() || readlinkSync(path) !== entry.target : !stat.isFile() || digest(path) !== entry.sha256 || entry.mode !== undefined && (stat.mode & 0o777) !== entry.mode)
      }).map((entry: any) => entry.path.slice(prefix.length)) as string[]
      dependencyDamage[directory] = damaged
      if (!complete || damaged.length) {
        repairDependencies.push(directory)
        const backups = join(target.prefix, '.local/deploy-updates')
        for (const name of existsSync(backups) ? readdirSync(backups).sort((a,b) => statSync(join(backups,b)).mtimeMs - statSync(join(backups,a)).mtimeMs) : []) {
          const backup = join(backups, name), receiptPath = join(backup, 'receipt.json')
          if (!existsSync(receiptPath)) continue
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')), index = receipt.dependencies?.indexOf(directory)
          if (index === undefined || index < 0 || receipt.status !== 'updated') continue
          const candidate = join(backup, `node_modules-${index}`)
          if (!existsSync(candidate)) continue
          const original = JSON.parse(readFileSync(join(backup, 'installation.json'), 'utf8'))
          const prefix = `program/${directory}/node_modules/`, entries = original.files.filter((item: any) => item.path.startsWith(prefix))
          if (!entries.length) continue
          const valid = entries.every((entry: any) => {
            const path = join(candidate, entry.path.slice(prefix.length)), stat = lstatSync(path, { throwIfNoEntry: false })
            return stat && (entry.type === 'symlink' ? stat.isSymbolicLink() && readlinkSync(path) === entry.target : stat.isFile() && digest(path) === entry.sha256)
          })
          if (valid) { modules = candidate; dependencyDamage[directory] = []; break }
        }
      }
    }
    dependencyBases[directory] = modules
    const damagedFolders = new Set((dependencyDamage[directory] ?? []).filter(path => path.startsWith('.pnpm/')).map(path => path.split('/')[1]))
    return [directory, existsSync(join(modules, '.pnpm')) ? readdirSync(join(modules, '.pnpm')).filter(name => !damagedFolders.has(name)) : []]
  }))
  const sources: Record<string, {sha256: string; mode: number} | null> = {}
  if (manifest.package.commit && manifest.package.commit !== head(target.prefix)) {
    // 历史更新没有同步清单时，只接受精确等于当前 Git 提交的源码。
    const tracked = new Map(git(target.prefix, 'ls-files', '-s', '-z').toString().split('\0').filter(Boolean).map(line => {
      const [meta, path] = line.split('\t'); return [path, meta.split(' ')[1]]
    }))
    for (const entry of manifest.files.filter((item: any) => item.type === 'file' && item.path.startsWith('program/'))) {
      const path = entry.path.slice(8)
      if (artifactPath(path)) continue
      const id = tracked.get(path)
      if (id && digest(safe(target.prefix, path)) !== entry.sha256) {
        const bytes = git(target.prefix, 'cat-file', 'blob', id)
        if (digest(safe(target.prefix, path)) !== hash(bytes)) throw new Error(`现有源码有未确认修改：${path}`)
        sources[path] = { sha256: hash(bytes), mode: statSync(join(target.prefix, path)).mode & 0o777 }
      }
    }
    const deleted = git(target.prefix, 'diff', '--name-only', '--diff-filter=D', '-z', manifest.package.commit, 'HEAD').toString().split('\0')
    for (const path of deleted) if (path && !existsSync(join(target.prefix, path))) sources[path] = null
  }
  const dirtyData = git(target.dataRoot, 'diff', '--name-only', '-z', 'HEAD').toString().split('\0').filter(Boolean).map(path => {
    let absolute: string
    try { absolute = safe(target.dataRoot, path) } catch (error) {
      if (error instanceof Error && error.message.includes('符号链接')) return { path, linked: true }
      throw error
    }
    return { path, sha256: digest(absolute), blob: existsSync(absolute) ? git(target.dataRoot, 'hash-object', '--', path).toString().trim() : null }
  })
  return { program: head(target.prefix), data: head(target.dataRoot), dataHistory: git(target.dataRoot, 'rev-list', '--max-count=100', 'HEAD').toString().trim().split('\n'), architecture: process.arch, dependencies, dependencyBases, repairDependencies, dependencyDamage, artifacts, revalidated, sources, dirtyData }
}

export function exportHistory(root: string, common?: string) {
  const temporary = mkdtempSync(join(tmpdir(), 'hep-history-'))
  try {
    const bundle = join(temporary, 'history.bundle')
    git(root, 'bundle', 'create', bundle, 'HEAD', ...(common ? [`^${common}`] : []))
    return readFileSync(bundle).toString('base64')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

/** 最小包只刷新管理身份、技能和参考资料，不导入完整仓库的业务资产或历史。 */
export function refreshMinimalData(root: string, source: string) {
  const commit = head(source)
  for (const path of ['AGENTS.md', '.agents/skills', 'docs']) {
    rmSync(join(root, path), { recursive: true, force: true })
    const archive = git(source, 'archive', commit, '--', path)
    run('tar', ['-xf', '-', '-C', root], undefined, archive)
    git(root, 'add', '-A', '--', path)
  }
  writeFileSync(join(root, 'README.md'), `# 最小初始化数据工作区\n\n管理助手资产来源：${commit}。不包含完整数据仓库的业务智能体和实验历史；部署更新保留现场配置、会话与自行创建的资产。\n`)
  git(root, 'add', 'README.md')
  if (git(root, 'diff', '--cached', '--name-only').length) git(root, '-c', 'user.name=HEP Deployment', '-c', 'user.email=deployment@localhost', 'commit', '-qm', `更新最小管理资产，来源 ${commit}`)
  return commit
}

export function prepareDependencyDelta(root: string, directory: string, existing: string[], architecture: string) {
  const modules = realpathSync(join(root, directory, 'node_modules')), store = join(modules, '.pnpm')
  const pkg = JSON.parse(git(root, 'show', `HEAD:${directory}/package.json`).toString())
  for (const name of ['package.json', 'pnpm-lock.yaml']) if (!readFileSync(join(root, directory, name)).equals(git(root, 'show', `HEAD:${directory}/${name}`))) throw new Error(`本地依赖合同有未提交修改：${directory}/${name}`)
  if (!readFileSync(join(store, 'lock.yaml')).equals(readFileSync(join(root, directory, 'pnpm-lock.yaml')))) throw new Error('本地 node_modules 与待部署锁文件不一致；请先通过 pnpm install --frozen-lockfile 准备')
  const selected = new Set<string>(), roots: string[] = [], bins: Record<string,string> = {}
  function link(path: string) {
    const resolved = resolve(dirname(path), readlinkSync(path))
    if (!resolved.startsWith(store + '/')) throw new Error(`依赖链接不属于 pnpm 资源：${path}`)
    const folder = resolved.slice(store.length + 1).split('/')[0]
    if (existing.includes(folder) || selected.has(folder)) return
    selected.add(folder); walk(join(store, folder))
  }
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isSymbolicLink()) link(next)
      else if (entry.isDirectory()) walk(next)
      else if (architecture !== process.arch) {
        const bytes = readFileSync(next)
        if (entry.name.endsWith('.node') || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes.subarray(0, 2).toString() === 'MZ') throw new Error(`新增依赖含本机架构二进制，需准备目标架构资源：${next}`)
      }
    }
  }
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const path = join(modules, name)
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`依赖不是已准备的 pnpm 链接：${name}`)
    roots.push(name); link(path)
    const dependency = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    for (const [bin, entry] of Object.entries(typeof dependency.bin === 'string' ? { [name.split('/').at(-1)!]: dependency.bin } : dependency.bin ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(bin) || typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`依赖可执行入口无效：${name}`)
      bins[bin] = `../${name}/${entry}`
    }
  }
  const archive = run('tar', ['-czf', '-', '--hard-dereference', '-C', modules, '--', ...roots, '.pnpm/lock.yaml', ...[...selected].map(folder => `.pnpm/${folder}`)])
  return { directory, archive: archive.toString('base64'), remove: roots, bins }
}

function inventory(root: string, relative: string): any[] {
  const absolute = join(root, relative), stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) return [{ path: `program/${relative}`, type: 'symlink', target: readlinkSync(absolute), mode: stat.mode & 0o777 }]
  if (stat.isDirectory()) return readdirSync(absolute).flatMap(name => inventory(root, `${relative}/${name}`))
  return [{ path: `program/${relative}`, type: 'file', sha256: hash(readFileSync(absolute)), mode: stat.mode & 0o777 }]
}

/** 仅更新 Git 差异和变化制品；配置、会话及未涉及的工作树改动保持原位。 */
export function applyUpdate(target: Target, update: Update) {
  const state = inspectUpdate(target)
  const content = (file: File) => file.content === null ? null : Buffer.from(file.content.startsWith('@') ? update.blobs?.[file.content.slice(1)] ?? (() => { throw new Error('增量内容缺失') })() : file.content, 'base64')
  if (update.repositories.length !== 2 || update.repositories[0].root !== target.prefix || update.repositories[1].root !== target.dataRoot) throw new Error('双仓身份不符')
  const manifestPath = join(target.prefix, '.local/installation.json'), originalManifest = readFileSync(manifestPath)
  const manifest = JSON.parse(originalManifest.toString())
  const activationPath = join(target.prefix, '.local/deploy-activation.json')
  const activationBefore = existsSync(activationPath) ? readFileSync(activationPath) : undefined
  const activation = activationBefore ? JSON.parse(activationBefore.toString()) : undefined
  let activationWritten = false
  const dependencyDirectories = [...new Set([...update.repositories[0].files.filter(file => /(?:^|\/)(package.json|pnpm-lock.yaml)$/.test(file.path)).map(file => dirname(file.path)), ...state.repairDependencies])]
  for (const directory of dependencyDirectories) {
    if (!['platform/plugin', 'runtime/adapters/dsh-web'].includes(directory)) throw new Error(`尚不支持此依赖目录的增量准备：${directory}`)
    if (!target.installDeps) throw new Error('依赖合同已变化；请使用 --install-deps 由工具在目标架构上准备匹配依赖')
    if (!update.dependencies?.some(item => item.directory === directory)) throw new Error(`缺少离线依赖增量：${directory}`)
  }
  const changed: { path: string; file: File; before: Buffer | null; mode: number; repo: number }[] = []
  for (const [index, repo] of update.repositories.entries()) {
    if (head(repo.root) !== repo.before || git(repo.root, 'diff', '--cached', '--name-only').length) throw new Error('远端提交或暂存区已变化，未更新')
    for (const file of [...repo.files, ...(index === 0 ? update.artifacts : [])]) {
      if (index === 1 && isDataState(file.path)) throw new Error('增量更新不得覆盖现场配置或运行状态')
      const path = safe(repo.root, file.path), current = digest(path), bytes = content(file), desired = bytes === null ? null : hash(bytes)
      if (current !== file.before && current !== desired && !file.accepted?.includes(current)) throw new Error(`远端文件存在冲突，未覆盖：${file.path}`)
      if (current !== desired || current !== null && (statSync(path).mode & 0o777) !== file.mode) changed.push({ path, file, before: current === null ? null : readFileSync(path), mode: current === null ? file.mode : statSync(path).mode & 0o777, repo: index })
    }
  }
  const report = { status: target.dryRun ? 'planned' : 'unchanged', activation: 'pending', files: changed.length, bytes: changed.reduce((n, x) => n + (content(x.file)?.length ?? 0), 0), commits: update.repositories.map(x => ({ before: x.before, commit: x.commit })), sourceDataCommit: update.sourceDataCommit, minimalData: !!target.minimalData, dependencies: dependencyDirectories, revalidatedArtifacts: state.revalidated, revalidatedSources: Object.keys(state.sources), backup: undefined as string | undefined }
  if (target.dryRun || !changed.length && !dependencyDirectories.length && !state.revalidated.length && !Object.keys(state.sources).length && update.repositories.every(repo => repo.before === repo.commit)) return report
  const lock = join(target.prefix, '.local/deploy-update.lock')
  mkdirSync(lock) // 同一安装不允许并行更新。
  const backup = join(target.prefix, '.local/deploy-updates', randomUUID())
  const written: typeof changed = [], advanced: Repository[] = []
  const dependencySwaps: { live: string; saved: string; prepared: string }[] = []
  try {
    mkdirSync(backup, { recursive: true, mode: 0o700 }); report.backup = backup
    writeFileSync(join(backup, 'installation.json'), originalManifest, { mode: 0o600 })
    for (const [index, entry] of changed.entries()) if (entry.before !== null) writeFileSync(join(backup, String(index)), entry.before, { mode: 0o600 })
    writeFileSync(join(backup, 'files.json'), JSON.stringify(changed.map((x, index) => ({ path: x.path, snapshot: x.before === null ? null : String(index), mode: x.mode }))), { mode: 0o600 })
    report.status = 'applying'; writeFileSync(join(backup, 'receipt.json'), JSON.stringify(report), { mode: 0o600 })
    const manifestFiles = new Map<string, any>(manifest.files.map((file: any) => [file.path, file]))
    for (const path of state.revalidated) manifestFiles.get(`program/${path}`).sha256 = state.artifacts[path].sha256
    for (const [path, entry] of Object.entries(state.sources)) {
      manifestFiles.delete(`program/${path}`)
      if (entry) manifestFiles.set(`program/${path}`, { path: `program/${path}`, type: 'file', ...entry })
    }
    for (const [index, repo] of update.repositories.entries()) {
      if (!repo.bundle) continue
      const bundle = join(backup, `${index}.bundle`)
      writeFileSync(bundle, Buffer.from(repo.bundle, 'base64'), { mode: 0o600 })
      git(repo.root, 'fetch', '--no-tags', bundle, 'HEAD')
      if (git(repo.root, 'rev-parse', 'FETCH_HEAD').toString().trim() !== repo.commit) throw new Error('增量 Git 包提交不符')
      // 允许安装包独有的配置提交；逐文件前置摘要负责拒绝现场冲突。
    }
    for (const [index, directory] of dependencyDirectories.entries()) {
      const prepared = join(backup, 'dependencies', String(index))
      mkdirSync(prepared, { recursive: true })
      const live = join(target.prefix, directory, 'node_modules')
      run('cp', ['-a', state.dependencyBases[directory], join(prepared, 'node_modules')])
      for (const path of state.dependencyDamage[directory] ?? []) rmSync(safe(join(prepared, 'node_modules'), path), { force: true })
      const delta = update.dependencies!.find(item => item.directory === directory)!
      for (const path of delta.remove) {
        if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error(`依赖包名无效：${path}`)
        rmSync(join(prepared, 'node_modules', path), { force: true, recursive: true })
      }
      run('tar', ['-xzf', '-', '-C', join(prepared, 'node_modules')], undefined, Buffer.from(delta.archive, 'base64'))
      mkdirSync(join(prepared, 'node_modules/.bin'), { recursive: true })
      for (const [name, path] of Object.entries(delta.bins)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || !path.startsWith('../') || path.slice(3).split('/').some(part => part === '..')) throw new Error('依赖可执行入口无效')
        const bin = join(prepared, 'node_modules/.bin', name); rmSync(bin, { force: true }); symlinkSync(path, bin)
        if (!existsSync(bin)) throw new Error(`离线可执行入口缺失：${name}`)
      }
      for (const path of delta.remove) if (!existsSync(join(prepared, 'node_modules', path))) throw new Error(`离线依赖链接未闭合：${path}`)
      dependencySwaps.push({ live, saved: join(backup, `node_modules-${index}`), prepared: join(prepared, 'node_modules') })
    }
    for (const entry of changed) {
      if (digest(entry.path) !== (entry.before === null ? null : hash(entry.before))) throw new Error(`更新期间文件已变化：${entry.file.path}`)
      written.push(entry)
      if (entry.file.content === null) rmSync(entry.path)
      else { mkdirSync(dirname(entry.path), { recursive: true }); writeFileSync(entry.path, content(entry.file)!); chmodSync(entry.path, entry.file.mode) }
      // 保留既有 inode，避免单文件 bind 挂载仍读取旧制品。
      const relative = `${entry.repo === 0 ? 'program' : 'data'}/${entry.file.path}`
      manifestFiles.delete(relative)
      if (entry.file.content !== null) manifestFiles.set(relative, { path: relative, type: 'file', sha256: digest(entry.path), mode: entry.file.mode })
    }
    for (const repo of update.repositories) {
      if (head(repo.root) !== repo.before) throw new Error('更新期间 Git HEAD 已变化')
      advanced.push(repo); git(repo.root, 'reset', '--mixed', repo.commit)
    }
    for (const swap of dependencySwaps) { renameSync(swap.live, swap.saved); renameSync(swap.prepared, swap.live) }
    manifest.files = [...manifestFiles.values()]
    for (const directory of dependencyDirectories) {
      const prefix = `program/${directory}/node_modules/`
      manifest.files = manifest.files.filter((file: any) => !file.path.startsWith(prefix)).concat(inventory(target.prefix, `${directory}/node_modules`))
    }
    manifest.package.commit = update.repositories[0].commit; manifest.data.commit = update.repositories[1].commit
    if (update.sourceDataCommit) { manifest.data.sourceCommit = update.sourceDataCommit; manifest.data.minimal = !!target.minimalData }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    for (const entry of changed) if (digest(entry.path) !== (entry.file.content === null ? null : hash(content(entry.file)!))) throw new Error('更新后文件摘要不符')
    // 修复后继续激活时，保留原会话快照并跟随本次已核对的提交。
    if (activation?.prefix === target.prefix && activation.dataRoot === target.dataRoot && activation.commit === update.repositories[0].before) {
      activationWritten = true
      writeFileSync(activationPath, JSON.stringify({ ...activation, commit: update.repositories[0].commit }), { mode: 0o600 })
    }
    report.status = 'updated'
  } catch (error) {
    let restored = true
    for (const swap of dependencySwaps.reverse()) if (existsSync(swap.saved)) try { rmSync(swap.live, { recursive: true, force: true }); renameSync(swap.saved, swap.live) } catch { restored = false }
    for (const repo of advanced.reverse()) try { git(repo.root, 'reset', '--mixed', repo.before) } catch { restored = false }
    for (const entry of written.reverse()) try {
      const desired = entry.file.content === null ? null : hash(content(entry.file)!)
      if (digest(entry.path) !== desired) { restored = false; continue }
      if (entry.before === null) rmSync(entry.path, { force: true })
      else { writeFileSync(entry.path, entry.before); chmodSync(entry.path, entry.mode) }
    } catch { restored = false }
    writeFileSync(manifestPath, originalManifest)
    if (activationWritten) writeFileSync(activationPath, activationBefore!)
    report.status = restored ? 'rolled-back' : 'recovery-required'
    throw new Error(`更新失败，${restored ? '已回滚' : '需根据备份恢复'}：${error instanceof Error ? error.message : error}；${backup}`)
  } finally {
    if (existsSync(backup)) writeFileSync(join(backup, 'receipt.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    rmSync(lock, { recursive: true })
  }
  return report
}

export function updateRemote(ssh: string | undefined, target: Target, programRoot: string, dataRoot: string) {
  if (ssh !== undefined && !/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(ssh)) throw new Error('SSH 目标无效')
  const source = readFileSync(new URL('./remote-update.mts', import.meta.url), 'utf8')
    .replace("import { dataStatePaths, isDataState } from './state.mts'", `const dataStatePaths = ${JSON.stringify(dataStatePaths)}; const isDataState = ${isDataState.toString()}`)
  const remote = (expression: string) => {
    const command = `HEP_ROOT=${quote(target.prefix)} . ${quote(join(target.prefix, 'bin/hep-env.sh'))} && ${quote(join(target.prefix, 'runtime/node/bin/node'))} --input-type=module-typescript -`
    return JSON.parse(run(ssh === undefined ? 'sh' : 'ssh', ssh === undefined ? ['-c', command] : ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ssh, command], undefined,
      source + `\ntry { console.log(JSON.stringify(await (${expression}))) } catch(e) { console.error(e.message); process.exitCode=1 }`).toString())
  }
  if (target.cancelPrepare !== undefined) console.error(JSON.stringify(remote(`cancelPreparation(${JSON.stringify(target)}, ${JSON.stringify(target.cancelPrepare)})`)))
  const state = remote(`inspectUpdate(${JSON.stringify(target)})`)
  const temporary = mkdtempSync(join(tmpdir(), 'hep-update-'))
  try {
    const fullDataRoot = dataRoot
    const sourceDataCommit = head(dataRoot)
    // 现场初始化提交未必属于完整仓库；导入缺少的对象，不改本地工作树与分支。
    if (!target.minimalData && spawnSync('git', ['-C', dataRoot, 'cat-file', '-e', state.data]).status !== 0) {
      const common = state.dataHistory.find((id: string) => spawnSync('git', ['-C', dataRoot, 'cat-file', '-e', id]).status === 0)
      if (!common) throw new Error('远端数据仓库与本地来源没有已知共同历史；未更新')
      const bundle = join(temporary, 'remote-data.bundle')
      writeFileSync(bundle, Buffer.from(remote(`exportHistory(${JSON.stringify(target.dataRoot)}, ${JSON.stringify(common)})`), 'base64'))
      git(dataRoot, 'fetch', '--no-tags', bundle, 'HEAD')
    }
    if (target.minimalData) {
      const root = join(temporary, 'minimal'); mkdirSync(root); git(root, 'init', '-q')
      const bundle = join(temporary, 'minimal.bundle')
      writeFileSync(bundle, Buffer.from(remote(`exportHistory(${JSON.stringify(target.dataRoot)})`), 'base64'))
      git(root, 'fetch', '--no-tags', bundle, 'HEAD'); git(root, 'reset', '--hard', state.data)
      refreshMinimalData(root, dataRoot); dataRoot = root
    }
    const repositories = [programRoot, dataRoot].map((root, index): Repository => {
      const before = index === 0 ? state.program : state.data, commit = head(root)
      if (index === 0) git(root, 'merge-base', '--is-ancestor', before, commit)
      const raw = git(root, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', before, commit).toString().split('\0')
      const entries: { path: string; oldMode: string; mode: string; old: string; next: string }[] = []
      for (let n = 0; n < raw.length - 1; n += 2) {
        const [oldMode, mode, old, next] = raw[n].slice(1).split(' ')
        entries.push({ path: raw[n + 1], oldMode, mode, old, next })
      }
      const paths = entries.map(x => x.path)
      if (index === 0 && !target.installDeps && paths.some(path => /(?:^|\/)(?:package.json|pnpm-lock.yaml)$/.test(path))) throw new Error('依赖合同已变化；请使用 --install-deps 由工具在目标架构上准备匹配依赖')
      const selected = entries.filter(x => index === 0 || !x.path.startsWith('config/') && x.path !== 'workspace.json' && !(/^0+$/.test(x.next) && state.dirtyData.some((item: any) => item.path === x.path && item.linked)))
      const ids = [...new Set(selected.flatMap(x => [x.old, x.next]).filter(id => !/^0+$/.test(id)))]
      const objects = readBlobs(root, ids)
      const files = selected.map((entry): File => {
        const { path, oldMode, mode } = entry
        if ([oldMode, mode].some(value => value !== '000000' && !value.startsWith('100'))) throw new Error(`增量更新暂不支持改变链接或子模块：${path}`)
        const old = objects.get(entry.old), next = objects.get(entry.next)
        const file: File = { path, before: old ? hash(old) : null, content: next ? next.toString('base64') : null, mode: mode === '100755' ? 0o755 : 0o644 }
        const dirty = index === 1 ? state.dirtyData.find((item: any) => item.path === path) : undefined
        if (dirty?.blob && dirty.sha256 !== file.before && dirty.sha256 !== (next ? hash(next) : null)) {
          const history = git(fullDataRoot, 'log', '--format=', '--raw', '--no-abbrev', 'HEAD', '--', path).toString()
          if (history.split(/\s+/).includes(dirty.blob) && hash(git(fullDataRoot, 'cat-file', 'blob', dirty.blob)) === dirty.sha256) file.accepted = [dirty.sha256]
        }
        return file
      })
      if (before === commit) return { root: index === 0 ? target.prefix : target.dataRoot, before, commit, files }
      const bundle = join(temporary, `${index}.bundle`)
      git(root, 'bundle', 'create', bundle, 'HEAD', `^${before}`)
      if (head(root) !== commit) throw new Error('本地 HEAD 在准备增量包时变化，请重试')
      return { root: index === 0 ? target.prefix : target.dataRoot, before, commit, files, bundle: readFileSync(bundle).toString('base64') }
    })
    const buildRoot = join(temporary, 'source'); mkdirSync(buildRoot)
    const archive = join(temporary, 'source.tar'); writeFileSync(archive, git(programRoot, 'archive', repositories[0].commit))
    run('tar', ['-xf', archive, '-C', buildRoot])
    for (const path of ['platform/plugin', 'runtime/adapters/dsh-web']) symlinkSync(join(resolve(programRoot), path, 'node_modules'), join(buildRoot, path, 'node_modules'))
    run(process.execPath, ['build.mjs'], join(buildRoot, 'platform/plugin'))
    const artifacts: File[] = [], present = new Set<string>()
    function collect(directory: string) {
      for (const entry of readdirSync(join(buildRoot, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`
        if (entry.isDirectory()) collect(path)
        else if (artifactPath(path)) {
          present.add(path)
          const bytes = readFileSync(join(buildRoot, path)), old = state.artifacts[path]
          if (hash(bytes) !== old?.sha256) artifacts.push({ path, before: old?.sha256 ?? null, content: bytes.toString('base64'), mode: old?.mode ?? 0o644 })
        }
      }
    }
    for (const directory of ['platform/plugin/lib', 'platform/plugin/business', 'runtime/adapters/dsh-web/lib']) collect(directory)
    for (const [path, old] of Object.entries(state.artifacts) as [string, any][]) if (!present.has(path)) artifacts.push({ path, before: old.sha256, content: null, mode: old.mode })
    const directories = [...new Set([...repositories[0].files.filter(file => /(?:^|\/)(package.json|pnpm-lock.yaml)$/.test(file.path)).map(file => dirname(file.path)), ...state.repairDependencies])]
    const dependencies = directories.map(directory => prepareDependencyDelta(programRoot, directory, state.dependencies[directory] ?? [], state.architecture))
    const blobs: Record<string, string> = {}
    for (const file of [...repositories.flatMap(repo => repo.files), ...artifacts]) if (file.content !== null) {
      const id = hash(Buffer.from(file.content, 'base64')); blobs[id] = file.content; file.content = `@${id}`
    }
    const compressed = encodeUpdate({ repositories, artifacts, sourceDataCommit, dependencies, blobs })
    console.error(`增量包 ${compressed.length} 字节；两仓 Git 差异 ${repositories.map(x => x.files.length).join('/')} 个文件；变化制品 ${artifacts.length} 个；不传镜像和运行状态，离线依赖增量 ${dependencies.length} 组`)
    if (target.start) remote(`activationSnapshot(${JSON.stringify(target)}, true)`)
    const wire = remote(`mkdtempSync(join(tmpdir(), 'hep-update-wire-'))`)
    let result: any
    try {
      const path = join(wire, 'update.gz')
      if (ssh === undefined) writeFileSync(path, compressed, { mode: 0o600 })
      else run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ssh, `umask 077; cat > ${quote(path)}`], undefined, compressed)
      result = remote(`applyUpdate(${JSON.stringify(target)}, decodeUpdate(readFileSync(${JSON.stringify(path)})))`)
    } finally { remote(`(rmSync(${JSON.stringify(wire)}, {recursive:true, force:true}), true)`) }
    if (target.start && !target.dryRun) result.activation = remote(`activateUpdate(${JSON.stringify(target)})`)
    console.log(JSON.stringify({ ...result, transferBytes: compressed.length }, null, 2))
    return 0
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

export async function activationSnapshot(target: Target, recover = false): Promise<{state: any; sessions: string[]}> {
  const lifecycle = await import(pathToFileURL(join(target.prefix, 'platform/lifecycle.mts')).href)
  const state = lifecycle.managedState(target.dataRoot, target.prefix)
  if (!state || !lifecycle.ownsPort(state.pid, state.host, state.port)) {
    const pending = join(target.prefix, '.local/deploy-activation.json')
    if (recover && existsSync(pending)) {
      const saved = JSON.parse(readFileSync(pending, 'utf8'))
      if (saved.prefix === target.prefix && saved.dataRoot === target.dataRoot && saved.commit === head(target.prefix)) return saved.snapshot
    }
    throw new Error('平台当前不属于目标安装或尚未就绪；未更新')
  }
  const account = JSON.parse(readFileSync(join(target.dataRoot, '.local/credentials/admin.json'), 'utf8'))
  const headers = { connection: 'close', origin: new URL(state.url).origin, 'content-type': 'application/x-www-form-urlencoded' }
  const login = await fetch(new URL('login', state.url), { method: 'POST', headers, body: new URLSearchParams({ username: account.username, password: account.password }), redirect: 'manual', signal: AbortSignal.timeout(120_000) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (login.status !== 303 || !cookie) throw new Error('平台登录核对失败')
  const response = await fetch(new URL('api/session/list', state.url), { method: 'POST', headers: { ...headers, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'deploy-update', method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(120_000) })
  const result = await response.json() as any, sessions = result?.result?.value?.items
  if (!response.ok || !result?.result?.ok || !Array.isArray(sessions) || sessions.some((item: any) => item.running)) throw new Error('管理会话仍在运行或状态未知；未更新/重启')
  return { state, sessions: sessions.map((item: any) => item.sessionId) as string[] }
}

export async function activateUpdate(target: Target) {
  let before = await activationSnapshot(target, true)
  const pending = join(target.prefix, '.local/deploy-activation.json')
  const command = (args: string[]) => run(join(target.prefix, 'platform/dsh-platform'), args, target.prefix)
  command(['prepare', '--offline'])
  applyUpdate(target, { repositories: [target.prefix, target.dataRoot].map(root => ({ root, before: head(root), commit: head(root), files: [] })), artifacts: [] })
  const lifecycle = await import(pathToFileURL(join(target.prefix, 'platform/lifecycle.mts')).href)
  if (lifecycle.ownsPort(before.state.pid, before.state.host, before.state.port)) {
    before = await activationSnapshot(target)
    writeFileSync(pending, JSON.stringify({ prefix: target.prefix, dataRoot: target.dataRoot, commit: head(target.prefix), snapshot: before }), { mode: 0o600 })
    command(['stop'])
  }
  try { command(['start', '--host', before.state.host, '--port', String(before.state.port), '--public-url', before.state.publicUrl ?? before.state.url]) }
  catch (error) { throw new Error(`更新已保留，平台启动失败；可使用同一 update --start 重试：${error instanceof Error ? error.message : error}`) }
  const after = await activationSnapshot(target)
  if (before.sessions.some(id => !after.sessions.includes(id))) throw new Error('更新后会话清单不完整')
  const { verifyDeployment } = await import(pathToFileURL(join(target.prefix, 'platform/deploy/verify.mts')).href)
  const verification = await verifyDeployment({ prefix: target.prefix, dataRoot: target.dataRoot, url: after.state.url })
  if (!verification.ok) throw new Error(`更新已生效，部署核对未全部通过：${JSON.stringify(verification.checks.filter((item: any) => item.status !== 'ok'))}`)
  rmSync(pending, { force: true })
  return { status: 'active', sessionsPreserved: before.sessions.length, pid: after.state.pid, verification }
}

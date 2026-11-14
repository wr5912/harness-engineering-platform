import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { managerHome } from '../manager-home.mts'
import { platformAddressArgs } from '../plugin/src/business-control/runtime-address.ts'

export interface RelocateOptions {
  prefix: string
  fromDataRoot: string
  dataRoot: string
  dryRun?: boolean
  resume?: boolean
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const sameDirectory = (a: string, b: string) => existsSync(a) && existsSync(b) && statSync(a).dev === statSync(b).dev && statSync(a).ino === statSync(b).ino

export function planRelocation(options: RelocateOptions) {
  const prefix = realpathSync(resolve(options.prefix)), fromDataRoot = resolve(options.fromDataRoot)
  const requested = resolve(options.dataRoot)
  const dataRoot = join(realpathSync(dirname(requested)), basename(requested))
  if ([prefix, fromDataRoot, dataRoot].some(path => /[\r\n\t]/.test(path))) throw new Error('安装路径不能包含换行或制表符')
  for (const [a, b] of [[prefix, fromDataRoot], [prefix, dataRoot], [fromDataRoot, dataRoot]]) {
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) throw new Error('程序目录、新旧数据根必须相互独立')
  }
  if (!existsSync(join(prefix, '.local/installation.json'))) throw new Error('程序目录缺少安装清单；仅迁移已安装的平台')
  const workspace = json(join(fromDataRoot, 'workspace.json'))
  if (workspace.schemaVersion !== 1 || typeof workspace.id !== 'string' || !workspace.id.startsWith('workspace-')
    || !Array.isArray(workspace.legacyRoots) || !workspace.legacyRoots.every((root: unknown) => typeof root === 'string')) throw new Error('原数据根的工作区身份或历史路径无效')
  const mounted = sameDirectory(fromDataRoot, dataRoot)
  if (!mounted && realpathSync(fromDataRoot) !== fromDataRoot) throw new Error('原数据根是其他目录的别名；请指定实际数据根')
  if (existsSync(dataRoot) && (!lstatSync(dataRoot).isDirectory() || lstatSync(dataRoot).isSymbolicLink()
    || !mounted && readdirSync(dataRoot).length)) throw new Error('目标数据根已占用；不会覆盖或合并另一工作区')
  return { prefix, fromDataRoot, dataRoot, workspaceId: workspace.id,
    mode: mounted ? 'existing' : statSync(fromDataRoot).dev === statSync(dirname(dataRoot)).dev ? 'rename' : 'bind' }
}

function fstabEscape(value: string) { return value.replaceAll('\\', '\\134').replaceAll(' ', '\\040') }

export function fstabForBind(current: string, source: string, target: string): string {
  const src = fstabEscape(source), dst = fstabEscape(target)
  const entries = current.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'))
    .map(line => line.trim().split(/\s+/)).filter(fields => fields[1] === dst)
  if (entries.length) {
    if (entries.length !== 1 || entries[0][0] !== src || !entries[0][3]?.split(',').includes('bind')) throw new Error('fstab 已存在冲突的目标挂载；不会覆盖')
    return current
  }
  return current.replace(/\n?$/, '\n') + `# harness-engineering-platform data root\n${src} ${dst} none bind,x-systemd.requires-mounts-for=${src} 0 0\n`
}

async function sessionSnapshot(url: string, dataRoot: string, expected?: string[]) {
  const account = json(join(dataRoot, '.local/credentials/admin.json'))
  const login = await fetch(new URL('login', url), { redirect: 'manual', signal: AbortSignal.timeout(120_000), method: 'POST', headers: { connection: 'close', origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: account.username, password: account.password }) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (login.status !== 303 || !cookie) throw new Error('迁移前后平台登录核对失败')
  const rpc = async (method: string, payload: unknown) => {
    const response = await fetch(new URL('api/' + method, url), { redirect: 'manual', signal: AbortSignal.timeout(120_000), method: 'POST', headers: { connection: 'close', origin: new URL(url).origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'data-root-relocation', method, payload }) })
    const result = response.status === 200 ? (await response.json() as any)?.result : undefined
    if (!result?.ok) throw new Error(`迁移核对 ${method} 未成功`)
    return result.value
  }
  const sessions = (await rpc('session/list', { args: { _request: {} } })).items
  if (!Array.isArray(sessions) || sessions.some((item: any) => item.running)) throw new Error('管理会话仍在运行或状态未知；未执行迁移')
  const ids: string[] = sessions.map((item: any) => item.sessionId)
  if (expected?.some(id => !ids.includes(id))) throw new Error('迁移后原会话清单不完整')
  return ids
}

function platformCommand(prefix: string, root: string, args: string[], log: string) {
  console.error(`dsh-deploy relocate: ${args.join(' ')} (${root})`)
  const result = spawnSync(join(prefix, 'platform/dsh-platform'), args, {
    cwd: prefix, env: { ...process.env, HARNESS_ASSET_ROOT: root }, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600, flag: 'a' })
  if (result.error || result.status !== 0) throw new Error(`${args[0]} 失败；详情保存在 ${log}`)
}

function verifyWorkspace(dataRoot: string) {
  const storage = json(join(managerHome(dataRoot), 'storages/workspace.json'))
  const ids = storage.global?.workspaceIds
  if (!Array.isArray(ids) || ids.length !== 1 || storage.tables?.workspaces?.[ids[0]]?.path !== dataRoot) throw new Error('原生管理工作区未绑定新数据根')
}

export async function relocate(options: RelocateOptions) {
  if (process.platform !== 'linux') throw new Error('数据根在线迁移当前支持 Linux')
  const plan = planRelocation(options)
  const { prefix, fromDataRoot, dataRoot, mode } = plan
  const envFile = join(prefix, 'bin/hep-env.sh'), locator = join(homedir(), '.config/harness-engineering-platform/workspace.json')
  const originalEnv = readFileSync(envFile, 'utf8')
  const rootLine = /^export HARNESS_ASSET_ROOT=.*$/m
  if (!rootLine.test(originalEnv)) throw new Error('安装器环境文件缺少数据根设置；未修改')
  if (mode !== 'existing' && !originalEnv.includes(`HARNESS_ASSET_ROOT:-${quote(fromDataRoot)}`)) throw new Error('原数据根与安装器启动定位不一致；未修改')
  const lifecycle = await import(pathToFileURL(join(prefix, 'platform/lifecycle.mts')).href)
  const state = lifecycle.managedState(mode === 'existing' ? dataRoot : fromDataRoot, prefix)
  if (state && !lifecycle.ownsPort(state.pid, state.host, state.port)) throw new Error('平台进程尚未就绪；未执行迁移')
  const sessions = state ? await sessionSnapshot(state.url, fromDataRoot) : []
  const fstab = mode === 'bind' ? fstabForBind(readFileSync('/etc/fstab', 'utf8'), fromDataRoot, dataRoot) : undefined
  const report = { ...plan, status: 'planned', sessionsPreserved: sessions.length, sessionIds: sessions,
    platform: state ? { host: state.host, port: state.port, url: state.url, publicUrl: state.publicUrl ?? state.url } : undefined,
    restarted: false, backup: undefined as string | undefined }
  if (mode === 'existing') {
    if (json(locator).assetRoot !== dataRoot || !originalEnv.includes(`HARNESS_ASSET_ROOT:-${quote(dataRoot)}`)) throw new Error('目标已挂载但启动定位未匹配；请根据上次迁移回执恢复后重试')
    if (options.resume) {
      const directory = join(prefix, '.local/deploy-relocations')
      const backup = readdirSync(directory).sort().reverse().map(name => join(directory, name))
        .filter(path => existsSync(join(path, 'receipt.json')))
        .find(path => {
          const receipt = json(join(path, 'receipt.json'))
          return receipt.fromDataRoot === fromDataRoot && receipt.dataRoot === dataRoot && receipt.workspaceId === plan.workspaceId
            && ['recovery-required', 'relocated'].includes(receipt.status)
        })
      if (!backup) throw new Error('没有匹配的迁移恢复回执；未启动平台')
      const receipt = json(join(backup, 'receipt.json'))
      if (options.dryRun) return { ...receipt, status: 'resume-planned' }
      if (!state) {
        if (!receipt.platform) throw new Error('恢复回执缺少原平台地址；未使用默认地址启动')
        platformCommand(prefix, dataRoot, ['start', ...platformAddressArgs(receipt.platform)], join(backup, 'lifecycle.log'))
      }
      const next = lifecycle.managedState(dataRoot, prefix)
      if (!next || !lifecycle.ownsPort(next.pid, next.host, next.port)) throw new Error('恢复后平台进程归属核对失败')
      const ids = await sessionSnapshot(next.url, dataRoot, receipt.sessionIds)
      if (ids.length < receipt.sessionsPreserved) throw new Error('恢复后管理会话数量减少')
      verifyWorkspace(dataRoot)
      const resumed = { ...receipt, status: 'relocated', restarted: true, resumed: true }
      save(join(backup, 'receipt.json'), resumed)
      return resumed
    }
    return { ...report, status: 'unchanged' }
  }
  if (options.resume) throw new Error('--resume 仅用于目标已就位且定位配置匹配的中断迁移')
  if (options.dryRun) return report
  if (mode === 'bind' && process.getuid?.() !== 0) throw new Error('跨文件系统迁移需要 root 执行 bind 挂载')
  if (mode === 'bind') {
    const fsType = execFileSync('findmnt', ['-n', '-o', 'FSTYPE', '-T', fromDataRoot], { encoding: 'utf8' }).trim()
    if (['tmpfs', 'ramfs'].includes(fsType)) throw new Error('原数据位于内存文件系统，不能持久绑定；请先通过部署工具迁移到磁盘')
  }
  const backup = join(prefix, '.local/deploy-relocations', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid)
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  chmodSync(backup, 0o700)
  report.backup = backup
  const home = managerHome(fromDataRoot)
  const profile = join(home, 'profiles/harness-platform')
  const files = [envFile, locator, join(fromDataRoot, 'workspace.json'),
    join(home, 'storages/workspace.json'),
    ...['package.json', 'harness-platform.patch.yml', 'cordis.patch.yml'].map(name => join(profile, name)),
    ...(fstab === undefined ? [] : ['/etc/fstab'])]
  const saved = files.map((file, index) => {
    const content = existsSync(file) ? readFileSync(file) : undefined
    const permissions = content === undefined ? undefined : statSync(file).mode & 0o777
    if (content !== undefined) writeFileSync(join(backup, String(index)), content, { mode: 0o600 })
    return { file, content, permissions }
  })
  save(join(backup, 'files.json'), saved.map(({ file, permissions }, index) => ({ file, permissions, snapshot: String(index) })))
  save(join(backup, 'receipt.json'), report)
  const log = join(backup, 'lifecycle.log')
  writeFileSync(log, '', { mode: 0o600 })
  const command = (args: string[], root: string) => platformCommand(prefix, root, args, log)
  const targetExisted = existsSync(dataRoot)
  let relocated = false, stopped = false, startAttempted = false
  try {
    if (fstab !== undefined) {
      mkdirSync(dataRoot, { recursive: true })
      const candidate = join(backup, 'fstab.next')
      writeFileSync(candidate, fstab, { mode: 0o600 })
      execFileSync('findmnt', ['--verify', '--tab-file', candidate], { stdio: 'pipe' })
    }
    if (state) { stopped = true; command(['stop'], fromDataRoot) }
    console.error(`dsh-deploy relocate: ${mode} ${fromDataRoot} -> ${dataRoot}`)
    if (mode === 'bind') {
      execFileSync('mount', ['--bind', fromDataRoot, dataRoot], { stdio: 'pipe' })
      relocated = true
      if (!sameDirectory(fromDataRoot, dataRoot) || realpathSync(dataRoot) !== dataRoot) throw new Error('挂载后目录身份核对失败')
      writeFileSync('/etc/fstab', fstab!, { mode: 0o644 })
      if (existsSync('/run/systemd/system')) execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' })
    } else {
      if (targetExisted) rmSync(dataRoot, { recursive: true })
      renameSync(fromDataRoot, dataRoot)
      relocated = true
      symlinkSync(dataRoot, fromDataRoot, 'dir')
    }
    const workspace = json(join(dataRoot, 'workspace.json'))
    workspace.legacyRoots = [...new Set([...workspace.legacyRoots, fromDataRoot])].filter(root => root !== dataRoot)
    save(join(dataRoot, 'workspace.json'), workspace)
    writeFileSync(envFile, originalEnv.replace(rootLine, `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-${quote(dataRoot)}}`))
    mkdirSync(dirname(locator), { recursive: true })
    save(locator, { ...(existsSync(locator) ? json(locator) : {}), assetRoot: dataRoot })
    command(['prepare', '--offline'], dataRoot)
    if (state) {
      startAttempted = true
      command(['start', ...platformAddressArgs(state)], dataRoot)
      report.restarted = true
      const next = lifecycle.managedState(dataRoot, prefix)
      if (!next || !lifecycle.ownsPort(next.pid, next.host, next.port)) throw new Error('迁移后平台进程归属核对失败')
      await sessionSnapshot(next.url, dataRoot, sessions)
      verifyWorkspace(dataRoot)
    }
    report.status = 'relocated'
    save(join(backup, 'receipt.json'), report)
    return report
  } catch (error) {
    writeFileSync(log, `\n${error instanceof Error ? error.stack : String(error)}\n`, { mode: 0o600, flag: 'a' })
    if (startAttempted && error instanceof Error && (['TimeoutError', 'AbortError'].includes(error.name) || error.message === 'fetch failed')) {
      save(join(backup, 'receipt.json'), { ...report, status: 'recovery-required' })
      throw new Error(`迁移后在线核对暂未完成，保留已就位的数据与平台；请查看 ${log} 并使用 --resume 重试核对`)
    }
    console.error('dsh-deploy relocate: 失败，恢复原定位与配置')
    try {
      if (startAttempted) command(['stop'], dataRoot)
      if (relocated) {
        if (mode === 'bind') execFileSync('umount', [dataRoot], { stdio: 'pipe' })
        else {
          if (existsSync(fromDataRoot) && lstatSync(fromDataRoot).isSymbolicLink()) rmSync(fromDataRoot)
          renameSync(dataRoot, fromDataRoot)
        }
      }
      for (const { file, content, permissions } of saved) {
        if (content === undefined) rmSync(file, { force: true })
        else { writeFileSync(file, content); chmodSync(file, permissions!) }
      }
      if (fstab !== undefined && existsSync('/run/systemd/system')) execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' })
      if (existsSync(dataRoot) && !targetExisted && readdirSync(dataRoot).length === 0) rmSync(dataRoot, { recursive: true })
      if (targetExisted && !existsSync(dataRoot)) mkdirSync(dataRoot)
      if (state && stopped) command(['start', ...platformAddressArgs(state)], fromDataRoot)
      save(join(backup, 'receipt.json'), { ...report, status: 'rolled-back' })
    } catch (recoveryError) {
      writeFileSync(log, `\n恢复失败：${recoveryError instanceof Error ? recoveryError.stack : String(recoveryError)}\n`, { mode: 0o600, flag: 'a' })
      save(join(backup, 'receipt.json'), { ...report, status: 'recovery-required' })
      throw new Error(`迁移失败且自动恢复未完成；原数据未删除，请查看 ${backup}/receipt.json 和 lifecycle.log`)
    }
    throw new Error(`迁移失败，已恢复原定位；请查看 ${backup}/lifecycle.log：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/** 远端执行的仍是本工具源码；只上传工具本身，不复制业务或程序仓库。 */
export function relocationSource(): string {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .replace("import { managerHome } from '../manager-home.mts'", managerHome.toString())
    .replace("import { platformAddressArgs } from '../plugin/src/business-control/runtime-address.ts'", platformAddressArgs.toString())
}

export function relocateRemote(target: string, options: RelocateOptions): number {
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target)) throw new Error('--ssh 需要 user@host，不接受 shell 参数')
  const source = relocationSource()
  const node = join(options.prefix, 'runtime/node/bin/node')
  const script = source + '\ntry { console.log(JSON.stringify(await relocate(JSON.parse(process.argv[2])), null, 2)) } catch (error) { console.error(error.message); process.exitCode = 1 }\n'
  return spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target,
    `${quote(node)} --input-type=module-typescript - ${quote(JSON.stringify(options))}`], { input: script, stdio: ['pipe', 'inherit', 'inherit'] }).status ?? 1
}

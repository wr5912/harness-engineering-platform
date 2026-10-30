import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { candidateDigest, candidateFiles, dataPath, sourceInfo } from '../tasks/files.ts'
import { programRoot } from '../workspace.ts'

type Body = Record<string, any>
export type DependencyTarget = { image: string; image_id: string; python_version: string; python_abi: string; os: string; libc: string; architecture: string }
export type DependencyMount = { source: string; target: string; read_only: true }
export type PreparedAssetDependencies = { status: 'ready' | 'pending'; reasons: string[]; mounts: DependencyMount[]; environment: Record<string, string>; target?: DependencyTarget; receipt?: Body }
export type AssetCommand = (command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }) => Promise<string>
type Declaration = { kind: 'node' | 'python'; path: string; directory: string; files: { path: string; sha256: string }[] }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const omitted = ['.venv', 'venv', '.local', '.env']
class DependencyError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
export const assetCommand: AssetCommand = (command, args, options) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } })
  let output = '', size = 0
  const collect = (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) child.kill('SIGKILL'); else output += chunk.toString() }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 180_000)
  child.on('error', error => { clearTimeout(timer); fail(error) })
  // 不返回安装器的原始输出，包索引凭据和来源 URL 不进入普通回执。
  child.on('close', code => { clearTimeout(timer); code === 0 && size <= 4 * 1024 * 1024 ? done(output.trim()) : fail(new DependencyError('dependency_pending', `${command} 依赖准备未完成（退出码 ${code ?? 'unknown'}），请核对目标环境、包版本和网络后重试`)) })
})
function atomic(file: string, value: string) { mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { writeFileSync(temp, value); renameSync(temp, file) } finally { rmSync(temp, { force: true }) } }
function declarations(candidate: string): Declaration[] {
  const files = candidateFiles(candidate, omitted).filter(path => /^dsh\/(?:managed|workspace)\//.test(path))
  const folders = new Map<string, string[]>()
  for (const path of files) if (/\/(?:package\.json|requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt|pyproject\.toml)$/.test(path)) {
    const directory = dirname(path), names = folders.get(directory) ?? []; names.push(path); folders.set(directory, names)
  }
  const result: Declaration[] = []
  for (const [directory, names] of folders) {
    const node = names.find(path => path.endsWith('/package.json'))
    if (node) {
      const manifest = JSON.parse(readFileSync(dataPath(candidate, node), 'utf8'))
      if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).length) {
        const lock = `${directory}/package-lock.json`
        result.push({ kind: 'node', path: node, directory, files: [node, ...(existsSync(dataPath(candidate, lock)) ? [lock] : [])].map(path => ({ path, sha256: hash(readFileSync(dataPath(candidate, path))) })) })
      }
    }
    const pythonNames = names.filter(path => !path.endsWith('/package.json'))
    const python = pythonNames.find(path => path.endsWith('/pyproject.toml')) ?? pythonNames.find(path => path.endsWith('/requirements.txt')) ?? pythonNames.filter(path => !path.endsWith('/requirements.lock.txt')).sort()[0] ?? pythonNames.find(path => path.endsWith('/requirements.lock.txt'))
    if (python && !python.endsWith('/package.json')) {
      const lock = `${directory}/requirements.lock.txt`
      result.push({ kind: 'python', path: python, directory, files: [python, ...(python !== lock && existsSync(dataPath(candidate, lock)) ? [lock] : [])].map(path => ({ path, sha256: hash(readFileSync(dataPath(candidate, path))) })) })
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
export function assetDependencyDeclarations(candidate: string) { return declarations(candidate) }
function declarationHash(items: Declaration[]) { return hash(JSON.stringify(items)) }
function entries(folder: string): { path: string; sha256: string }[] {
  const result: { path: string; sha256: string }[] = []
  function walk(path: string) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, item.name)
      if (item.isSymbolicLink()) {
        // npm 的 .bin 是工具链接，不装载、不执行；其余链接不接受为便携依赖。
        if (relative(folder, file).split('/').includes('.bin')) continue
        throw new DependencyError('dependency_pending', '依赖目录包含非便携符号链接')
      }
      if (item.isDirectory()) walk(file)
      else if (item.isFile()) result.push({ path: relative(folder, file).split('\\').join('/'), sha256: hash(readFileSync(file)) })
    }
  }
  walk(folder); return result
}
function dependencyRoot(root: string, id: string) { return dataPath(root, `.local/asset-dependencies/${id}`) }
/** 独立部署沿用其 DependencyPackage/path/lockSha256 合同，读取同一份已准备产物。 */
export function preparedAssetDependencyPackages(assetRoot: string, experimentId: string, arch?: string, expected: { image?: string; image_id?: string } = {}) {
  const prepared = resolvePreparedAssetDependencies(assetRoot, experimentId, expected)
  if (prepared.status !== 'ready' || !prepared.receipt || !prepared.target) return []
  if (arch && prepared.target?.architecture !== (arch === 'amd64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch)) return []
  const source = sourceInfo(assetRoot, experimentId), items = declarations(source.candidate)
  return items.map(item => {
    const pkg = prepared.receipt!.packages.find((pkg: Body) => pkg.declaration === item.path)
    const mount = prepared.mounts.find(mount => mount.target === pkg?.target)
    if (!mount) return null
    const names = item.kind === 'node' ? Object.keys(JSON.parse(readFileSync(dataPath(source.candidate, item.path), 'utf8')).dependencies ?? {}) : ['Python 项目声明']
    const directory = item.directory.slice('dsh/'.length)
    return { kind: item.kind, path: item.kind === 'python' ? `python/${directory}` : directory, name: item.path, dependencies: names,
      lockSha256: item.kind === 'node' ? hash(readFileSync(dataPath(source.candidate, `${item.directory}/package-lock.json`)))
        : hash(JSON.stringify(readdirSync(dataPath(source.candidate, item.directory)).filter(name => /^(?:requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt|pyproject\.toml)$/.test(name)).sort().map(name => [name, hash(readFileSync(dataPath(source.candidate, `${item.directory}/${name}`)))]))),
      modulesPath: mount.source, sourceFile: item.path, ready: true,
      preparedTarget: { image: prepared.target!.image, imageId: prepared.target!.image_id } }
  }).filter((item): item is NonNullable<typeof item> => item !== null)
}
/** 只读验证，不探测 Docker，也不执行已准备模块。供实例和评测共用。 */
export function resolvePreparedAssetDependencies(assetRoot: string, experimentId: string, expected: { image?: string; image_id?: string } = {}): PreparedAssetDependencies {
  try {
    const source = sourceInfo(assetRoot, experimentId), items = declarations(source.candidate)
    if (!items.length) return { status: 'ready', reasons: [], mounts: [], environment: {} }
    const root = dependencyRoot(assetRoot, source.id), pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))
    if (!/^[a-f0-9]{64}$/.test(pointer.digest)) throw new Error('无效依赖定位')
    const folder = dataPath(root, pointer.digest), receipt = JSON.parse(readFileSync(join(folder, 'receipt.json'), 'utf8'))
    const reasons: string[] = []
    if (hash(JSON.stringify(receipt)) !== pointer.digest || receipt.schema_version !== 1 || receipt.experiment_id !== source.id || receipt.declarations_sha256 !== declarationHash(items)) reasons.push('依赖声明、锁文件或回执已变化，需要重新准备')
    if (expected.image && expected.image !== receipt.target?.image || expected.image_id && expected.image_id !== receipt.target?.image_id) reasons.push('依赖的标准目标镜像已变化，需要重新准备')
    const mounts: DependencyMount[] = []
    for (const item of receipt.packages ?? []) {
      const path = dataPath(folder, item.path)
      if (hash(JSON.stringify(entries(path))) !== item.files_sha256) reasons.push('已准备依赖目录发生变化，需要重新准备')
      mounts.push({ source: path, target: item.target, read_only: true })
    }
    if (!mounts.length) reasons.push('依赖回执没有可装载目录')
    return { status: reasons.length ? 'pending' : 'ready', reasons, mounts: reasons.length ? [] : mounts, environment: reasons.length ? {} : receipt.environment ?? {}, target: receipt.target, receipt }
  } catch { return { status: 'pending', reasons: ['业务依赖尚未准备，或准备回执与产物无法完整核对'], mounts: [], environment: {} } }
}
const targetProbe = `import json,sys,sysconfig,platform; print(json.dumps(dict(python_version=platform.python_version(),python_abi='cp'+str(sys.version_info.major)+str(sys.version_info.minor),os=sys.platform,libc='-'.join(platform.libc_ver()),architecture=platform.machine())))`
async function targetEnvironment(image: string, fingerprint: string, command: AssetCommand, signal?: AbortSignal): Promise<DependencyTarget> {
  if (!image || image.startsWith('-') || /\s/.test(image)) throw new DependencyError('invalid_request', '目标镜像引用无效')
  const metadata = JSON.parse(await command('docker', ['image', 'inspect', '--format', '{{json .}}', image], { signal, timeout: 20_000 }))
  const id = metadata.Id
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new DependencyError('dependency_pending', '标准目标镜像尚未安装或身份无法核对')
  if (metadata.Config?.Labels?.['org.ai-agent-harness.dsh.image-build-fingerprint'] !== fingerprint) throw new DependencyError('dependency_pending', '目标镜像与当前锁定标准 Runtime 的构建指纹不匹配')
  const probe = JSON.parse(await command('docker', ['run', '--rm', '--network=none', '--read-only', '--entrypoint', 'python3', id, '-c', targetProbe], { signal, timeout: 30_000 }))
  if (probe.os !== 'linux' || !/^3\.\d+\.\d+$/.test(probe.python_version) || !['x86_64', 'aarch64'].includes(probe.architecture) || !/^glibc-\d+\.\d+$/.test(probe.libc)) throw new DependencyError('dependency_pending', '当前 Python 准备仅支持已核对的标准 Linux glibc 目标镜像')
  return { image, image_id: id, ...probe }
}
function pythonRequirements(candidate: string, item: Declaration) {
  const text = readFileSync(dataPath(candidate, item.path), 'utf8')
  let lines: string[]
  if (item.path.endsWith('.toml')) {
    const project = /(?:^|\n)\s*\[project\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/.exec(text)?.[1] ?? ''
    const opening = /(?:^|\n)\s*dependencies\s*=\s*\[/.exec(project)
    let list: string | undefined
    if (opening) {
      const start = opening.index + opening[0].length
      let quote = ''
      for (let index = start; index < project.length; index++) {
        const char = project[index]
        if (quote) { if (char === '\\' && quote === '"') index++; else if (char === quote) quote = '' }
        else if (char === '"' || char === "'") quote = char
        else if (char === ']') { list = project.slice(start, index); break }
      }
    }
    if (list === undefined) throw new DependencyError('dependency_pending', 'Python 项目没有静态 dependencies，需先声明明确的业务依赖')
    lines = [...list.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'/g)].map(match => match[1] ?? match[2])
  } else lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  // 只解析包索引声明，不允许本地目录、VCS、可编辑包、索引重定向和源构建。
  if (lines.some(line => !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*[<>=!~].*)?$/.test(line) || /(?:https?:|git\+|file:|\s@\s|--)/.test(line))) throw new DependencyError('dependency_pending', 'Python 依赖含本地、VCS、URL 或安装选项；请先提供包索引版本声明')
  return lines.join('\n') + '\n'
}
const unpackWheels = `import hashlib,json,pathlib,zipfile,email,sys
root=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True); locks=[]
for wheel in sorted(root.glob('*.whl')):
 with zipfile.ZipFile(wheel) as z:
  meta=[n for n in z.namelist() if n.endswith('.dist-info/METADATA')]
  if len(meta)!=1: raise ValueError('invalid wheel metadata')
  m=email.message_from_bytes(z.read(meta[0])); locks.append(m['Name']+'=='+m['Version']+' --hash=sha256:'+hashlib.sha256(wheel.read_bytes()).hexdigest())
  for n in z.namelist():
   p=pathlib.PurePosixPath(n)
   if p.is_absolute() or '..' in p.parts: raise ValueError('invalid wheel path')
   parts=list(p.parts)
   if parts and parts[0].endswith('.data'):
    if len(parts)<3 or parts[1] not in ('purelib','platlib'): continue
    parts=parts[2:]
   dest=out.joinpath(*parts)
   if n.endswith('/'): dest.mkdir(parents=True,exist_ok=True)
   else:
    if dest.exists(): raise ValueError('overlapping wheel files')
    dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(z.read(n))
print(json.dumps(dict(lock='\\n'.join(sorted(locks))+'\\n')))`
function validatePythonLock(text: string) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
  if (lines.some(line => !/^[A-Za-z0-9][A-Za-z0-9_.-]*==[^\s;]+\s+--hash=sha256:[a-f0-9]{64}$/.test(line))) throw new DependencyError('dependency_pending', 'Python 锁文件必须逐行提供精确版本和 wheel SHA-256')
  return lines.map(line => /^([^=]+)==([^\s]+)/.exec(line)!).map(match => ({ name: match[1].toLowerCase().replace(/[-_.]+/g, '_'), version: match[2] }))
}
function validatePreparedPython(folder: string, text: string, target: DependencyTarget) {
  const locked = validatePythonLock(text), files = entries(folder), installed = new Map<string, string>()
  const compatibleTag = (tag: string) => {
    const [interpreter, abi, platforms] = tag.trim().split('-'), version = Number(target.python_abi.slice(2))
    if (!interpreter || !abi || !platforms) return false
    const interpreterMatches = interpreter.split('.').some(value => value === 'py3' || value === `py${version}` || value === target.python_abi
      || abi === 'abi3' && /^cp3\d+$/.test(value) && Number(value.slice(2)) <= version)
    if (!interpreterMatches || !['none', 'abi3', target.python_abi].includes(abi)) return false
    return platforms.split('.').some(platform => {
      if (platform === 'any') return abi === 'none'
      const modern = /^manylinux_2_(\d+)_(x86_64|aarch64)$/.exec(platform)
      if (modern) return modern[2] === target.architecture && Number(modern[1]) <= Number(target.libc.split('.')[1])
      const legacy = /^manylinux(1|2010|2014)_(x86_64|aarch64)$/.exec(platform)
      return Boolean(legacy && legacy[2] === target.architecture && ({ '1': 5, '2010': 12, '2014': 17 }[legacy[1] as '1' | '2010' | '2014']) <= Number(target.libc.split('.')[1]))
    })
  }
  for (const file of files) {
    if (file.path.endsWith('.dist-info/METADATA')) {
      const metadata = readFileSync(join(folder, file.path), 'utf8'), name = /^Name:\s*(.+)$/m.exec(metadata)?.[1]?.trim(), version = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
      if (name && version) installed.set(name.toLowerCase().replace(/[-_.]+/g, '_'), version)
    }
    if (file.path.endsWith('.dist-info/WHEEL') && ![...readFileSync(join(folder, file.path), 'utf8').matchAll(/^Tag:\s*(.+)$/gm)].some(match => compatibleTag(match[1]))) throw new DependencyError('dependency_pending', 'Python wheel 的版本、ABI、OS/libc 或架构与标准目标镜像不兼容')
    if (/\.(?:pyd|dll)$/.test(file.path)) throw new DependencyError('dependency_pending', 'Python 库包含与 Linux 标准 Runtime 不兼容的原生文件')
    if (/\.so(?:\.\d+)*$/.test(file.path)) {
      const abi = /(?:cpython-|\.cp)(\d{2,3})/.exec(file.path)?.[1]
      if (abi && `cp${abi}` !== target.python_abi) throw new DependencyError('dependency_pending', 'Python 原生模块 ABI 与目标镜像不匹配')
      const bytes = readFileSync(join(folder, file.path))
      if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.readUInt16LE(18) !== (target.architecture === 'aarch64' ? 183 : 62)) throw new DependencyError('dependency_pending', 'Python 原生模块格式或架构与目标镜像不匹配')
    }
  }
  if (locked.some(item => installed.get(item.name) !== item.version)) throw new DependencyError('dependency_pending', 'Python site-packages 未包含精确锁声明的全部包版本')
}
function runtimeDirectory(path: string) {
  if (path === 'dsh/managed' || path.startsWith('dsh/managed/')) return '/opt/dsh-managed' + path.slice('dsh/managed'.length)
  return '/work/harness/workspace' + path.slice('dsh/workspace'.length)
}
/** 包管理器仅在独立准备目录运行；不会加载 Candidate 模块或执行来源脚本。 */
export function createAssetDependenciesHandler(assetRoot: string, options: { command?: AssetCommand } = {}) {
  const root = resolve(assetRoot), command = options.command ?? assetCommand
  const busy = new Set<string>()
  return async (body: Body, signal?: AbortSignal) => {
    let staging: string | undefined, id: string | undefined, acquired = false
    try {
      signal?.throwIfAborted()
      const source = sourceInfo(root, body.experiment_id); id = source.id
      if (busy.has(id)) throw new DependencyError('conflict', '该版本正在准备业务依赖')
      busy.add(id); acquired = true
      const before = candidateDigest(source.candidate)
      if (body.expected_candidate_sha256 && body.expected_candidate_sha256 !== before) throw new DependencyError('conflict', 'Candidate 已变化，请重新读取依赖声明')
      const items = declarations(source.candidate)
      if (body.declaration_paths !== undefined && (!Array.isArray(body.declaration_paths) || body.declaration_paths.some((path: unknown) => typeof path !== 'string')
        || JSON.stringify([...body.declaration_paths].sort()) !== JSON.stringify(items.map(item => item.path).sort()))) throw new DependencyError('invalid_request', 'declaration_paths 必须与自动发现的完整依赖声明一致；请先移除不属于目标运行的来源依赖')
      if (!items.length) return { ok: true as const, value: { experiment_id: id, ...resolvePreparedAssetDependencies(root, id) } }
      const platform = body.target_platform ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
      if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new DependencyError('invalid_request', '仅支持标准 linux/amd64 或 linux/arm64 Runtime')
      const identity = JSON.parse(await command(process.env.HARNESS_PYTHON || 'python3', [join(programRoot(), 'runtime/adapters/dsh-container/source_contract.py'), '--image-identity-for', platform], { signal, timeout: 20_000 }))
      if (body.target_image && body.target_image !== identity.tag) throw new DependencyError('invalid_request', '依赖必须针对当前锁定的标准 Runtime 镜像准备')
      const target = await targetEnvironment(identity.tag, identity.fingerprint, command, signal)
      if (target.architecture !== (platform === 'linux/amd64' ? 'x86_64' : 'aarch64')) throw new DependencyError('dependency_pending', '目标 Python 环境架构与标准镜像不匹配')
      const folder = dependencyRoot(root, id); mkdirSync(folder, { recursive: true })
      staging = join(folder, `.preparing-${randomUUID()}`); mkdirSync(staging)
      const packages: Body[] = [], pendingLocks: { path: string; value: string }[] = [], pythonPaths: string[] = []
      for (const [index, item] of items.entries()) {
        signal?.throwIfAborted()
        const destination = join(staging, `package-${index}`); mkdirSync(destination)
        if (item.kind === 'node') {
          const manifest = JSON.parse(readFileSync(dataPath(source.candidate, item.path), 'utf8'))
          if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(name => name.startsWith('@deepseek-ai/'))) throw new DependencyError('dependency_pending', 'DSH 公共模块应使用目标 Runtime 的共享 peerDependencies，不能安装第二份 DSH/Cordis')
          if (manifest.workspaces || Object.values({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(value => typeof value !== 'string' || /^(?:file:|link:|workspace:|git|https?:|\.\.?\/|\/)/.test(value))) throw new DependencyError('dependency_pending', 'Node 依赖包含工作区、本地路径或 VCS/URL；请先给出包索引版本')
          const sanitized = { ...manifest, scripts: {}, bin: undefined, workspaces: undefined }
          writeFileSync(join(destination, 'package.json'), JSON.stringify(sanitized, null, 2) + '\n')
          const lockPath = `${item.directory}/package-lock.json`, existing = existsSync(dataPath(source.candidate, lockPath))
          if (!existing && ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(name => existsSync(dataPath(source.candidate, `${item.directory}/${name}`)))) throw new DependencyError('dependency_pending', '该包已使用其他锁文件；请先明确转换为 package-lock.json，不能并行维护两份依赖锁')
          if (existing) {
            const saved = JSON.parse(readFileSync(dataPath(source.candidate, lockPath), 'utf8'))
            if (!saved.packages || Object.values(saved.packages).some((pkg: any) => pkg.link || pkg.resolved && !/^https:\/\//.test(pkg.resolved))) throw new DependencyError('dependency_pending', 'Node 锁文件包含非包索引来源，或缺少精确 packages 清单')
            writeFileSync(join(destination, 'package-lock.json'), JSON.stringify(saved, null, 2) + '\n')
          }
          const docker = ['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'npm_config_cache=/tmp/npm-cache', '-v', `${destination}:/prepare:rw`, '-w', '/prepare', '--entrypoint', 'npm', target.image_id]
          if (!existing) await command('docker', [...docker, 'install', '--package-lock-only', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund'], { signal })
          await command('docker', [...docker, 'ci', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund'], { signal })
          const nodeModules = join(destination, 'node_modules'); if (!existsSync(nodeModules)) throw new DependencyError('dependency_pending', 'Node 安装器没有生成依赖目录')
          const installedLock = JSON.parse(readFileSync(join(destination, 'package-lock.json'), 'utf8'))
          if (Object.values(installedLock.packages ?? {}).some((pkg: any) => pkg.hasInstallScript)) throw new DependencyError('dependency_pending', 'Node 依赖包含安装 Hook；已跳过执行，需先提供无需 Hook 的目标依赖或受控适配后再准备')
          if (!existing) pendingLocks.push({ path: lockPath, value: readFileSync(join(destination, 'package-lock.json'), 'utf8') })
          packages.push({ kind: 'node', declaration: item.path, path: `package-${index}/node_modules`, target: runtimeDirectory(item.directory) + '/node_modules', files_sha256: hash(JSON.stringify(entries(nodeModules))) })
        } else {
          const wheels = join(destination, 'wheels'), site = join(destination, 'site-packages'); mkdirSync(wheels)
          const lockPath = `${item.directory}/requirements.lock.txt`, existing = existsSync(dataPath(source.candidate, lockPath))
          const supplied = Array.isArray(body.prepared_python) ? body.prepared_python.find((value: Body) => value.declaration_path === item.path) : undefined
          if (supplied) {
            if (!existing || !supplied.target || Object.keys(target).some(key => supplied.target[key] !== target[key as keyof DependencyTarget])) throw new DependencyError('dependency_pending', '已准备 Python 库必须具有精确锁文件和匹配标准目标镜像的完整 Python/ABI/OS/libc/架构声明')
            const suppliedPath = dataPath(root, supplied.path)
            const files = entries(suppliedPath)
            if (!files.length) throw new DependencyError('dependency_pending', '已准备 Python 库目录为空')
            // 只复制已声明的库文件；不接受宿主 venv 及其 bin/pyvenv.cfg。
            if (existsSync(join(suppliedPath, 'pyvenv.cfg')) || existsSync(join(suppliedPath, 'bin')) || files.some(file => file.path.split('/').includes('site-packages'))) throw new DependencyError('dependency_pending', '请提供 site-packages 本身，不能复制宿主 venv')
            validatePreparedPython(suppliedPath, readFileSync(dataPath(source.candidate, lockPath), 'utf8'), target)
            cpSync(suppliedPath, site, { recursive: true, dereference: false })
            const mount = `/opt/harness-python/${hash(item.path).slice(0, 16)}/site-packages`; pythonPaths.push(mount)
            packages.push({ kind: 'python', declaration: item.path, path: `package-${index}/site-packages`, target: mount, files_sha256: hash(JSON.stringify(entries(site))) })
            continue
          }
          const requirements = existing ? readFileSync(dataPath(source.candidate, lockPath), 'utf8') : pythonRequirements(source.candidate, item)
          if (existing) validatePythonLock(requirements)
          const req = join(destination, 'requirements.txt'); writeFileSync(req, requirements)
          const requested = existing && item.path !== lockPath ? join(destination, 'requested.txt') : undefined
          if (requested) writeFileSync(requested, pythonRequirements(source.candidate, item))
          const glibc = Number(target.libc.split('.')[1]), arch = target.architecture, platforms: string[] = []
          for (let minor = glibc; minor >= 17; minor--) platforms.push('--platform', `manylinux_2_${minor}_${arch}`)
          platforms.push('--platform', `manylinux2014_${arch}`)
          if (arch === 'x86_64') platforms.push('--platform', 'manylinux2010_x86_64', '--platform', 'manylinux1_x86_64')
          const python = process.env.HARNESS_PYTHON || 'python3'
          await command(python, ['-m', 'pip', 'download', '--only-binary=:all:', '--disable-pip-version-check', '--dest', wheels, '--implementation', 'cp', '--python-version', target.python_version.split('.').slice(0, 2).join('.'), '--abi', target.python_abi, ...platforms, ...(existing ? ['--require-hashes'] : []), '-r', req, ...(requested ? ['-r', requested] : [])], { signal })
          if (!readdirSync(wheels).length && requirements.trim()) throw new DependencyError('dependency_pending', '没有适配标准目标镜像的 Python wheel')
          const unpacked = JSON.parse(await command(python, ['-I', '-c', unpackWheels, wheels, site], { signal }))
          validatePreparedPython(site, existing ? requirements : unpacked.lock, target)
          if (!existing) pendingLocks.push({ path: lockPath, value: unpacked.lock })
          const mount = `/opt/harness-python/${hash(item.path).slice(0, 16)}/site-packages`; pythonPaths.push(mount)
          packages.push({ kind: 'python', declaration: item.path, path: `package-${index}/site-packages`, target: mount, files_sha256: hash(JSON.stringify(entries(site))) })
        }
      }
      signal?.throwIfAborted()
      if (candidateDigest(source.candidate) !== before) throw new DependencyError('conflict', '准备依赖期间 Candidate 已变化，未保存锁文件或回执')
      for (const item of pendingLocks) if (existsSync(dataPath(source.candidate, item.path))) throw new DependencyError('conflict', '准备期间已出现新的锁文件，请重新准备')
      const written: string[] = []
      try {
        for (const item of pendingLocks) { atomic(dataPath(source.candidate, item.path), item.value); written.push(item.path) }
        const receipt = { schema_version: 1, experiment_id: id, declarations_sha256: declarationHash(declarations(source.candidate)), target, packages, environment: pythonPaths.length ? { PYTHONPATH: pythonPaths.join(':') } : {} }
        const digest = hash(JSON.stringify(receipt)); writeFileSync(join(staging, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
        const destination = join(folder, digest)
        if (!existsSync(destination)) renameSync(staging, destination)
        atomic(join(folder, 'current.json'), JSON.stringify({ digest }, null, 2) + '\n')
        return { ok: true as const, value: { experiment_id: id, candidate_sha256: candidateDigest(source.candidate), generated_locks: written, ...resolvePreparedAssetDependencies(root, id, { image_id: target.image_id }) } }
      } catch (error) {
        for (const path of written) { const item = pendingLocks.find(item => item.path === path)!; const file = dataPath(source.candidate, path); if (existsSync(file) && readFileSync(file, 'utf8') === item.value) rmSync(file) }
        throw error
      }
    } catch (error) {
      return { ok: false as const, error: { code: signal?.aborted ? 'aborted' : error instanceof DependencyError ? error.code : 'dependency_pending', message: signal?.aborted ? '依赖准备已取消' : error instanceof DependencyError ? error.message : '业务依赖尚未准备完成，请核对声明、目标镜像与包安装环境' }, value: { status: 'pending' as const } }
    } finally { if (staging) rmSync(staging, { recursive: true, force: true }); if (id && acquired) busy.delete(id) }
  }
}

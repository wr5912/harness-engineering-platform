import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { candidateFiles } from '../../plugin/src/tasks/files.ts'
import { versionSource, assertStandaloneVersionSupported } from '../../plugin/src/agents/version-source.ts'
import { assetDependencyDeclarations, preparedAssetDependencyPackages } from '../../plugin/src/agents/asset-dependencies.ts'
import { expectedImage } from '../image.mts'
import { collectEntries, sha256File } from '../manifest.mts'
import { isGlibcLibrary } from '../fsutil.mts'
import type { AgentPackageInput, AgentSourceSnapshot, DependencyPackage } from './types.mts'

const allowedRoots = new Map([['dsh/workspace', 'workspace'], ['dsh/presets', 'presets'], ['dsh/managed', 'managed']])
const omittedPart = new Set(['.local', '.env', '.venv', 'venv', 'RuntimeHOME', 'sessions', 'cache', '.git', 'node_modules', '__pycache__'])
const localArch = () => process.arch === 'arm64' ? 'arm64' : 'amd64'

/** 与现有 Candidate 摘要相同口径，大权重文件通过流式系统校验避免读入 Host 内存。 */
export function agentCandidateDigest(candidate: string): string {
  const hash = createHash('sha256')
  for (const path of candidateFiles(candidate, ['.venv', 'venv'])) {
    const mode = lstatSync(join(candidate, path)).mode & 0o111 ? 0o755 : 0o644
    hash.update(JSON.stringify([path, mode, sha256File(join(candidate, path))]))
  }
  return hash.digest('hex')
}

function gitState(root: string) {
  const invoke = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
  const head = invoke(['rev-parse', 'HEAD']), status = invoke(['status', '--porcelain'])
  return { commit: head.status === 0 ? head.stdout.trim() : 'unknown', dirty: status.status !== 0 || Boolean(status.stdout.trim()) }
}

/** 检查所有已带入的原生库，不能以主机目录名代替目标架构。 */
export function assertDependencyArchitecture(root: string, arch: string): void {
  if (lstatSync(root).isSymbolicLink()) throw new Error('依赖根不能是指向包外的符号链接，请准备普通目录')
  const expected = arch === 'arm64' ? 183 : 62
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (isGlibcLibrary(path)) throw new Error('业务依赖不能夹带宿主 glibc 或动态加载器')
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path))
        if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error('依赖包含包外符号链接，请先准备可移植的目标架构依赖')
        if (!existsSync(target)) throw new Error('依赖包含悬空符号链接，请重新准备依赖')
      } else if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(?:node|so(?:\.\d+)*)$/.test(entry.name)) {
        const bytes = readFileSync(path)
        if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
          if (machine !== expected) throw new Error(`业务原生依赖架构不符：${relative(root, path)}，请准备 ${arch} 版本`)
        }
      }
    }
  }
  walk(root)
}

function pythonPackages(candidate: string, input: AgentPackageInput): DependencyPackage[] {
  const result: DependencyPackage[] = []
  let preparedPackages: Array<{ path: string; lockSha256?: string; preparedTarget?: DependencyPackage['preparedTarget'] }> = []
  try { preparedPackages = JSON.parse(readFileSync(join(input.resourcesDir!, 'resources.json'), 'utf8')).dependencies ?? [] } catch { /* 未准备的资源保持明确缺口。 */ }
  for (const declaration of candidateFiles(candidate, ['.venv', 'venv'])) {
    if (!/^dsh\/(?:workspace|managed)\//.test(declaration) || declaration.split('/').some(name => omittedPart.has(name))) continue
    const filename = declaration.split('/').at(-1)!
    if (!/^(?:requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt|pyproject\.toml)$/.test(filename)) continue
    const path = `python/${relative(join(candidate, 'dsh'), dirname(join(candidate, declaration))).split(sep).join('/')}`
    // 同一目录只保留一个环境声明事实，pyproject 优先于附带的requirements投影。
    if (result.some(item => item.path === path)) continue
    const directory = dirname(join(candidate, declaration))
    const declarations = readdirSync(directory).filter(name => /^(?:requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt|pyproject\.toml)$/.test(name)).sort()
    const lockSha256 = createHash('sha256').update(JSON.stringify(declarations.map(name => [name, sha256File(join(directory, name))]))).digest('hex')
    const text = readFileSync(join(candidate, declaration), 'utf8')
    const requirementLines = filename.endsWith('.txt') ? text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')) : []
    let project = '', section = ''
    if (filename.endsWith('.toml')) for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) section = line.trim()
      else if (section === '[project]') project += line + '\n'
    }
    const opening = /(?:^|\n)\s*dependencies\s*=\s*\[/.exec(project)
    let declared: string | undefined
    if (opening) {
      const start = opening.index + opening[0].length
      let quote = ''
      for (let index = start; index < project.length; index++) {
        const char = project[index]
        if (quote) { if (char === '\\' && quote === '"') index++; else if (char === quote) quote = '' }
        else if (char === '"' || char === "'") quote = char
        else if (char === ']') { declared = project.slice(start, index); break }
      }
    }
    const entries = filename.endsWith('.txt') ? requirementLines : declared !== undefined ? [...declared.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'/g)].map(match => match[1] ?? match[2]) : []
    const names = entries.map(line => /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(line)?.[1]).filter((name): name is string => Boolean(name))
    const unresolved = filename.endsWith('.txt') ? entries.some(line => !/^\s*[A-Za-z0-9][A-Za-z0-9_.-]*/.test(line)) : declared === undefined
    const prepared = input.resourcesDir ? join(input.resourcesDir, 'dependencies', path, 'site-packages') : ''
    const preparedPackage = preparedPackages.find(item => item.path === path && item.lockSha256 === lockSha256)
    const preparedMatches = Boolean(preparedPackage)
    const vendor = ['vendor/site-packages', 'site-packages'].map(name => join(directory, name)).find(existsSync)
    let native = false
    if (vendor) {
      const inspect = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const file = join(folder, entry.name)
          if (entry.isDirectory()) inspect(file)
          else if (entry.isSymbolicLink() || /\.(?:so(?:\.\d+)*|pyd|dll)$/.test(entry.name)) native = true
        }
      }
      inspect(vendor)
    }
    const modulesPath = prepared && preparedMatches && existsSync(prepared) ? prepared : vendor && !native ? vendor : undefined
    let ready = Boolean(modulesPath) && !unresolved
    if (ready && names.length) {
      const entries = readdirSync(modulesPath!)
      ready = names.every(name => {
        const normalized = name.toLowerCase().replace(/[-_.]+/g, '_')
        return entries.some(entry => {
          const value = entry.toLowerCase().replace(/[-_.]+/g, '_')
          return value === normalized || value === normalized + '_py' || value.startsWith(normalized + '_') && value.endsWith('_dist_info')
        })
      })
    }
    if (ready) { try { assertDependencyArchitecture(modulesPath!, input.arch) } catch { ready = false } }
    result.push({ kind: 'python', path, name: `Python 环境（${relative(join(candidate, 'dsh'), directory).split(sep).join('/')}）`,
      sourceFile: declaration, dependencies: names.length ? names : ['Python 项目声明'], lockSha256,
      ...(modulesPath ? { modulesPath } : {}), ...(modulesPath === prepared && preparedPackage?.preparedTarget ? { preparedTarget: preparedPackage.preparedTarget } : {}), ready,
      ...(!ready ? { reason: unresolved ? 'Python 声明含未解析的环境/引用，需先准备明确的便携依赖，不能按零依赖出包'
        : native ? '含原生 Python 扩展，需要与目标 DSH 镜像兼容的已准备依赖；不会复制宿主 venv 或执行安装 Hook'
        : modulesPath ? '已有 Python 库目录未包含全部声明包，或目标架构不匹配，请补齐后重试'
          : '缺少可移植的 vendor/site-packages 或目标架构 site-packages；不会在目标机联网 pip install' } : {}) })
  }
  return result
}

function dependencyPackages(candidate: string, input: AgentPackageInput): DependencyPackage[] {
  const result: DependencyPackage[] = []
  let preparedPackages: Array<{ path: string; lockSha256?: string; preparedTarget?: DependencyPackage['preparedTarget'] }> = []
  if (input.resourcesDir) {
    try { preparedPackages = JSON.parse(readFileSync(join(input.resourcesDir, 'resources.json'), 'utf8')).dependencies ?? [] }
    catch { /* 未生成清单的目录不能冒充已核对的依赖缓存。 */ }
  }
  const walk = (path: string) => {
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const dependencies = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter(name => !pkg.peerDependenciesMeta?.[name]?.optional
        && !(name.startsWith('@deepseek-ai/') && existsSync(join(input.programRoot, 'platform/plugin/node_modules', name, 'package.json'))))])]
      if (dependencies.length) {
        const relativePath = relative(join(candidate, 'dsh'), path).split(sep).join('/')
        const lock = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json'].map(name => join(path, name)).find(existsSync)
        const lockSha256 = lock ? sha256File(lock) : createHash('sha256').update(readFileSync(manifest)).digest('hex')
        const prepared = input.resourcesDir ? join(input.resourcesDir, 'dependencies', relativePath, 'node_modules') : ''
        const local = join(path, 'node_modules')
        const preparedPackage = preparedPackages.find(item => item.path === relativePath && item.lockSha256 === lockSha256)
        const preparedMatches = Boolean(preparedPackage)
        const modules = prepared && preparedMatches && existsSync(prepared) ? prepared : localArch() === input.arch && existsSync(local) ? local : undefined
        let ready = Boolean(modules && dependencies.every(name => existsSync(join(modules, name))))
        if (ready) { try { assertDependencyArchitecture(modules!, input.arch) } catch { ready = false } }
        result.push({ path: relativePath, name: pkg.name ?? relativePath, dependencies, lockSha256, ...(modules ? { modulesPath: modules } : {}),
          ...(modules === prepared && preparedPackage?.preparedTarget ? { preparedTarget: preparedPackage.preparedTarget } : {}), ready })
      }
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && !omittedPart.has(entry.name)) walk(join(path, entry.name))
  }
  for (const name of ['dsh/managed', 'dsh/workspace']) if (existsSync(join(candidate, name))) walk(join(candidate, name))
  return result
}

export function inspectAgentSnapshot(input: AgentPackageInput, targetImage?: { tag: string; id: string }): AgentSourceSnapshot {
  if (!['amd64', 'arm64'].includes(input.arch) || !['online', 'offline'].includes(input.mode)) throw new Error('部署架构或模式无效')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.agentId)) throw new Error('智能体身份无效')
  const source = versionSource(input.assetRoot, input.experimentId)
  assertStandaloneVersionSupported(source)
  if (source.agent_id !== input.agentId) throw new Error('所选版本不属于当前智能体')
  const candidate = resolve(input.assetRoot, source.candidate_root, '..')
  const { load } = createRequire(join(input.programRoot, 'platform/plugin/package.json'))('js-yaml')
  const harness = load(readFileSync(join(candidate, 'harness.yaml'), 'utf8')) as any
  source.preset_id = harness.loadable_assets.preset_id
  const digest = agentCandidateDigest(candidate)
  if (input.expectedCandidateSha256 && digest !== input.expectedCandidateSha256) throw new Error('版本资产已变化，请刷新预览后重试')
  const files: AgentSourceSnapshot['files'] = [], omitted: string[] = []
  for (const path of candidateFiles(candidate, ['.venv', 'venv'])) {
    if (path.split('/').some(part => omittedPart.has(part)) || path.endsWith('.llm-api-key')) { omitted.push(path); continue }
    let target: string | undefined
    if (path === 'harness.yaml') target = 'assets/harness.yaml'
    for (const [prefix, destination] of allowedRoots) if (path.startsWith(prefix + '/')) target = `assets/${destination}/${path.slice(prefix.length + 1)}`
    if (!target) { omitted.push(path); continue }
    const file = join(candidate, path), stat = lstatSync(file)
    files.push({ path: target, sourcePath: path, sha256: sha256File(file), mode: stat.mode & 0o111 ? 0o755 : 0o644 })
  }
  for (const [prefix] of allowedRoots) if (!existsSync(join(candidate, prefix)) || !lstatSync(join(candidate, prefix)).isDirectory()) throw new Error(`来源缺少装载目录：${prefix}`)
  if (!files.some(file => file.sourcePath === `dsh/managed/${source.patch}`) || !files.some(file => file.sourcePath === `dsh/presets/${source.preset}`)) throw new Error('来源缺少实际 Profile Patch 或 Preset')
  const dependencies = [...dependencyPackages(candidate, input), ...pythonPackages(candidate, input)]
  let image: { tag?: string; id?: string } = targetImage ?? {}
  if (!targetImage && input.resourcesDir) try { image = JSON.parse(readFileSync(join(input.resourcesDir, 'resources.json'), 'utf8')).image ?? {} } catch { /* 运行资源缺失由调用方报告。 */ }
  const matchesTarget = (dependency: DependencyPackage) => !dependency.preparedTarget || !image.id || dependency.preparedTarget.imageId === image.id && dependency.preparedTarget.image === image.tag
  // 普通实例与独立部署复用同一份已核对依赖；不回拷到 Candidate 或复制宿主 venv。
  const preparedPackages = assetDependencyDeclarations(candidate).length ? preparedAssetDependencyPackages(input.assetRoot, input.experimentId, input.arch, { image: expectedImage(input.programRoot, input.arch).tag }) : []
  for (const prepared of preparedPackages) {
    const index = dependencies.findIndex(item => item.path === prepared.path)
    if (index >= 0 && dependencies[index].lockSha256 !== prepared.lockSha256) continue
    if (index >= 0 && dependencies[index].ready && matchesTarget(dependencies[index]) && input.resourcesDir && dependencies[index].modulesPath?.startsWith(resolve(input.resourcesDir) + sep)) continue
    assertDependencyArchitecture(prepared.modulesPath, input.arch)
    const frozen = { ...prepared, preparedFiles: dependencyEntries(prepared.modulesPath) }
    if (index >= 0) dependencies[index] = { ...dependencies[index], ...frozen, reason: undefined }
    else dependencies.push(frozen)
  }
  for (const dependency of dependencies) if (!matchesTarget(dependency)) {
    dependency.ready = false; dependency.reason = '已准备业务依赖对应另一标准镜像，需要针对当前运行资源重新准备'
  }
  return { agentId: input.agentId, experimentId: input.experimentId, candidate, candidateSha256: digest, source, files, omitted,
    dependencies, git: gitState(input.assetRoot) }
}

export function copyAgentSnapshot(snapshot: AgentSourceSnapshot, staging: string, signal?: AbortSignal): void {
  for (const file of snapshot.files) {
    signal?.throwIfAborted()
    const source = join(snapshot.candidate, file.sourcePath), target = join(staging, file.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    chmodSync(target, file.mode)
    if (sha256File(target) !== file.sha256) throw new Error('版本资产在导出期间变化，请重新导出')
  }
  if (agentCandidateDigest(snapshot.candidate) !== snapshot.candidateSha256) throw new Error('版本资产在导出期间变化，请重新导出')
}

export function dependencyEntries(path: string) { return collectEntries(realpathSync(path)) }

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sha256File } from '../manifest.mts'
import type { StandaloneExtension } from '../../plugin/src/standalone-extensions/index.ts'

const id = 'security-operations-compositions'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const standardPython = new Set('__future__ argparse base64 collections concurrent contextlib copy dataclasses datetime decimal enum functools hashlib html http io ipaddress itertools json math numbers os pathlib re signal socket ssl subprocess sys tempfile threading time typing urllib uuid zoneinfo'.split(' '))
interface Options { programRoot: string; assetRoot: string; staging: string; compositions?: any; signal?: AbortSignal; onProgress?: (value: { stage: string; message: string }) => void }
interface SourceFile { path: string; sha256: string }

/** 只遍历已选目录的发布项与其明确引用的固定子版本。 */
function requiredBusiness(catalog: any): { threat: boolean; flow: boolean } {
  const result = { threat: false, flow: false }
  function visit(config: any, path = new Set<string>()) {
    if (!config) return
    if (config.kind === 'threat-stage') result.threat = true
    else if (config.kind === 'composite') for (const step of config.steps ?? []) {
      const key = `${step.compositionId}:${step.versionId}`
      if (path.has(key)) throw new Error('独立部署组合存在循环版本依赖')
      const child = catalog.compositions.find((item: any) => item.id === step.compositionId)?.versions?.find((item: any) => item.versionId === step.versionId)?.config
      if (!child) throw new Error('独立部署组合缺少所引用的固定子版本')
      visit(child, new Set([...path, key]))
    }
    else if (config.flow) {
      if (config.flow !== 'soc-asset-alerts') throw new Error('此业务流程尚未提供独立运行扩展')
      result.flow = true
    }
  }
  for (const entry of catalog?.compositions ?? []) visit(entry.published)
  return result
}

function plainFile(root: string, file: string) {
  const base = realpathSync(root), path = realpathSync(file)
  if (!path.startsWith(base + sep) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('业务扩展包含包外链接或无效文件')
  return path
}
function git(root: string, args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })
  if (result.status !== 0) throw new Error('业务扩展的固定算法来源不可用，请恢复声明的 Git 提交后重试')
  return result.stdout
}

/** 仅静态构建平台明确装载的安全运营扩展；不执行数据工作区的 build 或安装脚本。 */
export async function stageSelectedExtensions(options: Options) {
  const needed = requiredBusiness(options.compositions)
  if (!needed.threat && !needed.flow) return { extensions: [] as StandaloneExtension[], sources: [] as SourceFile[] }
  options.signal?.throwIfAborted()
  options.onProgress?.({ stage: 'extensions', message: '正在冻结所用业务编排实现与固定算法' })
  const assetRoot = realpathSync(options.assetRoot), programRoot = realpathSync(options.programRoot)
  let declared: any
  try { declared = JSON.parse(readFileSync(join(assetRoot, 'workspace.json'), 'utf8')).extensions?.find((item: any) => item.id === id) } catch { /* 缺口用统一业务说明。 */ }
  if (declared?.path !== 'extensions/security-operations') throw new Error('所选组合需要工作区声明的 security-operations 业务扩展')
  const business = realpathSync(join(assetRoot, declared.path))
  if (!business.startsWith(assetRoot + sep)) throw new Error('业务扩展不在当前数据工作区内')
  const sources: SourceFile[] = []
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) collect(file)
      else { plainFile(business, file); sources.push({ path: relative(assetRoot, file).split(sep).join('/'), sha256: sha256File(file) }) }
    }
  }
  collect(join(business, 'src'))
  if (existsSync(join(business, 'package.json'))) {
    const manifest = plainFile(business, join(business, 'package.json')), pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.peerDependencies ?? {}).length) throw new Error('业务扩展声明了额外 Node 环境，尚未准备独立部署依赖')
    sources.push({ path: relative(assetRoot, manifest).split(sep).join('/'), sha256: sha256File(manifest) })
  }
  for (const entry of readdirSync(business)) if (/^(?:requirements[^/]*\.txt|pyproject\.toml)$/.test(entry)) throw new Error('业务扩展声明了额外 Python 环境，尚未准备独立部署依赖')
  const sourceText = readFileSync(plainFile(business, join(business, 'src/threat/source.ts')), 'utf8')
  const commit = /export const THREAT_SOURCE_COMMIT = ['"]([0-9a-f]{40})['"]/.exec(sourceText)?.[1]
  const sourceDirectory = /export const THREAT_SOURCE_DIRECTORY = ['"]([^'"\r\n]+)['"]/.exec(sourceText)?.[1]
  if (!commit || !sourceDirectory || sourceDirectory.startsWith('/') || sourceDirectory.split('/').some(part => !part || ['.', '..'].includes(part))) throw new Error('业务扩展的固定算法来源声明无效')
  const destination = join(options.staging, 'runtime/extensions', id)
  mkdirSync(destination, { recursive: true })
  let fixed: { commit: string; directory: string; digest: string; files: SourceFile[] } | undefined
  if (needed.threat) {
    const rows = git(assetRoot, ['ls-tree', '-r', '-z', commit, '--', sourceDirectory, sourceDirectory + '.mjs']).toString('utf8').split('\0').filter(Boolean)
    if (!rows.length) throw new Error('业务扩展的固定算法来源为空')
    const contents = new Map<string, Buffer>()
    for (const row of rows) {
      options.signal?.throwIfAborted()
      const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/.exec(row)
      if (!match) throw new Error('固定算法包含链接或非普通文件')
      const name = match[2], path = name === sourceDirectory + '.mjs' ? 'threat-analysis.mjs' : 'threat-analysis/' + name.slice(sourceDirectory.length + 1)
      if (!name.startsWith(sourceDirectory + '/') && name !== sourceDirectory + '.mjs') throw new Error('固定算法路径无效')
      contents.set(path, git(assetRoot, ['show', `${commit}:${name}`]))
    }
    if (!contents.has('threat-analysis.mjs')) throw new Error('固定算法缺少模型适配入口')
    const localModules = new Set([...contents.keys()].filter(name => name.endsWith('.py')).map(name => basename(name, '.py')))
    for (const [path, bytes] of contents) {
      if (/(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml)$/.test(path)) throw new Error('业务扩展声明了额外 Python 环境，尚未准备独立部署依赖')
      if (path.endsWith('package.json')) {
        const pkg = JSON.parse(bytes.toString('utf8'))
        if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.peerDependencies ?? {}).length) throw new Error('固定算法声明了额外 Node 依赖，尚未准备独立部署依赖')
      }
      if (path.endsWith('.py')) for (const line of bytes.toString('utf8').split(/\r?\n/)) {
        const imports = /^\s*(?:from\s+([A-Za-z_]\w*)[.\w]*\s+import\b|import\s+(.+))/.exec(line)
        const names = imports?.[1] ? [imports[1]] : imports?.[2]?.split(',').map(value => /^\s*([A-Za-z_]\w*)/.exec(value)?.[1]).filter(Boolean) ?? []
        if (names.some(name => !standardPython.has(name!) && !localModules.has(name!))) throw new Error('固定算法使用了尚未准备的 Python 依赖，请先补齐独立运行环境')
      }
    }
    const files: SourceFile[] = []
    for (const [path, bytes] of contents) { const target = join(destination, 'fixed-source', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { mode: 0o444 }); files.push({ path, sha256: hash(bytes) }) }
    fixed = { commit, directory: sourceDirectory, digest: hash(JSON.stringify(files)), files }
    writeFileSync(join(destination, 'fixed-source/index.json'), JSON.stringify(fixed, null, 2) + '\n', { mode: 0o444 })
  }
  const adapter = join(programRoot, 'platform/plugin/src/standalone-extensions')
  const compiledInputs: Array<{ path: string; sha256: string; absolute: string }> = []
  const require = createRequire(join(programRoot, 'platform/plugin/package.json'))
  const { build } = require('esbuild')
  const runtime = join(business, 'src/threat/runtime.ts'), services = join(business, 'src/threat-services.ts'), flow = join(business, 'src/asset-alerts.ts')
  const entry = `import { populateSecurityOperations } from ${JSON.stringify(join(adapter, 'security-operations.ts'))};\n`
    + `import { createThreatRuntime } from ${JSON.stringify(runtime)};\nimport { createNativeThreatServices } from ${JSON.stringify(services)};\nimport { assetAlertsFlow } from ${JSON.stringify(flow)};\n`
    + 'export const populate=(ctx,options)=>populateSecurityOperations(ctx,options,{createThreatRuntime,createNativeThreatServices,assetAlertsFlow});\n'
  options.signal?.throwIfAborted()
  const output = await build({ stdin: { contents: entry, resolveDir: business, sourcefile: 'standalone-security-operations.ts', loader: 'ts' }, bundle: true, write: false,
    platform: 'node', target: 'node24', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent',
    define: { __STANDALONE_THREAT_SOURCE_COMMIT__: JSON.stringify(commit), __STANDALONE_THREAT_SOURCE_DIRECTORY__: JSON.stringify(sourceDirectory), __STANDALONE_THREAT_SOURCE_DIGEST__: JSON.stringify(fixed?.digest ?? '') },
    plugins: [{ name: 'standalone-business-boundaries', setup(builder: any) {
      builder.onResolve({ filter: /^@harness-platform\/mcp\/extension$/ }, () => ({ path: join(programRoot, 'platform/plugin/src/mcp/extension.ts') }))
      builder.onResolve({ filter: /(?:^|\/)source\.ts$/ }, (args: any) => resolve(args.resolveDir, args.path) === join(business, 'src/threat/source.ts') ? { path: join(adapter, 'source.ts') } : undefined)
      builder.onLoad({ filter: /\.ts$/ }, (args: any) => {
        const absolute = realpathSync(args.path), contents = readFileSync(absolute, 'utf8')
        const prefix = absolute.startsWith(programRoot + sep) ? 'program' : absolute.startsWith(assetRoot + sep) ? 'data' : undefined
        if (!prefix) throw new Error('业务扩展引用了当前程序与数据工作区以外的源码')
        compiledInputs.push({ path: `${prefix}/${relative(prefix === 'program' ? programRoot : assetRoot, absolute).split(sep).join('/')}`, sha256: hash(contents), absolute })
        return { contents, loader: 'ts', resolveDir: dirname(absolute) }
      })
    } }],
  })
  for (const outputFile of Object.values(output.metafile.outputs) as any[]) for (const item of outputFile.imports) if (item.external && !builtinModules.includes(item.path) && !item.path.startsWith('node:')) throw new Error('业务扩展仍有未准备的外部 Node 依赖')
  options.signal?.throwIfAborted()
  for (const source of sources) if (sha256File(join(assetRoot, source.path)) !== source.sha256) throw new Error('业务扩展在导出期间变化，请重新导出')
  for (const source of compiledInputs) if (sha256File(source.absolute) !== source.sha256) throw new Error('业务扩展引用的程序源码在导出期间变化，请重新导出')
  const implementation = compiledInputs.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  const sourceDigest = hash(JSON.stringify({ sources, fixed, implementation }))
  const entryPath = `runtime/extensions/${id}/plugin.mjs`
  writeFileSync(join(options.staging, entryPath), output.outputFiles[0].contents, { mode: 0o444 })
  const extensions: StandaloneExtension[] = [{ id, entry: entryPath, sha256: sha256File(join(options.staging, entryPath)), sourceDigest }]
  return { extensions, sources, implementation, ...(fixed ? { fixedSource: { commit: fixed.commit, directory: fixed.directory, digest: fixed.digest, files: fixed.files } } : {}) }
}

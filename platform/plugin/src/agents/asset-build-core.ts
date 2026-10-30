import { createRequire, isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { programRoot } from '../workspace.ts'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const inside = (root: string, file: string) => { const path = relative(root, file); return path !== '..' && !path.startsWith('../') && !isAbsolute(path) }
const SDK = '@harness-platform/workflow-runtime'
const RESOLVER = 'runtime/adapters/dsh-web/src/resolve-runtime.ts'
export const protectedBuildSource = (path: string) => path.split('/').some(part => part === '.env' || part.startsWith('.env.') || part.endsWith('.llm-api-key'))
export class AssetCompileError extends Error { constructor(readonly code: string, message: string) { super(message) } }
export function assetCompiler() {
  const program = programRoot(), require = createRequire(join(program, 'platform/plugin/package.json'))
  const ts = require('typescript') as typeof import('typescript'), esbuild = require('esbuild') as typeof import('esbuild')
  return { ts, esbuild, program, receipt: { typescript: ts.version, esbuild: esbuild.version, platform_lock_sha256: hash(readFileSync(join(program, 'platform/plugin/pnpm-lock.yaml'))) } }
}
/** 两种资产共用的固定编译核心。仅解析和编译，不加载来源配置、脚本或模块。 */
export async function compileManagedAsset(input: { candidate: string; entry: string; output: string; dependencyRoots?: string[]; legacyWorkflow?: boolean;
  define?: Record<string, string>; beforeBundle?: (sources: { path: string; sha256: string }[], compiler: { typescript: string; esbuild: string }, platformSources: { path: string; sha256: string }[]) => Record<string, string> | void }, signal?: AbortSignal) {
  const { ts, esbuild, program } = assetCompiler(), modules = join(program, 'platform/plugin/node_modules'), runtime = join(program, 'platform/plugin/src/workflows/runtime.ts')
  const roots = input.dependencyRoots ?? [], shared = [join(program, 'platform/plugin/src/workflows'), join(program, 'platform/plugin/src/evaluation/model-attempts.ts'), join(program, RESOLVER)]
  const trusted = (file: string) => shared.some(path => file === path || file.startsWith(path + '/'))
  const options: import('typescript').CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
    esModuleInterop: true, resolveJsonModule: true, types: ['node'], typeRoots: [join(modules, '@types')], baseUrl: program,
    paths: { [SDK]: [runtime], ...(!input.legacyWorkflow ? { '@deepseek-ai/*': [join(modules, '@deepseek-ai/*')] } : {}) } }
  const host = ts.createCompilerHost(options)
  let protectedSourceError: AssetCompileError | undefined
  const assertBuildSource = (file: string) => {
    if (inside(input.candidate, resolve(file)) && protectedBuildSource(relative(input.candidate, resolve(file)).split('\\').join('/'))) {
      protectedSourceError = new AssetCompileError('invalid_request', 'Managed 构建不能读取凭据文件；请使用运行环境引用')
      throw protectedSourceError
    }
  }
  const readSource = host.readFile
  host.readFile = file => { assertBuildSource(file); return readSource(file) }
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const local = ts.resolveModuleName(name, containing, options, host).resolvedModule
    if (local) return local
    for (const folder of roots) { const found = ts.resolveModuleName(name, join(folder, 'index.ts'), options, host).resolvedModule; if (found) return found }
    return undefined
  })
  const compiler = ts.createProgram([input.entry], options, host), checker = compiler.getTypeChecker(), diagnostics = ts.getPreEmitDiagnostics(compiler)
  if (protectedSourceError) throw protectedSourceError
  if (diagnostics.length) throw new AssetCompileError('build_failed', `TypeScript 检查失败：${diagnostics.slice(0, 8).map(item => ts.flattenDiagnosticMessageText(item.messageText, ' ')).join('；')}`)
  const symbol = checker.getSymbolAtLocation(compiler.getSourceFile(input.entry)!)
  const exports = symbol ? checker.getExportsOfModule(symbol).map(item => item.name) : []
  if (input.legacyWorkflow && !['name', 'inject', 'apply'].every(name => exports.includes(name))) throw new AssetCompileError('build_failed', '工作流入口必须导出 DSH 插件的 name、inject 和 apply')
  const sources = compiler.getSourceFiles().map(item => resolve(item.fileName)).filter(file => inside(input.candidate, file)).map(file => ({ path: relative(input.candidate, file).split('\\').join('/'), sha256: hash(readFileSync(file)) })).sort((a, b) => a.path.localeCompare(b.path))
  const platformSources = [...new Set([...compiler.getSourceFiles().map(item => resolve(item.fileName)).filter(file => trusted(file)), join(program, RESOLVER)])]
    .map(file => ({ path: relative(program, file).split('\\').join('/'), sha256: hash(readFileSync(file)) })).sort((a, b) => a.path.localeCompare(b.path))
  const loadedSources = new Map<string, { path: string; sha256: string; root: string }>()
  const dshExports = new Map<string, string[]>()
  for (const file of compiler.getSourceFiles()) for (const statement of file.statements) {
    const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('@deepseek-ai/')) continue
    const module = checker.getSymbolAtLocation(specifier)
    if (module) dshExports.set(specifier.text, checker.getExportsOfModule(module).filter(item => {
      try { return ((item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item).flags & ts.SymbolFlags.Value) !== 0 } catch { return false }
    }).map(item => item.name))
  }
  const declaredDsh = JSON.parse(readFileSync(join(program, 'platform/plugin/package.json'), 'utf8'))
  const nativePackages = new Set(Object.keys({ ...declaredDsh.peerDependencies, ...declaredDsh.devDependencies }).filter(name => name.startsWith('@deepseek-ai/')))
  const packageName = (name: string) => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  const dependencyHas = (name: string) => roots.some(folder => existsSync(join(folder, 'node_modules', packageName(name), 'package.json')))
  signal?.throwIfAborted()
  if ([...sources.map(item => ({ ...item, root: input.candidate })), ...platformSources.map(item => ({ ...item, root: program }))]
    .some(item => hash(readFileSync(join(item.root, item.path))) !== item.sha256)) throw new AssetCompileError('conflict', '编译期间来源或共享运行器已变化，请重新预览')
  const bundle = async (defines: Record<string, string> = {}) => {
    try { return await esbuild.build({ entryPoints: [input.entry], outfile: input.output, bundle: true, write: false, metafile: true,
    platform: 'node', target: 'node24', format: 'esm', packages: 'bundle', logLevel: 'silent', nodePaths: [modules],
    define: { ...input.define, ...defines },
    plugins: [{ name: 'controlled-managed-source', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.path === SDK) return { path: runtime }
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        if (!input.legacyWorkflow && args.path.startsWith('@deepseek-ai/')) {
          if (!nativePackages.has(packageName(args.path)) || !dshExports.has(args.path)) throw new AssetCompileError('dependency_pending', `目标标准 Runtime 未提供共享模块 ${args.path}`)
          return { path: args.path, namespace: 'native-dsh' }
        }
        if (!input.legacyWorkflow && args.importer && inside(input.candidate, args.importer) && !args.path.startsWith('.') && !isAbsolute(args.path)) {
          if (!dependencyHas(args.path)) throw new AssetCompileError('dependency_pending', `业务模块 ${args.path} 尚未按精确锁准备`)
          return { path: args.path, external: true }
        }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: 'native-dsh' }, args => {
        const values = dshExports.get(args.path) ?? []
        const named = values.filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name))
        return { contents: `import {runtimeModule} from ${JSON.stringify(join(program, RESOLVER))};const native=await runtimeModule(${JSON.stringify(args.path)});\n${named.map((name, index) => `const value${index}=native[${JSON.stringify(name)}];export {value${index} as ${name}};`).join('\n')}\n${values.includes('default') ? 'export default native.default;' : ''}`, loader: 'js', resolveDir: program }
      })
      build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
        const file = realpathSync(args.path)
        assertBuildSource(file)
        if (!inside(input.candidate, file) && !trusted(file) && !inside(realpathSync(modules), file)) throw new AssetCompileError('invalid_request', 'Managed 入口不能导入其他 Candidate 或未固定的外部源码')
        if (inside(input.candidate, file) || trusted(file)) {
          const contents = readFileSync(file), root = inside(input.candidate, file) ? input.candidate : program
          loadedSources.set(file, { root, path: relative(root, file).split('\\').join('/'), sha256: hash(contents) })
          const extension = file.slice(file.lastIndexOf('.') + 1)
          const loader = ({ ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json' } as Record<string, import('esbuild').Loader>)[extension]
          if (loader) return { contents, loader, resolveDir: dirname(file) }
        }
        return undefined
      })
    } }] }) } catch (error) {
      // esbuild 会包装插件错误；受保护输入仍返回明确的业务失败原因。
      if (protectedSourceError) throw protectedSourceError
      throw error
    }
  }
  let built = await bundle()
  signal?.throwIfAborted()
  for (const item of loadedSources.values()) {
    const target = item.root === input.candidate ? sources : platformSources
    const existing = target.find(source => source.path === item.path)
    if (existing && existing.sha256 !== item.sha256) throw new AssetCompileError('conflict', '编译期间来源已变化，请重新预览')
    if (!existing) target.push({ path: item.path, sha256: item.sha256 })
  }
  sources.sort((a, b) => a.path.localeCompare(b.path)); platformSources.sort((a, b) => a.path.localeCompare(b.path))
  if ([...sources.map(item => ({ ...item, root: input.candidate })), ...platformSources.map(item => ({ ...item, root: program }))]
    .some(item => hash(readFileSync(join(item.root, item.path))) !== item.sha256)) throw new AssetCompileError('conflict', '编译期间来源或共享运行器已变化，请重新预览')
  // 依赖解析完成后再固定身份，避免 TypeScript 的声明文件替代真实 JS/JSON 输入。
  const defines = input.beforeBundle?.(sources, { typescript: ts.version, esbuild: esbuild.version }, platformSources)
  if (defines && Object.keys(defines).length) built = await bundle(defines)
  signal?.throwIfAborted()
  if ([...loadedSources.values()].some(item => !(item.root === input.candidate ? sources : platformSources)
    .some(source => source.path === item.path && source.sha256 === item.sha256))
    || [...sources.map(item => ({ ...item, root: input.candidate })), ...platformSources.map(item => ({ ...item, root: program }))]
      .some(item => hash(readFileSync(join(item.root, item.path))) !== item.sha256)) throw new AssetCompileError('conflict', '编译期间来源已变化，请重新预览')
  const artifact = built.outputFiles?.find(file => file.path === input.output)
  if (!artifact) throw new AssetCompileError('build_failed', '编译器没有产生约定 ESM 制品')
  const imports = Object.values(built.metafile!.outputs).flatMap(output => output.imports.map(item => item.path))
  if (!input.legacyWorkflow && imports.some(name => !isBuiltin(name) && !dependencyHas(name))) throw new AssetCompileError('dependency_pending', 'ESM 制品仍引用未准备的业务依赖')
  return { artifact: artifact.contents, sources, platform_sources: platformSources, runtime_imports: [...new Set(imports)], compiler: { typescript: ts.version, esbuild: esbuild.version } }
}

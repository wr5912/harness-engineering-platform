import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const programRoot = resolve(directory, '../../..')
const assetRoot = process.env.HARNESS_ASSET_ROOT
if (!assetRoot) throw new Error('构建扩展需要 HARNESS_ASSET_ROOT')
const data = join(assetRoot, 'mcp')
const aliases = { '@mcp/inspection': join(directory, 'src/inspection/index.ts'), '@harness-platform/security-operations': join(directory, 'src'), '@harness-platform/mcp': join(programRoot, 'platform/plugin/src/mcp') }
const programRequire = createRequire(join(programRoot, 'platform/plugin/package.json'))
const { sourceTreeDigest } = await import(join(programRoot, 'platform/plugin/src/mcp/source-digest.ts'))
const { readCompositions } = await import(join(programRoot, 'platform/plugin/src/mcp/compositions.ts'))
async function digest(paths) {
  const hash = createHash('sha256')
  async function visit(path, name) {
    const entries = await readdir(path, { withFileTypes: true }).catch(error => error.code === 'ENOTDIR' ? null : Promise.reject(error))
    if (!entries) { hash.update(name).update('\0').update(await readFile(path)); return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) await visit(join(path, entry.name), `${name}/${entry.name}`)
  }
  for (const path of paths) await visit(path, path.startsWith(programRoot + '/') ? 'program/' + path.slice(programRoot.length + 1) : 'data/' + path.slice(assetRoot.length + 1))
  return hash.digest('hex')
}
const { catalog } = readCompositions(join(data, 'compositions.json'))
const ids = [...new Set(catalog.compositions.flatMap(entry => [entry.draft, entry.published, ...(entry.versions ?? []).map(version => version.config)])
  .filter(config => config?.workflow).map(config => config.workflow))].sort()
const { build } = programRequire('esbuild')
const workflowDigests = Object.fromEntries(await Promise.all(ids.map(async id => {
  const compiled = await build({ absWorkingDir: data, entryPoints: [join(data, `compositions/${id}/src/index.ts`)], bundle: true,
    write: false, platform: 'node', target: 'node24', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent',
    alias: aliases })
  const paths = Object.keys(compiled.metafile.inputs).map(path => resolve(data, path)).sort()
  return [id, sourceTreeDigest({ program: programRoot, data: assetRoot }, [...paths, join(directory, 'src/soc.ts'), fileURLToPath(import.meta.url)])]
})))
const sourceDigest = await digest([join(directory, 'src'), join(directory, 'algorithm'), ...ids.map(id => join(data, `compositions/${id}/src`)), fileURLToPath(import.meta.url), join(directory, 'package.json'), ...['pnpm-lock.yaml', 'src/mcp/source-digest.ts', 'src/mcp/workflow-graph.ts', 'src/mcp/lfx-assets.ts', 'src/mcp/lfx-runtime.ts', 'src/evaluation/model-attempts.ts'].map(path => join(programRoot, 'platform/plugin', path))])
const output = join(data, '.local/build-cache', sourceDigest)
if (process.argv.includes('--path')) { process.stdout.write(output + '\n'); process.exit(0) }
await mkdir(output, { recursive: true })
await build({ entryPoints: [join(directory, 'src/index.ts')], outfile: join(output, 'plugin.js'), bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'silent',
  define: { __MCP_BUILD_DIGEST__: JSON.stringify(sourceDigest), __WORKFLOW_DIGESTS__: JSON.stringify(workflowDigests) },
  plugins: [{ name: 'mcp-contract', setup(builder) {
    builder.onResolve({ filter: /^@harness-platform\/mcp\// }, args => ({ path: join(programRoot, 'platform/plugin/src/mcp', args.path.split('/').at(-1) + '.ts') }))
    builder.onResolve({ filter: /^@harness-platform\/security-operations\// }, args => ({ path: join(directory, 'src', args.path.slice('@harness-platform/security-operations/'.length)) }))
    builder.onResolve({ filter: /^@mcp\/inspection$/ }, () => ({ path: join(directory, 'src/inspection/index.ts') }))
    builder.onResolve({ filter: /^@mcp\/workflows$/ }, () => ({ path: 'workflows', namespace: 'registered-workflows' }))
    builder.onLoad({ filter: /.*/, namespace: 'registered-workflows' }, () => ({ contents:
      ids.map((id, index) => `import { create as workflow${index} } from ${JSON.stringify(join(data, `compositions/${id}/src/index.ts`))}`).join('\n')
      + `\nexport default {${ids.map((id, index) => `${JSON.stringify(id)}:workflow${index}`).join(',')}}`, resolveDir: directory }))
  } }],
})
const { name, version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module', name, version }))
try { await symlink(join(programRoot, 'platform/plugin/node_modules'), join(output, 'node_modules'), 'dir') } catch (error) { if (error.code !== 'EEXIST') throw error }
process.stdout.write(output + '\n')

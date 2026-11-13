import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

const framework = dirname(dirname(fileURLToPath(import.meta.url)))
const root = join(process.env.HARNESS_ASSET_ROOT, 'mcp')
const require = createRequire(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/package.json'))
const { build } = require('esbuild')
const directory = await mkdtemp(join(tmpdir(), 'inspection-test-'))
const ids = ['baseline', 'vulnerabilities', 'reachability', 'routine', 'deep']
const { lfxWorkflow } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/lfx-runtime.ts'))
const { freezeLfxBundle } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/lfx-assets.ts'))
const { publishCompositionVersion } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/compositions.ts'))
// 真实 LFX 调度与 TypeScript 回调；仅替换外部 SOC 接口，固定子版本在隔离目录发布。
const nativeRoot = join(directory, 'native'), catalog = { schema_version: '1.0', compositions: [] }
// 通用源码来自程序仓库，夹具仅持有用户编排。
await mkdir(join(nativeRoot, 'mcp/compositions'), { recursive: true })
for (const id of ids) {
  const identity = 'inspection-' + id, target = join(nativeRoot, 'mcp/compositions', identity)
  await cp(join(root, 'compositions', identity), target, { recursive: true, filter: path => basename(path) !== 'versions' })
  const flow = JSON.parse(await readFile(join(target, 'flow.json'), 'utf8'))
  for (const node of flow.data.nodes) if (node.data.type === 'HepChild') {
    const template = node.data.node.template
    template.version_id.value = catalog.compositions.find(entry => entry.id === template.composition_id.value).publishedVersionId
  }
  await writeFile(join(target, 'flow.json'), JSON.stringify(flow))
  await writeFile(join(nativeRoot, 'mcp/compositions.json'), JSON.stringify(catalog))
  const config = { kind: 'workflow', workflow: identity, engine: 'lfx', toolName: identity.replaceAll('-', '_'), title: identity, description: '', connections: { master: 'master', ingest: 'ingest', graph: 'graph' } }
  config.flowDigest = freezeLfxBundle(nativeRoot, identity, config)
  const entry = { id: identity }; publishCompositionVersion(entry, config); catalog.compositions.push(entry)
  await writeFile(join(nativeRoot, 'mcp/compositions.json'), JSON.stringify(catalog))
}
const modules = {}
for (const id of ids) {
  const target = join(directory, id + '.mjs')
  await build({ entryPoints: [join(root, `compositions/inspection-${id}/src/index.ts`)], outfile: target, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', alias: { '@harness-platform/security-operations': join(framework, 'src'), '@mcp/inspection': join(framework, 'src/inspection/index.ts'), '@harness-platform/mcp/workflow-graph': join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/workflow-graph.ts') } })
  const module = await import(pathToFileURL(target).href)
  modules[id] = { ...module, create(soc) {
    const workflow = lfxWorkflow(nativeRoot, 'inspection-' + id, module.create(soc), soc)
    const nativeConfig = config => ({ ...config, engine: 'lfx', workflow: 'inspection-' + id, title: 'inspection-' + id })
    return { ...workflow, prepare: (input, config, signal, context) => workflow.prepare(input, nativeConfig(config), signal, context), execute: (input, config, context) => workflow.execute(input, nativeConfig(config), context) }
  } }
}
const socTarget = join(directory, 'soc.mjs')
await build({ entryPoints: [join(framework, 'src/soc.ts')], outfile: socTarget, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', nodePaths: [join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/node_modules')] })
const { createSoc } = await import(pathToFileURL(socTarget).href)
const asset = { assetId: 1, ip: '10.0.0.1', assetType: 'host', online: 'online', stateEvidence: { online: 'online', timeBasis: 'DATABASE_LOCAL', evaluatedAt: '2026-11-05 12:00:00', signals: [{ validity: 'CURRENT', supportsOnline: true, observedAt: '2026-11-05 11:59:00' }] } }
const config = { connections: { master: 'master', ingest: 'ingest', graph: 'graph' } }
const signal = AbortSignal.timeout(600_000)
function context(shared) { return { signal, shared, runId: 'test', nodeId: 'root', progress() {}, call: call => call(), map: (items, call) => Promise.all(items.map(call)) } }
const inventory = () => ({ code: 200, rows: [asset], total: 1 })

test('删除旧包及当前编排后仍可构建，剩余工作流正常登记', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'mcp-deleted-build-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  await cp(root, join(fixture, 'mcp'), {recursive:true,filter: path => !['.local','node_modules'].includes(basename(path))})
  const { readCompositions, writeCompositions } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/compositions.ts'))
  const file = join(fixture,'mcp/compositions.json'), state = readCompositions(file)
  state.catalog.compositions = state.catalog.compositions.filter(entry => entry.id !== 'inspection-deep')
  writeCompositions(file,state.catalog,state.revision,'inspection-deep')
  await rm(join(fixture,'mcp/compositions/security-asset-related-alerts-readonly'),{recursive:true,force:true})
  const output = execFileSync(process.execPath,[join(framework,'build.mjs')],{encoding:'utf8',env:{...process.env,HARNESS_ASSET_ROOT:fixture}}).trim()
  const plugin = await import(pathToFileURL(join(output,'plugin.js')).href)
  const extension = {}, cleanup = []
  const previous = process.env.HARNESS_ASSET_ROOT
  process.env.HARNESS_ASSET_ROOT = fixture
  try {
    plugin.apply({platformMcp:{compositionExtension:extension,servers:{get:()=>[]}},effect: fn => cleanup.push(fn())})
    const expected = [...new Set(state.catalog.compositions.flatMap(entry => [entry.draft, entry.published, ...(entry.versions ?? []).map(version => version.config)])
      .filter(config => config?.workflow).map(config => config.workflow))].sort()
    assert.deepEqual(Object.keys(extension.workflows).sort(), expected)
    assert.ok(!extension.workflows['inspection-deep'])
    assert.equal(typeof extension.flow.assetArguments,'function')
  } finally { cleanup.forEach(fn=>fn()); if(previous===undefined)delete process.env.HARNESS_ASSET_ROOT;else process.env.HARNESS_ASSET_ROOT=previous }
})

test('实现摘要跟踪实际共享依赖，未引用的源码不改变工作流身份', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'mcp-dependency-build-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  await cp(root, join(fixture, 'mcp'), { recursive: true, filter: path => !['.local', 'node_modules'].includes(basename(path)) })
  const id = 'dependency-check', source = join(fixture, 'mcp/compositions', id, 'src')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'index.ts'), `import { value } from './dependency-check.ts'; export const create = () => ({ value, connections: () => [], inputSchema: {} })`)
  const shared = join(source, 'dependency-check.ts')
  await writeFile(shared, 'export const value = 1')
  const { readCompositions, writeCompositions } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/compositions.ts'))
  const file = join(fixture, 'mcp/compositions.json'), state = readCompositions(file)
  state.catalog.compositions.push({ id, draft: { kind: 'workflow', workflow: id, toolName: id, title: id, description: '' } })
  writeCompositions(file, state.catalog, state.revision)
  async function fingerprint() {
    const output = execFileSync(process.execPath, [join(framework, 'build.mjs')], { encoding: 'utf8', env: {...process.env,HARNESS_ASSET_ROOT:fixture} }).trim()
    const plugin = await import(pathToFileURL(join(output, 'plugin.js')).href), extension = {}
    const previous = process.env.HARNESS_ASSET_ROOT
    process.env.HARNESS_ASSET_ROOT = fixture
    try {
      let cleanup
      plugin.apply({ platformMcp: { compositionExtension: extension, servers: { get: () => [] } }, effect: fn => { cleanup = fn() } })
      const result = extension.workflows[id].sourceDigest
      cleanup()
      return result
    } finally { if (previous === undefined) delete process.env.HARNESS_ASSET_ROOT; else process.env.HARNESS_ASSET_ROOT = previous }
  }
  const first = await fingerprint()
  await writeFile(join(source, 'unreferenced.ts'), 'export const unused = true')
  assert.equal(await fingerprint(), first)
  await writeFile(shared, 'export const value = 2')
  assert.notEqual(await fingerprint(), first)
})

test('状态使用 SOC 当前字段；基线当前模板和逐项覆盖必须一致', () => {
  assert.equal(modules.routine.classifyStatus(asset).status, 'normal')
  assert.equal(modules.routine.classifyStatus({ ...asset, stateEvidence: { ...asset.stateEvidence, signals: [] } }).status, 'normal')
  assert.equal(modules.routine.classifyStatus({ ...asset, stateEvidence: { ...asset.stateEvidence, evaluatedAt: 'invalid' } }).status, 'normal')
  assert.equal(modules.routine.classifyStatus({ ...asset, online: 'unknown' }).status, 'unknown')
  assert.equal(modules.routine.classifyStatus({ ...asset, online: undefined }).status, 'unknown')
  const ready = { assetId: 1, templateId: 8, templateScopeMatched: true, memberCount: 1, applicableCount: 1, coverageReason: 'APPLICABLE_ITEMS_PRESENT', items: [{ itemId: 2, applicable: true, applicabilityReason: 'MATCHED' }] }
  const report = { run: { assetId: 1, templateId: 8, passFlag: '1' } }
  assert.equal(modules.baseline.classify(1, report, ready).status, 'normal')
  assert.equal(modules.baseline.classify(1, report, { ...ready, templateId: 9 }).status, 'unknown')
  assert.equal(modules.baseline.classify(1, { run: null }, { ...ready, templateId: null }).status, 'unknown')
  assert.equal(modules.baseline.classify(1, report, { ...ready, items: [] }).status, 'unknown')
})

test('状态只作为常规内部组件复用冻结事实，不发布独立编排或重复查询', async () => {
  const { readCompositions } = await import(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/src/mcp/compositions.ts'))
  const state = readCompositions(join(root, 'compositions.json'))
  assert.equal(state.catalog.compositions.filter(entry => entry.id.startsWith('inspection-')).length, 5)
  assert.ok(!state.catalog.compositions.some(entry => entry.id === 'inspection-status'))
  const source = await import(pathToFileURL(join(directory, 'routine.mjs')).href)
  const workflow = source.create(async () => { throw new Error('状态汇总不应调用 SOC') })
  const result = workflow.components.status({}, config, context({scope: {assetIds:[1]}, assets:[asset]}))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].status, 'normal')
  assert.deepEqual(result.scope.assetIds, [1])
  const flow = JSON.parse(await readFile(join(root, 'compositions/inspection-routine/flow.json'), 'utf8'))
  assert.equal(flow.data.nodes.find(node => node.id === 'status').data.type, 'HepStatus')
  assert.ok(!flow.data.nodes.some(node => node.data.node.template.composition_id?.value === 'inspection-status'))
})

test('完整分页、稳定 ID 去重、冻结范围；分页中断不接受运行', async () => {
  let calls = 0
  const workflow = modules.baseline.create(async (_connection, operation, args) => { assert.equal(operation, 'list_soc_asset'); calls++; return { code: 200, total: 2, rows: args.pageNum === 1 ? [asset] : [{ ...asset, assetId: 2 }] } })
  const prepared = await workflow.prepare({ scope: { all: true } }, config, signal)
  assert.deepEqual(prepared.scope.assetIds, [1, 2]); assert.equal(calls, 2)
  await assert.rejects(workflow.prepare({ scope: {} }, config, signal), /明确范围/)
  const broken = modules.baseline.create(async () => ({ code: 200, total: 2, rows: [asset] }))
  await assert.rejects(broken.prepare({ scope: { all: true } }, config, signal), /未完整/)
})

test('同次运行复用准备和相同 GET；单接口失败保留另一接口事实', async () => {
  let count = 0
  const soc = async (_connection, operation) => {
    count++
    if (operation === 'list_soc_asset') return inventory()
    if (operation === 'get_admin_baseline_readiness') throw new Error('offline')
    return { code: 200, data: { run: null, findings: [] } }
  }
  const baseline = modules.baseline.create(soc), input = { scope: { all: true } }
  const prepared = await baseline.prepare(input, config, signal), ctx = context(prepared)
  const first = await baseline.execute(input, config, ctx)
  await baseline.execute(input, config, ctx)
  assert.equal(count, 3)
  assert.equal(first.items[0].status, 'failed')
  assert.equal(first.items[0].facts.report.run, null)
  assert.equal(first.items[0].facts.readiness.error, 'ingest/get_admin_baseline_readiness assetId=1：offline')
  const reports = baseline.artifacts(first)
  assert.deepEqual(reports.map(item => item.id), ['report', 'details', 'chat', 'markdown'])
  assert.equal(JSON.parse(reports[1].body).items.length, 1)
})

test('五项编排按 ID 定向冻结，准备和重试共用请求统计且不重复查询', async () => {
  for (const id of ids) {
    const calls = [], measured = { requests: 0 }
    let failed = false
    const soc = async (_connection, operation, args) => {
      calls.push({ operation, args })
      if (operation === 'get_soc_asset_by_asset_id') {
        if (!failed) { failed = true; throw new Error('ECONNRESET') }
        return { code: 200, data: asset }
      }
      if (operation === 'get_graph_compliance_rules') return { code: 200, data: [] }
      throw new Error('不得读取全量资产：' + operation)
    }
    const workflow = modules[id].create(soc), input = { scope: { assetIds: [1] }, reachability: { srcIp: '10.0.0.1', dstIp: '10.0.0.2' } }
    const preparation = { call: async fn => { measured.requests++; return fn() } }
    const frozen = await workflow.prepare(input, config, signal, preparation)
    assert.deepEqual(frozen.scope.assetIds, [1], id)
    assert.equal(calls.filter(call => call.operation === 'get_soc_asset_by_asset_id').length, 2, id)
    assert.equal(measured.requests, calls.length, id)
    await workflow.prepare(input, config, signal, preparation)
    assert.equal(measured.requests, calls.length, id)
    assert.equal(calls.filter(call => call.operation === 'get_soc_asset_by_asset_id').length, 2, id)
  }
})

test('定向查询拒绝错误身份；带部门筛选仍以服务端含下级部门列表确定范围', async () => {
  const wrong = modules.baseline.create(async () => ({ code: 200, data: { ...asset, assetId: 99 } }))
  await assert.rejects(wrong.prepare({ scope: { assetIds: [1] } }, config, signal), /身份不一致/)
  const scoped = modules.baseline.create(async (_connection, operation, args) => {
    assert.equal(operation, 'list_soc_asset'); assert.equal(args.deptId, 10)
    return { code: 200, rows: [{ ...asset, deptId: 11 }], total: 1 }
  })
  const frozen = await scoped.prepare({ scope: { assetIds: [1], deptIds: [10] } }, config, signal)
  assert.deepEqual(frozen.scope.assetIds, [1])
})

test('漏洞遍历全部直接子资产，完整空列表按当前 SOC 合同呈现', async () => {
  let pages = 0, reads = 0
  const soc = async (_connection, operation, args) => {
    if (operation === 'list_soc_asset') return inventory()
    if (operation === 'get_soc_asset_registration_children') { pages++; return { code: 200, data: { total: 2, records: [{ assetId: args.page + 1, hostAssetId: 1 }] } } }
    reads++; return { code: 200, data: [] }
  }
  const workflow = modules.vulnerabilities.create(soc), input = { scope: { all: true } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, context(prepared))
  assert.equal(pages, 2); assert.equal(reads, 3); assert.equal(result.items[0].status, 'normal')
  assert.equal(result.items[0].coverage, 'existing_records_only')
})

test('可达路径必须核对逐跳策略；批次进度与结果事实保留', async () => {
  let pathReads = 0, progress
  const soc = async (_connection, operation) => {
    if (operation === 'list_soc_asset') return inventory()
    pathReads++; return { code: 200, data: { reachable: true, verdict: 'REACHABLE', path: ['123'], reason: 'route' } }
  }
  const workflow = modules.reachability.create(soc), input = { scope: { all: true }, reachability: { srcIp: '10.0.0.1', dstIp: '10.0.0.2' } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, { ...context(prepared), progress(value) { if (value.completed) progress = value } })
  assert.equal(pathReads, 2); assert.equal(result.items[0].status, 'unknown'); assert.equal(progress.completed, 1); assert.equal(progress.total, 1)
  assert.equal(modules.reachability.matches(asset, { scope: 'ASSETS', cidrs: ['10.0.0.0/24'] }), true)
  assert.throws(() => modules.reachability.matches(asset, { bizIds: [1] }), /无法解析/)
})

test('原生工具发现复用，接口包装保持契约，配置变化后不切换运行目标', async () => {
  let discoveries = 0, calls = 0
  const server = { id: 'master', specUrl: 'http://fixture/openapi.json' }
  const soc = createSoc(async request => {
    if (request.action === 'test') { discoveries++; return { status: 200, value: { tools: [{ name: 'read', inputSchema: { properties: { body: { properties: { arguments: {} } } } } }] } } }
    calls++; assert.deepEqual(request.arguments, { body: { arguments: { id: 1 } } }); return { status: 200, value: { code: 200, data: [] } }
  }, () => [server])
  const fingerprint = soc.fingerprint('master')
  await Promise.all([soc('master','read',{id:1},signal,fingerprint),soc('master','read',{id:1},signal,fingerprint)])
  assert.equal(discoveries,1); assert.equal(calls,2)
  server.specUrl = 'http://other/openapi.json'
  await assert.rejects(soc('master','read',{id:1},signal,fingerprint),/配置已变化/)
  assert.equal(calls,2)
})

test('SOC 调用保留路径、分页及显式 body，不二次包装，不丢路径参数', async () => {
  const requests = [], servers = [{ id: 'framework', specUrl: 'http://example.invalid/spec' }]
  const soc = createSoc(async request => {
    requests.push(request)
    if (request.action === 'test') return { status: 200, value: { tools: [
      { name: 'approve', inputSchema: { properties: { taskId: {}, body: { type: 'object' } } } },
      { name: 'create', inputSchema: { properties: { body: { type: 'object' } } } },
      { name: 'mine', inputSchema: { properties: { pageNum: {}, pageSize: {} } } },
    ] } }
    return { status: 200, value: { code: 200 } }
  }, () => servers)
  await soc('framework', 'approve', { taskId: 7, body: { comment: 'yes' } }, signal)
  assert.deepEqual(requests.at(-1).arguments, { taskId: 7, body: { comment: 'yes' } })
  await soc('framework', 'create', { body: { changes: [1, 2] } }, signal)
  assert.deepEqual(requests.at(-1).arguments, { body: { changes: [1, 2] } })
  await soc('framework', 'create', { changes: [1] }, signal)
  assert.deepEqual(requests.at(-1).arguments, { body: { changes: [1] } })
  await soc('framework', 'mine', { pageNum: 2, pageSize: 100 }, signal)
  assert.deepEqual(requests.at(-1).arguments, { pageNum: 2, pageSize: 100 })
  const before = requests.length
  await assert.rejects(soc('framework', 'approve', { taskId: 7, comment: 'ambiguous' }, signal), /显式 body/)
  assert.equal(requests.length, before)
})

test('SOC 衔接按发现结果调用工具、资源和模板，资源正文进入同一业务解码', async () => {
  const calls = []
  const soc = createSoc(async request => {
    if (request.action === 'test') return { status: 200, value: { tools: [], resources: { resources: [{ name: 'get_graph_compliance_rules', uri: 'http://fixture/rules' }] }, resourceTemplates: { resourceTemplates: [{ name: 'get_soc_asset_vulnerabilities', uriTemplate: 'http://fixture/assets/{assetId}/vulnerabilities' }] } } }
    calls.push(request)
    return { status: 200, value: { contents: [{ text: JSON.stringify({ code: 200, data: [] }) }] } }
  }, () => [{ id: 'master', specUrl: 'http://fixture/openapi.json' }])
  const workflow = modules.vulnerabilities.create(async (connection, operation, args, signal) => {
    if (operation === 'list_soc_asset') return inventory()
    if (operation === 'get_soc_asset_registration_children') return { code: 200, data: { total: 0, records: [] } }
    return soc(connection, operation, args, signal)
  })
  const input = { scope: { all: true } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, context(prepared))
  assert.equal(result.items[0].status, 'normal')
  assert.equal(calls[0].action, 'readResource')
  assert.equal(calls[0].uriTemplate, 'http://fixture/assets/{assetId}/vulnerabilities')
  assert.deepEqual(calls[0].arguments, { assetId: 1 })
  await soc('master', 'get_graph_compliance_rules', {}, signal)
  assert.equal(calls[1].uri, 'http://fixture/rules')
  await assert.rejects(soc('master', 'missing', {}, signal), /未暴露/)
})


test('MCP调度400保留脱敏回执、调度状态与资产定位，不冒称上游HTTP400', async () => {
  const soc = createSoc(async request => {
    if (request.action === 'test') return { status: 200, value: { tools: [{ name: 'list_soc_asset', inputSchema: { properties: { pageNum: { type: 'integer' }, pageSize: { type: 'integer' }, includeUnits: { type: 'boolean' } } } }, { name: 'get_soc_asset_registration_children', inputSchema: { properties: { assetId: { type: 'integer' }, page: { type: 'integer' } } } }], resourceTemplates: { resourceTemplates: [{ name: 'get_soc_asset_vulnerabilities', uriTemplate: 'http://fixture/assets/{assetId}/vulnerabilities', inputSchema: { type: 'object', properties: { assetId: { type: 'integer' } } } }] } } }
    if (request.action === 'callTool' && request.toolName === 'list_soc_asset') return { status: 200, value: { code: 200, rows: [asset], total: 1 } }
    if (request.action === 'callTool') return { status: 200, value: { code: 200, data: { total: 0, records: [] } } }
    return { status: 400, value: { error: '上游连接失败 secret=fixture-secret' } }
  }, () => [{ id: 'ai-soc-master', specUrl: 'http://fixture/openapi.json' }])
  const workflow = modules.vulnerabilities.create((connection, operation, args, signal) => soc(connection, operation, args, signal)), testConfig = { connections: { master: 'ai-soc-master' } }
  const prepared = await workflow.prepare({ scope: { all: true } }, testConfig, signal)
  const result = await workflow.execute({ scope: { all: true } }, testConfig, context(prepared))
  const error = result.items[0].errors.find(value => value.includes('get_soc_asset_vulnerabilities'))
  assert.equal(result.items[0].status, 'failed')
  assert.match(error, /ai-soc-master\/get_soc_asset_vulnerabilities assetId=1/)
  assert.match(error, /MCP调度状态=400/)
  assert.match(error, /调度回执错误=/)
  assert.match(error, /已隐藏/)
  assert.doesNotMatch(error, /fixture-secret/)
  assert.doesNotMatch(error, /上游HTTP400/)
})

test('运行中连接变化拒绝重准备；保持同一次资产范围', async () => {
  let fingerprint = 'initial', inventories = 0
  const soc = Object.assign(async () => { inventories++; return inventory() }, { fingerprint: () => fingerprint })
  const workflow = modules.baseline.create(soc), input = { scope: { all: true } }
  const prepared = await workflow.prepare(input, config, signal)
  fingerprint = 'changed'
  await assert.rejects(workflow.execute(input, config, context(prepared)), /快照.*不一致/)
  assert.equal(inventories, 1)
})

test('规则接口失败保留其他检查；无启用规则提供实际连接参数', async () => {
  for (const unavailable of [true, false]) {
    let inventories = 0
    const soc = async (_connection, operation) => {
      if (operation === 'list_soc_asset') { inventories++; return inventory() }
      if (operation === 'get_graph_compliance_rules') { if (unavailable) throw new Error('rules offline'); return { code: 200, data: [] } }
      if (operation === 'get_soc_asset_registration_children') return { code: 200, data: { total: 0, records: [] } }
      if (operation === 'get_soc_asset_vulnerabilities') return { code: 200, data: [] }
      return { code: 200, data: {} }
    }
    const input = { scope: { all: true }, ...(!unavailable ? { reachability: { srcIp: '10.0.0.1', dstIp: '10.0.0.2' } } : {}) }, deep = modules.deep.create(soc)
    const prepared = await deep.prepare(input, config, signal), ctx = context(prepared)
    const result = await deep.execute(input, config, ctx)
    assert.equal(inventories, 1)
    assert.equal(result.checks.status.items[0].status, 'normal')
    assert.equal(result.checks.reachability.items[0].status, unavailable ? 'failed' : 'unknown')
    assert.equal(result.checks.vulnerabilities.items[0].status, 'normal')
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(result.scope, prepared.scope)
  }
})

test('漏洞同一标识保留每个来源的软件版本和处置记录，顺序稳定', async () => {
  const soc = async (_connection, operation, args) => {
    if (operation === 'list_soc_asset') return inventory()
    if (operation === 'get_soc_asset_registration_children') return { code: 200, data: { total: 1, records: [{ assetId: 2, hostAssetId: 1 }] } }
    if (args.assetId === 1) await new Promise(resolve => setTimeout(resolve, 5))
    return { code: 200, data: [{ cveId: 'CVE-example', version: String(args.assetId), recommendation: 'fix-' + args.assetId }] }
  }
  const workflow = modules.vulnerabilities.create(soc), input = { scope: { all: true } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, context(prepared)), findings = result.items[0].findings
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].sourceAssetIds, [1, 2])
  assert.deepEqual(findings[0].observations.map(item => [item.sourceAssetId, item.record.version, item.record.recommendation]), [[1, '1', 'fix-1'], [2, '2', 'fix-2']])
})

test('漏洞多宿主乱序嵌套批次保持归属，合法子资产汇总且失败不串行', async () => {
  const parents = [10, 20], children = { 10: [11, 12], 20: [21, 22] }
  const assets = [10, 11, 12, 20, 21, 22].map(assetId => ({ assetId, ip: `10.0.0.${assetId}`,
    ...([11, 12].includes(assetId) ? { hostAssetId: 10 } : [21, 22].includes(assetId) ? { hostAssetId: 20 } : {}) }))
  const soc = async (_connection, operation, args) => {
    if (operation === 'list_soc_asset') return { code: 200, rows: assets, total: assets.length }
    if (operation === 'get_soc_asset_registration_children') return { code: 200,
      data: { total: (children[args.assetId] ?? []).length, records: assets.filter(item => (children[args.assetId] ?? []).includes(item.assetId)) } }
    assert.equal(operation, 'get_soc_asset_vulnerabilities')
    await new Promise(resolve => setTimeout(resolve, (23 - args.assetId) * 2))
    return [10, 11].includes(args.assetId) ? { code: 500, message: 'fixture-business-error' }
      : { code: 200, data: [{ cveId: 'CVE-' + args.assetId, sourceMarker: args.assetId }] }
  }
  const workflow = modules.vulnerabilities.create(soc), input = { scope: { all: true } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, context(prepared))
  assert.deepEqual(result.items.map(item => item.assetId), assets.map(item => item.assetId))
  for (const item of result.items) {
    const allowed = new Set([item.assetId, ...(children[item.assetId] ?? [])])
    assert.ok(item.sources.every(source => allowed.has(source.assetId)), JSON.stringify(item))
    assert.ok(item.findings.every(finding => finding.observations.every(observation => allowed.has(observation.sourceAssetId)
      && observation.record.sourceMarker === observation.sourceAssetId)))
    assert.ok(item.errors.every(error => [...allowed].some(id => error.startsWith(`资产 ${id}：`))))
  }
  const first = result.items.find(item => item.assetId === parents[0]), second = result.items.find(item => item.assetId === parents[1])
  assert.equal(first.status, 'failed'); assert.deepEqual(first.sources.map(source => source.assetId), [12])
  assert.deepEqual(second.sources.map(source => source.assetId), [20, 21, 22]); assert.deepEqual(second.errors, [])
})

test('禁止可达规则遇到 NAT 即使路径不可达也保持未知', async () => {
  const second = { ...asset, assetId: 2, ip: '10.0.0.2' }
  const soc = async (_connection, operation) => {
    if (operation === 'list_soc_asset') return { code: 200, rows: [asset, second], total: 2 }
    if (operation === 'get_graph_compliance_rules') return { code: 200, data: [{ id: 1, enabled: true, ruleType: 'FORBIDDEN', sourceSelector: { cidrs: ['10.0.0.1'] }, destSelector: { cidrs: ['10.0.0.2'] } }] }
    return { code: 200, data: { reachable: false, verdict: 'UNREACHABLE', natApplied: true } }
  }
  const workflow = modules.reachability.create(soc), input = { scope: { all: true } }, prepared = await workflow.prepare(input, config, signal)
  const result = await workflow.execute(input, config, context(prepared))
  assert.equal(result.items[0].status, 'unknown')
  assert.match(result.items[0].message, /地址转换/)
})

test.after(async () => { await rm(directory, { recursive: true, force: true }) })

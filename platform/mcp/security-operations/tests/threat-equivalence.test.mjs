import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { after } from 'node:test'
import { THREAT_SOURCE_COMMIT } from '../src/threat/source.ts'
import { build } from 'esbuild'

const repository = process.env.HARNESS_ASSET_ROOT
const plugin = process.cwd()
const python = process.env.HARNESS_PYTHON || process.env.PYTHON || 'python3'
const incidentId = 'INC-20261015-000001'
const bindings = { socConnectionId: 'fixture-soc', reportConnectionId: 'fixture-report', model: { provider: 'fixture', model: 'fixture-model' } }
const hash = value => createHash('sha256').update(value).digest('hex')
let built, buildRoot
async function modules() {
  if (!built) built = (async () => {
    buildRoot = await mkdtemp(join(tmpdir(), 'threat-equivalence-build-'))
    const outfile = join(buildRoot, 'runtime.mjs')
    await build({ stdin: { contents: `export * from ${JSON.stringify(new URL('../src/threat/index.ts', import.meta.url).pathname)}; export { createThreatBridge } from ${JSON.stringify(new URL('../src/threat/bridge.ts', import.meta.url).pathname)}`, resolveDir: plugin }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(`file://${outfile}`)
  })()
  return built
}
async function remove(root) {
  async function writable(file) {
    const stat = await lstat(file)
    if (stat.isDirectory()) { await chmod(file, 0o700); for (const name of await readdir(file)) await writable(join(file, name)) }
    else if (!stat.isSymbolicLink()) await chmod(file, 0o600)
  }
  await writable(root)
  await rm(root, { recursive: true, force: true })
}
after(async () => { if (buildRoot) await remove(buildRoot) })

const envelope = data => ({ status: 'success', status_code: 200, result: { code: 200, data } })
const fullResult = {
  unified_event_id: incidentId, verdict: '误报', primary_claim: { type: '常规运维告警', result: '证据不足' },
  secondary_findings: null, confidence_score: 0.5, attack_stage: null, technique: null, technique_name: null,
  verified_facts: [], key_claims: [], counter_evidence: [], uncertainty_notes: '部分基本资料未提供，本次没有观察到异常行为。',
  attack_chain_speculation: { current_stage: null, observed_path: [], possible_next_steps: [], supporting_evidence: [] },
  rule_optimization_suggestions: [], recommended_actions: [], reasoning_summary: '本次仅观察到常规运维测试告警。未提供完整行为资料，需保留不确定性。',
}

// 两次运行各有独立调用记录；业务输入和模型响应取同一份冻结基本样例。
function servicesFor(scenario) {
  const calls = [], modelRequests = []
  let writes = 0
  return {
    calls, modelRequests,
    connectionFingerprint: connectionId => `fixture-target:${connectionId}`,
    resolveModel: route => route ?? bindings.model,
    async invoke(connection, tool, args, signal) {
      signal.throwIfAborted()
      calls.push({ connection, tool, args: structuredClone(args) })
      if (tool.endsWith('create_incident_judgement_claim')) return envelope({ judgementId: 'judge-basic' })
      if (tool.endsWith('get_correlate_incident_by_incident_id')) return envelope({ incidentId, incidentType: '常规运维告警', affectedAssetId: 9106,
        contributingAlertsJson: ['ALERT-BASIC-1'], firstSeenTime: '2026-10-15T00:00:00Z', lastSeenTime: '2026-10-15T00:00:00Z' })
      if (tool.endsWith('get_detect_alert_by_alert_id')) return envelope({ alert_id: 'ALERT-BASIC-1', source: 'EDR', affected_asset_id: 9106,
        created_at: '2026-10-15T00:00:00Z', ocsf: { device: { asset: { uid: '9106' }, ip: '192.0.2.10', hostname: 'test-host' } } })
      if (tool.endsWith('list_detect_whitelist')) return envelope(scenario.fast ? [{ whitelistId: 'white-basic', enabled: true, type: 'ASSET_ID', value: '9106' }] : [])
      if (tool.endsWith('get_correlate_threat_intel')) return envelope({ rows: [], total: 0 })
      if (tool.endsWith('get_soc_asset_by_asset_id')) return envelope({ assetId: 9106, ip: '192.0.2.10', hostname: 'test-host' })
      if (tool.endsWith('get_soc_asset_importance')) return envelope({ importance: 'low' })
      if (tool.endsWith('get_graph_enrich_topology_by_asset_id')) return envelope({ neighbors: [] })
      if (tool.endsWith('search_event')) return envelope({ items: [], total: 0 })
      if (tool.endsWith('get_correlate_intel_check')) return envelope({ hit: false, matches: [] })
      if (tool.endsWith('update_incident_judgement_result')) {
        if (scenario.retryWrite && ++writes === 1) throw new Error('fixture write unavailable')
        return envelope({ replayed: false })
      }
      if (tool.endsWith('create_correlate_incident_judgement_fail')) return envelope({ replayed: false })
      if (tool === 'save_persistence_result') return { content: [{ type: 'text', text: JSON.stringify({ code: 200, data: { id: 'report-basic', downloadUrl: 'https://example.test/reports/report-basic' } }) }] }
      return envelope([])
    },
    async inferFrozen(payload, route, signal) {
      signal.throwIfAborted()
      assert.deepEqual(route, bindings.model)
      modelRequests.push(structuredClone(payload))
      return { model: 'fixture-model', choices: [{ message: { content: JSON.stringify(scenario.invalid ? { verdict: '误报' } : fullResult) } }] }
    },
  }
}

async function baseline(source, home, services, createThreatBridge) {
  await mkdir(home)
  const bridge = await createThreatBridge(source.catalog, bindings, services, new AbortController().signal)
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(python, [join(source.directory, 'dsh_runner.py'), incidentId], {
        env: { ...process.env, DSH_HOME: home, PYTHONDONTWRITEBYTECODE: '1', THREAT_MODEL_BRIDGE_KEY: bridge.key,
          THREAT_ANALYSIS_CONFIG: JSON.stringify({ connections: { runtime: { bridgeUrl: bridge.runtime, bridgeKey: bridge.key } },
            analysisModel: { baseURL: bridge.model, model: bindings.model.model, apiKeyEnv: 'THREAT_MODEL_BRIDGE_KEY' } }) },
        timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      }, (error, output) => error ? reject(new Error('baseline_cli_failed')) : resolve(output))
    })
    const result = JSON.parse(stdout)
    return { result, directory: join(home, 'threat-analysis', result.run_id) }
  } finally { bridge.close() }
}

const markdownEscaped = value => value.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1')
async function comparison(run, directory) {
  // 仅归一化运行ID、名单查询时间和采集耗时；输入摘要先核验原文件，再按归一化输入重算。
  const replacements = [[run.run_id, '<run-id>'], [markdownEscaped(run.run_id), '<run-id>']]
  for (const match of run.result?.matches ?? []) {
    replacements.push([match.queried_at, '<queried-at>'], [markdownEscaped(match.queried_at), '<queried-at>'])
  }
  let canonicalInputHash
  function normalize(value, key = '') {
    if (key === 'enrichment_latency_ms') return '<enrichment-latency-ms>'
    if (key === 'input_sha256' && canonicalInputHash) return canonicalInputHash
    if (Array.isArray(value)) return value.map(item => normalize(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]))
    if (typeof value === 'string') for (const [from, to] of replacements) value = value.replaceAll(from, to)
    return value
  }
  let frozen
  if (run.route === 'five_source') {
    const bytes = await readFile(join(directory, 'fusion/five-source-output.json'))
    assert.equal(run.input_sha256, hash(bytes), '结果必须绑定本次实际冻结输入，不能直接忽略摘要字段')
    frozen = normalize(JSON.parse(bytes))
    canonicalInputHash = hash(JSON.stringify(frozen))
  }
  return { normalize, frozen }
}

for (const scenario of [
  { title: '名单快判：两边零次模型', fast: true },
  { title: '完整五源：两边一次模型且SOC同payload重试', retryWrite: true },
  { title: '可解析但校验失败：两边保留completed与failed校验状态', invalid: true },
]) test(`原固定CLI与四阶段等效：${scenario.title}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'threat-equivalence-'))
  try {
    const api = await modules()
    const stateRoot = join(root, 'platform')
    const source = await api.ensureThreatSource(repository, { stateRoot })
    assert.equal(source.commit, THREAT_SOURCE_COMMIT)
    const originalServices = servicesFor(scenario), candidateServices = servicesFor(scenario)
    const original = await baseline(source, join(root, 'baseline'), originalServices, api.createThreatBridge)
    const runtime = api.createThreatRuntime(repository, candidateServices, { stateRoot, python })
    const collected = await runtime.execute('collect', bindings, { incident_id: incidentId }, new AbortController().signal)
    const input = { run_id: collected.run_id }
    if (collected.route === 'five_source') await runtime.execute('infer', bindings, input, new AbortController().signal)
    await runtime.execute('writeback', bindings, input, new AbortController().signal)
    const candidate = await runtime.execute('report', bindings, input, new AbortController().signal)
    assert.equal(original.result.status, 'completed')
    assert.equal(candidate.status, 'completed')
    const expectedCalls = scenario.fast ? 0 : 1
    assert.equal(originalServices.modelRequests.length, expectedCalls)
    assert.equal(candidateServices.modelRequests.length, expectedCalls)
    assert.equal(candidate.validation.status, scenario.fast ? 'not_applicable_fast_classification' : scenario.invalid ? 'failed' : 'passed')
    const left = await comparison(original.result, original.directory)
    const right = await comparison(candidate, join(stateRoot, 'runs', candidate.run_id))
    // 只排除新执行器的技术回执；原业务结果及交付字段全部比较。
    const { phase_status, artifacts, trace, source: _source, ...businessResult } = candidate
    assert.deepEqual(right.normalize(businessResult), left.normalize(original.result))
    assert.deepEqual(right.frozen, left.frozen)
    if (!scenario.fast) {
      const inputOf = payload => ({ ...payload, messages: payload.messages.map((message, index) => index === 0 ? message : {
        ...message, prefix: message.content.slice(0, message.content.indexOf('{')), content: JSON.parse(message.content.slice(message.content.indexOf('{'))),
      }) })
      assert.deepEqual(right.normalize(inputOf(candidateServices.modelRequests[0])), left.normalize(inputOf(originalServices.modelRequests[0])))
    }
    for (const filename of ['report.html', 'summary.md', 'summary.json']) {
      const a = await readFile(join(original.directory, filename), 'utf8')
      const b = await runtime.artifact(candidate.run_id, filename)
      assert.deepEqual(right.normalize(filename.endsWith('.json') ? JSON.parse(b.body) : b.body), left.normalize(filename.endsWith('.json') ? JSON.parse(a) : a))
    }
    const sideEffects = services => services.calls.filter(call => /judgement_result$|judgement_fail$/.test(call.tool) || call.tool === 'save_persistence_result')
    const prepare = (call, normalize) => {
      const value = structuredClone(call)
      if (value.tool === 'save_persistence_result') {
        const html = Buffer.from(value.args.fileContentBase64, 'base64').toString('utf8')
        assert.equal(Buffer.from(html, 'utf8').toString('base64'), value.args.fileContentBase64)
        value.args.fileContentBase64 = Buffer.from(normalize(html), 'utf8').toString('base64')
      }
      return normalize(value)
    }
    assert.deepEqual(sideEffects(candidateServices).map(call => prepare(call, right.normalize)), sideEffects(originalServices).map(call => prepare(call, left.normalize)))
    assert.equal(sideEffects(candidateServices).at(-1).tool, 'save_persistence_result')
    assert.equal(sideEffects(candidateServices).filter(call => call.tool.endsWith('judgement_result')).length, scenario.retryWrite ? 2 : 1)
    if (scenario.retryWrite) for (const services of [originalServices, candidateServices]) {
      const writes = sideEffects(services).filter(call => call.tool.endsWith('judgement_result'))
      assert.deepEqual(writes[0].args, writes[1].args)
    }
    const reads = services => services.calls.filter(call => !sideEffects(services).includes(call)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    assert.deepEqual(right.normalize(reads(candidateServices)), left.normalize(reads(originalServices)))
  } finally { await remove(root) }
})

import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { build } from 'esbuild'

const repository = process.env.HARNESS_ASSET_ROOT
const python = process.env.HARNESS_PYTHON || process.env.PYTHON || 'python3'
const bindings = { socConnectionId: 'fixture-soc', reportConnectionId: 'fixture-report', model: { provider: 'fixture', model: 'fixture-model' } }
let modulePromise
async function runtimeModule() {
  if (!modulePromise) modulePromise = (async () => {
    const folder = await mkdtemp(join(tmpdir(), 'threat-build-'))
    const outfile = join(folder, 'runtime.mjs')
    await build({ entryPoints: [new URL('../src/threat/index.ts', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(`file://${outfile}`)
  })()
  return modulePromise
}
async function remove(folder) {
  // 测试清理只读 Git 制品，不改变源资产。
  async function writable(path) {
    const stat = await lstat(path)
    if (stat.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) }
    else await chmod(path, 0o600)
  }
  await writable(folder)
  await rm(folder, { recursive: true, force: true })
}
const envelope = data => ({ status: 'success', status_code: 200, result: { code: 200, data } })
function verdict() {
  return { unified_event_id: 'INC-20261015-000001', verdict: '误报', primary_claim: { type: '常规运维告警', result: '证据不足' },
    secondary_findings: null, confidence_score: 0.5, attack_stage: null, technique: null, technique_name: null,
    verified_facts: [], key_claims: [], counter_evidence: [], uncertainty_notes: '部分基本资料未提供，本次没有观察到异常行为。',
    attack_chain_speculation: { current_stage: null, observed_path: [], possible_next_steps: [], supporting_evidence: [] },
    rule_optimization_suggestions: [], recommended_actions: [], reasoning_summary: '本次仅观察到常规运维测试告警。未提供完整行为资料，需保留不确定性。' }
}
function fixtureServices(options = {}) {
  const calls = []
  let modelCalls = 0, resultCalls = 0, modelResolves = 0
  return {
    calls, get modelCalls() { return modelCalls }, get modelResolves() { return modelResolves },
    connectionFingerprint(connectionId) { return options.fingerprints?.[connectionId] ?? `fixture-target:${connectionId}` },
    resolveModel(route) { modelResolves++; return route ?? bindings.model },
    async invoke(connection, tool, args, signal, expectedFingerprint) {
      assert.equal(expectedFingerprint, this.connectionFingerprint(connection))
      calls.push({ connection, tool, args: structuredClone(args) })
      if (tool.endsWith('create_incident_judgement_claim')) {
        if (options.claimConflict) return { status: 'error', status_code: 409, result: { code: 409, data: null } }
        options.afterClaim?.()
        return envelope({ judgementId: 'judge-basic' })
      }
      if (tool.endsWith('get_correlate_incident_by_incident_id')) {
        options.cancel?.abort()
        signal.throwIfAborted()
        return envelope({ incidentId: args.incidentId, incidentType: '常规运维告警', affectedAssetId: 9106,
          contributingAlertsJson: ['ALERT-BASIC-1'], firstSeenTime: '2026-10-15T00:00:00Z', lastSeenTime: '2026-10-15T00:00:00Z' })
      }
      if (tool.endsWith('get_detect_alert_by_alert_id')) return envelope({ alert_id: 'ALERT-BASIC-1', source: 'EDR', affected_asset_id: 9106,
        created_at: '2026-10-15T00:00:00Z', ocsf: { device: { asset: { uid: '9106' }, ip: '192.0.2.10', hostname: 'test-host' } } })
      if (tool.endsWith('list_detect_whitelist')) return envelope(options.fast ? [{ whitelistId: 'white-basic', enabled: true, type: 'ASSET_ID', value: '9106' }] : [])
      if (tool.endsWith('get_correlate_threat_intel')) return envelope({ rows: [], total: 0 })
      if (tool.endsWith('get_soc_asset_by_asset_id')) return envelope({ assetId: 9106, ip: '192.0.2.10', hostname: 'test-host' })
      if (tool.endsWith('get_soc_asset_importance')) return envelope({ importance: 'low' })
      if (tool.endsWith('get_graph_enrich_topology_by_asset_id')) return envelope({ neighbors: [] })
      if (tool.endsWith('search_event')) return envelope({ items: [], total: 0 })
      if (tool.endsWith('get_correlate_intel_check')) return envelope({ hit: false, matches: [] })
      if (tool.endsWith('update_incident_judgement_result')) {
        assert.match(args.body.reportHtml, /^<!doctype html>/)
        if (options.retryWrite && ++resultCalls === 1) throw new Error('fixture upstream unavailable')
        return envelope({ replayed: false })
      }
      if (tool.endsWith('create_correlate_incident_judgement_fail')) return envelope({ replayed: false })
      if (tool === 'save_persistence_result') {
        assert.equal(connection, bindings.reportConnectionId)
        assert.equal(args.businessId.startsWith('run-'), true)
        if (options.reportFailure) throw new Error('fixture report unavailable')
        return { content: [{ type: 'text', text: JSON.stringify({ code: 200, data: { id: 'report-basic', downloadUrl: 'https://example.test/reports/report-basic' } }) }] }
      }
      return envelope([])
    },
    async inferFrozen(payload, route, signal) {
      signal.throwIfAborted()
      modelCalls++
      options.cancelModel?.abort()
      signal.throwIfAborted()
      options.modelEntered?.()
      if (options.modelGate) await options.modelGate
      assert.equal(route.provider, 'fixture')
      assert.equal(payload.messages.length, 2)
      assert.equal(payload.temperature, 0.1)
      return { model: 'fixture-model', choices: [{ message: { content: JSON.stringify(options.invalidOutput ? { verdict: '误报' } : verdict()) } }] }
    },
  }
}
async function setup(options) {
  const { createThreatRuntime } = await runtimeModule()
  const stateRoot = await mkdtemp(join(tmpdir(), 'threat-state-'))
  const services = fixtureServices(options)
  const runtime = createThreatRuntime(repository, services, { stateRoot, python })
  return { runtime, services, stateRoot, cleanup: () => remove(stateRoot) }
}
const active = () => new AbortController().signal

test('名单快判、原HTML先于SOC回写、独立报告保存与重放均经过实际阶段', async () => {
  const fx = await setup({ fast: true, retryWrite: true })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    assert.equal(collected.phase_status, 'completed', JSON.stringify(collected))
    assert.equal(collected.route, 'fast_classification')
    assert.equal(collected.result.verdict, '误报')
    assert.equal(collected.llm_invoked, false)
    const input = { run_id: collected.run_id }
    assert.equal((await fx.runtime.execute('infer', bindings, input, active())).phase_status, 'skipped')
    const saved = await fx.runtime.execute('writeback', bindings, input, active())
    assert.equal(saved.delivery.storage.summary.status, 'saved')
    const writes = fx.services.calls.filter(call => call.tool.endsWith('update_incident_judgement_result'))
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0].args, writes[1].args)
    const delivered = await fx.runtime.execute('report', bindings, input, active())
    assert.equal(delivered.delivery.storage.report.id, 'report-basic')
    assert.match(delivered.delivery.markdown, /https:\/\/example.test\/reports\/report-basic/)
    const count = fx.services.calls.length
    assert.equal((await fx.runtime.execute('report', bindings, input, active())).replayed, true)
    assert.equal(fx.services.calls.length, count)
    assert.equal(fx.services.modelCalls, 0)
    const recovered = (await runtimeModule()).createThreatRuntime(repository, fx.services, { stateRoot: fx.stateRoot, python })
    assert.equal((await recovered.inspect(collected.run_id)).delivery.storage.report.status, 'saved')
    const html = await recovered.artifact(collected.run_id, 'report.html')
    assert.match(html.body, /威胁事件快速研判报告/)
    assert.deepEqual(delivered.trace.map(row => row.stage), ['collect', 'writeback', 'report'])
    await assert.rejects(() => recovered.artifact(collected.run_id, '../context.json'), /not_found/)
  } finally { await fx.cleanup() }
})

test('五源输入原样进入一次模型；校验失败可解析结果继续回写且报告失败不改结论', async () => {
  const fx = await setup({ invalidOutput: true, reportFailure: true })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    assert.equal(collected.status, 'evidence_ready', JSON.stringify(collected))
    const input = { run_id: collected.run_id }
    await assert.rejects(() => fx.runtime.execute('writeback', bindings, input, active()), /inference_required/)
    const inferred = await fx.runtime.execute('infer', bindings, input, active())
    assert.equal(inferred.status, 'completed', JSON.stringify(inferred))
    assert.equal(inferred.validation.status, 'failed')
    assert.equal((await fx.runtime.execute('infer', bindings, input, active())).replayed, true)
    assert.equal(fx.services.modelCalls, 1)
    await fx.runtime.execute('writeback', bindings, input, active())
    const delivered = await fx.runtime.execute('report', bindings, input, active())
    assert.equal(delivered.status, 'completed')
    assert.equal(delivered.delivery.storage.report.status, 'failed')
    assert.equal(delivered.phase_status, 'failed')
    const metadata = await fx.runtime.artifact(collected.run_id, 'model/request-metadata.json')
    assert.equal(JSON.parse(metadata.body).endpoint, 'platform:inferFrozen')
    assert.doesNotMatch(metadata.body, /127\.0\.0\.1/)
  } finally { await fx.cleanup() }
})

test('认领冲突不取证、不补写失败、不生成报告；绑定与Run边界被校验', async () => {
  const fx = await setup({ claimConflict: true })
  try {
    await assert.rejects(() => fx.runtime.execute('collect', bindings, { incident_id: 'invalid' }, active()), /invalid_threat_incident/)
    const result = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    assert.equal(result.status, 'claim_failed')
    assert.equal(result.error_code, 409)
    assert.equal((await fx.runtime.execute('writeback', bindings, { run_id: result.run_id }, active())).phase_status, 'skipped')
    assert.equal((await fx.runtime.execute('report', bindings, { run_id: result.run_id }, active())).phase_status, 'skipped')
    assert.equal(fx.services.calls.length, 1)
    await assert.rejects(() => fx.runtime.execute('infer', { ...bindings, socConnectionId: 'other' }, { run_id: result.run_id }, active()), /binding_conflict/)
    await assert.rejects(() => fx.runtime.inspect('../outside'), /invalid_threat_run/)
  } finally { await fx.cleanup() }
})

test('Run冻结目标身份：同ID换目标、旧Run缺身份均在回写前拒绝；恢复原目标可继续且重放无副作用', async () => {
  const fingerprints = { [bindings.socConnectionId]: 'soc-target-v1', [bindings.reportConnectionId]: 'report-target-v1' }
  const fx = await setup({ fast: true, fingerprints })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const input = { run_id: collected.run_id }, before = fx.services.calls.length
    fingerprints[bindings.socConnectionId] = 'soc-target-v2'
    await assert.rejects(() => fx.runtime.execute('writeback', bindings, input, active()), /threat_connection_conflict/)
    assert.equal(fx.services.calls.length, before)
    fingerprints[bindings.socConnectionId] = 'soc-target-v1'
    fingerprints[bindings.reportConnectionId] = 'report-target-v2'
    await assert.rejects(() => fx.runtime.execute('writeback', bindings, input, active()), /threat_connection_conflict/)
    assert.equal(fx.services.calls.length, before)
    fingerprints[bindings.reportConnectionId] = 'report-target-v1'
    const contextFile = join(fx.stateRoot, 'runs', collected.run_id, 'context.json')
    const frozen = JSON.parse(await readFile(contextFile, 'utf8'))
    const legacy = { ...frozen }; delete legacy.connections
    await writeFile(contextFile, JSON.stringify(legacy))
    await assert.rejects(() => fx.runtime.execute('writeback', bindings, input, active()), /threat_connection_conflict/)
    assert.equal(fx.services.calls.length, before)
    await writeFile(contextFile, JSON.stringify(frozen))
    await fx.runtime.execute('writeback', bindings, input, active())
    const written = fx.services.calls.length
    assert.equal((await fx.runtime.execute('writeback', bindings, input, active())).replayed, true)
    assert.equal(fx.services.calls.length, written)
    const completedContext = JSON.parse(await readFile(contextFile, 'utf8'))
    const completedLegacy = { ...completedContext }; delete completedLegacy.connections
    await writeFile(contextFile, JSON.stringify(completedLegacy))
    fingerprints[bindings.socConnectionId] = 'soc-target-v2'
    assert.equal((await fx.runtime.execute('writeback', bindings, input, active())).replayed, true)
    assert.equal((await fx.runtime.inspect(collected.run_id)).run_id, collected.run_id)
    assert.match((await fx.runtime.artifact(collected.run_id, 'report.html')).body, /威胁事件快速研判报告/)
    await assert.rejects(() => fx.runtime.execute('report', bindings, input, active()), /threat_connection_conflict/)
    assert.equal(fx.services.calls.length, written)
    fingerprints[bindings.socConnectionId] = 'soc-target-v1'
    await writeFile(contextFile, JSON.stringify(completedContext))
    const cancelled = new AbortController(); cancelled.abort()
    const reported = await fx.runtime.execute('report', bindings, input, cancelled.signal)
    assert.equal(reported.phase_status, 'unknown')
    const cancelledCount = fx.services.calls.length
    assert.equal((await fx.runtime.execute('report', bindings, input, active())).replayed, true)
    assert.equal(fx.services.calls.length, cancelledCount)
  } finally { await fx.cleanup() }
})

test('阶段执行中改目标在下一次取证前拒绝，恢复目标后唯一fail回写仍可完成', async () => {
  const fingerprints = { [bindings.socConnectionId]: 'soc-target-v1', [bindings.reportConnectionId]: 'report-target-v1' }
  const fx = await setup({ fingerprints, afterClaim() { fingerprints[bindings.socConnectionId] = 'soc-target-v2' } })
  try {
    await assert.rejects(() => fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active()), /threat_connection_conflict/)
    assert.equal(fx.services.calls.length, 1)
    const [runId] = await readdir(join(fx.stateRoot, 'runs'))
    const failed = await fx.runtime.inspect(runId)
    assert.equal(failed.judgement_id, 'judge-basic')
    assert.equal(failed.phase_status, 'failed')
    assert.equal(failed.error_type, 'threat_connection_conflict')
    fingerprints[bindings.socConnectionId] = 'soc-target-v1'
    await fx.runtime.execute('writeback', bindings, { run_id: runId }, active())
    const writes = fx.services.calls.filter(row => row.tool.endsWith('create_correlate_incident_judgement_fail'))
    assert.equal(writes.length, 1)
    await fx.runtime.execute('writeback', bindings, { run_id: runId }, active())
    assert.equal(fx.services.calls.filter(row => row.tool.endsWith('create_correlate_incident_judgement_fail')).length, 1)
  } finally { await fx.cleanup() }
})

test('取证取消保留已认领身份，后续独立阶段只补写fail', async () => {
  const controller = new AbortController()
  const fx = await setup({ cancel: controller })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, controller.signal)
    assert.equal(collected.judgement_id, 'judge-basic', JSON.stringify(collected))
    assert.equal(collected.status, 'evidence_failed')
    await fx.runtime.execute('writeback', bindings, { run_id: collected.run_id }, active())
    const fail = fx.services.calls.filter(call => call.tool.endsWith('create_correlate_incident_judgement_fail'))
    assert.equal(fail.length, 1)
    assert.equal(fx.services.modelCalls, 0)
  } finally { await fx.cleanup() }
})

test('固定源码只读且完整五源正常通过；阶段重放不再次采样', async () => {
  const fx = await setup()
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const input = { run_id: collected.run_id }
    const inferred = await fx.runtime.execute('infer', bindings, input, active())
    assert.equal(inferred.validation.status, 'passed', JSON.stringify(inferred))
    assert.equal(inferred.result.confidence_score, 0.5)
    const source = await (await runtimeModule()).ensureThreatSource(repository, { stateRoot: fx.stateRoot })
    assert.equal((await lstat(join(source.directory, 'dsh_runner.py'))).mode & 0o222, 0)
    assert.equal((await lstat(source.bridgeModule)).mode & 0o222, 0)
    assert.equal((await readFile(join(source.directory, 'prompts/threat-analysis-system.txt'), 'utf8')).startsWith('你是 AI SOC'), true)
    assert.equal(fx.services.modelCalls, 1)
    assert.equal((await fx.runtime.execute('infer', bindings, input, active())).replayed, true)
    assert.equal(fx.services.modelCalls, 1)
    await fx.runtime.execute('writeback', bindings, input, active())
    assert.equal((await fx.runtime.execute('report', bindings, input, active())).delivery.storage.report.status, 'saved')
  } finally { await fx.cleanup() }
})

test('模型取消后保持至多一次调用并能独立fail回写', async () => {
  const controller = new AbortController()
  const fx = await setup({ cancelModel: controller })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const input = { run_id: collected.run_id }
    const inferred = await fx.runtime.execute('infer', bindings, input, controller.signal)
    assert.equal(inferred.status, 'model_failed')
    assert.equal(fx.services.modelCalls, 1)
    assert.equal((await fx.runtime.execute('infer', bindings, input, active())).replayed, true)
    assert.equal(fx.services.modelCalls, 1)
    await fx.runtime.execute('writeback', bindings, input, active())
    assert.equal(fx.services.calls.filter(call => call.tool.endsWith('create_correlate_incident_judgement_fail')).length, 1)
  } finally { await fx.cleanup() }
})

test('跨阶段仍共享原30分钟预算，过期不调用模型并进入fail回写', async () => {
  const fx = await setup()
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const file = join(fx.stateRoot, 'runs', collected.run_id, 'context.json')
    const context = JSON.parse(await readFile(file, 'utf8'))
    context.analysis_deadline = Date.now() / 1000 - 1
    await writeFile(file, JSON.stringify(context))
    const input = { run_id: collected.run_id }
    const inferred = await fx.runtime.execute('infer', bindings, input, active())
    assert.equal(inferred.status, 'model_failed')
    assert.equal(inferred.error_type, 'TimeoutError')
    assert.equal(fx.services.modelCalls, 0)
    await fx.runtime.execute('writeback', bindings, input, active())
    assert.equal(fx.services.calls.filter(call => call.tool.endsWith('create_correlate_incident_judgement_fail')).length, 1)
  } finally { await fx.cleanup() }
})

test('同一Run跨runtime并发infer由文件锁拒绝，完成后只重放结果', async () => {
  let entered, release, first, entryTimer
  const controller = new AbortController()
  const modelEntered = new Promise(resolve => { entered = resolve })
  const modelGate = new Promise(resolve => { release = resolve })
  const fx = await setup({ modelEntered: entered, modelGate })
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    assert.equal(collected.status, 'evidence_ready', JSON.stringify(collected))
    const input = { run_id: collected.run_id }
    first = fx.runtime.execute('infer', bindings, input, controller.signal)
    await Promise.race([
      modelEntered,
      first.then(result => assert.fail(`infer 在进入测试模型前结束：status=${result.status}, phase_status=${result.phase_status}`)),
      new Promise((_, reject) => { entryTimer = setTimeout(() => reject(new Error('infer 在10秒内未进入测试模型')), 10_000) }),
    ])
    clearTimeout(entryTimer)
    const other = (await runtimeModule()).createThreatRuntime(repository, fx.services, { stateRoot: fx.stateRoot, python })
    await assert.rejects(() => other.execute('infer', bindings, input, active()), /threat_run_busy/)
    assert.equal((await other.inspect(collected.run_id)).trace.at(-1).status, 'running')
    release()
    assert.equal((await first).status, 'completed')
    assert.equal((await other.execute('infer', bindings, input, active())).replayed, true)
    assert.equal(fx.services.modelCalls, 1)
  } finally {
    clearTimeout(entryTimer)
    release()
    controller.abort()
    await first?.catch(() => {})
    await fx.cleanup()
  }
})

test('模型只在首次infer解析冻结，collect模型字段不影响阶段配置', async () => {
  const fx = await setup()
  try {
    const collectBindings = { ...bindings, model: { provider: 'unused', model: 'not-called' } }
    const collected = await fx.runtime.execute('collect', collectBindings, { incident_id: 'INC-20261015-000001' }, active())
    assert.equal(fx.services.modelResolves, 0)
    const input = { run_id: collected.run_id }
    assert.equal((await fx.runtime.execute('infer', bindings, input, active())).status, 'completed')
    assert.equal(fx.services.modelResolves, 1)
    assert.equal((await fx.runtime.execute('infer', { socConnectionId: bindings.socConnectionId, reportConnectionId: bindings.reportConnectionId }, input, active())).replayed, true)
    assert.equal(fx.services.modelResolves, 1)
    await assert.rejects(() => fx.runtime.execute('infer', collectBindings, input, active()), /threat_model_conflict/)
    assert.equal(fx.services.modelCalls, 1)
    await fx.runtime.execute('writeback', collectBindings, input, active())
  } finally { await fx.cleanup() }
})

test('infer解释器启动失败仍持久model_failed，健康进程可独立fail回写', async () => {
  const fx = await setup()
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const input = { run_id: collected.run_id }
    const broken = (await runtimeModule()).createThreatRuntime(repository, fx.services, { stateRoot: fx.stateRoot, python: join(fx.stateRoot, 'missing-python') })
    const inferred = await broken.execute('infer', bindings, input, active())
    assert.equal(inferred.status, 'model_failed')
    assert.equal(inferred.phase_status, 'unknown')
    assert.equal(fx.services.modelCalls, 0)
    await fx.runtime.execute('writeback', bindings, input, active())
    assert.equal(fx.services.calls.filter(call => call.tool.endsWith('create_correlate_incident_judgement_fail')).length, 1)
  } finally { await fx.cleanup() }
})

test('缓存实际内容每次校验：篡改、缺失及符号链接均拒绝且不静默重建', async () => {
  const { ensureThreatSource } = await runtimeModule()
  for (const mutation of ['changed', 'missing', 'symlink']) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'threat-source-integrity-'))
    try {
      const source = await ensureThreatSource(repository, { stateRoot })
      const file = join(source.directory, 'dsh_runner.py')
      if (mutation === 'changed') { await chmod(file, 0o600); await writeFile(file, '# changed cache\n') }
      else {
        await chmod(dirname(file), 0o700)
        await rm(file)
        if (mutation === 'symlink') await symlink(join(source.directory, 'model_inference.py'), file)
      }
      await assert.rejects(() => ensureThreatSource(repository, { stateRoot }), /threat_source_integrity_failed/)
      if (mutation === 'changed') assert.equal(await readFile(file, 'utf8'), '# changed cache\n')
    } finally { await remove(stateRoot) }
  }
})

test('固定算法升级只重放旧完成阶段，保留模型与绑定校验，缺失交付及旧未完成阶段拒绝', async () => {
  const fx = await setup()
  try {
    const collected = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const input = { run_id: collected.run_id }
    await fx.runtime.execute('infer', bindings, input, active())
    await fx.runtime.execute('writeback', bindings, input, active())
    const delivered = await fx.runtime.execute('report', bindings, input, active())
    const directory = join(fx.stateRoot, 'runs', collected.run_id), file = join(directory, 'context.json')
    const context = JSON.parse(await readFile(file, 'utf8'))
    context.source = { commit: 'prior-fixed-source', digest: '0'.repeat(64) }
    await writeFile(file, JSON.stringify(context))
    const before = fx.services.calls.length, models = fx.services.modelCalls
    assert.equal((await fx.runtime.execute('report', bindings, input, active())).replayed, true)
    assert.equal((await fx.runtime.inspect(collected.run_id)).run_id, collected.run_id)
    await assert.rejects(() => fx.runtime.execute('report', { ...bindings, reportConnectionId: 'other' }, input, active()), /binding_conflict/)
    await assert.rejects(() => fx.runtime.execute('infer', { ...bindings, model: { provider: 'fixture', model: 'other' } }, input, active()), /model_conflict/)
    const outsideRun = join(fx.stateRoot, 'outside-run')
    await rename(directory, outsideRun)
    await symlink(outsideRun, directory)
    try {
      await assert.rejects(() => fx.runtime.execute('report', bindings, input, active()), /artifact_integrity_failed/)
      await assert.rejects(() => fx.runtime.inspect(collected.run_id), /artifact_integrity_failed/)
      await assert.rejects(() => fx.runtime.artifact(collected.run_id, 'report.html'), /artifact_integrity_failed/)
    } finally { await rm(directory); await rename(outsideRun, directory) }
    const outsideModel = join(fx.stateRoot, 'outside-model')
    await rename(join(directory, 'model'), outsideModel)
    await symlink(outsideModel, join(directory, 'model'))
    try { await assert.rejects(() => fx.runtime.execute('report', bindings, input, active()), /artifact_integrity_failed/) }
    finally { await rm(join(directory, 'model')); await rename(outsideModel, join(directory, 'model')) }
    const html = await readFile(join(directory, 'report.html'))
    await rm(join(directory, 'report.html'))
    await assert.rejects(() => fx.runtime.execute('report', bindings, input, active()), /artifact_integrity_failed/)
    await writeFile(join(directory, 'report.html'), html)
    const result = await readFile(join(directory, 'result.json'))
    await writeFile(join(directory, 'result.json'), JSON.stringify({ ...context.result, run_id: 'other' }))
    await assert.rejects(() => fx.runtime.execute('report', bindings, input, active()), /artifact_integrity_failed/)
    await writeFile(join(directory, 'result.json'), result)
    assert.deepEqual((await fx.runtime.execute('report', bindings, input, active())).delivery, delivered.delivery)
    assert.equal(fx.services.calls.length, before)
    assert.equal(fx.services.modelCalls, models)
    const partial = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active())
    const partialFile = join(fx.stateRoot, 'runs', partial.run_id, 'context.json')
    const unfinished = JSON.parse(await readFile(partialFile, 'utf8')); unfinished.source = context.source
    await writeFile(partialFile, JSON.stringify(unfinished))
    await assert.rejects(() => fx.runtime.execute('infer', bindings, { run_id: partial.run_id }, active()), /source_integrity_failed/)
    assert.equal(fx.services.modelCalls, models)
  } finally { await fx.cleanup() }
})

test('首次取证先登记已落盘的Run，登记失败不调用上游', async () => {
  const fx = await setup({ fast: true })
  try {
    let bound
    await assert.rejects(fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001' }, active(), {
      execution_id: 'platform-binding-probe', role: 'target',
      async onRun(id) {
        bound = id
        const saved = JSON.parse(await readFile(join(fx.stateRoot, 'runs', id, 'context.json'), 'utf8'))
        assert.equal(saved.result.run_id, id)
        assert.equal(fx.services.calls.length, 0)
        throw new Error('回执关联未能持久保存')
      },
    }), /回执关联未能持久保存/)
    assert.match(bound, /^run-/)
    assert.equal(fx.services.calls.length, 0)
    const result = await fx.runtime.execute('collect', bindings, { incident_id: 'INC-20261015-000001', run_id: bound }, active(), {
      execution_id: 'platform-binding-probe', role: 'target', async onRun(id) { assert.equal(id, bound); assert.equal(fx.services.calls.length, 0) },
    })
    assert.equal(result.run_id, bound)
    assert.ok(fx.services.calls.length > 0)
  } finally { await fx.cleanup() }
})

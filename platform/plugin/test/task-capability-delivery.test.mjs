import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'node:http'
import { zipSync, strToU8 } from 'fflate'
import { discoverTaskCapabilities } from '../src/tasks/capabilities.ts'
import { applyTaskAssembly, previewTaskAssembly } from '../src/tasks/assembly.ts'
import { candidateDigest, sha256 } from '../src/tasks/files.ts'
import { verifyInspectionReport } from '../src/tasks/inspection-report.ts'
import { verifyTaskDelivery } from '../src/tasks/delivery.ts'

const program = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const adapter = join(program, 'runtime/adapters/dsh-container'), python = process.env.HARNESS_PYTHON || 'python3'
const sourceId = 'EXP-inspection-task-001-r123456abcdef', targetId = 'EXP-inspection-task-002-r123456abcdef'
function write(root, path, body) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task delivery ')); t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'workspace.json', JSON.stringify({ schemaVersion: 1, id: 'workspace-task-test' }))
  const sources = {}
  for (const id of [sourceId, targetId]) {
    const candidate = `evolution/experiments/${id}/candidate`
    write(root, `${candidate}/dsh/workspace/AGENTS.md`, '只读巡检测试资产。')
    write(root, `${candidate}/dsh/managed/task.patch.yml`, '- name: cordis:include\n  config:\n    path: /opt/dsh-presets/inspection-task/agent.cordis.yml\n')
    write(root, `${candidate}/dsh/presets/inspection-task/agent.cordis.yml`, '- name: "@deepseek-ai/dsh-agent"\n')
    write(root, `evolution/experiments/${id}/change.yaml`, 'baseline_ref: "none:first-experiment"\n')
    sources[id] = { agent_id: 'inspection-task', candidate_root: `${candidate}/dsh`, profile: 'web', patch: 'task.patch.yml', preset: 'inspection-task/agent.cordis.yml', guard: null, config_markers: ['inspection-task'], required_env_names: [] }
  }
  write(root, 'config/sources.json', JSON.stringify({ schema_version: '1.1', sources }))
  write(root, `evolution/experiments/${sourceId}/candidate/dsh/workspace/.agents/skills/inspection/SKILL.md`, '# 巡检\n查询指定设备并核对完整性。\n')
  return root
}
function assemblyInput(root) {
  const path = 'dsh/workspace/.agents/skills/inspection/SKILL.md'
  return { target_source: `experiment:${targetId}`, expected_candidate_sha256: candidateDigest(join(root, `evolution/experiments/${targetId}/candidate`)), files: [{ source: `experiment:${sourceId}`, path, expected_source_sha256: sha256(readFileSync(join(root, `evolution/experiments/${sourceId}/candidate/${path}`))), expected_target_sha256: null }] }
}

test('能力目录读取实际来源和原生 MCP，区分发现与验证并过滤凭据', async t => {
  const root = fixture(t)
  const result = await discoverTaskCapabilities(root, { nativeServers: () => [{ id: 'inspection', url: 'https://private.invalid/mcp', token: 'do-not-output', enabled: true, tools: { names: ['list_devices'] } }] })
  assert.equal(result.sources.length, 2); assert.equal(result.sources[0].skills[0].name, 'inspection')
  assert.equal(result.mcp[0].verification, 'configured'); assert.deepEqual(result.mcp[0].tools, ['list_devices'])
  assert.doesNotMatch(JSON.stringify(result), /do-not-output|private.invalid/)
  const digest = execFileSync(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from run_record import candidate_digest; print(candidate_digest(Path(sys.argv[2])))', adapter, join(root, `evolution/experiments/${sourceId}/candidate`)], { encoding: 'utf8', env: { ...process.env, HARNESS_PROGRAM_ROOT: program } }).trim()
  assert.equal(result.sources[0].candidate_sha256, digest)
  assert.equal(result.sources[0].candidate_sha256_basis, 'run-content-path-mode')
})

test('能力目录等待实际工具发现与固定版本引用，不从配置名字猜schema', async t => {
  const root = fixture(t), schema = { type: 'object', properties: { assetId: { type: 'integer' } }, required: ['assetId'] }
  let requested
  const result = await discoverTaskCapabilities(root, { server_id: 'soc-readonly', nativeServers: () => [{ id: 'soc-readonly', tools: { names: ['get_asset'] } }],
    discoveredTools: async serverId => { requested = serverId; return [{ server_id: serverId, name: 'get_asset', inputSchema: schema, headers: { Authorization: 'secret-value' } }] },
    compositionBindings: async () => [{ composition_id: 'asset-alerts', version_id: 'v-fixed', tool_name: 'query_asset_alerts', url: 'https://private.invalid' }],
  })
  assert.equal(requested, 'soc-readonly')
  assert.deepEqual(result.mcp[0].tool_schemas, [{ name: 'get_asset', inputSchema: schema, verification: 'discovered' }])
  assert.deepEqual(result.composition_bindings, [{ composition_id: 'asset-alerts', version_id: 'v-fixed', tool_name: 'query_asset_alerts', verification: 'published' }])
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private.invalid|Authorization/)
})

test('能力目录只保留来源一致且完整的原生分组固定绑定，不输出凭据或猜补分组', async t => {
  const root = fixture(t), version = 'a'.repeat(64), implementation = 'b'.repeat(64)
  const fixed = { group_id: 'research-tools', group_target_digest: 'c'.repeat(64), tool_name: 'mcp__compositions__query_asset_alerts', compositionId: 'asset-alerts', versionId: version, expectedImplementationDigest: implementation, input_schema: { type: 'object' } }
  const entry = { composition_id: 'asset-alerts', version_id: version, tool_name: 'query_asset_alerts', source_digest: implementation }
  const result = await discoverTaskCapabilities(root, { compositionBindings: async () => [
    { ...entry, fixed_binding: { ...fixed, token: 'do-not-output' } },
    { ...entry, fixed_binding: { ...fixed, versionId: 'd'.repeat(64) } },
    { ...entry, fixed_binding: { ...fixed, group_target_digest: undefined } },
    { ...entry, fixed_binding_unavailable: '尚无可核验原生分组' },
  ] })
  assert.deepEqual(result.composition_bindings[0].fixed_binding, fixed)
  for (const binding of result.composition_bindings.slice(1)) assert.equal(binding.fixed_binding, undefined)
  assert.equal(result.composition_bindings[3].fixed_binding_unavailable, '尚无可核验原生分组')
  assert.doesNotMatch(JSON.stringify(result), /do-not-output|token/)
})

test('能力目录接受分组 v2 固定绑定并保留旧版默认值', async t => {
  const root = fixture(t), version = 'a'.repeat(64), implementation = 'b'.repeat(64)
  const entry = { composition_id: 'asset-alerts', version_id: version, tool_name: 'query_asset_alerts', source_digest: implementation }
  const fixed = { group_id: 'research-tools', group_link_version: 2, group_target_digest: 'c'.repeat(64),
    tool_name: 'platform-compositions__query_asset_alerts', compositionId: 'asset-alerts', versionId: version,
    expectedImplementationDigest: implementation, input_schema: { type: 'object' } }
  const result = await discoverTaskCapabilities(root, { compositionBindings: async () => [
    { ...entry, fixed_binding: { ...fixed, token: 'do-not-output' } },
    { ...entry, fixed_binding: { ...fixed, tool_name: 'mcp__compositions__query_asset_alerts' } },
  ] })
  assert.deepEqual(result.composition_bindings[0].fixed_binding, fixed)
  assert.equal(result.composition_bindings[1].fixed_binding, undefined)
  assert.doesNotMatch(JSON.stringify(result), /do-not-output/)
})

test('装配预览无写入，应用复制真实 Skill 并核对配置引用，拒绝重复应用和来源漂移', async t => {
  const root = fixture(t), input = assemblyInput(root), target = join(root, `evolution/experiments/${targetId}/candidate/${input.files[0].path}`)
  assert.equal((await previewTaskAssembly(root, input)).bindings.status, 'declared'); assert.equal(existsSync(target), false)
  const receipt = await applyTaskAssembly(root, input)
  assert.equal(receipt.experiment_id, targetId); assert.equal(receipt.bindings.runtime_verified, false); assert.match(readFileSync(target, 'utf8'), /完整性/)
  await assert.rejects(applyTaskAssembly(root, input), /已变化/)
  const second = fixture(t), next = assemblyInput(second); next.files[0].expected_source_sha256 = '0'.repeat(64)
  await assert.rejects(previewTaskAssembly(second, next), /来源已变化/)
})

test('整批装配先检查配置绑定，缺失依赖或越界路径不得部分写入', async t => {
  const root = fixture(t), input = assemblyInput(root), config = 'dsh/presets/inspection-task/agent.cordis.yml'
  input.configuration_edits = [{ path: config, content: '- name: cordis:include\n  config:\n    path: /opt/dsh-managed/missing.mjs\n', expected_target_sha256: sha256(readFileSync(join(root, `evolution/experiments/${targetId}/candidate/${config}`))) }]
  await assert.rejects(applyTaskAssembly(root, input), /不存在的资产/)
  assert.equal(existsSync(join(root, `evolution/experiments/${targetId}/candidate/${input.files[0].path}`)), false)
  delete input.configuration_edits; input.files[0].target_path = '../escape.md'; await assert.rejects(applyTaskAssembly(root, input), /相对路径/)
  input.files[0].target_path = 'dsh/workspace/.env'; await assert.rejects(applyTaskAssembly(root, input), /不能作为装配资产/)
  input.files[0].target_path = 'dsh/workspace/link/report.md'; symlinkSync(tmpdir(), join(root, `evolution/experiments/${targetId}/candidate/dsh/workspace/link`))
  await assert.rejects(applyTaskAssembly(root, input), /符号链接/)
})

test('CSV 和 Markdown 真实报告检查设备集合、重复、状态和统计', () => {
  const contract = { expected_device_ids: ['D-1', 'D-2'], expected_statuses: { 'D-1': '正常', 'D-2': '待核对' } }
  assert.equal(verifyInspectionReport('device_id,status\nD-1,正常\nD-2,待核对\n', 'csv', contract).ok, true)
  const text = '# 巡检报告\n\n| 设备ID | 状态 |\n| --- | --- |\n| D-1 | 正常 |\n| D-2 | 待核对 |\n\n设备总数：2\n'
  assert.equal(verifyInspectionReport(text, 'markdown', contract).ok, true)
  assert.equal(verifyInspectionReport(text.replace('设备总数：2', '设备总数：3'), 'markdown', contract).ok, false)
  const missing = verifyInspectionReport('device_id,status\nD-1,正常\nD-1,正常\n', 'csv', contract)
  assert.deepEqual(missing.missing, ['D-2']); assert.deepEqual(missing.duplicates, ['D-1'])
  assert.equal(verifyInspectionReport('device_id,status\nD-1,未知\nD-2,待核对\n', 'csv', contract).ok, false)
  assert.throws(() => verifyInspectionReport('"device_id,status', 'csv', contract), /引号未闭合/)
})

function sealedRun(root, withRegression = false) {
  const env = { ...process.env, HARNESS_ASSET_ROOT: root, HARNESS_PROGRAM_ROOT: program }
  const cli = (...args) => execFileSync(python, [join(adapter, 'run_record.py'), '--repo', root, ...args], { env, encoding: 'utf8' }).trim()
  write(root, 'agents/inspection-task/evaluation.md', '# 巡检\n\n#### U-INS-001 报告设备完整\n\n**用户输入**\n\n> 查询 D-1、D-2 并生成 CSV。\n\n**预期**\n\nCSV 含两台设备，设备清单完整。\n')
  if (withRegression) write(root, 'agents/inspection-task/evaluation.md', readFileSync(join(root, 'agents/inspection-task/evaluation.md'), 'utf8') + '\n#### U-IDENTITY-001 身份回归\n\n**用户输入**\n\n> 你是谁？\n\n**预期**\n\n说明巡检职责，不需要查询设备。\n')
  const run = cli('init', '--source', `experiment:${sourceId}`, '--case', 'U-INS-001', ...(withRegression ? ['--case', 'U-IDENTITY-001'] : []), '--kind', 'technical'), prefix = `evolution/experiments/${sourceId}/runs/${run}`
  const report = '# 巡检\n\n| device_id | status |\n| --- | --- |\n| D-1 | 正常 |\n| D-2 | 正常 |\n\n设备总数：2\n'
  write(root, `${prefix}/evidence/U-INS-001/response.json`, JSON.stringify({ assistant_texts: [report] }))
  const toolReport = { completed: true, markdown: report, report_sha256: sha256(report), download_url: '/assistant/api/task-examples/artifact?run_id=task-test&file=report.md' }
  write(root, `${prefix}/evidence/U-INS-001/trace.jsonl`, [
    { type: 'session', id: 'session-test-1' },
    { type: 'tool/call', data: { callId: 'inspection-call', name: 'task_inspection', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'inspection-call', isError: false, content: [{ type: 'text', text: JSON.stringify(toolReport) }] } } },
  ].map(event => JSON.stringify({ session_log: 'session.v4.jsonl', event })).join('\n') + '\n')
  write(root, `${prefix}/evidence/U-INS-001/checks.json`, JSON.stringify({ session_id: 'session-test-1', session_preset: 'inspection-task', session_workspace: '/work/harness/workspace', preset_matches: true, workspace_matches: true }))
  write(root, `${prefix}/results.jsonl`, JSON.stringify({ run_id: run, trial_id: 'trial-test', input_id: 'U-INS-001', execution_status: 'completed', verdict: 'passed', observation: '确定性设备清单通过。', evidence_ref: 'evidence/U-INS-001' }) + '\n')
  if (withRegression) {
    write(root, `${prefix}/evidence/U-IDENTITY-001/trace.jsonl`, JSON.stringify({ session_log: 'session.v4.jsonl', event: { type: 'session', id: 'session-identity' } }) + '\n')
    write(root, `${prefix}/evidence/U-IDENTITY-001/checks.json`, JSON.stringify({ session_id: 'session-identity', preset_matches: true, workspace_matches: true }))
    write(root, `${prefix}/results.jsonl`, readFileSync(join(root, prefix, 'results.jsonl'), 'utf8') + JSON.stringify({ run_id: run, trial_id: 'trial-identity', input_id: 'U-IDENTITY-001', execution_status: 'completed', verdict: 'passed', observation: '身份回归通过。', evidence_ref: 'evidence/U-IDENTITY-001' }) + '\n')
  }
  const contract = JSON.parse(execFileSync(python, [join(adapter, 'source_contract.py'), '--repo', root, '--source', `experiment:${sourceId}`], { env, encoding: 'utf8' })), image = 'sha256:' + '1'.repeat(64)
  write(root, `${prefix}/evidence/dsh-image.json`, JSON.stringify({ local_image_id: image, local_image_tag: contract.image.local_image_tag, image_build_fingerprint: contract.image.build_fingerprint }))
  cli('finalize', '--run', run, '--status', 'completed')
  const artifact = `${prefix}/artifacts/${withRegression ? 'U-INS-001/' : ''}report.md`; write(root, artifact, report)
  const directory = join(root, '.local/instances/delivery-test')
  write(root, '.local/instances/delivery-test/instance.json', JSON.stringify({ name: 'delivery-test', workspace_id: 'workspace-task-test', asset_root: root, source_id: `experiment:${sourceId}`, agent_id: 'inspection-task', container_name: 'delivery-test-container', image_id: image, image_tag: contract.image.local_image_tag, port: 3184 }))
  const observed = { container: [{ Image: image, State: { Running: true }, Config: { Labels: { 'com.docker.compose.project.working_dir': directory, 'com.docker.compose.project.config_files': join(directory, 'compose.yaml') } }, Mounts: ['workspace', 'presets', 'managed'].map((key, index) => ({ Destination: ['/work/harness/workspace', '/opt/dsh-presets', '/opt/dsh-managed'][index], Source: contract[key], RW: false })) }], image: [{ Config: { Labels: { 'org.ai-agent-harness.dsh.image-build-fingerprint': contract.image.build_fingerprint } } }] }
  return { run, artifact, observed }
}

test('交付检查执行真实封存与来源校验，仅隔离 Docker 边界；不能只凭 running 通过', async t => {
  const root = fixture(t), { run, artifact, observed } = sealedRun(root, true)
  const report = readFileSync(join(root, artifact), 'utf8')
  const csv = 'device_id,status\nD-1,正常\nD-2,正常\n'
  let includeCsv = true, toolCsv = csv, downloadedCsv = csv
  let includeReport = true, validReportHash = true, downloadedReport = report
  let probeInput = ''
  const server = createServer(async (request, response) => {
    if (request.url === '/assistant/') { response.end('ready'); return }
    if (request.url.startsWith('/assistant/api/task-examples/artifact')) { response.end(new URL(request.url, 'http://localhost').searchParams.get('file') === 'devices.csv' ? downloadedCsv : downloadedReport); return }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const args = chunks.length ? JSON.parse(Buffer.concat(chunks)).payload.args : null
    const method = new URL(request.url, 'http://localhost').pathname.slice('/assistant/api/'.length)
    const reply = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result: { ok: true, value } })) }
    if (method === 'workspace/create') return reply({ workspace: { workspaceId: 'workspace-probe', path: '/work/harness/workspace' } })
    if (method === 'session/create') return reply({ sessionId: 'session-probe', agentPreset: 'inspection-task' })
    if (method === 'session/rename') return reply({ title: args.request.title, seq: 1 })
    if (method === 'session/list') return reply({ items: [{ sessionId: 'session-probe', cwd: '/work/harness/workspace', projections: { values: { agentPreset: 'inspection-task' } } }] })
    if (method === 'session/prompt') { probeInput = args.request.content[0].text; return reply({ accepted: true }) }
    if (method === 'session.export') {
      const events = [{ type: 'session', id: 'session-probe' }, { type: 'user/message', data: { id: 'probe-message', source: { kind: 'user' }, content: [{ type: 'text', text: probeInput }] } },
        { type: 'tool/call', data: { callId: 'probe-call', name: 'task_inspection', arguments: '{}' } },
        { type: 'tool/result', data: { message: { toolCallId: 'probe-call', isError: false, content: [{ type: 'text', text: JSON.stringify({ completed: includeReport, ...(includeReport ? { markdown: report } : {}), report_sha256: validReportHash ? sha256(report) : '0'.repeat(64), download_url: '/assistant/api/task-examples/artifact?run_id=new-delivery-report&file=report.md', ...(includeCsv ? { csv: toolCsv, csv_url: '/assistant/api/task-examples/artifact?run_id=new-delivery-report&file=devices.csv' } : {}) }) }] } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '报告已生成。' }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 1 } }]
      response.end(Buffer.from(zipSync({ 'session.jsonl': strToU8(events.map(event => JSON.stringify(event)).join('\n') + '\n') }))); return
    }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const manifestPath = join(root, '.local/instances/delivery-test/instance.json')
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), port: server.address().port }))
  const bin = join(root, 'bin'); write(root, 'observation.json', JSON.stringify(observed))
  const script = write(root, 'bin/docker', '#!/usr/bin/env node\nconst fs=require("fs");const o=JSON.parse(fs.readFileSync(process.env.HEP_DELIVERY_TEST_OBSERVATION));process.stdout.write(JSON.stringify(process.argv[2]==="image"?o.image:o.container));\n'); chmodSync(script, 0o700)
  const before = Object.fromEntries(['PATH', 'HARNESS_PYTHON', 'HARNESS_PROGRAM_ROOT', 'HEP_DELIVERY_TEST_OBSERVATION'].map(key => [key, process.env[key]]))
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, HARNESS_PYTHON: python, HARNESS_PROGRAM_ROOT: program, HEP_DELIVERY_TEST_OBSERVATION: join(root, 'observation.json') })
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  const input = { agent_id: 'inspection-task', source: `experiment:${sourceId}`, run_id: run, instance_name: 'delivery-test', artifacts: [artifact], expected_device_ids: ['D-1', 'D-2'], required_case_ids: ['U-INS-001', 'U-IDENTITY-001'], required_tool_names: ['task_inspection'], require_csv: true }
  const verify = value => verifyTaskDelivery(root, value, undefined, { instanceUrl: async () => `http://127.0.0.1:${server.address().port}/assistant/` })
  const passed = await verify(input); assert.equal(passed.ready, true, JSON.stringify(passed.checks))
  assert.equal(passed.probe.session_id, 'session-probe')
  assert.deepEqual(passed.probe.downloads.map(item => item.format), ['markdown', 'csv'])
  assert.equal(readFileSync(join(passed.probe.path, 'devices.csv'), 'utf8'), csv)
  assert.equal(new URL(passed.probe.downloads[1].url).port, String(server.address().port))
  assert.equal(passed.checks.some(check => check.name === 'business_tools:U-IDENTITY-001'), false)
  // 非巡检任务也必须在交付实例完成报告并实际下载；旧 Run 的成功不能替代新实例。
  const generic = { ...input, expected_device_ids: undefined, require_csv: false }
  const genericPassed = await verify(generic)
  assert.equal(genericPassed.ready, true)
  assert.deepEqual(genericPassed.probe.downloads.map(item => item.format), ['markdown'])
  includeReport = false
  const startedOnly = await verify(generic)
  assert.equal(startedOnly.ready, false)
  assert.equal(startedOnly.checks.find(check => check.name === 'delivery_report').ok, false)
  assert.equal(startedOnly.probe.status, 'failed')
  assert.ok(existsSync(join(startedOnly.probe.path, 'evidence/U-INS-001/trace.jsonl')))
  assert.match(readFileSync(join(startedOnly.probe.path, 'evidence/U-INS-001/tools.jsonl'), 'utf8'), /completed/)
  includeReport = true; validReportHash = false
  assert.equal((await verify(generic)).ready, false, '完成自报不能代替真实正文摘要')
  validReportHash = true; downloadedReport = '另一次任务的旧报告'
  const staleDownload = await verify(generic)
  assert.equal(staleDownload.ready, false)
  assert.equal(staleDownload.checks.find(check => check.name === 'delivery_download').ok, false)
  downloadedReport = report
  downloadedCsv = 'device_id,status\nD-1,正常\n'
  const mismatchedCsv = await verify(input)
  assert.equal(mismatchedCsv.ready, false); assert.equal(mismatchedCsv.checks.find(check => check.name === 'delivery_csv_download').ok, false)
  downloadedCsv = csv; includeCsv = false
  const missingCsv = await verify(input)
  assert.equal(missingCsv.ready, false); assert.equal(missingCsv.checks.find(check => check.name === 'delivery_csv').ok, false)
  includeCsv = true
  toolCsv = downloadedCsv = csv.replace('D-2,正常', 'D-2,待核对')
  assert.equal((await verify(input)).checks.find(check => check.name === 'delivery_csv').ok, false, '下载匹配也不能掩盖 Markdown 与 CSV 状态不一致')
  toolCsv = downloadedCsv = csv
  assert.equal((await verify({ ...input, required_tool_names: ['unrelated_business_tool'] })).ready, false)
  assert.equal((await verifyTaskDelivery(root, { ...input, ready: true, artifacts: ['agents/inspection-task/evaluation.md'] })).ready, false)
  observed.container[0].Mounts[0].RW = true; write(root, 'observation.json', JSON.stringify(observed)); assert.equal((await verifyTaskDelivery(root, input)).ready, false)
  observed.container[0].Mounts[0].RW = false; write(root, 'observation.json', JSON.stringify(observed)); write(root, artifact, 'device_id,status\nD-1,正常\n')
  const missing = await verifyTaskDelivery(root, input); assert.equal(missing.ready, false); assert.equal(missing.checks.find(check => check.name.startsWith('inspection:')).ok, false)
  write(root, `evolution/experiments/${sourceId}/candidate/dsh/workspace/AGENTS.md`, '已改变的指令。')
  const changed = await verifyTaskDelivery(root, input); assert.equal(changed.checks.find(check => check.name === 'candidate_unchanged').ok, false); assert.equal(changed.ready, false)
})

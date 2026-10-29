import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fixture, write } from '../../deploy/test/agent-fixture.mjs'
import { createDeployments } from '../src/deployment/index.ts'
import { createDeploymentSeed } from '../src/deployment/seed.ts'

function withProgram(t, program) {
  const previous = process.env.HARNESS_PROGRAM_ROOT
  process.env.HARNESS_PROGRAM_ROOT = program
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_PROGRAM_ROOT; else process.env.HARNESS_PROGRAM_ROOT = previous })
}
const signal = () => new AbortController().signal

test('独立导出预览、异步打包、状态恢复与流式下载走真实进程，公开回执不包含凭据', async t => {
  const f = fixture(t)
  withProgram(t, f.program)
  cpSync(f.resources, join(f.program, '.local/deploy-assets/amd64'), { recursive: true })
  const secret = 'private-deployment-fixture'
  const services = { seed: async () => ({ seed: { environment: { MODEL_FIXTURE_KEY: secret } } }) }
  const manager = createDeployments(f.data, services)
  t.after(() => manager.dispose())
  const input = { agent_id: 'alpha', experiment_id: f.id, arch: 'amd64', mode: 'online' }
  const preview = await manager.handler('preview', input, signal())
  assert.equal(preview.ok, true, JSON.stringify(preview.error))
  assert.equal(preview.value.resourceReady, true)
  assert.equal(JSON.stringify(preview).includes(secret), false)
  assert.equal((await manager.handler('export', input, signal())).ok, false)
  const accepted = await manager.handler('export', { ...input, expected_candidate_sha256: preview.value.candidateSha256 }, signal())
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  assert.equal(accepted.value.state, 'running')
  let job
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await manager.handler('status', { job_id: accepted.value.id }, signal())
    assert.equal(status.ok, true)
    job = status.value
    if (job.state !== 'running') break
    await delay(50)
  }
  assert.equal(job.state, 'completed', job.error)
  assert.equal(job.archive, undefined)
  assert.equal(JSON.stringify(job).includes(secret), false)
  const response = await manager.download(new Request('http://localhost/download?job_id='+job.id))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).subarray(0, 2)], [31,139])
  const row = JSON.parse(readFileSync(join(f.data, '.local/artifacts/agent-deployments', job.id, 'state.json')))
  assert.equal(statSync(row.archive).mode & 0o777, 0o600)
  const restored = createDeployments(f.data, services)
  t.after(() => restored.dispose())
  assert.equal((await restored.handler('status', { job_id: job.id }, signal())).value.state, 'completed')
  assert.equal((await restored.download(new Request('http://localhost/download?job_id=../../etc/passwd'))).status, 409)
})

test('取消导出不自动重放；进程中断回读明确区分，原工作区不被改写', async t => {
  const f = fixture(t)
  withProgram(t, f.program)
  cpSync(f.resources, join(f.program, '.local/deploy-assets/amd64'), { recursive: true })
  const manager = createDeployments(f.data, { seed: async () => ({ seed: {} }) })
  t.after(() => manager.dispose())
  const input = { agent_id: 'alpha', experiment_id: f.id, arch: 'amd64', mode: 'online' }
  const preview = await manager.handler('preview', input, signal())
  const original = readFileSync(join(f.candidate, 'dsh/workspace/AGENTS.md'), 'utf8')
  const accepted = await manager.handler('export', { ...input, expected_candidate_sha256: preview.value.candidateSha256 }, signal())
  await manager.handler('cancel', { job_id: accepted.value.id }, signal())
  await manager.dispose()
  const status = await manager.handler('status', { job_id: accepted.value.id }, signal())
  assert.equal(status.value.state, 'cancelled')
  assert.equal(readFileSync(join(f.candidate, 'dsh/workspace/AGENTS.md'), 'utf8'), original)
  const id = '00000000-0000-4000-8000-000000000001'
  write(join(f.data, '.local/artifacts/agent-deployments', id, 'state.json'), JSON.stringify({ id, ...input, state: 'running' }))
  const interrupted = await manager.handler('status', { job_id: id }, signal())
  assert.equal(interrupted.value.state, 'interrupted')
  assert.equal((await manager.handler('status', { job_id: id }, signal())).value.state, 'interrupted')
})

test('连接种子只收集当前业务来源的MCP闭包和环境，不携带其他服务或平台治理', async t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '# 当前业务\n\n使用 mcp__business-group__lookup。\n')
  write(join(f.data, 'config/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, servers: [
    { id: 'needed', serverName: 'needed', url: 'http://mcp.internal', tools: { mode: 'all', names: [] } },
    { id: 'other', serverName: 'other', url: 'http://other.internal', tools: { mode: 'all', names: [] } },
  ], groups: [{ id: 'business-group', members: [{ serverId: 'needed', names: ['lookup'], resourceUris: [], resourceTemplates: [] }] }] }))
  write(join(f.data, '.local/credentials/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, sharedToken: 'fixture-shared', servers: { needed: { apiKey: 'fixture-needed' }, other: { apiKey: 'fixture-other' } } }))
  const load = createDeploymentSeed(f.data, async () => ({ policy: { patch: [{ id: 'llm-test' }], default: { provider: 'test', model: 'test' } }, environment: { MODEL_FIXTURE_KEY: 'fixture-model' } }))
  const { seed } = await load({ agent_id: 'alpha', experiment_id: f.id }, signal())
  assert.deepEqual(seed.mcp.servers.map(server => server.id), ['needed'])
  assert.deepEqual(seed.mcp.groups.map(group => group.id), ['business-group'])
  assert.equal(seed.mcp.servers[0].apiKey, 'fixture-needed')
  assert.equal(JSON.stringify(seed).includes('fixture-other'), false)
  assert.equal(seed.environment.MODEL_FIXTURE_KEY, 'fixture-model')
  assert.equal(seed.environment.TEST_MODEL_KEY, 'synthetic-fixture-value')
  assert.equal(seed.agentId, 'alpha')
  await assert.rejects(load({ agent_id: 'other', experiment_id: f.id }, signal()), /不属于/)
})

test('请求回执丢失后相同身份恢复同一任务，拒绝并发错对象或不同选项', async t => {
  const f = fixture(t)
  withProgram(t, f.program)
  cpSync(f.resources, join(f.program, '.local/deploy-assets/amd64'), { recursive: true })
  let seedCalls = 0
  const services = { seed: async () => { seedCalls++; await delay(30); return { seed: {} } } }
  const manager = createDeployments(f.data, services)
  t.after(() => manager.dispose())
  const input = { agent_id: 'alpha', experiment_id: f.id, arch: 'amd64', mode: 'online' }
  const preview = await manager.handler('preview', input, signal())
  const request = { ...input, request_id: 'cd606d91-67f0-4b05-a001-000000000001', expected_candidate_sha256: preview.value.candidateSha256 }
  const [first, retry, wrong] = await Promise.all([
    manager.handler('export', request, signal()), manager.handler('export', request, signal()),
    manager.handler('export', { ...request, mode: 'offline' }, signal()),
  ])
  assert.equal(first.ok, true)
  assert.equal(retry.ok, true)
  assert.equal(first.value.id, retry.value.id)
  assert.equal(wrong.ok, false)
  assert.equal(seedCalls, 2) // 一次预览，一次实际接受。
  let job
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await manager.handler('status', { job_id: first.value.id }, signal())).value
    if (job.state !== 'running') break
    await delay(50)
  }
  assert.equal(job.state, 'completed', job.error)
  const restored = createDeployments(f.data, services)
  t.after(() => restored.dispose())
  const recovered = await restored.handler('export', request, signal())
  assert.equal(recovered.value.state, 'completed')
  assert.equal(recovered.value.sha256, job.sha256)
  assert.equal(seedCalls, 2)
  assert.equal((await restored.handler('export', { ...request, arch: 'arm64' }, signal())).ok, false)
})

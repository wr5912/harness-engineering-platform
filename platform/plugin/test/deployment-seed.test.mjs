import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { dump } from 'js-yaml'
import { fixture, write } from '../../deploy/test/agent-fixture.mjs'
import { createDeploymentSeed } from '../src/deployment/seed.ts'

const signal = () => new AbortController().signal
const project = async () => ({ policy: { patch: [] }, environment: {} })
function native(f, servers) {
  write(join(f.candidate, 'dsh/managed/alpha.patch.yml'), dump([{ id: 'mcp-session-manager', config: { servers, groups: [] } }]))
}
const invoke = (f, projection = project, url) => createDeploymentSeed(f.data, projection, url)({ agent_id: 'alpha', experiment_id: f.id }, signal())

test('独立种子只导出 Harness 原生连接与工具选择，不读取平台流程、执行状态和下游配置', async t => {
  const f = fixture(t)
  const server = { id: 'business', enabled: true, url: 'http://platform.test/hep/mcp/groups/business/v2', headers: [], tools: { mode: 'selected', names: ['run', 'get_composition_run'] } }
  native(f, [server])
  write(join(f.data, 'config/mcp-compositions.json'), 'not a composition catalog')
  write(join(f.candidate, 'dsh/managed/binding.ts'), 'export const fixedCompositions = process.env.BINDING;')
  const { seed, notices } = await invoke(f)
  assert.deepEqual(seed.mcp, { servers: [server], groups: [] })
  assert.deepEqual(notices, [])
  for (const key of ['compositions', 'extensions', 'fixedBindings']) assert.equal(key in seed, false)
})

test('只为当前平台的已声明入口补充凭据，不向其他主机或前缀转发平台 Token', async t => {
  const f = fixture(t), token = 'a'.repeat(64)
  write(join(f.data, 'config/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, servers: [], groups: [] }))
  write(join(f.data, '.local/credentials/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, sharedToken: token, servers: {} }))
  native(f, [
    { id: 'current', url: 'http://platform.test/hep/mcp/groups/current/v2' },
    { id: 'legacy-link', url: 'http://platform.test/hep/mcp/groups/legacy-link' },
    { id: 'other', url: 'http://other.test/hep/mcp/groups/other/v2' },
    { id: 'prefix', url: 'http://platform.test/other/mcp/groups/prefix/v2' },
    { id: 'configured', url: 'http://platform.test/hep/mcp/groups/configured/v2', headers: [{ name: 'Authorization', value: 'Bearer own' }] },
  ])
  const result = await invoke(f, project, id => `http://platform.test/hep/mcp/groups/${id}/v2`)
  assert.deepEqual(result.seed.mcp.servers.map(server => server.headers?.[0]?.value), [`Bearer ${token}`, `Bearer ${token}`, undefined, undefined, 'Bearer own'])
})

test('业务代码和 Profile 中的 JS 表达式只作为资产数据读取，不执行', async t => {
  const f = fixture(t), marker = join(f.root, 'must-not-execute')
  write(join(f.candidate, 'dsh/managed/business.mjs'), `throw new Error('must not import business code')`)
  write(join(f.candidate, 'dsh/managed/alpha.patch.yml'), `- id: unrelated\n  config:\n    value: !!js require('fs').writeFileSync('${marker}', 'bad')\n- id: mcp-session-manager\n  config: {servers: [], groups: []}\n`)
  assert.deepEqual((await invoke(f)).seed.mcp, { servers: [], groups: [] })
  assert.equal(existsSync(marker), false)
})

test('模型投影失败不阻塞原生连接导出，凭据来自业务环境声明', async t => {
  const f = fixture(t)
  native(f, [{ id: 'external', url: 'http://external.test/mcp' }])
  write(join(f.candidate, 'dsh/workspace/.env'), 'BUSINESS_KEY=fixture\n')
  const result = await invoke(f, async () => { throw new Error('model missing') })
  assert.equal(result.seed.environment.BUSINESS_KEY, 'fixture')
  assert.equal(result.seed.mcp.servers[0].url, 'http://external.test/mcp')
  assert.equal(result.notices.length, 1)
})

test('Web 角色运行声明拒绝不支持的独立部署，不提前生成投影', async t => {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nrole_instructions:\n  alpha-main: dsh/workspace/AGENTS.md\n')
  let projected = false
  await assert.rejects(invoke(f, async () => { projected = true; return project() }), /当前 Web 独立运行包尚未适配这些投影/)
  assert.equal(projected, false)
})

test('SDK 使用所选 Candidate 的模型投影，保留原生资产', async t => {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  const original = readFileSync(harness, 'utf8').replace('loadable_assets:\n', 'loadable_assets:\n  profile: sdk\n') + '\nrole_instructions:\n  alpha-main: dsh/workspace/AGENTS.md\n'
  write(harness, original)
  const selection = { provider: 'sdk-provider', model: 'sdk-model' }
  const patch = [{ id: 'sdk-model-binding', config: { selection } }]
  let requested
  const result = await invoke(f, async (agentId, selected, candidatePath) => {
    requested = { agentId, selected, candidatePath }
    return { policy: { patch, default: selection }, environment: {} }
  })
  assert.deepEqual(requested, { agentId: 'alpha', selected: undefined, candidatePath: f.candidate })
  assert.deepEqual(result.seed.modelPatch, patch)
  assert.deepEqual(result.seed.defaultModel, selection)
  assert.deepEqual(result.notices, [])
  assert.equal(readFileSync(harness, 'utf8'), original)
})

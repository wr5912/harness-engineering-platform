import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture, write } from '../../deploy/test/agent-fixture.mjs'
import { createDeploymentSeed } from '../src/deployment/seed.ts'
import { compositionConfig, compositionVersionId, readCompositions } from '../src/mcp/compositions.ts'

const signal = () => new AbortController().signal
const publishedAt = '2026-10-29T00:00:00Z'
function config(toolName, connectionId, extra = {}) {
  return compositionConfig({ toolName, title: toolName, description: '', connectionId, ...extra })
}
function entry(id, published, previous = [], draft) {
  return { id, ...(draft ? { draft } : {}), published: { ...published, publishedAt },
    publishedVersionId: compositionVersionId(published),
    versions: [...previous, published].map(value => ({ versionId: compositionVersionId(value), config: value, publishedAt })) }
}
function group(names) {
  return { id: 'business-group', members: [{ serverId: 'platform-compositions', names, resourceUris: [], resourceTemplates: [] }] }
}
function configure(f, serverIds, compositions, groups = []) {
  write(join(f.data, 'config/mcp-manager.json'), JSON.stringify({ schemaVersion: 1,
    servers: serverIds.map(id => ({ id, serverName: id, url: `http://${id}.internal`, tools: { mode: 'all', names: [] } })), groups }))
  write(join(f.data, '.local/credentials/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, sharedToken: 'fixture-shared',
    servers: Object.fromEntries(serverIds.map(id => [id, { apiKey: `fixture-${id}` }])) }))
  write(join(f.data, 'config/mcp-compositions.json'), JSON.stringify({ schema_version: '1.0', compositions }))
}
function seed(f) {
  return createDeploymentSeed(f.data, async () => ({ policy: { patch: [] }, environment: {} }))({ agent_id: 'alpha', experiment_id: f.id }, signal())
}

test('尚未适配的角色运行声明不能回落全局模型后生成独立部署种子', async t => {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nrole_instructions:\n  alpha-main: dsh/workspace/AGENTS.md\n')
  let projected = false
  await assert.rejects(createDeploymentSeed(f.data, async () => { projected = true; return { policy: { patch: [] }, environment: {} } })({ agent_id: 'alpha', experiment_id: f.id }, signal()), /当前独立运行包尚未适配/)
  assert.equal(projected, false)
})

test('分组发布组合递归保留固定子版本及实际后端凭据，排除草稿、其他历史版和无关编排', async t => {
  const f = fixture(t)
  const oldFlow = config('child_tool', 'flow-soc', { flow: 'soc-asset-alerts', alertsConnectionId: 'flow-alerts' })
  const newFlow = config('child_tool', 'new-soc', { flow: 'soc-asset-alerts', alertsConnectionId: 'new-alerts' })
  const stage = config('stage_tool', 'stage-main', { kind: 'threat-stage', stage: 'collect', bindings: { socConnectionId: 'stage-soc', reportConnectionId: 'stage-report' } })
  const parent = config('parent_tool', 'platform-compositions', { kind: 'composite', steps: [
    { id: 'flow', compositionId: 'child', versionId: compositionVersionId(oldFlow), inputMap: {} },
    { id: 'stage', compositionId: 'stage', versionId: compositionVersionId(stage), inputMap: {} },
  ] })
  const oldParent = config('parent_tool', 'historical-server')
  const unused = config('unrelated_tool', 'unrelated-server')
  configure(f, ['flow-soc', 'flow-alerts', 'stage-main', 'stage-soc', 'stage-report', 'new-soc', 'new-alerts', 'historical-server', 'draft-server', 'unrelated-server'], [
    entry('parent', parent, [oldParent], config('parent_tool', 'draft-server')),
    entry('child', newFlow, [oldFlow], config('child_tool', 'draft-server')),
    entry('stage', stage), entry('unrelated', unused),
  ], [group(['parent_tool'])])
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '使用 mcp__business-group__parent_tool。文档曾提到 unrelated，但不调用它。\n')
  const original = readFileSync(join(f.data, 'config/mcp-compositions.json'), 'utf8')
  const { seed: actual } = await seed(f)
  assert.deepEqual(actual.mcp.servers.map(server => server.id), ['flow-soc', 'flow-alerts', 'stage-main', 'stage-soc', 'stage-report'])
  assert.deepEqual(actual.mcp.servers.map(server => server.apiKey), ['fixture-flow-soc', 'fixture-flow-alerts', 'fixture-stage-main', 'fixture-stage-soc', 'fixture-stage-report'])
  assert.deepEqual(actual.mcp.mountServerIds, ['business-group'])
  assert.deepEqual(actual.compositions.compositions.map(value => value.id), ['parent', 'child', 'stage'])
  for (const value of actual.compositions.compositions) { assert.equal(value.draft, undefined); assert.equal(value.versions.length, 1) }
  assert.equal(actual.compositions.compositions[1].publishedVersionId, compositionVersionId(oldFlow))
  assert.deepEqual(actual.compositions.compositions[1].versions[0].config, oldFlow)
  assert.equal(/fixture-(?:new|historical|draft|unrelated)/.test(JSON.stringify(actual)), false)
  write(join(f.root, 'selected.json'), JSON.stringify(actual.compositions))
  assert.deepEqual(readCompositions(join(f.root, 'selected.json')).catalog, actual.compositions)
  assert.equal(readFileSync(join(f.data, 'config/mcp-compositions.json'), 'utf8'), original)
})

test('Candidate 明确固定旧版本时不替换成当前发布版，同时支持 TS、JSON 和 YAML 字面量', async t => {
  for (const extension of ['ts', 'json', 'yml']) await t.test(extension, async t => {
    const f = fixture(t), old = config('fixed_tool', 'fixed-server'), current = config('fixed_tool', 'current-server')
    configure(f, ['fixed-server', 'current-server'], [entry('fixed', current, [old])])
    const binding = { compositionId: 'fixed', versionId: compositionVersionId(old) }
    const content = extension === 'ts' ? `const compositionId = 'fixed'; const versionId = '${binding.versionId}'; export const definition = { fixedCompositions: { run: { compositionId, versionId } } };`
      : extension === 'json' ? JSON.stringify({ fixedCompositions: { run: binding } })
        : `fixedCompositions:\n  run:\n    compositionId: fixed\n    versionId: ${binding.versionId}\n`
    write(join(f.candidate, `dsh/managed/bindings.${extension}`), content)
    const { seed: actual } = await seed(f)
    assert.deepEqual(actual.mcp.servers.map(server => server.id), ['fixed-server'])
    assert.deepEqual(actual.compositions.compositions[0].versions.map(version => version.versionId), [binding.versionId])
    assert.equal(actual.compositions.compositions[0].publishedVersionId, binding.versionId)
    assert.deepEqual(actual.compositions.compositions[0].published, { ...old, publishedAt })
  })
})

test('固定旧版与分组当前发布版同时使用时保留两者，当前发布指针仍保持原身份', async t => {
  const f = fixture(t), old = config('fixed_tool', 'fixed-server'), current = config('fixed_tool', 'current-server')
  configure(f, ['fixed-server', 'current-server'], [entry('fixed', current, [old])], [group(['fixed_tool'])])
  write(join(f.candidate, 'dsh/managed/binding.json'), JSON.stringify({ group_id: 'business-group', compositionId: 'fixed', versionId: compositionVersionId(old) }))
  const { seed: actual } = await seed(f)
  assert.deepEqual(actual.mcp.servers.map(server => server.id), ['fixed-server', 'current-server'])
  const selected = actual.compositions.compositions[0]
  assert.deepEqual(selected.versions.map(version => version.versionId), [compositionVersionId(old), compositionVersionId(current)])
  assert.equal(selected.publishedVersionId, compositionVersionId(current))
})

test('源代码只静态读取，SDK 动态元数据和测试样例不被视为待导出的业务绑定', async t => {
  const f = fixture(t), fixed = config('fixed_tool', 'fixed-server'), unrelated = config('unrelated_tool', 'unrelated-server')
  configure(f, ['fixed-server', 'unrelated-server'], [entry('fixed', fixed), entry('unrelated', unrelated)])
  const marker = join(f.root, 'source-must-not-execute')
  write(join(f.candidate, 'dsh/managed/business.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');
    export const definition = { fixedCompositions: { run: { compositionId: 'fixed', versionId: '${compositionVersionId(fixed)}' } } };
    function metadata(binding) { return { compositionId: binding.compositionId, versionId: binding.versionId }; }`)
  write(join(f.candidate, 'dsh/managed/business.test.ts'), `const example = {compositionId:'unrelated',versionId:'${compositionVersionId(unrelated)}'};`)
  const { seed: actual } = await seed(f)
  assert.equal(existsSync(marker), false)
  assert.deepEqual(actual.mcp.servers.map(server => server.id), ['fixed-server'])
  assert.deepEqual(actual.compositions.compositions.map(value => value.id), ['fixed'])
})

test('固定版本或真实后端缺失时明确阻断，不回退到其他版本或忽略连接', async t => {
  const f = fixture(t), current = config('fixed_tool', 'current-server')
  configure(f, ['current-server'], [entry('fixed', current)])
  write(join(f.candidate, 'dsh/managed/binding.json'), JSON.stringify({ compositionId: 'fixed', versionId: 'f'.repeat(64) }))
  await assert.rejects(seed(f), /固定版本 .* 不存在，未替换为其他版本/)
  const missing = config('fixed_tool', 'missing-server')
  configure(f, ['current-server'], [entry('fixed', missing)])
  write(join(f.candidate, 'dsh/managed/binding.json'), JSON.stringify({ compositionId: 'fixed', versionId: compositionVersionId(missing) }))
  await assert.rejects(seed(f), /MCP 连接 missing-server 尚未配置/)
})

test('嵌套子组合缺少固定版本时不使用它的当前发布版替代', async t => {
  const f = fixture(t), child = config('child_tool', 'child-server')
  const parent = config('parent_tool', 'platform-compositions', { kind: 'composite', steps: [
    { id: 'child', compositionId: 'child', versionId: 'f'.repeat(64), inputMap: {} },
  ] })
  configure(f, ['child-server'], [entry('parent', parent), entry('child', child)], [group(['parent_tool'])])
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '使用 mcp__business-group__parent_tool。\n')
  await assert.rejects(seed(f), /编排 child 的固定版本 .* 不存在，未替换为其他版本/)
})

test('明确直连编排工具时仅选择该工具当前发布版与后端连接', async t => {
  const f = fixture(t), direct = config('direct_tool', 'direct-server'), other = config('other_tool', 'other-server')
  configure(f, ['direct-server', 'other-server'], [entry('direct', direct), entry('other', other)])
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '使用 mcp__compositions__direct_tool。\n')
  const { seed: actual } = await seed(f)
  assert.deepEqual(actual.mcp.servers.map(server => server.id), ['direct-server'])
  assert.deepEqual(actual.mcp.mountServerIds, ['platform-compositions'])
  assert.deepEqual(actual.compositions.compositions.map(value => value.id), ['direct'])
})

test('无法静态确定的固定身份拒绝导出，避免将可变值误判为已冻结版本', async t => {
  const f = fixture(t), fixed = config('fixed_tool', 'fixed-server')
  configure(f, ['fixed-server'], [entry('fixed', fixed)])
  write(join(f.candidate, 'dsh/managed/binding.ts'), `let compositionId = 'fixed'; const versionId = '${compositionVersionId(fixed)}'; export const definition = { fixedCompositions: { run: { compositionId, versionId } } };`)
  await assert.rejects(seed(f), /固定编排身份无法静态确定/)
  write(join(f.candidate, 'dsh/managed/binding.ts'), 'export const definition = { fixedCompositions: { run: { compositionId: process.env.COMPOSITION, versionId: process.env.VERSION } } };')
  await assert.rejects(seed(f), /固定编排身份无法静态确定/)
})

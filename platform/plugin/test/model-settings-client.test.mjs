import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/models/client.tsx', import.meta.url).pathname], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require })
const { businessConnectionState, businessDefaultState, modelPolicyIssue, platformDefaultState, selectedFromKey, statusAfterRead } = module.exports
const catalog = { default: { provider: 'provider-a', model: 'model-1' }, routableProviders: ['provider-a'], failures: [],
  groups: [{ id: 'provider-a', name: '服务 A', models: [
    { id: 'model-1', name: '模型一', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
    { id: 'model-2', name: '模型二', reasoning: { efforts: [{ id: 'medium', name: '中' }], defaultEffort: 'medium' } },
  ] }] }
const ref = model => ({ provider: 'provider-a', model })
const modelKey = model => JSON.stringify([model.provider, model.model])

test('业务默认直接从当前可用目录选择，目录漂移后必须重新选择', () => {
  assert.match(modelPolicyIssue(catalog, [], null), /统一默认/)
  assert.equal(modelPolicyIssue(catalog, [ref('model-1')], ref('model-1')), '')
  assert.match(modelPolicyIssue(catalog, [ref('model-1')], ref('model-2')), /当前业务可用目录/)
  assert.match(modelPolicyIssue(catalog, [ref('model-1')], { ...ref('model-1'), reasoningEffort: 'invalid' }), /推理档位/)
})

test('默认模型选择保留同模型原推理档位，切换模型采用新模型默认档位', () => {
  const high = { ...ref('model-1'), reasoningEffort: 'high' }
  const selected = (key, previous) => JSON.parse(JSON.stringify(selectedFromKey(catalog, key, previous)))
  assert.deepEqual(selected(modelKey(high), high), high)
  assert.deepEqual(selected(modelKey(ref('model-2')), high), { ...ref('model-2'), reasoningEffort: 'medium' })
  assert.deepEqual(selected(modelKey(ref('model-1')), ref('model-2')), { ...ref('model-1'), reasoningEffort: 'low' })
})

test('平台账号登录模型不声明为业务实例可用', () => {
  const account = { provider: 'deepseek-account', model: 'account-model' }
  assert.match(modelPolicyIssue(catalog, [account], account), /只供平台助手/)
})

test('连接状态只针对业务统一默认，缺密钥不阻止保存选择', () => {
  const selected = ref('model-1')
  assert.equal(modelPolicyIssue(catalog, [selected], selected), '')
  const missing = businessConnectionState(selected, { 'provider-a': { state: 'missing_api_key', message: '请在设置 → 模型中配置 API Key' } })
  assert.equal(missing.kind, 'blocked')
  assert.match(missing.label, /默认模型连接未就绪/)
  assert.match(missing.description, /可先保存选择/)
  assert.match(missing.description, /API Key/)
  assert.equal(businessConnectionState(selected, { 'provider-a': { state: 'ready', message: '可解析' } }).kind, 'ready')
  const runtimeCheck = businessConnectionState(selected, { 'provider-a': { state: 'runtime_check', message: '需在业务实例中核对' } })
  assert.equal(runtimeCheck.kind, 'runtime_check')
  assert.match(runtimeCheck.description, /实际调用核对/)
  assert.equal(businessConnectionState(selected, {}).kind, 'blocked')
  assert.equal(businessConnectionState(null, {}).kind, 'unconfigured')
})

const revisionA = 'a'.repeat(64)
const revisionB = 'b'.repeat(64)
const businessSnapshot = (current, changes = {}) => ({ business_default: current, business_model_revision: revisionA,
  migration_required: false, legacy_default: null, ...changes })

test('新回读保留仍准确的保存回执并清除旧未知或已变化回执', () => {
  const saved = ref('model-1'), changed = ref('model-2')
  const success = { tone: 'success', text: '已保存并回读', selection: saved }
  assert.equal(statusAfterRead(success, saved), success)
  assert.equal(statusAfterRead(success, changed), null)
  assert.equal(statusAfterRead({ tone: 'warning', text: '结果未知' }, saved), null)
  assert.equal(statusAfterRead({ tone: 'error', text: '保存失败' }, saved), null)
})

test('旧格式迁移预选不是用户修改，旧会话草稿应自动归一', () => {
  const legacy = ref('model-1')
  const snapshot = businessSnapshot(null, { migration_required: true, legacy_default: legacy, business_model_revision: revisionB })
  const oldPreselection = { base: null, value: legacy, revision: revisionA }
  const state = businessDefaultState(oldPreselection, snapshot)
  assert.equal(state.dirty, false)
  assert.equal(state.stale, false)
  assert.equal(state.stored, null)
  assert.deepEqual(JSON.parse(JSON.stringify(state.draft.value)), legacy)
  assert.equal(state.draft.revision, revisionB)
  assert.equal(state.draft.edited, false)
})

test('已保存值与草稿相同后清除假草稿，平台默认也按同一规则归一', () => {
  const first = ref('model-1'), saved = ref('model-2')
  const oldDraft = { base: first, value: saved, revision: revisionA, edited: true }
  const business = businessDefaultState(oldDraft, businessSnapshot(saved, { business_model_revision: revisionB }))
  assert.equal(business.dirty, false)
  assert.equal(business.stale, false)
  assert.equal(business.stored, null)
  assert.equal(business.draft.revision, revisionB)
  const platform = platformDefaultState({ base: first, value: saved }, saved)
  assert.equal(platform.dirty, false)
  assert.equal(platform.stale, false)
  assert.equal(platform.stored, null)
})

test('仅修订号变化但当前默认未变时，保留不同草稿并更新保存基准', () => {
  const first = ref('model-1'), draftValue = ref('model-2')
  const draft = { base: first, value: draftValue, revision: revisionA, edited: true }
  const state = businessDefaultState(draft, businessSnapshot(first, { business_model_revision: revisionB }))
  assert.equal(state.dirty, true)
  assert.equal(state.stale, false)
  assert.equal(state.draft.revision, revisionB)
  assert.deepEqual(JSON.parse(JSON.stringify(state.stored.value)), draftValue)
})

test('不同默认在别处保存时保留草稿并阻止误判为当前值', () => {
  const original = ref('model-1'), draftValue = ref('model-2')
  const external = { ...original, reasoningEffort: 'high' }
  const draft = { base: original, value: draftValue, revision: revisionA, edited: true }
  const business = businessDefaultState(draft, businessSnapshot(external, { business_model_revision: revisionB }))
  assert.equal(business.dirty, true)
  assert.equal(business.stale, true)
  assert.deepEqual(JSON.parse(JSON.stringify(business.draft.value)), draftValue)
  assert.equal(business.draft.revision, revisionA)
  assert.deepEqual(JSON.parse(JSON.stringify(business.stored.value)), draftValue)
  const platform = platformDefaultState({ base: original, value: draftValue }, external)
  assert.equal(platform.dirty, true)
  assert.equal(platform.stale, true)
  assert.deepEqual(JSON.parse(JSON.stringify(platform.stored.value)), draftValue)
})

test('迁移中明确另选的模型保留，未编辑的预选随旧配置更新', () => {
  const original = ref('model-1'), selected = ref('model-2')
  const snapshot = businessSnapshot(null, { migration_required: true, legacy_default: original, business_model_revision: revisionB })
  const edited = businessDefaultState({ base: null, value: selected, revision: revisionA }, snapshot)
  assert.equal(edited.dirty, true)
  assert.equal(edited.stale, false)
  assert.deepEqual(JSON.parse(JSON.stringify(edited.draft.value)), selected)
  assert.equal(edited.draft.revision, revisionB)
  const preselection = businessDefaultState({ base: null, value: original, revision: revisionA, edited: false },
    { ...snapshot, legacy_default: selected })
  assert.equal(preselection.dirty, false)
  assert.equal(preselection.stored, null)
  assert.deepEqual(JSON.parse(JSON.stringify(preselection.draft.value)), selected)
  const uncertainOldDraft = businessDefaultState({ base: null, value: original, revision: revisionA },
    { ...snapshot, legacy_default: selected })
  assert.equal(uncertainOldDraft.dirty, true, '无编辑标记的旧草稿不能确认是否为用户选择，应保留')
})

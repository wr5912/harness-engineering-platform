import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { boundDrafts, saveDraftBinding, withDraftInstance } from '../src/mcp/draft-bindings.ts'

test('草稿固定在指定实例及来源，普通发现不受影响，并发上下文互不串用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-draft-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const instance = { instanceId: 'acceptance', sourceDigest: 'source-a' }
  const compositions = [{ id: 'policy-change', config: { toolName: 'policy_change', flowDigest: 'fixed' }, implementationDigest: 'implementation' }]
  saveDraftBinding(root, { ...instance, compositions })
  assert.deepEqual(boundDrafts(root), [])
  assert.deepEqual(withDraftInstance(instance, () => boundDrafts(root)), compositions)
  assert.deepEqual(withDraftInstance({ ...instance, instanceId: 'other' }, () => boundDrafts(root)), [])
  assert.throws(() => withDraftInstance({ ...instance, sourceDigest: 'changed' }, () => boundDrafts(root)), /来源不一致/)
  const values = await Promise.all([instance, { ...instance, instanceId: 'other' }].map(binding => withDraftInstance(binding, async () => { await Promise.resolve(); return boundDrafts(root) })))
  assert.deepEqual(values, [compositions, []])
  assert.throws(() => saveDraftBinding(root, { ...instance, instanceId: '../escape', compositions }), /名称/)
  saveDraftBinding(root, { ...instance, compositions: [] })
  assert.deepEqual(withDraftInstance(instance, () => boundDrafts(root)), [])
  assert.deepEqual(withDraftInstance({ ...instance, sourceDigest: 'changed' }, () => boundDrafts(root)), [])
})

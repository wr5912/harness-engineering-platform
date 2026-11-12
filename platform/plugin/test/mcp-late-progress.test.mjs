import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflowRuns } from '../src/mcp/workflow-runs.ts'
test('终态后迟到的节点进度不再改写结果，只累计审计计数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-late-progress-'))
  const store = workflowRuns(root)
  let late
  const run = await store.start({ config: { workflow: 'check' }, input: {}, catalog: {}, version: { implementationDigest: 'x'.repeat(64) }, executionId: 'late', compositionId: 'check' },
    { responseMode: 'complete' }, async context => {
      context.progress({ status: 'completed', result: { round: 7, pending: 'collectionCapability' } })
      late = context.progress
      return { result: { stable: true } }
    })
  assert.equal(store.inspect(run.run_id).nodes.root.result.round, 7)
  late.call({ nodeId: 'root' }, { status: 'completed', result: { round: 8, pending: 'late' } })
  const after = store.inspect(run.run_id)
  assert.equal(after.nodes.root.result.round, 7, '终态后写入必须被丢弃')
  assert.equal(store.read(run.run_id).late_progress, 1)
})

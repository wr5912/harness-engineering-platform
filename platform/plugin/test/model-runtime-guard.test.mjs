import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = mkdtempSync(join(tmpdir(), 'model-runtime-guard-'))
await build({ entryPoints: [new URL('../src/models/runtime.ts', import.meta.url).pathname], outfile: join(bundled, 'runtime.mjs'),
  bundle: true, platform: 'node', format: 'esm' })
const { apply } = await import(`file://${join(bundled, 'runtime.mjs')}`)
test.after(() => rmSync(bundled, { recursive: true, force: true }))

test('同一业务实例的目标与评测 Session 均只可调用启动时业务目录模型', async () => {
  const listeners = new Map()
  apply({ on: (event, listener) => listeners.set(event, listener) }, {
    agentId: 'example-agent', allowed: [{ provider: 'provider-a', model: 'model-one' }],
  })
  const stream = listeners.get('llm/stream')
  assert.equal(typeof stream, 'function')
  const emitted = []
  const next = async function* () { emitted.push('dispatched'); yield 'ok' }
  for (const sessionId of ['target-session', 'evaluation-judge-session']) {
    await assert.rejects(async () => {
      for await (const _chunk of stream({ provider: 'provider-a', model: 'model-two', sessionId }, next)) {}
    }, /当前不可使用模型 provider-a\/model-two/)
  }
  assert.deepEqual(emitted, [])
  const received = []
  for await (const chunk of stream({ provider: 'provider-a', model: 'model-one', sessionId: 'evaluation-judge-session' }, next)) received.push(chunk)
  assert.deepEqual(received, ['ok'])
  assert.deepEqual(emitted, ['dispatched'])
})

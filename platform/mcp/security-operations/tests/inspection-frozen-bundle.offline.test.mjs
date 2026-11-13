import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.env.HARNESS_ASSET_ROOT, 'mcp')
for (const [id, call] of [['inspection-routine', 'routine'], ['inspection-deep', 'deep']]) {
  test(`${id} 固定bundle的summary传入真实执行完成`, () => {
    const catalog = JSON.parse(readFileSync(join(root, 'compositions', id, 'composition.json'), 'utf8'))
    const digest = catalog.published.flowDigest
    const bundle = JSON.parse(readFileSync(join(root, 'compositions', id, 'versions', digest, 'bundle.json'), 'utf8'))
    assert.match(bundle.typescript, new RegExp(`summary\\("${call}", \\[\\], context, "completed"\\)`))
    assert.doesNotMatch(bundle.typescript, /execution_status: "unverified"/)
  })
}

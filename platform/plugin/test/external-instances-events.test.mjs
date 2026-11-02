import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createPlatformEvents } from '../src/realtime/index.ts'

test('同目录的MCP、接入登记及策略都通知；首次身份目录创建只触发元数据回读', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-events-'))
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config/mcp-compositions.json'), '{}')
  const events = createPlatformEvents(root, { docker: false, minIntervalMs: 100 })
  const seen = []
  events.subscribe(event => seen.push(event)); events.start()
  t.after(() => { events.dispose(); rmSync(root, { recursive: true, force: true }) })
  async function changed(action) {
    seen.length = 0; action()
    for (let n = 0; n < 120; n++) { if (seen.length) return seen[0]; await delay(25) }
    assert.fail('事实源变更没有发出失效通知')
  }
  for (const name of ['external-instances.json', 'business-access.json', 'mcp-compositions.json']) {
    const event = await changed(() => {
      writeFileSync(join(root, `config/${name}.tmp`), '{}')
      renameSync(join(root, `config/${name}.tmp`), join(root, 'config', name))
    })
    assert.ok(event.domains.includes('instances'))
    assert.equal(JSON.stringify(event).includes('secret'), false)
  }
  const event = await changed(() => {
    mkdirSync(join(root, '.local/agent-access'), { recursive: true })
    writeFileSync(join(root, '.local/agent-access/state.json'), JSON.stringify({ secret: 'must-not-be-broadcast' }))
  })
  assert.ok(event.domains.includes('instances'))
  assert.equal(JSON.stringify(event).includes('must-not-be-broadcast'), false)
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyDeployment } from '../verify.mts'

test('无关 HTTP 200 不通过在线工作区核验，也不向它发送登录凭据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-verify-'))
  let requests = 0
  const server = createServer((req, res) => { requests++; res.end('ok') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const report = await verifyDeployment({ prefix: join(root, 'program'), dataRoot: join(root, 'data'), url: `http://127.0.0.1:${server.address().port}/hep/` })
    assert.equal(report.onlineVerified, false)
    assert.equal(report.ok, false)
    assert.equal(report.checks.find(check => check.id === 'online-workspace').status, 'mismatch')
    assert.equal(requests, 0)
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
})

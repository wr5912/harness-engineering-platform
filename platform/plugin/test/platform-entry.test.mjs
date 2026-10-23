import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { platformEntryUrl, platformGroupUrl } from '../src/business-control/group-link.ts'

test('空白工作区由实际启动入口初始化，保持网关关闭', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-empty-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(platformEntryUrl(root, { fallback: 'http://127.0.0.1:18120/' }), 'http://127.0.0.1:18120/')
  assert.equal(platformGroupUrl(root, 'test'), 'http://127.0.0.1:18120/mcp/groups/test/v2')
  assert.equal(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).enabled, false)
})

test('平台入口保留域名、反代和子路径，所有分组由同一入口派生', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  for (const [base, configured] of [['/hep/', 'http://172.16.138.228:18120/hep/'], ['/tools/hep/', 'https://proxy.example/tools/hep/']]) {
    writeFileSync(join(root, 'config/sites.json'), JSON.stringify({ platform: base }))
    writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ gateway: { managementUrl: configured } }))
    assert.equal(platformEntryUrl(root, { publicUrl: configured, fallback: `http://0.0.0.0:18120${base}` }), configured)
    assert.equal(platformGroupUrl(root, 'test'), `${configured}mcp/groups/test/v2`)
    assert.throws(() => platformEntryUrl(root, { publicUrl: 'https://other.example/', fallback: configured }), /不一致/)
  }
  writeFileSync(join(root, 'config/sites.json'), JSON.stringify({ platform: '/hep/' }))
  for (const origin of ['http://127.0.0.1:18120', 'http://172.16.138.229:18120']) {
    writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ gateway: {} }))
    assert.equal(platformEntryUrl(root, { fallback: `${origin}/hep/` }), `${origin}/hep/`)
    assert.equal(platformGroupUrl(root, 'test'), `${origin}/hep/mcp/groups/test/v2`)
    assert.equal(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).gateway.managementUrl, `${origin}/hep/`)
  }
})

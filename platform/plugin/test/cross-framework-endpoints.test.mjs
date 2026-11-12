import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSampleEndpoints } from '../../cross-framework/endpoints.mts'

test('跨框架样本读取服务生成的地址配置，不假定 Docker 网桥或端口', t => {
  const root = mkdtempSync(join(tmpdir(), 'sample-endpoints-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.local'))
  const file = join(root, '.local/endpoints.json')
  assert.throws(() => readSampleEndpoints(root), /先启动隔离验收服务/)
  const configured = { origin: 'https://platform.example:4321', fixture: 'http://fixture.example:5678', model: 'http://model.example:6789/v1' }
  writeFileSync(file, JSON.stringify({ ...configured, origin: configured.origin + '/', pid: 123 }))
  assert.deepEqual(readSampleEndpoints(root), configured)
  for (const invalid of [null, {}, { ...configured, origin: 'file:///tmp/service' }, { ...configured, fixture: 'http://user:secret@fixture.example' }, { ...configured, model: 'http://model.example/v1?key=secret' }]) {
    writeFileSync(file, JSON.stringify(invalid))
    assert.throws(() => readSampleEndpoints(root), error => /地址配置无效/.test(error.message) && !error.message.includes('secret'))
  }
})

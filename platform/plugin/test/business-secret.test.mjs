import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ensureBusinessSecret, resolveBusinessSecretFile } from '../src/business-control/secret-file.ts'

test('业务共享密钥按当前数据根解析，缺失时初始化且不覆盖已有文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'business-secret-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relative = '.local/business-control-mock/gateway-secret.bin'
  const expected = resolve(root, relative)
  assert.equal(resolveBusinessSecretFile(root, relative), expected)
  assert.equal(resolveBusinessSecretFile(root, '/var/lib/business-secret'), '/var/lib/business-secret')
  assert.equal(ensureBusinessSecret(root, relative), expected)
  assert.equal(statSync(expected).size, 48)
  assert.equal(statSync(expected).mode & 0o777, 0o600)
  const saved = readFileSync(expected)
  ensureBusinessSecret(root, relative)
  assert.deepEqual(readFileSync(expected), saved)
  writeFileSync(expected, 'a'.repeat(32))
  assert.equal(ensureBusinessSecret(root, relative), expected)
  assert.equal(readFileSync(expected, 'utf8'), 'a'.repeat(32))
})

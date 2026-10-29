import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import test from 'node:test'
import {build} from 'esbuild'

const output = mkdtempSync(join(tmpdir(), 'provider-protocol-test-'))
await build({entryPoints: [new URL('../src/business-control/protocol-documents.ts', import.meta.url).pathname], outfile: join(output, 'protocols.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'})
const {readProviderProtocol} = await import(`file://${join(output, 'protocols.mjs')}`)
test.after(() => rmSync(output, {recursive: true, force: true}))
const root = resolve(new URL('../../../', import.meta.url).pathname)
for (const kind of ['risk-assessment', 'access-control']) test(`${kind} 的查看与下载读取唯一规范且摘要对应完整UTF-8内容`, () => {
  const value = readProviderProtocol(kind, root)
  assert.equal(value.kind, kind)
  assert.equal(value.version, '1.0')
  assert.equal(value.content, readFileSync(join(root, 'docs/platform-design', value.filename), 'utf8'))
  assert.equal(value.sha256, createHash('sha256').update(value.content).digest('hex'))
  assert.ok(!value.filename.includes('/'))
  assert.match(value.content, /第三方/)
  assert.match(value.content, /兜底/)
  for (const [, example] of value.content.matchAll(/```json\n([\s\S]*?)\n```/g)) assert.doesNotThrow(() => JSON.parse(example))
})
test('规范只接受固定种类，不以用户输入拼接程序或数据文件路径', () => {
  for (const kind of ['../config/business-access.json', 'authentication', '__proto__']) assert.throws(() => readProviderProtocol(kind, root), /请选择/)
})

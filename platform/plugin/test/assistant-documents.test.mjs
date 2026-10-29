import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createDocumentReader } from '../src/assistant/documents.ts'

function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-documents-'))
  const ctx = new Context()
  new SessionStore(ctx)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  const agent = id => ({ id, session: ctx.sessions.create(id, { meta: { cwd: root } }) })
  const owner = agent('owner'), other = agent('other')
  const ref = { attachmentId: 'native-content-digest', name: '附件.txt', bytes: 12 }
  owner.session.append('user/message', { id: 'upload', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }, { surfaceOp: 'append' })
  const reads = []
  const services = {
    attachments: {
      fileHostPath: () => '/native/attachments/knowledge',
      async *readFileStream(ref, signal) { signal.throwIfAborted(); reads.push(ref); yield Buffer.from('附件正文'); },
    },
    fs: { processPathFromHostPath: () => '/execution/attachments/knowledge' },
  }
  const signal = new AbortController().signal
  return { root, owner, other, services, reads, signal, read: createDocumentReader(root, services) }
}

test('当前真实 Session 文件块可读，跨 Session 和任意宿主路径不能读取', async t => {
  const f = fixture(t)
  const result = await f.read({ path: '/execution/attachments/knowledge' }, f.owner, f.signal)
  assert.equal(result.source_kind, 'attachment')
  assert.equal(result.filename, '附件.txt')
  assert.equal(result.blocks[0].text, '附件正文')
  assert.equal(f.reads.length, 1)
  await assert.rejects(f.read({ path: '/execution/attachments/knowledge' }, f.other, f.signal), /路径/)
  await assert.rejects(f.read({ path: '/etc/passwd' }, f.owner, f.signal), /路径/)
  assert.equal(f.reads.length, 1)
  assert.deepEqual(readdirSync(f.root), [])
})

test('长段连续分页重组无丢字，摘要和来源变更拒绝续读', async t => {
  const text = '知识🙂条目'.repeat(420)
  const f = fixture(t, { 'long.md': text, 'copy.md': text })
  const before = readdirSync(f.root)
  let result = await f.read({ path: 'long.md', limit: 512 }, f.owner, f.signal)
  const first = result
  let collected = ''
  let offset = 0, reads = 0
  for (;;) {
    for (const block of result.blocks) {
      assert.equal(block.start_offset, offset)
      collected += block.text
      offset = block.end_offset
      assert.doesNotMatch(block.text, /[\uD800-\uDBFF]$/)
    }
    reads++
    if (!result.has_more) break
    assert.ok(reads < 20)
    result = await f.read({ path: 'long.md', cursor: result.next_cursor, source_sha256: result.source_sha256, limit: 512 }, f.owner, f.signal)
  }
  assert.equal(collected, text)
  assert.ok(reads > 1)
  assert.deepEqual(readdirSync(f.root), before)
  await assert.rejects(f.read({ path: 'copy.md', cursor: first.next_cursor }, f.owner, f.signal), /游标/)
  writeFileSync(join(f.root, 'long.md'), '已经修订')
  await assert.rejects(f.read({ path: 'long.md', cursor: first.next_cursor }, f.owner, f.signal), /游标/)
  await assert.rejects(f.read({ path: 'long.md', source_sha256: first.source_sha256 }, f.owner, f.signal), /文档已变化/)
})

test('工作区文档支持相对和绝对路径，拒绝逃逸、符号链接和凭据路径', async t => {
  const f = fixture(t, { 'guide.txt': '业务规范' })
  assert.equal((await f.read({ path: join(f.root, 'guide.txt') }, f.owner, f.signal)).blocks[0].text, '业务规范')
  symlinkSync(join(f.root, 'guide.txt'), join(f.root, 'alias.txt'))
  mkdirSync(join(f.root, '.local'))
  writeFileSync(join(f.root, '.local', 'secret.txt'), '凭据')
  for (const path of ['../other.txt', 'alias.txt', '.local/secret.txt', 'secret.llm-api-key']) {
    await assert.rejects(f.read({ path }, f.owner, f.signal))
  }
  await assert.rejects(f.read({ path: 'guide.txt', session_id: 'other' }, f.owner, f.signal), /Unrecognized key/)
})

test('附件流必须完整通过校验，取消和未映射路径不会产生部分正文', async t => {
  const f = fixture(t)
  f.services.attachments.readFileStream = async function* () { yield Buffer.from('看似正常'); throw new Error('附件摘要不匹配') }
  await assert.rejects(f.read({ path: '/execution/attachments/knowledge' }, f.owner, f.signal), /附件摘要不匹配/)
  f.services.fs.processPathFromHostPath = () => undefined
  await assert.rejects(f.read({ path: '/execution/attachments/knowledge' }, f.owner, f.signal), /路径/)
  const controller = new AbortController()
  controller.abort(new Error('用户取消'))
  await assert.rejects(f.read({ path: 'anything.txt' }, f.owner, controller.signal), /用户取消/)
})

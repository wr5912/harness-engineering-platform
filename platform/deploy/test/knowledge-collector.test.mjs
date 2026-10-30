import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectKnowledge, inspectKnowledge } from '../knowledge/index.mts'
import { collectPlatformKnowledge, managementKnowledgeRoots } from '../knowledge/platform.mts'
import { createOfflineKnowledgeProvider } from '../../plugin/src/standalone-knowledge/index.ts'
import { pdfBytes, docxBytes } from '../../plugin/test/document-fixtures.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harness-knowledge-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value) }
  return { root, write, outDir: join(root, 'knowledge/offline'), roots: [{ root, label: 'business' }] }
}
async function server(t) {
  let requests = []
  const pdf = pdfBytes(['离线甲型规程']), docx = docxBytes(['离线乙型规程'])
  const http = createServer(async (req, res) => {
    requests.push(req.url)
    if (req.url === '/slow.md') { await new Promise(r => setTimeout(r, 400)); if (res.destroyed) return }
    const entries = {
      '/guide.md': ['text/markdown', '# 规程\n\n保持原文与版本。\n'],
      '/page.html': ['text/html', '<!doctype html><title>知识</title><p>离线规则</p><script>globalThis.executed=true</script>'],
      '/manual.pdf': ['application/pdf', pdf],
      '/manual.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx],
      '/bad.md': ['application/octet-stream', Buffer.from([0, 1, 2])],
      '/slow.md': ['text/plain', '不应完成'],
    }
    const entry = entries[req.url]
    if (!entry) { res.writeHead(404); res.end('secret=not-for-log'); return }
    res.writeHead(200, { 'content-type': entry[0] }); res.end(entry[1])
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => { http.closeAllConnections(); http.close() })
  const base = `http://127.0.0.1:${http.address().port}`
  const fetcher = async (url, signal) => { const response = await fetch(url, { signal }); return { url: response.url, statusCode: response.status, contentType: response.headers.get('content-type') || '', bytes: new Uint8Array(await response.arrayBuffer()) } }
  return { base, fetcher, requests }
}

test('在线包保留本地来源且不抓取互联网，明确服务与模糊引用不冒充知识', async t => {
  const f = fixture(t)
  f.write('SKILL.md', '[参考](https://example.test/docs/guide)\n[服务](https://api.example.test/v1/chat)\nhttps://example.test/unknown\n[本地](references/local.md)')
  f.write('references/local.md', '既有本地知识\n')
  let calls = 0
  const result = await collectKnowledge({ ...f, mode: 'online', fetcher: async () => { calls++; throw new Error('不应联网') } })
  assert.equal(calls, 0)
  assert.equal(existsSync(f.outDir), false)
  assert.equal(readFileSync(join(f.root, 'references/local.md'), 'utf8'), '既有本地知识\n')
  assert.deepEqual(result.references.map(ref => ref.kind), ['document', 'service', 'ambiguous'])
  assert.equal(result.missing.length, 0)
  assert.ok(result.warnings.some(item => item.code === 'static_coverage'))
})

test('离线归档实际HTTP正文、PDF和DOCX，原件摘要、页段定位及HTML均保留', async t => {
  const f = fixture(t), s = await server(t)
  const skill = ['guide.md', 'page.html', 'manual.pdf', 'manual.docx'].map(path => `[参考](${s.base}/${path})`).join('\n')
  f.write('SKILL.md', skill)
  const result = await collectKnowledge({ ...f, mode: 'offline', fetcher: s.fetcher })
  assert.equal(result.missing.length, 0)
  assert.equal(result.sources.length, 4)
  assert.equal(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), skill)
  for (const source of result.sources) assert.equal(createHash('sha256').update(readFileSync(join(f.outDir, source.path))).digest('hex'), source.sha256)
  const pdf = result.sources.find(source => source.format === 'pdf')
  const docx = result.sources.find(source => source.format === 'docx')
  assert.match(readFileSync(join(f.outDir, pdf.readablePath), 'utf8'), /page-1[\s\S]*离线甲型规程/)
  assert.match(readFileSync(join(f.outDir, docx.readablePath), 'utf8'), /paragraph-1[\s\S]*离线乙型规程/)
  const provider = createOfflineKnowledgeProvider(join(f.outDir, 'index.json'))
  const html = await provider.fetch({ url: s.base + '/page.html#fragment' })
  assert.equal(html.body.kind, 'html')
  assert.match(html.body.content, /<script>globalThis.executed=true<\/script>/)
  assert.equal(globalThis.executed, undefined)
  assert.match((await provider.fetch({ url: s.base + '/manual.pdf' })).body.content, /离线甲型规程/)
})

test('知识缓存按原URL与原件摘要复用；损坏缓存不能伪造成功', async t => {
  const f = fixture(t), s = await server(t)
  f.write('SKILL.md', `[参考](${s.base}/guide.md)`)
  await collectKnowledge({ ...f, mode: 'offline', fetcher: s.fetcher })
  const again = await collectKnowledge({ ...f, mode: 'offline', fetcher: async () => { throw new Error('缓存不应联网') } })
  assert.equal(again.sources.length, 1)
  assert.equal(again.missing.length, 0)
  writeFileSync(join(f.outDir, again.sources[0].path), '被修改')
  const damaged = await collectKnowledge({ ...f, mode: 'offline', fetcher: async () => { throw new Error('secret=hidden') } })
  assert.equal(damaged.sources.length, 0)
  assert.equal(damaged.missing.length, 1)
  assert.doesNotMatch(JSON.stringify(damaged), /secret=hidden/)
})

test('错误状态、错误类型和截断均记为必需资料缺失，凭据URL不进入结果', async t => {
  const f = fixture(t), s = await server(t)
  f.write('SKILL.md', `[资料](${s.base}/missing.md)\n[资料](${s.base}/bad.md)\n[资料](https://example.test/docs/guide?token=do-not-copy)\n[丢失](reference/no.md)`)
  const result = await collectKnowledge({ ...f, mode: 'offline', fetcher: s.fetcher })
  assert.equal(result.sources.length, 0)
  assert.equal(result.missing.filter(item => item.required).length, 4)
  assert.ok(result.missing.some(item => item.code === 'credential_url'))
  assert.doesNotMatch(JSON.stringify(result), /do-not-copy|not-for-log/)
  const truncated = await collectKnowledge({ ...f, mode: 'offline', fetcher: async url => ({ url, statusCode: 200, contentType: 'text/plain', bytes: Buffer.from('局部内容'), truncated: true }) })
  assert.equal(truncated.sources.length, 0)
})

test('取消下载立即终止，不发布完整索引；离线provider不回退网络且校验摘要', async t => {
  const f = fixture(t), s = await server(t)
  f.write('SKILL.md', `[参考](${s.base}/slow.md)`)
  const controller = new AbortController()
  const pending = collectKnowledge({ ...f, mode: 'offline', fetcher: s.fetcher, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('用户取消')), 30)
  await assert.rejects(pending, /用户取消/)
  assert.equal(existsSync(join(f.outDir, 'index.json')), false)
  f.write('SKILL.md', `[参考](${s.base}/guide.md)`)
  const result = await collectKnowledge({ ...f, mode: 'offline', fetcher: s.fetcher })
  const provider = createOfflineKnowledgeProvider(join(f.outDir, 'index.json'))
  const before = s.requests.length
  await assert.rejects(provider.fetch({ url: s.base + '/not-included' }), /未包含/)
  assert.equal(s.requests.length, before)
  writeFileSync(join(f.outDir, result.sources[0].path), '已篡改')
  await assert.rejects(provider.fetch({ url: s.base + '/guide.md' }), /摘要不符/)
})

test('完整平台只检查管理入口与声明扩展，业务Skill不混入管理知识清单', t => {
  const f = fixture(t)
  f.write('AGENTS.md', '管理身份 [研究资料](docs/research.md)')
  f.write('docs/research.md', '[参考](https://example.test/docs/nested)')
  f.write('.agents/skills/manage/SKILL.md', '[参考](https://example.test/docs/management)')
  f.write('extensions/declared/skills/one/SKILL.md', '[参考](https://example.test/docs/extension)')
  f.write('evolution/experiments/EXP-business-001/candidate/dsh/workspace/.agents/skills/business/SKILL.md', '[参考](https://example.test/docs/business)')
  f.write('workspace.json', JSON.stringify({ extensions: [{ path: 'extensions/declared' }] }))
  const roots = managementKnowledgeRoots(f.root)
  const result = inspectKnowledge({ roots, mode: 'offline' })
  assert.deepEqual(result.references.map(ref => ref.url).sort(), ['https://example.test/docs/extension', 'https://example.test/docs/management', 'https://example.test/docs/nested'])
})

test('用户可用冻结版本内的本地文档补齐指定URL，不能读取版本外文件', async t => {
  const f = fixture(t)
  f.write('SKILL.md', '[参考](https://example.test/docs/required)')
  f.write('knowledge/material.md', '# 离线提供的资料\n\n保留指定版本。\n')
  let calls = 0
  const result = await collectKnowledge({ ...f, mode: 'offline', localSources: [{ url: 'https://example.test/docs/required', path: join(f.root, 'knowledge/material.md') }], fetcher: async () => { calls++; throw new Error('不应联网') } })
  assert.equal(calls, 0)
  assert.equal(result.missing.length, 0)
  assert.equal(result.sources[0].providedFrom, 'business/knowledge/material.md')
  const provider = createOfflineKnowledgeProvider(join(f.outDir, 'index.json'))
  assert.match((await provider.fetch({ url: 'https://example.test/docs/required' })).body.content, /保留指定版本/)
  const rejected = await collectKnowledge({ ...f, mode: 'offline', localSources: [{ url: 'https://example.test/docs/required', path: '/etc/passwd' }], fetcher: async () => { throw new Error('不应回退联网') } })
  assert.equal(rejected.missing.length, 1)
  assert.equal(rejected.sources.length, 0)
})


test('完整平台同步打包接入使用冻结管理快照，并清理暂存输入', t => {
  const f = fixture(t)
  f.write('data/AGENTS.md', '管理助手使用本地资料。')
  f.write('data/.agents/skills/manage/SKILL.md', '---\nname: manage\ndescription: 本地技能\n---\n[参考](reference.md)')
  f.write('data/.agents/skills/manage/reference.md', '已经保存在本地的知识。')
  const metadata = collectPlatformKnowledge(f.root)
  assert.equal(metadata.path, 'data/knowledge/offline/index.json')
  const index = JSON.parse(readFileSync(join(f.root, metadata.path), 'utf8'))
  assert.equal(index.mode, 'offline')
  assert.equal(index.missing.length, 0)
  assert.equal(existsSync(join(f.root, '.knowledge-input.json')), false)
  assert.equal(existsSync(join(f.root, '.knowledge-result.json')), false)
})

test('完整平台复用资源目录中按摘要核对的知识；缓存正文不扩充依赖，损坏仍拒绝出包', async t => {
  const f = fixture(t), s = await server(t), data = join(f.root, 'data'), cache = join(f.root, 'prepared/knowledge')
  f.write('data/AGENTS.md', `[参考](${s.base}/guide.md)`)
  const prepared = await collectKnowledge({ roots: [{ root: data, label: 'management' }], mode: 'offline', outDir: cache, fetcher: s.fetcher })
  writeFileSync(join(cache, 'unselected.md'), '[参考](https://docs.invalid/unselected.md)')
  const before = s.requests.length
  const metadata = collectPlatformKnowledge(f.root, cache)
  const index = JSON.parse(readFileSync(join(f.root, metadata.path), 'utf8'))
  assert.equal(index.sources.length, 1)
  assert.equal(index.missing.length, 0)
  assert.deepEqual(index.references.map(ref => ref.url), [s.base + '/guide.md'])
  assert.equal(s.requests.length, before, '已核验的缓存不重新联网')
  writeFileSync(join(cache, prepared.sources[0].path), '损坏的缓存')
  rmSync(join(data, 'knowledge'), { recursive: true, force: true })
  assert.throws(() => collectPlatformKnowledge(f.root, cache), /离线知识缺少/)
  const rejected = JSON.parse(readFileSync(join(data, 'knowledge/offline/index.json'), 'utf8'))
  assert.equal(rejected.sources.length, 0)
  assert.ok(rejected.missing.some(item => item.required))
  assert.equal(existsSync(join(f.root, '.knowledge-input.json')), false)
  assert.equal(existsSync(join(f.root, '.knowledge-result.json')), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import * as OfflineKnowledge from '../src/standalone-knowledge/index.ts'
import { generateProfile } from '../src/standalone/bootstrap.ts'
import { collectKnowledge } from '../../deploy/knowledge/index.mts'
import { managementKnowledgeRoots } from '../../deploy/knowledge/platform.mts'

// 与独立 Runtime 的其他原生接缝验收共用锁定安装来源，不替换 Web 或工具注册表。
const anchor = '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json', sdk = createRequire(anchor)
const lock = JSON.parse(await readFile(new URL('../../../runtime/adapters/dsh-container/source.lock.json', import.meta.url), 'utf8'))
assert.equal(JSON.parse(await readFile(anchor, 'utf8')).version, lock.cli_version, '原生 SDK 的 CLI 版本须与 Runtime 来源锁一致')
const [{ Context }, { default: WebRuntime }, { default: ToolRuntime }, { default: SystemPrompt }, HttpFetch, ToolWeb] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-web-fetch-http', '@deepseek-ai/dsh-tool-web',
].map(name => import(pathToFileURL(sdk.resolve(name)).href)))
const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ expression: value }) }))
const rows = entries => entries.flatMap(entry => [entry, ...rows(entry.insert ?? [])])
const base = load(await readFile(join(dirname(sdk.resolve('@deepseek-ai/dsh-base/package.json')), 'cordis.patch.yml'), 'utf8'), { schema })
const baseWebConfig = rows(base).find(entry => entry.id === 'web').config

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'standalone-native-knowledge-')), data = join(directory, 'data'), candidate = join(data, 'evolution/experiments/EXP-one-001/candidate/dsh')
  t.after(() => rm(directory, { recursive: true, force: true }))
  let requests = 0
  const pages = {
    '/docs/business.html': '<!doctype html><html><title>业务资料</title><h1>业务操作规则</h1><p>这是当前业务智能体的冻结知识。</p><script>globalThis.__offlineKnowledgeScriptExecuted=true</script></html>',
    '/docs/management.html': '<!doctype html><h1>管理资料</h1><p>这是平台管理助手的知识。</p>',
    '/docs/extension.html': '<!doctype html><h1>管理扩展资料</h1><p>仅属于声明的管理技能。</p>',
  }
  const server = createServer((request, response) => { requests++; response.writeHead(pages[request.url] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); response.end(pages[request.url] ?? '未选择的资料不应采集') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let stopped = false
  async function stop() { if (!stopped) { stopped = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
  t.after(stop)
  const origin = `http://127.0.0.1:${server.address().port}`
  async function write(path, text) { const file = join(data, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text) }
  const managementSkill = `[管理资料](${origin}/docs/management.html)\n`, businessSkill = `[业务资料](${origin}/docs/business.html)\n`
  await write('AGENTS.md', '# 平台管理身份\n')
  await write('.agents/skills/manage/SKILL.md', managementSkill)
  await write('workspace.json', JSON.stringify({ extensions: [{ path: 'extensions/declared' }] }))
  await write('extensions/declared/skills/helper/SKILL.md', `[管理扩展](${origin}/docs/extension.html)\n`)
  await write('extensions/unselected/skills/helper/SKILL.md', `[不应采集](${origin}/docs/unselected.html)\n`)
  await write('evolution/experiments/EXP-one-001/candidate/dsh/workspace/.agents/skills/business/SKILL.md', businessSkill)
  await write('evolution/experiments/EXP-other-001/candidate/dsh/workspace/.agents/skills/other/SKILL.md', `[其他业务](${origin}/docs/other.html)\n`)
  await mkdir(join(candidate, 'presets'), { recursive: true }); await mkdir(join(candidate, 'managed'), { recursive: true })
  const fetcher = async (url, signal) => { const response = await fetch(url, { signal }); return { url: response.url, statusCode: response.status, contentType: response.headers.get('content-type'), bytes: new Uint8Array(await response.arrayBuffer()) } }
  const businessOut = join(candidate, 'workspace/knowledge/offline'), managementOut = join(data, 'knowledge/offline')
  const business = await collectKnowledge({ roots: ['workspace', 'presets', 'managed'].map(name => ({ root: join(candidate, name), label: name })), mode: 'offline', outDir: businessOut, fetcher })
  const management = await collectKnowledge({ roots: managementKnowledgeRoots(data), mode: 'offline', outDir: managementOut, fetcher })
  assert.deepEqual(business.missing, []); assert.deepEqual(management.missing, [])
  assert.equal(requests, 3)
  await stop()
  return { directory, data, candidate, origin, pages, business, management, businessOut, managementOut, managementSkill, businessSkill, requests: () => requests }
}

async function mountNative(t, indexPath, config) {
  const previous = process.env.DSH_WEB_FETCH_PROVIDER
  let ctx
  try {
    process.env.DSH_WEB_FETCH_PROVIDER = OfflineKnowledge.OFFLINE_KNOWLEDGE_PROVIDER_ID
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(WebRuntime, config)
  } finally { if (previous === undefined) delete process.env.DSH_WEB_FETCH_PROVIDER; else process.env.DSH_WEB_FETCH_PROVIDER = previous }
  t.after(() => ctx.fiber.dispose())
  let networkAttempts = 0
  const networkProvider = new HttpFetch.HttpFetchProvider({ maxResponseBytes: 1024 * 1024, maxBodyChars: 100_000, timeoutMs: 500, maxRedirects: 2, userAgent: 'harness-native-offline-test' }, async () => {
    networkAttempts++
    throw new Error('离线验收不应进入 HTTP 网络边界')
  })
  ctx.web.registerFetchProvider(networkProvider)
  const provider = await ctx.plugin(OfflineKnowledge, { indexPath })
  await ctx.plugin(ToolWeb, { search: false })
  let calls = 0
  return { ctx, provider, networkAttempts: () => networkAttempts, call: url => ctx.tools.execute({ name: 'web_fetch', arguments: { url }, callId: `offline-native-${++calls}`, signal: new AbortController().signal }) }
}

async function generatedWebConfig(fixture, offlineKnowledge) {
  const root = join(fixture.directory, 'bundle'), home = join(fixture.directory, 'home')
  await mkdir(join(root, 'assets/managed'), { recursive: true })
  // 模拟既有业务配置；离线投影必须在其后明确覆盖原生 base 默认的 http。
  await writeFile(join(root, 'assets/managed/one.patch.yml'), '- id: web\n  config:\n    fetchProvider: http\n')
  generateProfile({ agentId: 'one', experimentId: 'EXP-one-001', presetId: 'one', profilePatch: 'one.patch.yml', modelPatch: [], mcp: { servers: [], groups: [], sharedToken: 'a'.repeat(64) }, ...(offlineKnowledge ? { offlineKnowledge: { indexPath: join(fixture.businessOut, 'index.json') } } : {}) }, home, root)
  const patch = load(await readFile(join(home, 'standalone/runtime.patch.yml'), 'utf8'), { schema })
  return Object.assign({}, baseWebConfig, ...rows(patch).filter(entry => entry.id === 'web').map(entry => entry.config))
}

test('真实原生 Web 与 web_fetch 使用生成的离线选择，来源关闭后读HTML，未知URL不回落公网', async t => {
  const f = await fixture(t), config = await generatedWebConfig(f, true)
  assert.equal(baseWebConfig.fetchProvider, 'http')
  assert.equal(config.fetchProvider, OfflineKnowledge.OFFLINE_KNOWLEDGE_PROVIDER_ID)
  const native = await mountNative(t, join(f.businessOut, 'index.json'), config)
  const url = f.origin + '/docs/business.html#frozen'
  const raw = await native.ctx.web.fetch({ url })
  assert.equal(raw.body.kind, 'html'); assert.equal(raw.body.content, f.pages['/docs/business.html'])
  const result = await native.call(url)
  assert.equal(result.isError, false)
  assert.match(result.content.map(block => block.text ?? '').join('\n'), /业务操作规则[\s\S]*冻结知识/)
  assert.equal(globalThis.__offlineKnowledgeScriptExecuted, undefined)
  const missing = await native.call('https://www.w3.org/TR/not-in-offline-fixture')
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /未包含在离线知识包/)
  await assert.rejects(native.ctx.web.fetch({ url: f.origin + '/docs/not-included.html' }), /未包含在离线知识包/)
  assert.equal(native.networkAttempts(), 0); assert.equal(f.requests(), 3)
})

test('管理助手与选定业务 Skill 独立归档并独立接入原生 Web，不串入其他角色或智能体', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.business.sources.map(source => source.url), [f.origin + '/docs/business.html'])
  assert.deepEqual(f.management.sources.map(source => source.url).sort(), [f.origin + '/docs/management.html', f.origin + '/docs/extension.html'].sort())
  assert.ok(f.business.references.every(reference => reference.source.startsWith('workspace/')))
  assert.ok(f.management.references.every(reference => reference.source.startsWith('management/')))
  const config = { fetchProvider: OfflineKnowledge.OFFLINE_KNOWLEDGE_PROVIDER_ID }
  const business = await mountNative(t, join(f.businessOut, 'index.json'), config), management = await mountNative(t, join(f.managementOut, 'index.json'), config)
  assert.match((await business.ctx.web.fetch({ url: f.origin + '/docs/business.html' })).body.content, /当前业务智能体/)
  assert.match((await management.ctx.web.fetch({ url: f.origin + '/docs/management.html' })).body.content, /平台管理助手/)
  await assert.rejects(business.ctx.web.fetch({ url: f.origin + '/docs/management.html' }), /未包含/)
  await assert.rejects(management.ctx.web.fetch({ url: f.origin + '/docs/business.html' }), /未包含/)
  await assert.rejects(business.ctx.web.fetch({ url: f.origin + '/docs/other.html' }), /未包含/)
  assert.equal(business.networkAttempts() + management.networkAttempts(), 0)
  assert.equal(await readFile(join(f.candidate, 'workspace/.agents/skills/business/SKILL.md'), 'utf8'), f.businessSkill)
  assert.equal(await readFile(join(f.data, '.agents/skills/manage/SKILL.md'), 'utf8'), f.managementSkill)
})

test('原生 provider 生命周期与取消不触发公网兜底；在线投影保持原生 http 配置', async t => {
  const f = await fixture(t), native = await mountNative(t, join(f.businessOut, 'index.json'), { fetchProvider: OfflineKnowledge.OFFLINE_KNOWLEDGE_PROVIDER_ID })
  await assert.rejects(native.ctx.web.fetch({ url: f.origin + '/docs/business.html' }, AbortSignal.abort()), { name: 'AbortError' })
  await native.provider.dispose()
  await assert.rejects(native.ctx.web.fetch({ url: f.origin + '/docs/business.html' }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  assert.equal(native.networkAttempts(), 0)
  const online = await generatedWebConfig(f, false)
  assert.equal(online.fetchProvider, 'http')
})

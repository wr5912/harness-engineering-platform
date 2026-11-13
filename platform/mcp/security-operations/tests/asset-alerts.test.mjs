import { assetAlertsFlow } from '../src/asset-alerts.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'

async function loadMcpModule(native = false) {
  const outdir = await mkdtemp(join(tmpdir(), 'mcp-module-'))
  const outfile = join(outdir, 'index.mjs')
  await symlink(join(process.cwd(), 'node_modules'), join(outdir, 'node_modules'), 'dir')
  await build({
    entryPoints: [native ? 'src/mcp/native.ts' : 'src/mcp/index.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: native ? [(await import(new URL('file://' + process.cwd() + '/build.mjs'))).managerSources] : [],
  })
  return import(outfile)
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('SOC 双服务编排在独立与原生适配器中正确编码、校验业务结果并保留已发布版本', async () => {
  for (const native of [false, true]) {
    const module = await loadMcpModule(native)
    const temp = await mkdtemp(join(tmpdir(), 'soc-composition-'))
    const calls = []
    let baseUrl, alertsMethod = 'get'
    const spec = kind => ({ openapi: '3.0.0', info: { title: kind, version: '1' }, servers: [{ url: baseUrl }], paths: kind === 'master' ? {
      '/soc/asset/{assetId}': { get: { operationId: 'get_soc_asset_by_asset_id', parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'integer' } }] } },
    } : {
      '/detect/alert/list': { [alertsMethod]: { operationId: 'list_detect_alert', parameters: [{ name: 'req', in: 'query', required: true, schema: { type: 'object', properties: { assetId: { type: 'string' }, pageNum: { type: 'integer' }, pageSize: { type: 'integer' }, windowSeconds: { type: 'integer' } } } }] } },
    } })
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.local')
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method })
      const reply = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
      if (url.pathname === '/master-spec') return reply(spec('master'))
      if (url.pathname === '/detect-spec') return reply(spec('detect'))
      if (req.headers['x-api-key'] !== 'fixture-soc-key') return reply({ code: 403 }, 403)
      if (url.pathname.startsWith('/soc/asset/')) {
        const assetId = Number(url.pathname.split('/').at(-1))
        return reply(assetId === 9107 ? { code: 500 } : { code: 200, data: assetId === 9108 ? {} : { assetId: assetId === 9109 ? 1 : assetId, hostname: '联试资产', credential: 'fixture-soc-key' } })
      }
      if (url.pathname === '/detect/alert/list') {
        const id = url.searchParams.get('assetId')
        if (id === '9110') return reply({ code: 500 })
        if (id === '9111') return reply({ code: 200, data: {} })
        if (id === '9113') return reply({ code: 503 }, 503)
        return reply({ code: 200, data: { groups: id === '9112' ? [] : Array.from({ length: 3 }, (_, n) => ({ groupKey: `group-${n}`, affectedAssetId: id })), totalGroups: id === '9112' ? 0 : 22, totalAlerts: id === '9112' ? 0 : 777, pageNum: 1, pageSize: Number(url.searchParams.get('pageSize')), from: '2026-09-14T00:00:00Z', to: '2026-10-14T00:00:00Z', truncated: false } })
      }
      reply({ code: 404 }, 404)
    })
    baseUrl = `http://127.0.0.1:${await listen(server)}`
    try {
      const published = { toolName: 'query_asset_related_alerts', title: '资产相关告警只读查询', description: '', connectionId: 'old-api' }
      const draft = { ...published, flow: 'soc-asset-alerts', connectionId: 'master', alertsConnectionId: 'detect' }
      const compositionsFile = join(temp, native ? 'platform/mcp-compositions.json' : 'compositions.json')
      await mkdir(join(temp, 'platform'), { recursive: true })
      await writeFile(compositionsFile, JSON.stringify({ schema_version: '1.0', compositions: [{ id: 'asset-alerts', published, draft }] }))
      const servers = ['master', 'detect'].map(id => ({ id, enabled: true, specUrl: `${baseUrl}/${id}-spec`, authType: 'credential', authHeader: 'X-API-Key', apiKey: 'fixture-soc-key' }))
      const rpc = native ? module.createManagedMcpHandler(temp, () => servers, { extension: { id: 'fixture-security', flow: assetAlertsFlow } }) : module.createMcpHandler(temp, { stateFile: join(temp, 'state.json'), compositionsFile, extension: { id: 'fixture-security', flow: assetAlertsFlow } })
      if (!native) {
        const path = join(temp, 'credential.txt')
        await writeFile(path, 'fixture-soc-key')
        for (const server of servers) assert.equal((await rpc('registerOpenApi', { ...server, credentialRef: { kind: 'file', path } })).ok, true)
      }
      const listed = (await rpc('list', {})).value
      const graph = listed.compositions[0].graphs.draft
      assert.deepEqual(graph.nodes.filter(node => node.operationId).map(node => [node.connectionId, node.operationId]), [['master', 'get_soc_asset_by_asset_id'], ['detect', 'list_detect_alert']])
      assert.equal(listed.compositions[0].graphs.published.nodes.find(node => node.id === 'getAsset').operationId, 'get_asset')
      const query = (endpoint, asset, limit = 2) => rpc(endpoint, { compositionId: 'asset-alerts', version: 'draft', revision: listed.revision, input: { asset, limit } })
      const dry = await query('dryRunComposition', '9106')
      assert.equal(dry.ok, true)
      assert.equal(dry.value.upstreamRequests, 0)
      for (const asset of ['host-a', '0', '9106.5', '9007199254740992']) assert.equal((await query('dryRunComposition', asset)).ok, false)
      assert.deepEqual(calls, [])
      const executed = await query('executeComposition', '9106')
      assert.equal(executed.ok, true)
      assert.equal(executed.value.ok, true)
      assert.equal(executed.value.result.asset.assetId, 9106)
      assert.equal(executed.value.result.alerts.length, 2)
      assert.ok(executed.value.result.alerts.every(group => group.affectedAssetId === '9106'))
      assert.equal(executed.value.result.alertSummary.totalAlerts, 777)
      assert.deepEqual(calls.find(call => call.path === '/detect/alert/list').query, { assetId: '9106', pageNum: '1', pageSize: '2', windowSeconds: '2592000' })
      assert.deepEqual(executed.value.receipts.map(receipt => [receipt.connectionId, receipt.method]), [['master', 'GET'], ['detect', 'GET']])
      assert.ok(!JSON.stringify(executed).includes('fixture-soc-key'))
      for (const [asset, code, firstFailed] of [['9107', 'business_failed', true], ['9108', 'mapping_failed', true], ['9109', 'mapping_failed', true], ['9110', 'business_failed', false], ['9111', 'mapping_failed', false], ['9113', 'step_failed', false]]) {
        calls.length = 0
        const failure = (await query('executeComposition', asset)).value
        assert.equal(failure.ok, false, asset)
        assert.equal(failure.error.code, code, asset)
        assert.equal(failure.result.trace[1].status, firstFailed ? 'skipped' : 'failed')
        assert.equal(calls.some(call => call.path === '/detect/alert/list'), !firstFailed)
      }
      const empty = (await query('executeComposition', '9112')).value
      assert.equal(empty.ok, true)
      assert.deepEqual(empty.result.alerts, [])
      assert.equal(empty.result.alertSummary.totalAlerts, 0)
      calls.length = 0
      alertsMethod = 'post'
      assert.equal((await query('executeComposition', '9106')).ok, false)
      assert.ok(calls.every(call => call.path.endsWith('-spec')))
      assert.deepEqual((await rpc('list', {})).value.compositions[0].published, published)
      assert.equal((await rpc('saveCompositionDraft', { compositionId: 'asset-alerts', revision: listed.revision, draft: { ...draft, alertsConnectionId: '' } })).ok, false)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  }
})

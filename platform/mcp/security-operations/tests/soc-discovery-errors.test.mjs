import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const program = process.env.HARNESS_PROGRAM_ROOT
if (!program) throw new Error('需要 HARNESS_PROGRAM_ROOT')
const { build } = createRequire(join(program, 'platform/plugin/package.json'))('esbuild')
const { outputFiles } = await build({ entryPoints: [new URL('../src/soc.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', nodePaths: [join(program, 'platform/plugin/node_modules')] })
const { createSoc } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)

const servers = () => [{ id: 'master', enabled: true, specUrl: 'https://example.invalid/openapi.json' }]
test('发现失败保留安全连接、操作、阶段与调度状态，不透传凭据', async () => {
  const soc = createSoc(async () => ({ status: 502, value: { error: 'HTTP 502 token=secret-value', authorization: 'secret-value' } }), servers)
  await assert.rejects(soc('master', 'list_soc_asset', {}, new AbortController().signal), error => {
    assert.equal(error.stage, 'discovery')
    assert.equal(error.serverId, 'master')
    assert.equal(error.operationId, 'list_soc_asset')
    assert.equal(error.status, 502)
    assert.match(error.message, /依赖工具发现失败.*连接=master.*阶段=discovery.*操作=list_soc_asset.*MCP调度状态=502/u)
    assert.doesNotMatch(error.message, /secret-value/u)
    return true
  })
})
test('结构缺失与网络异常均保留发现阶段，失败目录不缓存为成功', async () => {
  let calls = 0
  const soc = createSoc(async () => {
    calls++
    if (calls === 1) return { status: 200, value: {} }
    throw new Error('fetch failed')
  }, servers)
  await assert.rejects(soc('master', 'list_soc_asset', {}, new AbortController().signal), /发现回执缺少 tools 数组/u)
  await assert.rejects(soc('master', 'list_soc_asset', {}, new AbortController().signal), /阶段=discovery.*fetch failed/u)
  assert.equal(calls, 2)
})
test('目录成功但操作缺失不冒充发现传输失败', async () => {
  const soc = createSoc(async () => ({ status: 200, value: { tools: [] } }), servers)
  await assert.rejects(soc('master', 'list_soc_asset', {}, new AbortController().signal), /依赖工具发现失败.*未暴露所需操作：list_soc_asset/u)
})

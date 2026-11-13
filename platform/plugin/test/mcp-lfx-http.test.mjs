import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import test from 'node:test'
import { lfxHttpError } from '../src/mcp/lfx-http.ts'

test('上传与执行流的 HTTP 失败保留状态、阶段和上游 detail', async t => {
  const server = createServer((request, response) => {
    response.writeHead(422, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ detail: 'Invalid flow data: Settings service not found' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(url)
  const upload = await lfxHttpError(response.status, 'POST', '/flows/upload/', response.body)
  assert.match(upload.message, /422，POST \/flows\/upload\//)
  assert.match(upload.message, /Invalid flow data: Settings service not found/)
  const stream = await new Promise((resolve, reject) => get(url, resolve).once('error', reject))
  const execute = await lfxHttpError(stream.statusCode, 'POST', '/api/v2/workflows', stream)
  assert.match(execute.message, /422，POST \/api\/v2\/workflows/)
  assert.match(execute.message, /Settings service not found/)
})

test('错误正文支持空响应、文本与 FastAPI 校验列表，并限制长度及凭据', async () => {
  const error = async text => (await lfxHttpError(422, 'POST', '/flows/upload/', new Response(text).body)).message
  assert.match(await error(''), /422/)
  assert.match(await error('upstream unavailable'), /upstream unavailable/)
  const validation = await error(JSON.stringify({ detail: [{ loc: ['body', 'flow'], msg: 'Field required', input: 'private-input' }] }))
  assert.match(validation, /body.flow: Field required/)
  assert.doesNotMatch(validation, /private-input/)
  const secret = await error(JSON.stringify({ detail: 'Authorization: Bearer secret-value api_key=hidden-key password=hidden-pass' }))
  assert.doesNotMatch(secret, /secret-value|hidden-key|hidden-pass/)
  assert.ok((await error('x'.repeat(100_000))).length < 600)
})

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 仅用于接入验收的模拟业务与身份边界，不装入平台默认配置。 */
export async function startFixture(root: string, port = 0, host = '127.0.0.1', existingCredentials?: { userA: string; userB: string; resource: string; catalog: string }) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const credentials = existingCredentials ?? { userA: randomBytes(32).toString('base64url'), userB: randomBytes(32).toString('base64url'),
    resource: randomBytes(32).toString('base64url'), catalog: randomBytes(32).toString('base64url') }
  const assets = new Map([['A-1', { id: 'A-1', group: 'A', status: '正常' }], ['B-1', { id: 'B-1', group: 'B', status: '异常' }]])
  const ledger: Array<{ at: string; operation: string; object?: string }> = []
  const record = (operation: string, object?: string) => {
    const item = { at: new Date().toISOString(), operation, ...(object ? { object } : {}) }
    appendFileSync(join(root, 'resource-events.jsonl'), JSON.stringify(item) + '\n', { mode: 0o600 }); ledger.push(item)
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture.local'), expiresAt = new Date(Date.now() + 60000).toISOString()
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const bytes of req) { raw += bytes; if (raw.length > 1048576) return send(413, { error: 'body_too_large' }) }
      const input = raw ? JSON.parse(raw) : {}
      // 确定性模型只验证真实 Runtime 的工具协议闭环，不用于业务质量结论。
      if (url.pathname === '/v1/models') return send(200, { object: 'list', data: [{ id: 'cross-framework-fixture', object: 'model', owned_by: 'local-fixture' }] })
      if (url.pathname === '/v1/chat/completions') {
        const messages = input.messages ?? [], last = messages.at(-1), tools = input.tools ?? []
        const userIndex = messages.findLastIndex((item: any) => item.role === 'user'
          && !/Current runtime context\.|Time sampled while preparing/.test(JSON.stringify(item.content)))
        const catalog = /catalog|目录/i.test(JSON.stringify(messages[userIndex]?.content ?? ''))
        const isolation = /隔离探针/.test(JSON.stringify(messages[userIndex]?.content ?? ''))
        const tool = tools.find((item: any) => (isolation ? /^(Bash|bash)$/ : catalog ? /get_catalog/ : /get_asset|asset_read/).test(item.function?.name ?? ''))
        const completed = messages.slice(userIndex + 1).some((item: any) => item.role === 'tool')
        const command = `for p in /run/connector/instance.key /run/connector/config.json /run/instance/instance.secret /var/run/docker.sock; do if dd if="$p" of=/dev/null bs=1 count=1 status=none 2>/dev/null; then printf '%s:READABLE\\n' "$p"; else printf '%s:UNREADABLE\\n' "$p"; fi; done`
        const call = !completed && tool ? { id: 'call-fixture-tool', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(isolation ? { command, ...(tool.function?.parameters?.required?.includes('description') ? { description: '只读核对秘密隔离边界' } : {}) } : catalog ? {} : { id: 'A-1' }) } } : undefined
        const content = completed ? '模拟循环已完成，实际调用结果以工具返回为准。' : last ? '模拟模型收到消息。' : '模拟模型就绪。'
        const base = { id: 'chatcmpl-fixture', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: input.model ?? 'cross-framework-fixture' }
        record(call ? 'model:tool-request' : 'model:response')
        if (input.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content }
          res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
          res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n')
          res.end('data: [DONE]\n\n'); return
        }
        return send(200, { ...base, choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
      }
      if (url.pathname === '/health') return send(200, { fixture: true })
      if (url.pathname === '/auth') {
        const subjectId = input.credential === credentials.userA ? 'sample-user-a' : input.credential === credentials.userB ? 'sample-user-b' : undefined
        return send(200, { authenticated: !!subjectId, subjectId, credentialId: subjectId, expiresAt })
      }
      if (url.pathname === '/trust') return send(200, { valid: ['sample-user-a', 'sample-user-b'].includes(input.subjectId), subjectId: input.subjectId, version: 1, expiresAt })
      if (url.pathname === '/risk') {
        const blocked = JSON.stringify(input.input ?? '').includes('SAMPLE_DENY')
        return send(200, { version: 1, scope: input.scope, level: blocked ? 'high' : 'low',
          constraints: { deniedOperations: blocked ? ['*'] : [] }, reasons: [blocked ? '模拟规则拒绝' : '模拟范围内无阻断项'], expiresAt })
      }
      if (url.pathname === '/authorize') return send(200, { protocolVersion: 1, requestId: input.requestId, binding: input.binding,
        decision: JSON.stringify(input.input ?? '').includes('SAMPLE_AUTH_DENY') ? 'deny' : 'allow', policyVersion: 'fixture-1', reason: '模拟访问决定', expiresAt })
      if (url.pathname === '/catalog') {
        if (req.headers.authorization !== `Bearer ${credentials.catalog}`) return send(401, { error: 'native_auth_required' })
        record('catalog'); return send(200, { catalog: ['资产查询'], authentication: 'native', harnessSignature: false })
      }
      if (url.pathname === '/catalog/mcp') {
        if (req.headers.authorization !== `Bearer ${credentials.catalog}`) return send(401, { error: 'native_auth_required' })
        if (input.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
        let result: unknown
        if (input.method === 'initialize') result = { protocolVersion: input.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'native-catalog', version: '1.0.0' } }
        else if (input.method === 'tools/list') result = { tools: [{ name: 'get_catalog', description: '查询模拟业务目录，使用原生认证', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
        else if (input.method === 'ping') result = {}
        else if (input.method === 'tools/call' && input.params?.name === 'get_catalog') { record('catalog'); result = { content: [{ type: 'text', text: JSON.stringify({ catalog: ['资产查询'], authentication: 'native', harnessSignature: false }) }] } }
        else return send(400, { error: 'unsupported_method' })
        return send(200, { jsonrpc: '2.0', id: input.id, result })
      }
      const match = /^\/assets\/([A-Z]-\d+)$/.exec(url.pathname)
      if (match) {
        if (req.headers.authorization !== `Bearer ${credentials.resource}`) return send(401, { error: 'native_proxy_auth_required' })
        const item = assets.get(match[1]); if (!item) return send(404, { error: 'asset_not_found' })
        if (req.method === 'GET') { record('asset:read', match[1]); return send(200, item) }
        if (req.method === 'PATCH') { item.status = String(input.status ?? item.status); record('asset:write', match[1]); return send(200, item) }
        return send(405, { error: 'method_not_allowed' })
      }
      return send(404, { error: 'not_found' })
    } catch { return send(400, { error: 'invalid_request' }) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const address = server.address() as { port: number }
  return { server, origin: `http://${host}:${address.port}`, credentials, ledger,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

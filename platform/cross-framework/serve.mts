import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { startFixture } from './fixture.ts'
import { createAgentAccessHandler } from '../plugin/src/agent-access/index.ts'
import { createExternalAccessHandler } from '../plugin/src/instances/external/index.ts'

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !root.includes('/.local/')) throw new Error('请显式提供 .local 下的隔离数据根')
const host = process.argv[3] ?? '127.0.0.1'
mkdirSync(join(root, 'config'), { recursive: true, mode: 0o700 })
mkdirSync(join(root, '.local', 'credentials'), { recursive: true, mode: 0o700 })
const fixtureCredentials = join(root, '.local', 'credentials', 'fixture.json')
const fixture = await startFixture(join(root, '.local', 'fixture'), 18650, host, existsSync(fixtureCredentials) ? JSON.parse(readFileSync(fixtureCredentials, 'utf8')) : undefined)
const origin = `http://${host}:18656`
writeFileSync(join(root, '.local', 'credentials', 'fixture.json'), JSON.stringify(fixture.credentials), { mode: 0o600 })
writeFileSync(join(root, '.local', 'credentials', 'resource.key'), fixture.credentials.resource, { mode: 0o600 })
const schema = { type: 'object', properties: { id: { type: 'string', pattern: '^[AB]-[0-9]+$' } }, required: ['id'], additionalProperties: false }
const config = { schemaVersion: 1, enabled: true, agents: [], externalInstances: [],
  authentication: { endpoint: fixture.origin + '/auth' }, identityTrust: { endpoint: fixture.origin + '/trust' },
  riskAssessment: { endpoint: fixture.origin + '/risk' }, accessAuthorization: { endpoint: fixture.origin + '/authorize' },
  agentAccess: { schemaVersion: 1, issuer: origin + '/agent-access', resources: [{ id: 'sample-assets', audience: 'urn:harness:sample-assets',
    endpoint: fixture.origin, credentialFile: '.local/credentials/resource.key', tools: [
      { name: 'get_asset', scope: 'assets:read', method: 'GET', path: '/assets/{id}', objectField: 'id', inputSchema: schema },
      { name: 'update_asset', scope: 'assets:write', method: 'PATCH', path: '/assets/{id}', objectField: 'id', inputSchema: schema },
    ] }], grants: [] } }
if (!existsSync(join(root, 'config', 'business-access.json'))) writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
const machine = createAgentAccessHandler(root), external = createExternalAccessHandler(root)
const server = createServer((req, res) => { void (async () => {
  if (await machine(req, res) || await external(req, res)) return
  res.writeHead(404); res.end()
})().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
await new Promise<void>(resolve => server.listen(18656, host, resolve))
writeFileSync(join(root, '.local', 'endpoints.json'), JSON.stringify({ origin, fixture: fixture.origin, model: fixture.origin + '/v1', pid: process.pid }), { mode: 0o600 })
process.stdout.write(JSON.stringify({ event: 'samples-ready', port: 18656 }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { external.close(); server.close(); void fixture.close().finally(() => process.exit(0)) })

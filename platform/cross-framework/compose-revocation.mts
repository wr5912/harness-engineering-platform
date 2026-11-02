import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { externalDetail, externalInstances, getExternalInstance, mutateExternal } from '../plugin/src/instances/external/registry.ts'
import { probeExternal } from '../plugin/src/instances/external/adapters.ts'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'

// 使用独立登记、key 与授予作恢复见证，绝不撤销三框架样本正在使用的凭据。
const action = process.argv[2], root = resolve(process.argv[3]), platform = join(root, 'platform'), id = 'compose-revocation-probe'
const privateFile = join(platform, '.local/credentials/compose-revocation.json')
if (action === 'prepare') {
  const source = externalDetail(platform, 'remote-opencode-sample')
  if (!getExternalInstance(platform, id)) mutateExternal(platform, 'save', { requestId: randomUUID(), revision: externalInstances(platform).revision,
    agent: source.agent, instance: { ...source.instance, id, name: 'Compose 撤销恢复独立见证', description: '仅验证持久撤销，不开放用户入口' },
    policy: { subjects: ['sample-user-a'], actions: ['agent:access', 'session:read'], enabled: false } })
  let detail = externalDetail(platform, id)
  const verification = await probeExternal(platform, detail.instance, AbortSignal.timeout(30000))
  if (!verification.ok) throw new Error('独立恢复见证的原生目标验证未通过')
  mutateExternal(platform, 'verify', { id, requestId: randomUUID(), revision: detail.revision }, verification)
  const service = new AgentAccessService(platform), credential = service.createCredential(id)
  mkdirSync(join(platform, '.local/credentials'), { recursive: true, mode: 0o700 })
  service.saveGrant({ instanceId: id, resourceId: 'sample-assets', scopes: ['assets:read'], objects: ['A-1'], enabled: true, revision: service.status(id).revision })
  const issued = await service.issue(credential.credential.clientId, credential.secret, 'urn:harness:sample-assets', ['assets:read'])
  const active = await service.verify(issued.access_token, 'sample-assets')
  const claims = JSON.parse(Buffer.from(issued.access_token.split('.')[1], 'base64url').toString())
  writeFileSync(privateFile, JSON.stringify({ instanceId: id, clientId: credential.credential.clientId, credentialId: credential.credential.id, secret: credential.secret,
    token: issued.access_token, tokenExpiresAt: new Date(claims.exp * 1000).toISOString(), issuedKid: JSON.parse(Buffer.from(issued.access_token.split('.')[0], 'base64url').toString()).kid }), { mode: 0o600 })
  service.revokeCredential(id, credential.credential.id)
  service.saveGrant({ instanceId: id, resourceId: 'sample-assets', scopes: ['assets:read'], objects: ['A-1'], enabled: false, revision: service.status(id).revision })
  writeFileSync(join(root, 'compose-revocation-before.json'), JSON.stringify({ at: new Date().toISOString(), instanceId: id, tokenPreviouslyActive: active.credential.id === credential.credential.id,
    credentialRevoked: true, grantDisabled: true, tokenExpiresAt: new Date(claims.exp * 1000).toISOString(), issuedKid: JSON.parse(Buffer.from(issued.access_token.split('.')[0], 'base64url').toString()).kid }, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ instanceId: id, tokenPreviouslyActive: true, credentialRevoked: true, grantDisabled: true, privateWitnessSaved: true }) + '\n')
} else if (action === 'verify') {
  const witness = JSON.parse(readFileSync(privateFile, 'utf8')), service = new AgentAccessService(platform)
  const origin = JSON.parse(readFileSync(join(platform, '.local/endpoints.json'), 'utf8')).origin as string
  const endpoint = new URL(origin)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('恢复验收端点定位无效')
  const status = service.status(id), credential = status.credentials.find(row => row.id === witness.credentialId), grant = status.grants.find(row => row.resourceId === 'sample-assets')
  const authorization = `Basic ${Buffer.from(`${witness.clientId}:${witness.secret}`).toString('base64')}`
  const self = await fetch(new URL('/api/agent-access/v1/self/status', origin), { headers: { authorization }, signal: AbortSignal.timeout(10000) })
  const resource = await fetch(new URL('/api/agent-access/v1/resources/sample-assets/mcp', origin), { method: 'POST', headers: { authorization: `Bearer ${witness.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'recovery-probe', method: 'tools/call', params: { name: 'get_asset', arguments: { id: 'A-1' } } }), signal: AbortSignal.timeout(10000) })
  const result = { at: new Date().toISOString(), instanceId: id, credentialStillRevoked: credential?.status === 'revoked', grantStillDisabled: grant?.enabled === false,
    tokenStillWithinLifetime: Date.parse(witness.tokenExpiresAt) > Date.now(),
    originalKidStillKnown: status.signingKeys.some(key => key.kid === witness.issuedKid), selfHttpStatus: self.status, oldTokenHttpStatus: resource.status,
    passed: credential?.status === 'revoked' && grant?.enabled === false && Date.parse(witness.tokenExpiresAt) > Date.now() && self.status === 401 && [401, 403].includes(resource.status) }
  writeFileSync(join(root, 'compose-revocation-after.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify(result) + '\n'); if (!result.passed) process.exitCode = 1
} else throw new Error('用法：bun platform/cross-framework/compose-revocation.mts <prepare|verify> <样本状态根>')

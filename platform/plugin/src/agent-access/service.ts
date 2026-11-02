import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { fromJSONSchema } from 'zod'
import { getExternalInstance, ExternalAccessError } from '../instances/external/registry.ts'
import { AccessError, type AccessEvent, type AccessResource, type AgentAccessOptions, type CredentialMetadata, type ResourceGrant, type ResourceTool } from './contracts.ts'
import { digest, readConfiguration, readEvents, readState, recordEvent, updateConfiguration, updateState, type Credential, type SigningKey } from './store.ts'

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) throw new AccessError('invalid_request', `${label}无效`)
  return value.trim()
}
const metadata = ({ hash, ...value }: Credential): CredentialMetadata => value
const list = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || item.length > 256)) throw new AccessError('invalid_request', `${label}无效`)
  return [...new Set(value)]
}
export class AgentAccessService {
  constructor(readonly assetRoot: string, readonly options: AgentAccessOptions = {}) {}
  private now() { return this.options.now?.() ?? Date.now() }
  private time() { return new Date(this.now()).toISOString() }
  private instance(instanceId: string, verified = false) {
    const value = this.options.resolveInstance ? this.options.resolveInstance(instanceId) : getExternalInstance(this.assetRoot, instanceId)
    if (!value || value.state === 'removed') throw new AccessError('invalid_instance', '实例未登记或已移除', 403)
    if (verified && (value.state === 'draft' || !value.verification?.ok || value.verification.bindingDigest !== value.bindingDigest)) throw new AccessError('instance_unverified', '实例接入绑定尚未验证', 403)
    return value
  }
  private event(event: Omit<AccessEvent, 'at'>) { recordEvent(this.assetRoot, { ...event, at: this.time() }) }
  recordDenial(reason: string, resourceId?: string) {
    this.event({ requestId: randomUUID(), ...(resourceId ? { resourceId } : {}), stage: 'denied', reason })
  }
  private active(credential: Credential) {
    return credential.status === 'active' && Date.parse(credential.expiresAt) > this.now() && (!credential.retireAt || Date.parse(credential.retireAt) > this.now())
  }
  status(instanceId: string) {
    this.instance(instanceId)
    const { config, revision } = readConfiguration(this.assetRoot), state = readState(this.assetRoot)
    return { instanceId, revision, issuer: config.issuer,
      credentials: state.credentials.filter(row => row.instanceId === instanceId).map(row => ({ ...metadata(row), effectiveStatus: this.active(row) ? 'active' : row.status === 'revoked' ? 'revoked' : 'expired' })),
      resources: config.resources.map(({ id, audience, tools }) => ({ id, audience, tools: tools.map(({ name, scope }) => ({ name, scope })) })),
      grants: config.grants.filter(row => row.instanceId === instanceId), records: readEvents(this.assetRoot, instanceId),
      signingKeys: state.keys.map(({ kid, status, retireAt }) => ({ kid, status, retireAt })), observedAt: this.time() }
  }
  createCredential(instanceId: string, rotate = false) {
    this.instance(instanceId)
    const secret = randomBytes(32).toString('base64url'), now = this.now()
    const credential = updateState(this.assetRoot, state => {
      const existing = state.credentials.filter(row => row.instanceId === instanceId)
      if (!rotate && existing.some(row => this.active(row))) throw new AccessError('conflict', '实例已有有效凭据，请使用轮换', 409)
      if (rotate) for (const row of existing.filter(row => this.active(row))) row.retireAt = new Date(now + 600000).toISOString()
      const row: Credential = { id: `credential-${randomUUID()}`, clientId: existing[0]?.clientId ?? `client-${randomUUID()}`, instanceId,
        status: 'active', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString(), hash: digest(secret) }
      state.credentials.push(row)
      return metadata(row)
    })
    this.event({ requestId: randomUUID(), instanceId, credentialId: credential.id, stage: 'management', reason: rotate ? 'credential_rotated' : 'credential_created' })
    return { credential, secret }
  }
  revokeCredential(instanceId: string, credentialId: string) {
    this.instance(instanceId)
    updateState(this.assetRoot, state => {
      const row = state.credentials.find(row => row.id === credentialId && row.instanceId === instanceId)
      if (!row) throw new AccessError('invalid_credential', '凭据不属于此实例', 404)
      row.status = 'revoked'
    })
    this.event({ requestId: randomUUID(), instanceId, credentialId, stage: 'management', reason: 'credential_revoked' })
    return this.status(instanceId)
  }
  authenticate(clientId: string, secret: string, requestId = randomUUID()) {
    const hashed = Buffer.from(digest(secret), 'hex')
    const credential = readState(this.assetRoot).credentials.find(row => row.clientId === clientId && this.active(row)
      && /^[a-f0-9]{64}$/.test(row.hash) && timingSafeEqual(Buffer.from(row.hash, 'hex'), hashed))
    if (!credential) throw new AccessError('invalid_client', '实例凭据无效或已失效', 401)
    this.instance(credential.instanceId)
    this.event({ requestId, instanceId: credential.instanceId, credentialId: credential.id, stage: 'authenticated' })
    return credential
  }
  selfStatus(clientId: string, secret: string) {
    const credential = this.authenticate(clientId, secret), instance = this.instance(credential.instanceId)
    const { config } = readConfiguration(this.assetRoot)
    const endpointVerified = instance.verification?.ok === true && instance.verification.bindingDigest === instance.bindingDigest
    return { instanceId: credential.instanceId, clientId, registration: { state: instance.state, bindingDigest: instance.bindingDigest },
      requestAuthentication: { result: 'verified', method: 'client_secret_basic', credentialId: credential.id, verifiedAt: this.time(), evidenceScope: 'possession-of-instance-credential' },
      credential: { state: 'active', expiresAt: credential.expiresAt, retireAt: credential.retireAt },
      harnessCredentialAccess: { enabled: config.grants.some(row => row.instanceId === credential.instanceId && row.enabled), eligibility: 'requires-request-time-authorization' },
      runtimeEvidence: { sourceIntegrity: 'unknown', endpointVerified,
        endpointVerificationState: endpointVerified ? 'verified' : instance.verification?.ok ? 'stale' : 'unverified',
        ...(instance.verification?.observedAt ? { lastEndpointVerificationAt: instance.verification.observedAt } : {}) }, observedAt: this.time() }
  }
  saveGrant(input: Record<string, unknown>) {
    const instanceId = requiredText(input.instanceId, '实例'), resourceId = requiredText(input.resourceId, '资源')
    this.instance(instanceId)
    const scopes = list(input.scopes, '操作范围'), objects = input.objects === undefined ? undefined : list(input.objects, '对象范围')
    if (typeof input.enabled !== 'boolean') throw new AccessError('invalid_request', '请明确资源授权状态')
    updateConfiguration(this.assetRoot, requiredText(input.revision, '配置版本'), config => {
      const resource = config.resources.find(row => row.id === resourceId)
      if (!resource || scopes.some(scope => !resource.tools.some(tool => tool.scope === scope))) throw new AccessError('invalid_scope', '资源或操作范围未登记')
      const previous = config.grants.find(row => row.instanceId === instanceId && row.resourceId === resourceId)
      const grant: ResourceGrant = { instanceId, resourceId, scopes, ...(objects !== undefined ? { objects } : {}), enabled: input.enabled as boolean, version: (previous?.version ?? 0) + 1 }
      if (previous) config.grants[config.grants.indexOf(previous)] = grant
      else config.grants.push(grant)
    })
    this.event({ requestId: randomUUID(), instanceId, resourceId, stage: 'management', reason: 'grant_updated' })
    return this.status(instanceId)
  }
  disableResourceAccess(instanceId: string, revision: string) {
    this.instance(instanceId)
    updateConfiguration(this.assetRoot, revision, config => { for (const grant of config.grants.filter(row => row.instanceId === instanceId)) { grant.enabled = false; grant.version++ } })
    this.event({ requestId: randomUUID(), instanceId, stage: 'management', reason: 'resource_access_disabled' })
    return this.status(instanceId)
  }
  async rotateSigningKey(emergencyKid?: string) {
    const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true })
    const key: SigningKey = { kid: `access-${randomUUID()}`, privateKey: await exportPKCS8(pair.privateKey), publicJwk: await exportJWK(pair.publicKey), status: 'active' }
    updateState(this.assetRoot, state => {
      for (const current of state.keys) if (current.status === 'active') { current.status = 'retiring'; current.retireAt = new Date(this.now() + 330000).toISOString() }
      if (emergencyKid) { const current = state.keys.find(row => row.kid === emergencyKid); if (current) current.status = 'revoked' }
      state.keys.push(key); state.currentKid = key.kid
    })
    return { kid: key.kid, publicJwk: { ...key.publicJwk, kid: key.kid, alg: 'RS256', use: 'sig' } }
  }
  disableSigningKey(kid: string) {
    updateState(this.assetRoot, state => {
      const key = state.keys.find(row => row.kid === kid)
      if (!key) throw new AccessError('invalid_key', '签发密钥不存在', 404)
      key.status = 'revoked'; if (state.currentKid === kid) delete state.currentKid
    })
    return { kid, status: 'revoked' }
  }
  private async key() {
    let state = readState(this.assetRoot)
    if (!state.currentKid) {
      if (state.keys.length) throw new AccessError('signing_unavailable', '签发密钥已停用，请配置新密钥', 503)
      await this.rotateSigningKey()
      state = readState(this.assetRoot)
    }
    const key = state.keys.find(row => row.kid === state.currentKid && row.status === 'active')
    if (!key) throw new AccessError('signing_unavailable', '当前没有有效签发密钥', 503)
    return key
  }
  async issue(clientId: string, secret: string, audience: string, scopes: string[]) {
    const requestId = randomUUID(), credential = this.authenticate(clientId, secret, requestId)
    const instance = this.instance(credential.instanceId, true), { config } = readConfiguration(this.assetRoot)
    if (!config.issuer) throw new AccessError('signing_unavailable', '签发者尚未配置', 503)
    const resource = config.resources.find(row => row.audience === audience), grant = resource && config.grants.find(row => row.instanceId === credential.instanceId && row.resourceId === resource.id && row.enabled)
    if (!resource || !grant) throw new AccessError('invalid_target', '资源未登记或未获授予', 403)
    if (!scopes.length || scopes.some(scope => !grant.scopes.includes(scope) || !resource.tools.some(tool => tool.scope === scope))) throw new AccessError('invalid_scope', '申请范围超出实例资源授予', 403)
    const key = await this.key(), now = Math.floor(this.now() / 1000)
    const expiresAt = Math.min(now + 300, Math.floor(Date.parse(credential.expiresAt) / 1000), credential.retireAt ? Math.floor(Date.parse(credential.retireAt) / 1000) : Infinity)
    const jti = randomUUID()
    const token = await new SignJWT({ client_id: clientId, scope: [...new Set(scopes)].join(' '), hep_credential_id: credential.id, hep_grant_version: grant.version,
      hep_binding: instance.bindingDigest, hep_resource_binding: digest(JSON.stringify(resource)) })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: key.kid }).setIssuer(config.issuer).setSubject(`instance:${credential.instanceId}`)
      .setAudience(audience).setIssuedAt(now).setExpirationTime(expiresAt).setJti(jti).sign(await importPKCS8(key.privateKey, 'RS256'))
    await this.verify(token, resource.id)
    this.event({ requestId, instanceId: credential.instanceId, credentialId: credential.id, resourceId: resource.id, jti, grantVersion: grant.version, stage: 'issued' })
    return { access_token: token, token_type: 'Bearer', expires_in: expiresAt - now, scope: [...new Set(scopes)].join(' ') }
  }
  async verify(token: string, resourceId: string) {
    let { config } = readConfiguration(this.assetRoot)
    let resource = config.resources.find(row => row.id === resourceId)
    if (!resource || !config.issuer) throw new AccessError('invalid_target', '签名资源绑定不存在', 403)
    let result: { payload: JWTPayload; protectedHeader: { kid?: string; alg?: string; typ?: string } }
    try {
      result = await jwtVerify(token, async header => {
        if (header.jku || header.x5u || header.alg !== 'RS256' || header.typ !== 'at+jwt') throw new Error('invalid_header')
        const key = readState(this.assetRoot).keys.find(row => row.kid === header.kid && row.status !== 'revoked' && (!row.retireAt || Date.parse(row.retireAt) > this.now()))
        if (!key) throw new Error('unknown_kid')
        return importJWK(key.publicJwk, 'RS256')
      }, { algorithms: ['RS256'], issuer: config.issuer, audience: resource.audience, typ: 'at+jwt', clockTolerance: 30, currentDate: new Date(this.now()), requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope', 'hep_credential_id', 'hep_grant_version', 'hep_binding', 'hep_resource_binding'] })
    } catch { throw new AccessError('invalid_token', '访问令牌无效、过期或签发密钥已停用', 401) }
    const payload = result.payload
    // 密码学校验会让出执行权；在其后读取当前授予及密钥状态，不能沿用校验前的允许快照。
    config = readConfiguration(this.assetRoot).config
    resource = config.resources.find(row => row.id === resourceId)
    if (!resource || payload.iss !== config.issuer) throw new AccessError('invalid_token', '签名资源或签发者绑定已变化', 403)
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp <= payload.iat || payload.iat > this.now() / 1000 + 30 || payload.exp - payload.iat > 300
      || payload.aud !== resource.audience || typeof payload.scope !== 'string' || typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 512) throw new AccessError('invalid_token', '访问令牌声明无效', 401)
    const state = readState(this.assetRoot), credential = state.credentials.find(row => row.id === payload.hep_credential_id && row.clientId === payload.client_id)
    const signingKey = state.keys.find(row => row.kid === result.protectedHeader.kid && row.status !== 'revoked' && (!row.retireAt || Date.parse(row.retireAt) > this.now()))
    if (!signingKey) throw new AccessError('invalid_token', '签发密钥已停用', 401)
    if (!credential || !this.active(credential) || payload.sub !== `instance:${credential.instanceId}`) throw new AccessError('invalid_token', '令牌关联凭据已失效', 401)
    const instance = this.instance(credential.instanceId, true), grant = config.grants.find(row => row.instanceId === credential.instanceId && row.resourceId === resource.id && row.enabled)
    if (!grant || payload.hep_grant_version !== grant.version || payload.hep_binding !== instance.bindingDigest || payload.hep_resource_binding !== digest(JSON.stringify(resource))) throw new AccessError('invalid_token', '资源授权或接入绑定已变化', 403)
    const scopes = payload.scope.split(' ')
    if (!scopes.length || scopes.some(scope => !grant.scopes.includes(scope))) throw new AccessError('invalid_scope', '令牌范围已失效', 403)
    return { credential, grant, resource, payload, scopes }
  }
  async dispatch(token: string, resourceId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal) {
    let current = await this.verify(token, resourceId)
    const tool = current.resource.tools.find(row => row.name === toolName)
    if (!tool || !current.scopes.includes(tool.scope)) throw new AccessError('insufficient_scope', '此工具不在当前授权范围', 403)
    this.validateArgs(tool, args)
    if (current.grant.objects !== undefined && !tool.objectField) throw new AccessError('object_binding_missing', '此工具缺少对象绑定，不能落实当前对象授予', 503)
    if (tool.objectField && current.grant.objects !== undefined && !current.grant.objects.includes(String(args[tool.objectField]))) throw new AccessError('object_forbidden', '请求对象不在资源授予范围', 403)
    try {
      if (this.options.authorize) await this.options.authorize({ instanceId: current.credential.instanceId, resource: current.resource, tool, args }, signal)
      else {
        const { authorizeExternalOperation } = await import('../instances/external/access.ts')
        await authorizeExternalOperation(this.assetRoot, { instanceId: current.credential.instanceId, args, operation: { serverId: current.resource.id,
          operationId: tool.name, kind: tool.method === 'GET' ? 'read' : 'write', target: this.target(current.resource, tool, args).href, method: tool.method } }, signal)
      }
    } catch (error) {
      if (error instanceof ExternalAccessError) throw new AccessError(error.code, error.message, error.status)
      throw error
    }
    signal.throwIfAborted()
    const requestId = randomUUID(), event = { requestId, instanceId: current.credential.instanceId, credentialId: current.credential.id, resourceId, operation: toolName, jti: current.payload.jti, grantVersion: current.grant.version }
    try { this.event({ ...event, stage: 'prepared' }) }
    catch { throw new AccessError('record_unavailable', '必要记录不可写，本次未派发', 503) }
    // 异步风险/记录完成后复核，撤销不滞留在旧快照中。
    current = await this.verify(token, resourceId)
    const url = this.target(current.resource, tool, args), headers: Record<string, string> = { 'content-type': 'application/json' }
    let upstreamSecret: string | undefined
    if (current.resource.credentialFile) {
      const path = isAbsolute(current.resource.credentialFile) ? current.resource.credentialFile : resolve(this.assetRoot, current.resource.credentialFile)
      upstreamSecret = readFileSync(path, 'utf8').trim()
      if (!upstreamSecret || /[\r\n]/.test(upstreamSecret)) throw new AccessError('upstream_credential_invalid', '资源原生凭据无效', 503)
      headers.authorization = `Bearer ${upstreamSecret}`
    }
    try { this.event({ ...event, stage: 'dispatched' }) }
    catch { throw new AccessError('record_unavailable', '必要记录不可写，本次未派发', 503) }
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(url, { method: tool.method, headers, redirect: 'error', signal,
        ...(!['GET', 'DELETE'].includes(tool.method) ? { body: JSON.stringify(args) } : {}) })
      let body = await response.text()
      if (body.length > 2 * 1024 * 1024) throw new AccessError('upstream_response_too_large', '目标结果过大', 502)
      try { this.event({ ...event, stage: 'response', httpStatus: response.status }) }
      catch { throw new AccessError('result_recording_failed', '请求已执行，但结果记录写入失败；请核对目标结果，勿重复提交', 502) }
      if (!response.ok) throw new AccessError('upstream_error', `目标返回 HTTP ${response.status}`, 502)
      // 代理不返回上游凭据相关响应头，正文不包含访问 token。
      for (const secret of [token, upstreamSecret]) if (secret) body = body.replaceAll(secret, '[凭据已隐藏]')
      return { content: [{ type: 'text', text: body }], isError: false, requestId }
    } catch (error) {
      if (error instanceof AccessError) throw error
      try { this.event({ ...event, stage: 'unknown', reason: 'upstream_interrupted' }) } catch { /* 已派发的结果未知，记录缺口不改变事实。 */ }
      throw new AccessError('result_unknown', '请求已派发，目标结果待确认；不会自动重试', 502)
    }
  }
  private target(resource: AccessResource, tool: ResourceTool, args: Record<string, unknown>) {
    const base = new URL(resource.endpoint)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new AccessError('invalid_target', '资源目标配置无效', 503)
    const path = tool.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, field: string) => {
      const value = args[field]
      if (value === undefined || value === '.' || value === '..') throw new AccessError('invalid_request', '资源路径参数无效')
      return encodeURIComponent(String(value))
    })
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new AccessError('invalid_target', '资源操作路径无效', 503)
    const url = new URL(path, base)
    if (url.origin !== base.origin) throw new AccessError('invalid_target', '资源目标越界', 503)
    return url
  }
  private validateArgs(tool: ResourceTool, args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AccessError('invalid_request', '工具参数必须是对象')
    if (Object.keys(args).some(key => ['__proto__', 'constructor', 'prototype', 'authorization', 'skip_signature', 'instance_id', 'url'].includes(key.toLowerCase()))) throw new AccessError('invalid_request', '工具参数包含不允许的控制字段')
    if (tool.inputSchema) {
      let valid: boolean
      try { valid = fromJSONSchema(tool.inputSchema).safeParse(args).success }
      catch { throw new AccessError('invalid_schema', '此工具参数规格暂不受支持，未派发请求', 503) }
      if (!valid) throw new AccessError('invalid_request', '工具参数不符合登记规格')
    }
    if (tool.objectField && (typeof args[tool.objectField] !== 'string' || !args[tool.objectField])) throw new AccessError('invalid_request', '资源对象参数无效')
  }
}

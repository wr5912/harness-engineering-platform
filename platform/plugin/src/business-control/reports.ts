import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getBusinessControl, withBusinessContext, matchesOperationTarget } from './core.ts'
import type { BusinessContext, BusinessOperation } from './contracts.ts'
interface ReportRecord { sessionId: string; sourceUrl: string; expectedOrigin: string; serverId?: string }
export interface BusinessReportConnection { headers: Readonly<Record<string, string>>; assertCurrent(): void }
type HeadersResolver = (serverId: string, expectedOrigin: string) => BusinessReportConnection | Promise<BusinessReportConnection>
const symbol = Symbol.for('harness.business-report.headers.v1')
const global = globalThis as typeof globalThis & { [symbol]?: Map<string, HeadersResolver> }
const resolvers = global[symbol] ??= new Map<string, HeadersResolver>()
export function setBusinessReportHeaderResolver(assetRoot: string, resolver: HeadersResolver): () => void {
  const root = resolve(assetRoot); resolvers.set(root, resolver)
  return () => { if (resolvers.get(root) === resolver) resolvers.delete(root) }
}
function reportPath(assetRoot: string): string { return join(getBusinessControl(assetRoot).stateDirectory(), 'reports.json') }
function records(assetRoot: string): Record<string, ReportRecord> {
  const path = reportPath(assetRoot)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, ReportRecord>
}
function source(sourceUrl: string, expectedOrigin: string): URL {
  const url = new URL(sourceUrl), expected = new URL(expectedOrigin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== expected.origin || url.username || url.password || url.search || url.hash || !/^\/reports\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)) throw new Error('报告来源超出已验证发布目标')
  return url
}
/** 发布返回值转成受归属检查的下载入口；持久化只保存连接引用，不复制服务凭据。 */
export function registerBusinessReport(assetRoot: string, context: BusinessContext, sourceUrl: string, expectedOrigin: string, upstream?: { serverId: string }): string {
  const control = getBusinessControl(assetRoot)
  if (!upstream?.serverId) throw new Error('业务报告缺少受管服务引用')
  const scoped = { ...context, scope: { ...context.scope, serverId: upstream.serverId } }
  control.assert(scoped, 'publish')
  if (!context.scope.sessionId || !context.scope.instanceId) throw new Error('业务报告必须有 Session 和实例归属')
  const url = source(sourceUrl, expectedOrigin), id = randomUUID()
  const value = records(assetRoot)
  value[id] = { sessionId: context.scope.sessionId, sourceUrl: url.href, expectedOrigin: url.origin, ...(upstream ? { serverId: upstream.serverId } : {}) }
  const path = reportPath(assetRoot), temporary = `${path}.${randomUUID()}.tmp`
  mkdirSync(control.stateDirectory(), { recursive: true, mode: 0o700 }); writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path)
  control.bindResource(scoped, { kind: 'report', id })
  return `/agents/${context.scope.agentId}/instances/${context.scope.instanceId}/api/business-control/reports/${id}`
}
export async function readBusinessReport(assetRoot: string, context: BusinessContext, id: string, signal = new AbortController().signal): Promise<{ body: Uint8Array; contentType: string; filename: string }> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('业务报告不可用')
  const record = records(assetRoot)[id]
  if (!record) throw new Error('业务报告不可用')
  if (!record.serverId) throw new Error('业务报告缺少受管服务引用')
  const control = getBusinessControl(assetRoot), owned = control.sessionContext(context, record.sessionId)
  const scoped = { ...owned, scope: { ...owned.scope, serverId: record.serverId } }, resources = [{ kind: 'report', id }]
  const url = source(record.sourceUrl, record.expectedOrigin)
  // 下载是独立真实GET操作，不从曾经允许POST发布推导读取权限。
  const rule = control.config().operations?.find(value => value.serverId === record.serverId && value.kind === 'publish'
    && value.method.toUpperCase() === 'GET' && matchesOperationTarget(value.target, url.href, value.queryParameters))
  if (!rule) throw new Error('报告下载操作尚未登记或目标已经变化')
  const operation: BusinessOperation = { serverId: record.serverId, operationId: rule.operationId, kind: 'publish',
    target: url.href, method: 'GET', resources, args: { reportRef: id }, ...(rule.schemaDigest ? { schemaDigest: rule.schemaDigest } : {}) }
  return withBusinessContext(scoped, () => control.execute(operation, async executionSignal => {
    const resolver = resolvers.get(resolve(assetRoot))
    if (!resolver) throw new Error('报告服务连接尚未装载')
    const connection = await resolver(record.serverId!, record.expectedOrigin)
    if (!connection || typeof connection.assertCurrent !== 'function') throw new Error('报告连接缺少当前配置检查')
    // 连接解析可能异步；只在重新检查后把当前凭据送往仍获准的实际目标。
    await control.revalidateIdentity(scoped, executionSignal)
    control.assertOperation(scoped, operation)
    connection.assertCurrent()
    const response = await fetch(url, { headers: connection.headers, redirect: 'error', signal: AbortSignal.any([executionSignal, AbortSignal.timeout(15_000)]) })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) throw new Error('报告服务未返回有效HTML')
    const chunks: Uint8Array[] = []; let length = 0
    for await (const bytes of response.body) { length += bytes.length; if (length > 5 * 1024 * 1024) throw new Error('报告超过首期非流式传输上限'); chunks.push(bytes) }
    const body = Buffer.concat(chunks), text = body.toString('utf8')
    await control.inspect(scoped, 'report', text, executionSignal, 'publish')
    await control.revalidateIdentity(scoped, executionSignal)
    executionSignal.throwIfAborted()
    connection.assertCurrent()
    control.assertOperation(scoped, operation)
    control.assert(scoped, 'publish', resources, text)
    return { body: new Uint8Array(body), contentType: 'text/html; charset=utf-8', filename: `${id}.html` }
  }, signal))
}

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'

const key = Symbol.for('harness.platform.entry-address.v1')
const globals = globalThis as typeof globalThis & { [key]?: Map<string, string> }
const entries = globals[key] ??= new Map<string, string>()

export function processBirth(pid: number): string | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch { return undefined }
}

/** 插件各制品共用实际启动入口；CLI 只复用仍在运行的本工作区进程记录。 */
export function runningPlatformEntry(assetRoot: string): string | undefined {
  const root = resolve(assetRoot), entry = entries.get(root)
  if (entry) return entry
  try {
    const state = JSON.parse(readFileSync(join(root, '.local/platform-service/state.json'), 'utf8'))
    if (state.dataRoot === root && Number.isInteger(state.pid) && state.pid > 1 && state.birth
      && processBirth(state.pid) === state.birth) return state.publicUrl ?? state.url
  } catch { /* 未由生命周期工具启动时，由插件启动入口提供地址。 */ }
  return undefined
}

export function bindPlatformEntry(assetRoot: string, entry: string): void { entries.set(resolve(assetRoot), entry) }

/** 内部重启复用监听参数；只有独立的公开入口才需覆盖配置。 */
export function platformAddressArgs(address: { host: string; port: number; url?: string; publicUrl?: string }, explicit = false): string[] {
  const direct = address.url ?? (address.publicUrl ? `http://${address.host}:${address.port}${new URL(address.publicUrl).pathname}` : undefined)
  return ['--host', address.host, '--port', String(address.port),
    ...(address.publicUrl && (explicit || address.publicUrl !== direct) ? ['--public-url', address.publicUrl] : [])]
}

/** 未标注模式的历史 HTTP IP 是自动地址；域名、HTTPS 和显式入口仍由用户管理。 */
export function automaticAddress(value: unknown, mode?: unknown): boolean {
  if (mode === 'explicit') return false
  if (mode === 'auto' || value === undefined) return true
  const url = new URL(String(value))
  return url.protocol === 'http:' && (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 || url.hostname === 'localhost')
}

type Access = { gateway?: { publicOrigin?: string; publicOriginMode?: string; port?: number; managementUrl?: string; managementUrlMode?: string }; operations?: Array<{ target: string }> }

export function rebasePlatformOperations(access: Access, previous: string | undefined, entry: string): void {
  if (!previous || previous === entry) return
  const old = new URL(previous), current = new URL(entry)
  for (const operation of access.operations ?? []) {
    let url: URL
    try { url = new URL(operation.target) } catch { continue }
    if (url.origin === old.origin && url.pathname.startsWith(old.pathname)) {
      operation.target = new URL(url.pathname.slice(old.pathname.length) + url.search, current).href
    }
  }
}

/** 自动地址在读取时派生，Git 同步旧配置不能改变运行中的公开入口。 */
export function effectiveBusinessAccess<T extends Access>(assetRoot: string, access: T): T {
  const entry = runningPlatformEntry(assetRoot), gateway = access.gateway
  if (!entry || !gateway) return access
  const previous = gateway.managementUrl
  if (automaticAddress(gateway.managementUrl, gateway.managementUrlMode)) gateway.managementUrl = entry
  if (automaticAddress(gateway.publicOrigin, gateway.publicOriginMode)) {
    gateway.publicOrigin = `http://${new URL(entry).hostname}:${gateway.port ?? 53105}`
  }
  if (previous !== gateway.managementUrl) rebasePlatformOperations(access, previous, entry)
  return access
}

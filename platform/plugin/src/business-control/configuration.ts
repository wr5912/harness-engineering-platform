import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BusinessGatewayConfig } from './gateway.ts'
import { ensureBusinessSecret, prepareBusinessRuntimeFile } from './secret-file.ts'

export function validateBusinessGateway(value: unknown): asserts value is BusinessGatewayConfig {
  const gateway = value as BusinessGatewayConfig | undefined
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway) || typeof gateway.host !== 'string' || !gateway.host || !Number.isSafeInteger(gateway.port)
    || gateway.port < 1 || gateway.port > 65535 || typeof gateway.publicOrigin !== 'string'
    || typeof gateway.sharedSecretFile !== 'string' || !gateway.sharedSecretFile || !Array.isArray(gateway.instances)) {
    throw new Error('业务网关配置不完整，请核对 config/business-access.json 后重新启动平台')
  }
  const origin = new URL(gateway.publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.href !== `${origin.origin}/`) {
    throw new Error('业务网关 publicOrigin 必须是无路径和凭据的 HTTP(S) 地址')
  }
}

/** 初始化缺失字段；保留用户明确关闭的开关、现有登记和自定义网关地址。 */
export function initializeBusinessGateway(assetRoot: string, managementUrl: string, host?: string, port?: number): void {
  const path = join(assetRoot, 'config/business-access.json')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const access = before ? JSON.parse(before) : { schemaVersion: 1, enabled: true, agents: [] }
  if (access?.schemaVersion !== 1 || typeof access.enabled !== 'boolean' || !Array.isArray(access.agents)) {
    throw new Error('业务接入配置无效，请核对 config/business-access.json')
  }
  const entry = new URL(managementUrl)
  access.gateway ??= {}
  const gateway = access.gateway
  if (typeof gateway !== 'object' || Array.isArray(gateway)) throw new Error('业务网关配置必须是对象')
  gateway.host ??= host ?? entry.hostname.replace(/^\[|\]$/g, '')
  gateway.port = port ?? gateway.port ?? 53105
  gateway.publicOrigin ??= `http://${entry.hostname}:${gateway.port}`
  gateway.sharedSecretFile ??= '.local/credentials/business-shared.key'
  gateway.instances ??= []
  gateway.managementUrl = managementUrl
  validateBusinessGateway(gateway)
  if (access.enabled === true) ensureBusinessSecret(assetRoot, gateway.sharedSecretFile)
  const saved = `${JSON.stringify(access, null, 2)}\n`
  if (saved === before) {
    prepareBusinessRuntimeFile(path)
    return
  }
  mkdirSync(join(assetRoot, 'config'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, saved, { mode: 0o600 })
  prepareBusinessRuntimeFile(temporary)
  renameSync(temporary, path)
}

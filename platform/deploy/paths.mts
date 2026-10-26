import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareBusinessRuntimeFile } from '../plugin/src/business-control/secret-file.ts'

export interface PathMapping {
  from: string
  to: string
}

function pathPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?![A-Za-z0-9_.-])', 'g')
}

export interface RewriteReport {
  changed: string[]
  oldReferences: Array<{ file: string; pattern: string }>
}

function instanceFiles(dataRoot: string): string[] {
  const root = join(dataRoot, '.local', 'instances')
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const name of readdirSync(root).sort()) {
    for (const file of ['instance.json', 'compose.yaml']) {
      const path = join(root, name, file)
      if (existsSync(path)) files.push(path)
    }
  }
  return files
}

export function knownPathFiles(dataRoot: string): string[] {
  const files = [
    join(dataRoot, 'workspace.json'),
    join(dataRoot, 'config', 'business-access.json'),
    join(dataRoot, '.local/platform-home/profiles/harness-platform/cordis.patch.yml'),
  ].filter(existsSync)
  return files.concat(instanceFiles(dataRoot))
}

function normalizeMapping(mapping: PathMapping): PathMapping {
  const from = mapping.from.replace(/\/+$/, '')
  const to = mapping.to.replace(/\/+$/, '')
  if (!from || !to) throw new Error('路径映射不能为空')
  return { from, to }
}

export function rewriteKnownPaths(dataRoot: string, mappings: PathMapping[]): RewriteReport {
  const normalized = mappings.map(normalizeMapping).filter(mapping => mapping.from !== mapping.to).sort((a, b) => b.from.length - a.from.length)
  const report: RewriteReport = { changed: [], oldReferences: [] }
  for (const file of knownPathFiles(dataRoot)) {
    const original = readFileSync(file, 'utf8')
    let updated = original
    for (const mapping of normalized) updated = updated.replace(pathPattern(mapping.from), mapping.to)
    if (updated !== original) {
      if (file.endsWith('.json')) {
        try { JSON.parse(updated) } catch { throw new Error(`路径映射后 JSON 无效：${file}`) }
      }
      writeFileSync(file, updated, { encoding: 'utf8', mode: 0o600 })
      report.changed.push(file)
    }
    for (const mapping of normalized) {
      if (pathPattern(mapping.from).test(updated)) report.oldReferences.push({ file, pattern: mapping.from })
    }
  }
  return report
}

export function scanKnownOldPaths(dataRoot: string, patterns: string[]): Array<{ file: string; pattern: string }> {
  const found: Array<{ file: string; pattern: string }> = []
  for (const file of knownPathFiles(dataRoot)) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of patterns) if (pattern && pathPattern(pattern).test(text)) found.push({ file, pattern })
  }
  return found
}

export function rewriteDeploymentAddress(dataRoot: string, host: string, port: number, gatewayPort?: number): boolean {
  const file = join(dataRoot, 'config', 'business-access.json')
  if (!existsSync(file)) return false
  const access = JSON.parse(readFileSync(file, 'utf8'))
  if (!access.gateway) return false
  const gateway = access.gateway
  gateway.host = host
  if (gatewayPort !== undefined) gateway.port = gatewayPort
  if (gateway.publicOrigin) {
    const origin = new URL(gateway.publicOrigin)
    origin.hostname = host
    if (gatewayPort !== undefined) origin.port = String(gatewayPort)
    gateway.publicOrigin = origin.origin
  }
  if (gateway.managementUrl) {
    const management = new URL(gateway.managementUrl)
    management.hostname = host
    management.port = String(port)
    gateway.managementUrl = management.href
  }
  writeFileSync(file, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 })
  prepareBusinessRuntimeFile(file)
  return true
}

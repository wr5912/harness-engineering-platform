import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareBusinessRuntimeFile } from '../plugin/src/business-control/secret-file.ts'
import { initializeBusinessGateway } from '../plugin/src/business-control/configuration.ts'
import { validatePlatformEntryUrl } from '../plugin/src/business-control/group-link.ts'

export interface PathMapping {
  from: string
  to: string
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

function longestPattern(values: string[]): RegExp {
  return new RegExp('(?:' + values.sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9_.-])', 'g')
}

export function rewriteKnownPaths(dataRoot: string, mappings: PathMapping[]): RewriteReport {
  const normalized = mappings.map(normalizeMapping).sort((a, b) => b.from.length - a.from.length)
  const replacements = new Map<string, string>()
  for (const mapping of normalized) {
    if (replacements.has(mapping.from) && replacements.get(mapping.from) !== mapping.to) throw new Error('同一路径不能映射到不同目标')
    replacements.set(mapping.from, mapping.to)
  }
  const report: RewriteReport = { changed: [], oldReferences: [] }
  for (const file of knownPathFiles(dataRoot)) {
    const original = readFileSync(file, 'utf8')
    const updated = replacements.size ? original.replace(longestPattern([...replacements.keys()]), from => replacements.get(from)!) : original
    if (updated !== original) {
      if (file.endsWith('.json')) {
        try { JSON.parse(updated) } catch { throw new Error(`路径映射后 JSON 无效：${file}`) }
      }
      writeFileSync(file, updated, { encoding: 'utf8', mode: 0o600 })
      report.changed.push(file)
    }
  }
  report.oldReferences = scanKnownOldPaths(dataRoot, normalized.filter(mapping => mapping.from !== mapping.to).map(mapping => mapping.from), normalized.map(mapping => mapping.to))
  return report
}

export function scanKnownOldPaths(dataRoot: string, patterns: string[], allowedTargets: string[] = []): Array<{ file: string; pattern: string }> {
  const found: Array<{ file: string; pattern: string }> = []
  const allowed = new Set(allowedTargets.filter(Boolean)), old = new Set(patterns.filter(Boolean))
  const values = [...new Set([...allowed, ...old])]
  if (!values.length) return found
  for (const file of knownPathFiles(dataRoot)) {
    const text = readFileSync(file, 'utf8')
    const matches = new Set<string>()
    for (const match of text.matchAll(longestPattern(values))) if (!allowed.has(match[0]) && old.has(match[0])) matches.add(match[0])
    for (const pattern of matches) found.push({ file, pattern })
  }
  return found
}

export function rewriteDeploymentAddress(dataRoot: string, host: string, port: number, gatewayPort?: number, publicUrl?: string): boolean {
  const file = join(dataRoot, 'config', 'business-access.json')
  const sites = join(dataRoot, 'config/sites.json')
  const base = existsSync(sites) ? JSON.parse(readFileSync(sites, 'utf8')).platform : '/hep/'
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  const management = new URL(publicUrl ? validatePlatformEntryUrl(dataRoot, publicUrl) : previous?.gateway?.managementUrl ?? `http://${host}:${port}${base}`)
  if (publicUrl && new URL(publicUrl).hash) throw new Error('--public-url 不能包含片段')
  if (!publicUrl) { management.hostname = host; management.port = String(port) }
  initializeBusinessGateway(dataRoot, management.href, host, gatewayPort)
  const access = JSON.parse(readFileSync(file, 'utf8'))
  const gateway = access.gateway
  gateway.host = host
  if (gatewayPort !== undefined) gateway.port = gatewayPort
  if (gateway.publicOrigin) {
    const origin = new URL(gateway.publicOrigin)
    origin.hostname = management.hostname
    if (gatewayPort !== undefined) origin.port = String(gatewayPort)
    gateway.publicOrigin = origin.origin
  }
  if (gateway.managementUrl) {
    gateway.managementUrl = management.href
  }
  writeFileSync(file, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 })
  prepareBusinessRuntimeFile(file)
  return true
}

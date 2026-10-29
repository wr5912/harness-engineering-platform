import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

declare const __STANDALONE_THREAT_SOURCE_COMMIT__: string
declare const __STANDALONE_THREAT_SOURCE_DIRECTORY__: string
declare const __STANDALONE_THREAT_SOURCE_DIGEST__: string
export const THREAT_SOURCE_COMMIT = __STANDALONE_THREAT_SOURCE_COMMIT__
export const THREAT_SOURCE_DIRECTORY = __STANDALONE_THREAT_SOURCE_DIRECTORY__
export const defaultThreatStateRoot = () => join(process.env.DSH_HOME || '/var/lib/dsh', 'standalone/artifacts/security-operations')

/** 替换原 Git 缓存入口；固定算法和原文保持逐字节一致，目标机无需数据仓库。 */
export async function loadThreatSource(assetRoot: string, _stateRoot?: string) {
  try {
    const directory = realpathSync(join(assetRoot, 'runtime/extensions/security-operations-compositions/fixed-source'))
    const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'))
    if (index.commit !== THREAT_SOURCE_COMMIT || index.directory !== THREAT_SOURCE_DIRECTORY || !Array.isArray(index.files)
      || index.digest !== __STANDALONE_THREAT_SOURCE_DIGEST__ || createHash('sha256').update(JSON.stringify(index.files)).digest('hex') !== index.digest) throw new Error('metadata')
    for (const file of index.files) {
      if (typeof file.path !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('metadata')
      const path = realpathSync(join(directory, file.path))
      if (!path.startsWith(directory + sep) || createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('digest')
    }
    const root = realpathSync(join(directory, 'threat-analysis'))
    if (!root.startsWith(directory + sep)) throw new Error('path')
    return { root, catalog: join(root, 'catalog'), commit: index.commit as string, digest: index.digest as string }
  } catch { throw new Error('threat_source_integrity_failed') }
}
export async function ensureThreatSource(assetRoot: string, _opts?: unknown) {
  const source = await loadThreatSource(assetRoot)
  return { ...source, directory: source.root, bridgeModule: `${source.root}.mjs` }
}

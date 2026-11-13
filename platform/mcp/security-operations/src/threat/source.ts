import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

export const THREAT_SOURCE_COMMIT = 'c903724269be0ef249182e2fd7024325c7124629'
export const THREAT_SOURCE_DIRECTORY = 'threat-analysis'
export type ThreatSource = { root: string; catalog: string; commit: string; digest: string }

export function defaultThreatStateRoot(assetRoot: string) {
  if (existsSync(join(assetRoot, 'workspace.json'))) return join(assetRoot, 'mcp', '.local')
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'harness-platform', 'threat', createHash('sha256').update(assetRoot).digest('hex').slice(0, 16))
}

export async function ensureThreatSource(assetRoot: string, opts: { stateRoot?: string } = {}) {
  const source = await loadThreatSource(assetRoot, opts.stateRoot ?? defaultThreatStateRoot(assetRoot))
  return { ...source, directory: source.root, bridgeModule: `${source.root}.mjs` }
}

// 算法随程序分发；数据工作区只保存运行缓存与结果。
export async function loadThreatSource(assetRoot: string, stateRoot: string): Promise<ThreatSource> {
  const implementation = resolve(process.env.HARNESS_PROGRAM_ROOT || fileURLToPath(new URL('../../../../../', import.meta.url)), 'platform/mcp/security-operations/algorithm')
  const implementationDigest = await sourceDigest(implementation)
  const cache = join(stateRoot, 'cache', 'source', `${THREAT_SOURCE_COMMIT}-${implementationDigest.slice(0, 16)}`)
  const marker = join(cache, 'source.json')
  let metadata: { digest: string }
  let cached = false
  try { await lstat(cache); cached = true } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('threat_source_integrity_failed') }
  if (!cached) {
    await mkdir(dirname(cache), { recursive: true })
    const temporary = `${cache}.${randomUUID()}.tmp`
    await mkdir(temporary)
    try {
      await cp(implementation, join(temporary, 'implementation'), { recursive: true })
      // source.json 必须在根目录封只读前写入。
      metadata = { digest: await sourceDigest(join(temporary, 'implementation'), true) }
      await writeFile(join(temporary, 'source.json'), JSON.stringify(metadata), { mode: 0o444 })
      await chmod(temporary, 0o555)
      try { await rename(temporary, cache) }
      catch (error: any) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
    } catch { throw new Error('threat_source_unavailable') }
    finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined) }
  }
  try {
    if ((await lstat(cache)).isSymbolicLink() || (await lstat(marker)).isSymbolicLink()) throw new Error('symlink')
    metadata = JSON.parse(await readFile(marker, 'utf8'))
    if (!/^[0-9a-f]{64}$/.test(metadata.digest) || await sourceDigest(join(cache, 'implementation')) !== metadata.digest) throw new Error('digest')
  } catch { throw new Error('threat_source_integrity_failed') }
  const root = join(cache, 'implementation', THREAT_SOURCE_DIRECTORY)
  return { root, catalog: join(root, 'catalog'), commit: THREAT_SOURCE_COMMIT, digest: metadata.digest }
}

async function sourceDigest(root: string, seal = false) {
  const hash = createHash('sha256')
  async function walk(folder: string, prefix = ''): Promise<void> {
    if ((await lstat(folder)).isSymbolicLink()) throw new Error('source_symlink')
    for (const name of (await readdir(folder)).sort()) {
      const file = join(folder, name), stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error('source_symlink')
      if (stat.isDirectory()) await walk(file, `${prefix}${name}/`)
      else if (stat.isFile()) {
        hash.update(prefix + name).update('\0').update(await readFile(file))
        if (seal) await chmod(file, 0o444)
      } else throw new Error('source_file_type')
    }
    if (seal) await chmod(folder, 0o555)
  }
  await walk(root)
  return hash.digest('hex')
}

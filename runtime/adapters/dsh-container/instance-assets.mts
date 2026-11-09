import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appliedFiles, assetStatus, evaluationInstance, sourceAssets, type AssetFileCache } from './instance-assets.ts'

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const cache: AssetFileCache = Object.create(null)
  const cachePath = input.cache !== false && input.directory && join(input.directory, 'asset-file-cache.json')
  if (process.argv[2] === 'status' && cachePath) {
    try { Object.assign(cache, JSON.parse(readFileSync(cachePath, 'utf8'))) } catch {}
  }
  const value = process.argv[2] === 'evaluation' ? evaluationInstance(input.contract, input.manifest, input.generation, input.directory, input.model)
    : process.argv[2] === 'applied' ? appliedFiles(input.contract, input.manifest, input.directory)
    : process.argv[2] === 'source' ? sourceAssets(input.contract, input.manifest, input.directory)
    : assetStatus(input.contract, input.manifest, input.generation, input.state, input.directory, cachePath ? cache : undefined)
  if (process.argv[2] === 'status' && cachePath) {
    try {
      const temporary = `${cachePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 })
      renameSync(temporary, cachePath)
    } catch { /* 派生缓存不可写时不影响状态核对。 */ }
  }
  process.stdout.write(JSON.stringify(value))
} catch (error) {
  process.stderr.write(`资产装载核对失败：${(error as Error).message}\n`)
  process.exitCode = 1
}

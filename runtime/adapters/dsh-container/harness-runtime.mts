import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectHarnessPresets } from '../../../platform/plugin/src/models/harness-runtime.ts'

try {
  const [candidate, destination, runtimeFile] = process.argv.slice(2)
  if (candidate === '--private-files') {
    if (!destination || !runtimeFile || !/^(?:EXP|VAR)-[a-z0-9-]+-[0-9]{3}(?:-r[0-9a-f]{12})?$/.test(runtimeFile)) throw new Error('私有运行文件缺少有效的来源版本')
    const parent = resolve(destination, '.local/verification-private-files'), folder = join(parent, runtimeFile)
    const privateDirectory = (path: string) => {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('私有运行文件目录必须由当前用户持有且仅本人可访问')
    }
    if (existsSync(parent)) privateDirectory(parent)
    let present = true
    try { lstatSync(folder) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error }
    if (!present) { process.stdout.write('[]'); process.exit(0) }
    privateDirectory(folder)
    const files = readdirSync(folder)
    for (const name of files) {
      const stat = lstatSync(join(folder, name))
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('私有运行文件必须为当前用户持有、仅本人可读写的普通文件')
    }
    process.stdout.write(JSON.stringify(files.length ? [{ source: folder, target: '/var/lib/dsh/private', read_only: true }] : []))
    process.exit(0)
  }
  if (candidate === '--build-evidence') {
    const { assetBuildReviewEvidence } = await import('../../../platform/plugin/src/agents/asset-build.ts')
    if (!destination || !runtimeFile) throw new Error('缺少构建审读来源参数')
    process.stdout.write(JSON.stringify(assetBuildReviewEvidence(destination, runtimeFile)))
    process.exit(0)
  }
  if (candidate === '--dependencies') {
    const { resolvePreparedAssetDependencies } = await import('../../../platform/plugin/src/agents/asset-dependencies.ts')
    const [, root, id, image, imageId, candidatePath] = process.argv.slice(2)
    if (!root || !id) throw new Error('缺少依赖来源参数')
    const result = resolvePreparedAssetDependencies(root, id, { ...(image ? { image } : {}), ...(imageId ? { image_id: imageId } : {}) }, candidatePath)
    process.stdout.write(JSON.stringify(result))
    process.exit(result.status === 'ready' ? 0 : 1)
  }
  if (!candidate || !destination || !runtimeFile) throw new Error('缺少运行投影参数')
  projectHarnessPresets(candidate, destination, JSON.parse(readFileSync(runtimeFile, 'utf8')))
} catch (error) {
  process.stderr.write((error as Error).message + '\n')
  process.exitCode = 1
}

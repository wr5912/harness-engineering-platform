import { readFileSync } from 'node:fs'
import { projectHarnessPresets } from '../../../platform/plugin/src/models/harness-runtime.ts'

try {
  const [candidate, destination, runtimeFile] = process.argv.slice(2)
  if (candidate === '--build-evidence') {
    const { assetBuildReviewEvidence } = await import('../../../platform/plugin/src/agents/asset-build.ts')
    if (!destination || !runtimeFile) throw new Error('缺少构建审读来源参数')
    process.stdout.write(JSON.stringify(assetBuildReviewEvidence(destination, runtimeFile)))
    process.exit(0)
  }
  if (candidate === '--dependencies') {
    const { resolvePreparedAssetDependencies } = await import('../../../platform/plugin/src/agents/asset-dependencies.ts')
    const [, root, id, image, imageId] = process.argv.slice(2)
    if (!root || !id) throw new Error('缺少依赖来源参数')
    const result = resolvePreparedAssetDependencies(root, id, { ...(image ? { image } : {}), ...(imageId ? { image_id: imageId } : {}) })
    process.stdout.write(JSON.stringify(result))
    process.exit(result.status === 'ready' ? 0 : 1)
  }
  if (!candidate || !destination || !runtimeFile) throw new Error('缺少运行投影参数')
  projectHarnessPresets(candidate, destination, JSON.parse(readFileSync(runtimeFile, 'utf8')))
} catch (error) {
  process.stderr.write((error as Error).message + '\n')
  process.exitCode = 1
}

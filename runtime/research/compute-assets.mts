import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { previewComputeAssets, applyComputeAssets } from '../../platform/plugin/src/agents/compute-assets.ts'
import { archiveDecisionTraining } from '../../platform/plugin/src/agents/compute-training.ts'
import { sha256 } from '../../platform/plugin/src/tasks/files.ts'

/** 本地资产工具；预览不写数据根，应用只复用现有 edit 或训练归档，不连接运行实例。 */
export async function main(args: string[]) {
  const [method, ...flags] = args, values: Record<string, string> = {}
  if (!['preview', 'apply', 'training-preview', 'training-archive'].includes(method ?? '') || flags.length % 2) throw Error('用法：compute-assets.mts preview|apply|training-preview|training-archive --asset-root <绝对路径> --experiment-id <ID> --request <JSON文件> [--expected-preview-sha256 <摘要>]')
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i]!
    if (!['--asset-root', '--experiment-id', '--request', '--expected-preview-sha256'].includes(name) || values[name] || !flags[i + 1]) throw Error('参数缺失或重复')
    values[name] = flags[i + 1]!
  }
  const root = values['--asset-root'], id = values['--experiment-id'], requestPath = values['--request']
  if (!root?.startsWith('/') || !id || !requestPath) throw Error('必须明确指定绝对数据根、版本身份和请求文件')
  const request = JSON.parse(readFileSync(requestPath, 'utf8')), expected = values['--expected-preview-sha256']
  if (method === 'preview') return previewComputeAssets(root, id, request)
  if (method === 'apply') {
    if (request.experiment_id !== id || !expected) throw Error('应用必须使用同一版本的固定预览及其摘要')
    const { createAgentsHandler } = await import('../../platform/plugin/src/agents/index.ts')
    const handler = createAgentsHandler(root)
    return applyComputeAssets(root, request, expected, async (endpoint, body) => {
      const result = await handler(endpoint, body, new AbortController().signal)
      if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    })
  }
  if (method === 'training-preview') {
    const preview = await archiveDecisionTraining(root, id, undefined, request.training_files ?? [], true)
    return { preview_sha256: sha256(JSON.stringify(preview)), archive: preview }
  }
  if (!expected) throw Error('请先核对当前训练归档预览及其摘要')
  return archiveDecisionTraining(root, id, undefined, request.training_files ?? [], false, expected)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
  .then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
  .catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : '资产整理失败' }) + '\n'); process.exitCode = 1 })

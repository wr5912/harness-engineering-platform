import { versionSource, versionSources } from '../../../platform/plugin/src/agents/version-source.ts'

try {
  const [root, id, commit] = process.argv.slice(2)
  if (!root) throw new Error('缺少数据工作区')
  const checked = commit === '--check-assets' || commit === '--analysis-assets'
  const source = checked ? (await import('../../../platform/plugin/src/agents/candidate-assets.ts')).assertCandidateAssets(root, id, commit !== '--analysis-assets')
    : id ? versionSource(root, id, commit) : versionSources(root)
  process.stdout.write(JSON.stringify(source))
} catch (error) {
  const failed = error as Error & { code?: string; details?: Record<string, unknown> }
  process.stderr.write((failed.code ? JSON.stringify({ code: failed.code, message: failed.message, ...failed.details }) : failed.message) + '\n')
  process.exitCode = 1
}

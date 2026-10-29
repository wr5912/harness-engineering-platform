import { versionSource, versionSources } from '../../../platform/plugin/src/agents/version-source.ts'

try {
  const [root, id, commit] = process.argv.slice(2)
  if (!root) throw new Error('缺少数据工作区')
  process.stdout.write(JSON.stringify(id ? versionSource(root, id, commit) : versionSources(root)))
} catch (error) {
  process.stderr.write((error as Error).message + '\n')
  process.exitCode = 1
}

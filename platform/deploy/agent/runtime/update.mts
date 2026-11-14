import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { collectEntries, writeChecksums } from '../../manifest.mts'
import { harnessDigest } from '../layout.mts'
import { agentCandidateDigest } from '../snapshot.mts'
import { writeCompactRuntime } from './compact.mts'
import { migrateStandaloneConnections } from '../../../plugin/src/standalone/connections.ts'

const { load } = createRequire(new URL('../../../plugin/package.json', import.meta.url))('js-yaml')

/** 已安装实例复用标准运行器；HOME 留在原处，旧执行制品备份在安装目录外。 */
export async function updateAgentRuntime(root: string, programRoot: string, image: { tag: string; id: string; fingerprint: string }) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (manifest.kind !== 'standalone-agent' || ![1, 2].includes(manifest.schemaVersion) || manifest.source?.profile === 'sdk')
    throw new Error('运行时升级需要已安装的原生 Web 智能体包')
  const native = manifest.schemaVersion === 2
  const deploymentFile = join(root, native ? 'config/deployment.env' : 'state/deployment.env')
  const deployment = existsSync(deploymentFile) ? readFileSync(deploymentFile, 'utf8') : ''
  const external = parseEnv(deployment).AGENT_HARNESS_ROOT
  const harnessRoot = native ? realpathSync(external ? resolve(root, external) : join(root, 'harness')) : dirname(realpathSync(join(root, 'assets/harness.yaml')))
  const harness = load(readFileSync(join(harnessRoot, 'harness.yaml'), 'utf8')) as any
  const assets = harness?.loadable_assets
  if (harness?.agent?.id !== manifest.source.agentId || !assets?.profile_patch?.startsWith('dsh/managed/'))
    throw new Error('安装的 Harness 缺少匹配的原生装载声明')
  for (const name of ['workspace', 'presets', 'managed']) {
    const path = join(harnessRoot, 'dsh', name)
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`Harness 缺少 dsh/${name}`)
  }
  const sourceId = manifest.source.experimentId?.startsWith('business:') ? manifest.source.experimentId : `business:${manifest.source.agentId}`
  const seedRoot = join(root, native ? 'config/seed' : 'config-seed')
  const prepared = mkdtempSync(join(dirname(root), '.agent-runtime-'))
  const backup = mkdtempSync(join(dirname(root), `.${manifest.source.agentId}-runtime-backup-`))
  const moved: string[] = [], installed: string[] = []
  try {
    await writeCompactRuntime(prepared, { programRoot, imageTag: image.tag, imageId: image.id, imageFingerprint: image.fingerprint,
      arch: manifest.package.arch, agentId: manifest.source.agentId, experimentId: sourceId,
      presetId: assets.preset_id, profilePatch: assets.profile_patch.slice('dsh/managed/'.length), profile: 'web', harnessRoot })
    cpSync(seedRoot, join(prepared, 'config/seed'), { recursive: true })
    const migrate = (value: any) => ({ ...migrateStandaloneConnections(value, join(harnessRoot, 'dsh/managed')),
      experimentId: sourceId, presetId: assets.preset_id, profilePatch: assets.profile_patch.slice('dsh/managed/'.length) })
    const seedFile = join(prepared, 'config/seed/standalone.json')
    writeFileSync(seedFile, JSON.stringify(migrate(JSON.parse(readFileSync(seedFile, 'utf8'))), null, 2) + '\n', { mode: 0o600 })
    if (deployment) {
      const overrides = deployment.split('\n').filter(line => !/^(?:IMAGE_TAG|IMAGE_ID|IMAGE_FINGERPRINT|AGENT_ID|AGENT_ARCH|AGENT_PROFILE)=/.test(line)).join('\n')
      const generated = join(prepared, 'config/deployment.env')
      writeFileSync(generated, readFileSync(generated, 'utf8') + overrides + '\n', { mode: 0o600 })
    }
    if (!native) symlinkSync(harnessRoot, join(prepared, 'harness'), 'dir')
    const currentFile = join(root, 'state/home/standalone/config.json')
    if (existsSync(currentFile)) cpSync(currentFile, join(backup, 'standalone-config.json'))
    // 移动旧文件而非复制大型运行环境；回滚时可以原位恢复。
    for (const path of ['agent', 'standalone_agent_launcher', 'manifest.json', 'SHA256SUMS', 'config', 'images', ...(!native ? ['assets', 'runtime', 'mcp', 'config-seed', 'install.sh', 'README.md'] : [])]) {
      if (!existsSync(join(root, path))) continue
      renameSync(join(root, path), join(backup, path)); moved.push(path)
    }
    for (const path of ['standalone_agent_launcher', 'config', ...(!native ? ['harness'] : [])]) {
      renameSync(join(prepared, path), join(root, path)); installed.push(path)
    }
    if (existsSync(currentFile)) writeFileSync(currentFile, JSON.stringify(migrate(JSON.parse(readFileSync(currentFile, 'utf8'))), null, 2) + '\n', { mode: 0o600 })
    delete manifest.extensions
    manifest.schemaVersion = 2
    const git = (args: string[]) => { const result = spawnSync('git', args, { cwd: harnessRoot, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : undefined }
    manifest.source = { ...manifest.source, experimentId: sourceId, candidateSha256: agentCandidateDigest(harnessRoot),
      commit: git(['rev-parse', 'HEAD']) ?? manifest.source.commit, dirty: Boolean(git(['status', '--porcelain']) ?? 'unknown'),
      harnessSha256: harnessDigest(harnessRoot), files: [], omitted: [],
      paths: { workspace: 'harness/dsh/workspace', presets: 'harness/dsh/presets', managed: 'harness/dsh/managed',
        profilePatch: `harness/${assets.profile_patch}`, preset: `harness/dsh/presets/${assets.preset_file ?? `${assets.preset_id}/agent.cordis.yml`}` } }
    manifest.image = { tag: image.tag, id: image.id, fingerprint: image.fingerprint, arch: manifest.package.arch }
    manifest.files = collectEntries(root, ['state', '.env', 'manifest.json', 'SHA256SUMS'])
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    writeChecksums(root, manifest.files)
    return { runtimeUpdated: root, harnessRoot, image: image.tag, backup, restartRequired: true }
  } catch (error) {
    for (const path of installed) rmSync(join(root, path), { recursive: true, force: true })
    for (const path of [...moved].reverse()) {
      rmSync(join(root, path), { recursive: true, force: true })
      renameSync(join(backup, path), join(root, path))
    }
    if (existsSync(join(backup, 'standalone-config.json'))) cpSync(join(backup, 'standalone-config.json'), join(root, 'state/home/standalone/config.json'))
    throw error
  } finally { rmSync(prepared, { recursive: true, force: true }) }
}

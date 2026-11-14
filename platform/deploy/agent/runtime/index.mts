import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stageManagedProjections } from './projections.mts'
import { collectEntries, sha256File, writeChecksums } from '../../manifest.mts'
import { writeCompactRuntime } from './compact.mts'
import { migrateStandaloneConnections } from '../../../plugin/src/standalone/connections.ts'

export interface RuntimeBundleOptions { programRoot: string; imageTag: string; imageId?: string; imageFingerprint?: string; arch: 'amd64' | 'arm64'; agentId: string; experimentId: string; presetId: string; profilePatch: string; profile?: 'web' | 'sdk'; harnessRuntime?: any; harnessRoot?: string }

/** 已有预览沿用冻结资产，只刷新同一版本的运行器，不生成归档。 */
export async function refreshAgentPreview(root: string, programRoot: string, preview: { agentId: string; experimentId: string; candidateSha256: string; arch: string }) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (manifest.kind !== 'standalone-agent' || manifest.source.agentId !== preview.agentId
    || manifest.source.experimentId !== preview.experimentId || manifest.source.candidateSha256 !== preview.candidateSha256
    || manifest.package.arch !== preview.arch) throw new Error('预览目录与所选智能体版本、资产摘要或架构不一致')
  if (manifest.source.profile === 'sdk') throw new Error('现有预览运行器刷新仅支持 Web 包；SDK 包请使用正式导出入口')
  if (manifest.schemaVersion === 2) {
    if (!/^sha256:[0-9a-f]{64}$/.test(manifest.image?.id ?? '') || !/^sha256:[0-9a-f]{64}$/.test(manifest.image?.fingerprint ?? '')) throw new Error('预览缺少标准 Runtime 镜像身份；请重新导出')
    const composeFile = join(root, 'config/compose.yaml')
    const compose = JSON.parse(readFileSync(composeFile, 'utf8'))
    for (const service of Object.values(compose.services) as any[]) {
      if (![manifest.image.id, manifest.image.tag].includes(service.image) || service.build) throw new Error('预览 Compose 未使用标准 Runtime 镜像；请重新导出')
      service.image = manifest.image.id
    }
    writeFileSync(composeFile, JSON.stringify(compose, null, 2) + '\n')
    const deploymentFile = join(root, 'config/deployment.env')
    let deployment = readFileSync(deploymentFile, 'utf8')
    for (const [key, value] of Object.entries({ IMAGE_TAG: manifest.image.tag, IMAGE_ID: manifest.image.id, IMAGE_FINGERPRINT: manifest.image.fingerprint })) {
      const pattern = new RegExp(`^${key}=.*$`, 'm')
      deployment = pattern.test(deployment) ? deployment.replace(pattern, `${key}=${value}`) : deployment.trimEnd() + `\n${key}=${value}\n`
    }
    writeFileSync(deploymentFile, deployment, { mode: 0o600 })
    // 镜像承载运行器；预览刷新只更新入口，不改写现场配置或旧包目录。
    cpSync(join(programRoot, 'platform/deploy/agent/runtime/standalone_agent_launcher'), join(root, 'standalone_agent_launcher'))
    rmSync(join(root, 'agent'), { force: true })
    chmodSync(join(root, 'standalone_agent_launcher'), 0o755)
    cpSync(join(programRoot, 'platform/deploy/agent/runtime/config.README.md'), join(root, 'config/README.md'))
    const refreshed = ['standalone_agent_launcher', 'config/README.md', 'config/deployment.env', 'config/compose.yaml']
    manifest.files = manifest.files.filter((file: { path: string }) => file.path !== 'agent' && !refreshed.includes(file.path))
    manifest.files.push(...refreshed.map(path => ({ path, type: 'file', sha256: sha256File(join(root, path)), mode: lstatSync(join(root, path)).mode & 0o777 })))
    manifest.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    writeChecksums(root, manifest.files)
    return
  }
  const seedFile = join(root, 'config-seed/standalone.json')
  const config = migrateStandaloneConnections(JSON.parse(readFileSync(seedFile, 'utf8')), join(root, 'assets/managed'))
  writeFileSync(seedFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  for (const legacy of ['runtime/lfx', 'runtime/extensions', 'mcp/compositions']) rmSync(join(root, legacy), { recursive: true, force: true })
  delete manifest.extensions
  await writeLegacyRuntimeBundle(root, { programRoot, imageTag: manifest.image.tag, imageId: manifest.image.id,
    imageFingerprint: manifest.image.fingerprint, arch: manifest.package.arch, agentId: config.agentId,
    experimentId: config.experimentId, presetId: config.presetId, profilePatch: config.profilePatch, profile: config.profile })
  rmSync(join(root, 'agent'), { force: true })
  const refreshed = ['standalone_agent_launcher', 'install.sh', 'README.md', 'config-seed/standalone.json']
  manifest.files = manifest.files.filter((file: { path: string }) => !file.path.startsWith('runtime/') && !file.path.startsWith('mcp/compositions/') && file.path !== 'agent' && !refreshed.includes(file.path))
  manifest.files.push(...collectEntries(join(root, 'runtime')).map(file => ({ ...file, path: `runtime/${file.path}` })),
    ...refreshed.map(path => ({ path, type: 'file', sha256: sha256File(join(root, path)), mode: lstatSync(join(root, path)).mode & 0o777 })))
  manifest.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  writeChecksums(root, manifest.files)
}

/** 目标机只用 Bash 和 Docker；Node、DSH 与初始化均在同一标准镜像内执行。 */
export async function writeLegacyRuntimeBundle(staging: string, options: RuntimeBundleOptions) {
  if (!options.programRoot) throw new Error('独立运行器需要明确的平台程序根')
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId ?? '') || !/^sha256:[0-9a-f]{64}$/.test(options.imageFingerprint ?? '')) throw new Error('运行包需要完整的标准 Runtime 不可变镜像 ID 和构建指纹')
  const programRoot = options.programRoot
  const root = join(staging, 'runtime')
  mkdirSync(root, { recursive: true })
  for (const name of ['standalone-bootstrap.js', 'standalone-plugin.js', 'standalone-bridge.js', 'standalone-connection.js']) {
    const source = join(programRoot, 'platform/plugin/lib', name)
    if (!existsSync(source)) throw new Error(`独立运行器未构建：${name}；请构建平台插件后再导出`)
    cpSync(source, join(root, name))
  }
  const offlineProvider = join(programRoot, 'platform/plugin/lib/standalone-knowledge.js')
  if (existsSync(offlineProvider)) cpSync(offlineProvider, join(root, 'standalone-knowledge.js'))
  const sdk = options.profile === 'sdk'
  if (!sdk) {
    const web = join(programRoot, 'runtime/adapters/dsh-web/lib')
    if (!existsSync(join(web, 'container-webserver.mjs'))) throw new Error('独立 Web 适配器未构建')
    cpSync(web, join(root, 'web'), { recursive: true })
  }
  cpSync(join(programRoot, 'runtime/adapters/dsh-container/runtime-compat'), join(root, 'runtime-compat'), { recursive: true })
  cpSync(join(programRoot, 'platform/deploy/bootstrap-docker.sh'), join(root, 'bootstrap-docker.sh'))
  for (const name of ['install.sh', 'standalone_agent_launcher']) cpSync(join(programRoot, 'platform/deploy/agent/runtime', name), join(staging, name), { preserveTimestamps: true })
  chmodSync(join(staging, 'standalone_agent_launcher'), 0o755)
  cpSync(join(programRoot, 'platform/deploy/agent/runtime/README.md'), join(staging, 'README.md'))
  const projections = stageManagedProjections(staging, programRoot)
  const volume = [
    { type: 'bind', source: './assets/workspace', target: '/work/harness/workspace', read_only: true },
    { type: 'bind', source: sdk && options.harnessRuntime ? './runtime/projections/presets' : './assets/presets', target: '/opt/dsh-presets', read_only: true },
    { type: 'bind', source: projections.length ? './runtime/projections/managed' : './assets/managed', target: '/opt/dsh-managed', read_only: true },
    { type: 'bind', source: '.', target: '/opt/standalone', read_only: true },
    { type: 'bind', source: './state/home', target: '/var/lib/dsh' },
  ]
  volume.push({ type: 'bind', source: './state/home/profiles/node_modules', target: '/opt/node_modules', read_only: true })
  if (sdk && options.harnessRuntime) {
    if (existsSync(join(staging, 'assets/candidate'))) {
      // Docker 不能在只读父挂载内创建子挂载点；仅在制品中准备空目录，源资产不变。
      for (const name of ['workspace', 'presets', 'managed']) mkdirSync(join(staging, 'assets/candidate/dsh', name), { recursive: true })
      volume.push({ type: 'bind', source: './assets/candidate', target: '/opt/harness-candidate', read_only: true })
    }
    for (const name of ['workspace', 'presets', 'managed']) volume.push({ type: 'bind', source: `./assets/${name}`, target: `/opt/harness-candidate/dsh/${name}`, read_only: true })
    volume.push({ type: 'bind', source: './runtime/model-binding-runtime.js', target: '/opt/harness-model-runtime/model-binding-runtime.mjs', read_only: true })
  }
  const common = { image: options.imageId, pull_policy: 'never', working_dir: '/work/harness/workspace', volumes: volume,
    environment: { HOME: '/var/lib/dsh', DSH_HOME: '/var/lib/dsh', STANDALONE_UID: '${AGENT_UID:-1000}', STANDALONE_GID: '${AGENT_GID:-1000}', ...(!sdk ? { STANDALONE_HOST: '${AGENT_HOST:-127.0.0.1}', STANDALONE_PORT: '${AGENT_PORT:-18500}' } : {}), STANDALONE_ROOT: '/opt/standalone', DSH_TELEMETRY_DISABLED: '1', HARNESS_DSH_ENTRY: '/opt/dsh/apps/cli/lib/bin.js', ...(sdk ? { HARNESS_SDK_OPTIONS: '/var/lib/dsh/standalone/sdk-options.json' } : {}) } }
  const compose = { services: {
    init: { ...common, user: '0:0', network_mode: 'none', entrypoint: ['/bin/sh', '-c'], command: ['node /opt/standalone/runtime/standalone-bootstrap.js init && chown -R $$STANDALONE_UID:$$STANDALONE_GID /var/lib/dsh'] },
    dsh: { ...common, user: '${AGENT_UID:-1000}:${AGENT_GID:-1000}', init: true, depends_on: { init: { condition: 'service_completed_successfully' } },
      environment: { ...common.environment, NODE_USE_ENV_PROXY: '1' },
      env_file: [{ path: './.env', required: false }],
      entrypoint: ['node', '/opt/standalone/runtime/standalone-bootstrap.js'], command: sdk ? ['sdk-run', '/var/lib/dsh/standalone/input.json'] : ['start'],
      ...(!sdk ? { ports: ['${AGENT_PORT:-18500}:3080'], healthcheck: { test: ['CMD', 'node', '-e', "const ip=Object.values(require('node:os').networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&!a.internal).address;fetch('http://'+ip+':3080/assistant/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"], interval: '2s', timeout: '3s', start_period: '180s', retries: 30 } } : {}),
      extra_hosts: ['host.docker.internal:host-gateway'], stop_grace_period: '20s' },
  } }
  writeFileSync(join(root, 'compose.yaml'), JSON.stringify(compose, null, 2) + '\n')
  writeFileSync(join(root, 'bundle.env'), `AGENT_ID=${options.agentId}\nAGENT_ARCH=${options.arch}\nAGENT_PROFILE=${options.profile ?? 'web'}\nIMAGE_TAG=${options.imageTag}\nIMAGE_ID=${options.imageId || ''}\nIMAGE_FINGERPRINT=${options.imageFingerprint || ''}\n`)
}

export const writeRuntimeBundle = writeCompactRuntime

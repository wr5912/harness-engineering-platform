import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stageManagedProjections } from './projections.mts'

export interface RuntimeBundleOptions { programRoot: string; imageTag: string; imageId?: string; imageFingerprint?: string; arch: 'amd64' | 'arm64'; agentId: string; experimentId: string; presetId: string; profilePatch: string; bridgeRequired?: boolean }

/** 目标机只用 Bash 和 Docker；Node、DSH 与初始化均在同一标准镜像内执行。 */
export async function writeRuntimeBundle(staging: string, options: RuntimeBundleOptions) {
  if (!options.programRoot) throw new Error('独立运行器需要明确的平台程序根')
  const programRoot = options.programRoot
  const root = join(staging, 'runtime')
  mkdirSync(root, { recursive: true })
  for (const name of ['standalone-bootstrap.js', 'standalone-plugin.js', 'standalone-bridge.js']) {
    const source = join(programRoot, 'platform/plugin/lib', name)
    if (!existsSync(source)) throw new Error(`独立运行器未构建：${name}；请构建平台插件后再导出`)
    cpSync(source, join(root, name))
  }
  const offlineProvider = join(programRoot, 'platform/plugin/lib/standalone-knowledge.js')
  if (existsSync(offlineProvider)) cpSync(offlineProvider, join(root, 'standalone-knowledge.js'))
  const web = join(programRoot, 'runtime/adapters/dsh-web/lib')
  if (!existsSync(join(web, 'container-webserver.mjs'))) throw new Error('独立 Web 适配器未构建')
  cpSync(web, join(root, 'web'), { recursive: true })
  cpSync(join(programRoot, 'runtime/adapters/dsh-container/runtime-compat'), join(root, 'runtime-compat'), { recursive: true })
  cpSync(join(programRoot, 'platform/deploy/bootstrap-docker.sh'), join(root, 'bootstrap-docker.sh'))
  for (const name of ['install.sh', 'agent']) cpSync(join(programRoot, 'platform/deploy/agent/runtime', name), join(staging, name), { preserveTimestamps: true })
  const projections = stageManagedProjections(staging, programRoot)
  const volume = [
    { type: 'bind', source: './assets/workspace', target: '/work/harness/workspace', read_only: true },
    { type: 'bind', source: './assets/presets', target: '/opt/dsh-presets', read_only: true },
    { type: 'bind', source: projections.length ? './runtime/projections/managed' : './assets/managed', target: '/opt/dsh-managed', read_only: true },
    { type: 'bind', source: '.', target: '/opt/standalone', read_only: true },
    { type: 'bind', source: './state/home', target: '/var/lib/dsh' },
  ]
  const common = { image: options.imageTag, pull_policy: 'never', working_dir: '/work/harness/workspace', volumes: volume,
    environment: { DSH_HOME: '/var/lib/dsh', STANDALONE_UID: '${AGENT_UID:-1000}', STANDALONE_GID: '${AGENT_GID:-1000}', STANDALONE_HOST: '${AGENT_HOST:-127.0.0.1}', STANDALONE_PORT: '${AGENT_PORT:-18500}', STANDALONE_ROOT: '/opt/standalone', DSH_TELEMETRY_DISABLED: '1', HARNESS_DSH_ENTRY: '/opt/dsh/apps/cli/lib/bin.js' } }
  const compose = { services: {
    init: { ...common, user: '0:0', network_mode: 'none', entrypoint: ['/bin/sh', '-c'], command: ['node /opt/standalone/runtime/standalone-bootstrap.js init && chown -R $$STANDALONE_UID:$$STANDALONE_GID /var/lib/dsh'] },
    dsh: { ...common, user: '${AGENT_UID:-1000}:${AGENT_GID:-1000}', init: true, depends_on: { init: { condition: 'service_completed_successfully' } },
      entrypoint: ['node', '/opt/standalone/runtime/standalone-bootstrap.js'], command: ['start'],
      ports: ['${AGENT_PORT:-18500}:3080'], extra_hosts: ['host.docker.internal:host-gateway'],
      healthcheck: { test: ['CMD', 'node', '-e', "const ip=Object.values(require('node:os').networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&!a.internal).address;fetch('http://'+ip+':3080/assistant/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"], interval: '2s', timeout: '3s', retries: 30 }, stop_grace_period: '20s' },
  } }
  writeFileSync(join(root, 'compose.yaml'), JSON.stringify(compose, null, 2) + '\n')
  writeFileSync(join(root, 'bundle.env'), `AGENT_ID=${options.agentId}\nAGENT_ARCH=${options.arch}\nIMAGE_TAG=${options.imageTag}\nIMAGE_ID=${options.imageId || ''}\nIMAGE_FINGERPRINT=${options.imageFingerprint || ''}\n`)
}

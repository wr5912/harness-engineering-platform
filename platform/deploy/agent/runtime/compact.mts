import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeBundleOptions } from './index.mts'

/** 通用适配器在标准镜像内；归档只带 Harness、入口和现场配置。 */
export async function writeCompactRuntime(staging: string, options: RuntimeBundleOptions) {
  if (!options.programRoot) throw new Error('运行包需要明确的平台程序根')
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId ?? '') || !/^sha256:[0-9a-f]{64}$/.test(options.imageFingerprint ?? '')) throw new Error('运行包需要完整的标准 Runtime 不可变镜像 ID 和构建指纹')
  const sdk = options.profile === 'sdk', runtime = '/opt/dsh-standalone'
  mkdirSync(join(staging, 'config/seed'), { recursive: true, mode: 0o700 })
  copyFileSync(join(options.programRoot, 'platform/deploy/agent/runtime/standalone_agent_launcher'), join(staging, 'standalone_agent_launcher'))
  chmodSync(join(staging, 'standalone_agent_launcher'), 0o755)
  copyFileSync(join(options.programRoot, 'platform/deploy/agent/runtime/config.README.md'), join(staging, 'config/README.md'))
  const volumes = [
    { type: 'bind', source: '${AGENT_HARNESS_ROOT:-./harness}', target: '/opt/standalone/harness', read_only: true, bind: { create_host_path: false } },
    { type: 'bind', source: '${AGENT_HARNESS_ROOT:-./harness}', target: '/opt/harness-candidate', read_only: true, bind: { create_host_path: false } },
    { type: 'bind', source: '${AGENT_HARNESS_ROOT:-./harness}/dsh/workspace', target: '/work/harness/workspace', read_only: true, bind: { create_host_path: false } },
    { type: 'bind', source: './config/seed', target: '/opt/standalone/config/seed', read_only: true },
    { type: 'bind', source: './state/home', target: '/var/lib/dsh' },
    { type: 'bind', source: './state/home/standalone/managed', target: '/opt/dsh-managed', read_only: true },
    { type: 'bind', source: './state/home/standalone/presets', target: '/opt/dsh-presets', read_only: true },
    { type: 'bind', source: './state/home/profiles/node_modules', target: '/opt/node_modules', read_only: true },
  ]
  const common = { image: options.imageId, pull_policy: 'never', working_dir: '/work/harness/workspace', volumes,
    environment: { HOME: '/var/lib/dsh', DSH_HOME: '/var/lib/dsh', STANDALONE_ROOT: '/opt/standalone',
      STANDALONE_RUNTIME: runtime, STANDALONE_UID: '${AGENT_UID:-1000}', STANDALONE_GID: '${AGENT_GID:-1000}',
      STANDALONE_HOST: '${AGENT_HOST:-127.0.0.1}', ...(!sdk ? { STANDALONE_PORT: '${AGENT_PORT:-18500}' } : {}),
      DSH_TELEMETRY_DISABLED: '1', HARNESS_DSH_ENTRY: '/opt/dsh/apps/cli/lib/bin.js',
      ...(sdk ? { HARNESS_SDK_OPTIONS: '/var/lib/dsh/standalone/sdk-options.json' } : {}) } }
  const compose = { services: {
    init: { ...common, user: '0:0', network_mode: 'none', entrypoint: ['/bin/sh', '-c'],
      command: [`node ${runtime}/standalone-bootstrap.js init && chown -R $$STANDALONE_UID:$$STANDALONE_GID /var/lib/dsh`] },
    dsh: { ...common, user: '${AGENT_UID:-1000}:${AGENT_GID:-1000}', init: true,
      environment: { ...common.environment, NODE_USE_ENV_PROXY: '1' },
      env_file: [{ path: './config/deployment.env', required: false }, { path: './.env', required: false }],
      depends_on: { init: { condition: 'service_completed_successfully' } },
      entrypoint: ['node', `${runtime}/standalone-bootstrap.js`],
      command: sdk ? ['sdk-run', '/var/lib/dsh/standalone/input.json'] : ['start'],
      ...(!sdk ? { ports: ['${AGENT_PORT:-18500}:3080'], healthcheck: { test: ['CMD', 'node', '-e', "const ip=Object.values(require('node:os').networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&!a.internal).address;fetch('http://'+ip+':3080/assistant/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"], interval: '2s', timeout: '3s', start_period: '180s', retries: 30 } } : {}),
      extra_hosts: ['host.docker.internal:host-gateway'], stop_grace_period: '20s' },
  } }
  writeFileSync(join(staging, 'config/compose.yaml'), JSON.stringify(compose, null, 2) + '\n')
  writeFileSync(join(staging, 'config/deployment.env'), `# 修改后运行 ./standalone_agent_launcher restart；首次启动自动导入随包镜像。\nAGENT_ID=${options.agentId}\nAGENT_ARCH=${options.arch}\nAGENT_PROFILE=${options.profile ?? 'web'}\nIMAGE_TAG=${options.imageTag}\nIMAGE_ID=${options.imageId}\nIMAGE_FINGERPRINT=${options.imageFingerprint}\n# AGENT_PORT=18500\n# AGENT_HOST=192.168.1.10\n# AGENT_HARNESS_ROOT=/absolute/path/to/harness\n# AGENT_UID=1000\n# AGENT_GID=1000\n# COMPOSE_PROJECT_NAME=hep-agent-${options.agentId}\n# HTTP_PROXY=http://host.docker.internal:7897\n# HTTPS_PROXY=http://host.docker.internal:7897\n# NO_PROXY=localhost,127.0.0.1,host.docker.internal\n`)
  const environmentTemplate = join(options.harnessRoot ?? join(staging, 'harness'), 'dsh/workspace/deployment.env.example')
  if (existsSync(environmentTemplate)) appendFileSync(join(staging, 'config/deployment.env'), '\n# 业务 Harness 公开环境配置\n' + readFileSync(environmentTemplate, 'utf8').trimEnd() + '\n')
}

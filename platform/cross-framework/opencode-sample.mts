import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SAMPLE_NAME = 'hep-cross-framework-opencode'
const SAMPLE_NETWORK = 'hep-cross-framework-opencode'
const here = dirname(fileURLToPath(import.meta.url))
function docker(args: string[]) { return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim() }
export interface OpenCodeSampleOptions { sourceRoot: string; stateRoot: string; port?: number; bunBinary?: string; image?: string }

/** 测试样本部署，不给平台产品授予接管外部实例生命周期的能力。 */
export function startOpenCodeSample(options: OpenCodeSampleOptions) {
  const source = resolve(options.sourceRoot), state = resolve(options.stateRoot), port = options.port ?? 18655
  const version = JSON.parse(readFileSync(join(source, 'packages/cli/package.json'), 'utf8')).version
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (version !== '2.2.5' || commit !== '9bbb8ce18c80f099e0e448775f59d965ead40a21') throw new Error('OpenCode 样本源码与锁定版本不匹配')
  if (!existsSync(join(state, 'server-credential.json'))) throw new Error('先配置专用服务凭据，不能把秘密写入命令行')
  const home = join(state, 'container-home'), workspace = join(state, 'workspace')
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(workspace, { recursive: true, mode: 0o700 })
  try { docker(['network', 'inspect', SAMPLE_NETWORK]) } catch { docker(['network', 'create', SAMPLE_NETWORK]) }
  try {
    const existing = JSON.parse(docker(['inspect', SAMPLE_NAME]))[0]
    if (existing.Config.Labels?.['hep.sample'] !== 'cross-framework-opencode') throw new Error('同名容器不属于本任务')
    if (existing.State.Running) {
      const mappedPort = Number(existing.HostConfig.PortBindings?.['4096/tcp']?.[0]?.HostPort)
      if (mappedPort !== port || !existing.Mounts.some((mount: { Source: string; Destination: string; RW: boolean }) => mount.Source === source && mount.Destination === '/opt/opencode' && mount.RW === false)) throw new Error('已有样本配置不同，请先定向停止该样本再调整')
      return { name: SAMPLE_NAME, port: mappedPort, state: 'running', version, commit, channel: 'local' }
    }
    docker(['rm', SAMPLE_NAME])
  } catch (error) { if (error instanceof Error && (error.message.includes('不属于') || error.message.includes('配置不同'))) throw error }
  const image = options.image ?? 'node:24-bookworm-slim'
  const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  const args = ['run', '-d', '--name', SAMPLE_NAME, '--label', 'hep.sample=cross-framework-opencode', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--network', SAMPLE_NETWORK, '--add-host', 'host.docker.internal:host-gateway', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-p', `127.0.0.1:${port}:4096`, '-e', 'HOME=/home/sample', '-e', 'XDG_DATA_HOME=/home/sample/.local/share', '-e', 'XDG_STATE_HOME=/home/sample/.local/state',
    '-e', 'XDG_CONFIG_HOME=/home/sample/.config', '-e', 'XDG_CACHE_HOME=/home/sample/.cache', '-e', 'OPENCODE_CONFIG_DIR=/home/sample/.config/opencode',
    '-v', `${source}:/opt/opencode:ro`, '-v', `${resolve(options.bunBinary ?? '/home/admin/.bun/bin/bun')}:/usr/local/bin/bun:ro`,
    '-v', `${home}:/home/sample`, '-v', `${workspace}:/workspace`, '-v', `${join(state, 'server-credential.json')}:/run/sample/server-credential.json:ro`,
    '-v', `${join(here, 'opencode-preload.mts')}:/opt/sample/preload.mts:ro`, '-w', '/workspace', image,
    'bun', '--preload', '/opt/sample/preload.mts', '/opt/opencode/packages/cli/src/index.ts', 'serve', '--hostname', '0.0.0.0', '--port', '4096']
  const id = docker(args)
  const result = { name: SAMPLE_NAME, id, port, version, commit, channel: 'local', imageId, network: SAMPLE_NETWORK, sourceReadOnly: true, dockerSocket: false,
    note: '锁定上游源码运行；版本常量来自该源码 package.json，不是官方发行二进制。' }
  writeFileSync(join(state, 'deployment.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  return result
}
export function configureOpenCodeSample(stateRoot: string, input: { modelEndpoint: string; connectorUrl: string; model?: string; nativeCatalog?: { url: string; credentialFile: string } }) {
  for (const value of [input.modelEndpoint, input.connectorUrl]) if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error('样本服务地址无效')
  const directory = join(resolve(stateRoot), 'container-home/.config/opencode'); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const model = input.model ?? 'cross-framework-sample'
  const servers: Record<string, unknown> = { protected_assets: { type: 'remote', url: input.connectorUrl, oauth: false, codemode: false } }
  if (input.nativeCatalog) {
    if (!['http:', 'https:'].includes(new URL(input.nativeCatalog.url).protocol)) throw new Error('原认证目录资源地址无效')
    const native = JSON.parse(readFileSync(input.nativeCatalog.credentialFile, 'utf8'))
    if (typeof native.catalog !== 'string' || native.catalog.length < 16) throw new Error('原认证目录凭据无效')
    servers.native_catalog = { type: 'remote', url: input.nativeCatalog.url, headers: { Authorization: `Bearer ${native.catalog}` }, oauth: false, codemode: false }
  }
  const config = { update: 'disable', share: 'disabled', snapshots: false, model: `sample/${model}`,
    providers: { sample: { name: '本地模拟推理边界', package: '@ai-sdk/openai-compatible', settings: { baseURL: input.modelEndpoint, apiKey: 'local-simulator-no-real-key' },
      models: { [model]: { name: '跨框架接入验收模型', capabilities: { tools: true }, limit: { context: 32768, output: 4096 } } } } },
    permissions: [{ action: '*', resource: '*', effect: 'allow' }], mcp: { servers } }
  writeFileSync(join(directory, 'opencode.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { configured: true, model, mcp: 'protected_assets' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'start' || !process.argv[3] || !process.argv[4]) throw new Error('用法：node opencode-sample.mts start <源码目录> <样本状态目录> [端口]')
  process.stdout.write(JSON.stringify(startOpenCodeSample({ sourceRoot: process.argv[3], stateRoot: process.argv[4], port: process.argv[5] ? Number(process.argv[5]) : undefined })) + '\n')
}

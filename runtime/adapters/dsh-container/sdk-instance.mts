/** 为一次 SDK 应用执行生成无业务监听端口的标准容器。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { observeSdkContainer, sdkExecutionStatus } from './sdk-instance-state.mts'

const adapter = dirname(fileURLToPath(import.meta.url))
const launch = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { target, name, project, contract, identity, manifest } = launch
const operationId = manifest.sdk_operation_id ?? randomUUID()
let result: any, stopping = false, child: ChildProcess | undefined, generationWritten = false
const stopRequested = () => stopping || Boolean(process.env.HARNESS_SDK_STOP_FILE && existsSync(process.env.HARNESS_SDK_STOP_FILE))
const ownsGeneration = () => {
  if (!generationWritten) return false
  try { return JSON.parse(readFileSync(join(target, 'instance.json'), 'utf8')).sdk_operation_id === operationId }
  catch { return false }
}
const stop = () => { stopping = true; if (ownsGeneration()) child?.kill('SIGTERM') }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
const cancelBeforeRuntime = () => {
  if (!stopRequested()) return
  const report = { type: 'result', name, profile: 'sdk', status: 'stopped', runtime_started: false,
    sdk_operation_id: operationId, event_count: 0, message: 'SDK 准备已停止，尚未启动 Runtime' }
  if (ownsGeneration()) {
    write(join(target, 'sdk-result.json'), report)
    write(join(target, 'instance.json'), { ...instance, status: 'stopped' })
  }
  process.stdout.write(JSON.stringify(report) + '\n')
  process.exit(1)
}
cancelBeforeRuntime()
const runtime = join(target, 'sdk-runtime')
const home = launch.homeDirectory ?? join(target, 'dsh-home')
if (launch.reuseHome && (home !== join(target, 'dsh-home') || !existsSync(home) || !lstatSync(home).isDirectory()
  || lstatSync(home).isSymbolicLink() || realpathSync(home) !== resolve(home))) {
  throw new Error('既有 SDK HOME 缺失或与登记路径不一致；拒绝创建空 HOME 替代')
}
const owned = (path: string) => { if (process.getuid?.() === 0) chownSync(path, 1000, 1000) }
const write = (path: string, value: unknown, mode = 0o644) => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode }); owned(path)
}
for (const directory of [target, runtime, home, join(home, 'profiles'), join(home, 'profiles/sdk')]) {
  mkdirSync(directory, { recursive: true }); owned(directory)
}
// Profile 是可复现来源，用户的持久设置不随每次调用覆盖。
const profileManifest = join(home, 'profiles/sdk/package.json')
copyFileSync(contract.profile_manifest, profileManifest); owned(profileManifest)
const sharedModules = join(runtime, 'node_modules')
mkdirSync(join(sharedModules, '@deepseek-ai'), { recursive: true })
owned(sharedModules); owned(join(sharedModules, '@deepseek-ai'))
const sdkLink = join(sharedModules, '@deepseek-ai/dsh-sdk-client')
if (existsSync(sdkLink)) {
  if (readlinkSync(sdkLink) !== '/opt/dsh/packages/sdk/client') throw new Error('SDK 共享模块投影与标准镜像不一致')
} else {
  try { symlinkSync('/opt/dsh/packages/sdk/client', sdkLink) }
  catch (error: any) { if (error.code !== 'EEXIST' || readlinkSync(sdkLink) !== '/opt/dsh/packages/sdk/client') throw error }
}
write(join(runtime, 'input.json'), launch.input, 0o600)
write(join(runtime, 'preset.patch.json'), [{ insert: [{ id: 'harness-sdk-preset',
  name: 'file:///opt/dsh-adapter/sdk-preset.mts', config: { presetId: contract.preset_id } }] }])
const options = {
  profile: 'sdk', dshBin: '/opt/dsh/apps/cli/lib/bin.js', dshHome: '/var/lib/dsh',
  cwd: contract.workspace_path ?? '/work/harness/workspace',
  patches: ['/opt/dsh-adapter/sdk-profile.patch.yml', contract.patch,
    '/opt/harness-sdk/model.patch.json', '/opt/harness-sdk/preset.patch.json'],
  ...launch.selection,
  moduleLinksPath: '/opt/node_modules',
}
write(join(runtime, 'options.json'), options)
writeFileSync(join(runtime, 'model.patch.json'), launch.modelPatch, { mode: 0o644 }); owned(join(runtime, 'model.patch.json'))
const mount = (source: string, target: string, read_only = true) => ({ type: 'bind', source: resolve(source), target, read_only, bind: { create_host_path: false } })
const volumes = [mount(adapter, '/opt/dsh-adapter'), mount(runtime, '/opt/harness-sdk'),
  mount(home, '/var/lib/dsh', false), mount(contract.workspace, '/work/harness/workspace'),
  mount(contract.runtime_presets_host ?? contract.presets, '/opt/dsh-presets'),
  mount(contract.managed, '/opt/dsh-managed'),
  mount(launch.modelRuntime, '/opt/harness-model-runtime/model-runtime.mjs'),
  mount(sharedModules, '/opt/node_modules', false),
  mount(contract.candidate_source_root ?? dirname(contract.candidate_root), '/opt/harness-candidate'),
]
if (contract.harness_runtime) volumes.push(mount(launch.modelBinding, '/opt/harness-model-runtime/model-binding-runtime.mjs'))
if (contract.project_workspace_host) volumes.push(mount(contract.project_workspace_host, '/work/project', false))
for (const dependency of launch.dependencyMounts ?? contract.asset_dependencies?.mounts ?? []) volumes.push(mount(dependency.source, dependency.target))
const compose = { services: { dsh: {
  image: identity.image_id, pull_policy: 'never', container_name: name, init: true,
  user: '1000:1000', working_dir: options.cwd, read_only: true, stop_grace_period: '20s',
  entrypoint: ['node', '/opt/dsh-adapter/sdk-runner.mts'],
  command: ['/opt/harness-sdk/options.json', '/opt/harness-sdk/input.json'],
  environment: { DSH_HOME: '/var/lib/dsh', DSH_TELEMETRY_DISABLED: '1', HARNESS_SDK_OPTIONS: '/opt/harness-sdk/options.json',
    ...Object.fromEntries((launch.environmentNames as string[]).map(key => [key, `\${${key}}`])) },
  tmpfs: ['/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777'], volumes,
} } }
write(join(target, 'compose.yaml'), compose)
const instance = { ...manifest, profile: 'sdk', port: null, base_url: null, web_base_path: null,
  sdk_operation_id: operationId,
  status: 'starting', home_directory: home, sdk_options: join(runtime, 'options.json'), sdk_input: join(runtime, 'input.json') }
cancelBeforeRuntime()
write(join(target, 'instance.json'), instance)
generationWritten = true
const args = ['compose', '--project-name', project, '--file', join(target, 'compose.yaml')]
cancelBeforeRuntime()
process.stdout.write(JSON.stringify({ type: 'launching', name, sdk_operation_id: operationId }) + '\n')
cancelBeforeRuntime()
child = spawn('docker', [...args, 'up', '--no-build', '--abort-on-container-exit', '--exit-code-from', 'dsh', '--no-log-prefix', '--no-color'],
  { cwd: target, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
if (stopRequested()) stop()
createInterface({ input: child.stdout! }).on('line', line => {
  try {
    const event = JSON.parse(line)
    if (event.type === 'result' || event.type === 'error') result = event
    else process.stdout.write(JSON.stringify({ ...event, name }) + '\n')
  } catch { process.stderr.write(line + '\n') }
})
child.stderr!.pipe(process.stderr)
let code = 1
try {
  code = await new Promise<number>((done, reject) => { child!.once('error', reject); child!.once('close', value => done(value ?? 1)) })
} catch (error) {
  result = { message: error instanceof Error ? error.message : String(error) }
}
process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
const container = await observeSdkContainer(name, project, target, ownsGeneration)
const status = sdkExecutionStatus(stopping, code, result, container)
const report = { type: 'result', name, profile: 'sdk', status, port: null, base_url: null,
  sdk_operation_id: operationId, runtime_started: true,
  container_state: container.state, container_stopped: container.stopped,
  session_id: result?.session_id ?? null, final_response: result?.final_response ?? '',
  event_count: result?.event_count ?? (Array.isArray(result?.events) ? result.events.length : 0),
  trace: { kind: 'dsh-session', home_directory: home, session_id: result?.session_id ?? null },
  ...(result?.message ? { message: result.message } : {}) }
if (ownsGeneration()) {
  write(join(target, 'sdk-result.json'), report)
  write(join(target, 'instance.json'), { ...instance, status, last_session_id: report.session_id })
}
process.stdout.write(JSON.stringify(report) + '\n')
process.exitCode = status === 'completed' ? 0 : 1

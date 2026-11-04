import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { redactRunText } from '../agents/run-files.ts'
import { readSdkOperation, saveSdkOperation, sdkInstance, stopSdkInstance } from './operations.ts'

const directory = process.argv[2]
const config = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')) as {
  root: string; program: string; cli?: string; secret_env_keys: string[]; model_policy: boolean
}
const operation = readSdkOperation(directory)
const secrets = config.secret_env_keys.map(key => process.env[key]).filter((value): value is string => Boolean(value))
const redact = (text: string) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), redactRunText(text))
const cli = config.cli ?? join(config.program, 'runtime/adapters/dsh-container/dsh-dev')
const environment = { ...process.env, HARNESS_ASSET_ROOT: config.root, HARNESS_PROGRAM_ROOT: config.program,
  HARNESS_SDK_OPERATION_ID: operation.id, HARNESS_SDK_STOP_FILE: join(directory, 'stop-requested') }
let stopping = false, stderr = '', pending = '', result: Record<string, any> | undefined
const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
let stopPromise: Promise<boolean> | undefined
const save = () => saveSdkOperation(directory, operation)
const stop = async () => {
  if (stopping) return
  stopping = true; operation.status = 'stopping'; save()
  writeFileSync(join(directory, 'stop-requested'), '', { mode: 0o600 })
  let current: ReturnType<typeof sdkInstance>
  try { current = sdkInstance(config.root, operation) }
  catch (error) { operation.status = 'unknown'; operation.error = redact((error as Error).message); save(); stopPromise = Promise.resolve(false); return }
  if (current?.sdk_operation_id !== operation.id) {
    // 只终止自己仍在准备的 CLI；不能因复用旧登记而停止另一代次容器。
    child.kill('SIGTERM')
    stopPromise = Promise.resolve(false)
    return
  }
  stopPromise = stopSdkInstance(config.root, operation, cli, environment).then(() => {
    child.kill('SIGTERM'); return true
  }, error => {
    operation.error = redact(error.message); operation.status = 'unknown'; save(); return false
  })
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
operation.worker_pid = process.pid; operation.status = 'running'; save()
const args = [cli, '--repo', config.root, 'sdk-run', '--source', operation.source, '--instance', operation.instance_id, '--input-file', join(directory, 'input.json')]
if (config.model_policy) args.push('--model-policy', join(directory, 'model-policy.json'))
const child = spawn(process.env.HARNESS_PYTHON || 'python3', args, { cwd: config.root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
const line = (raw: string) => {
  if (!raw.trim()) return
  const clean = redact(raw)
  try {
    const value = JSON.parse(clean)
    if (value.type === 'launching' && value.sdk_operation_id === operation.id || value.type === 'initialized') operation.runtime_started = true
    if (value.profile === 'sdk' && value.name === operation.instance_id
      && (value.sdk_operation_id === undefined || value.sdk_operation_id === operation.id)
      && ['completed', 'failed', 'unknown', 'stopped'].includes(value.status)) result = value
    else operation.events = [...operation.events, value].slice(-200)
  } catch { operation.events = [...operation.events, { message: clean.slice(-4000) }].slice(-200) }
  save()
}
const consumeStdout = (text: string) => {
  pending += text
  let index: number
  while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index)); pending = pending.slice(index + 1) }
  // 最终文本可大于单个事件；轨迹逐条流式传递，超大单行明确保留未知结果。
  if (pending.length > 16 * 1024 * 1024) { line(pending.slice(0, 4000) + '…'); pending = '' }
}
const consumeStderr = (text: string) => {
  const combined = stderr + text
  // 先清理完整诊断再截断，避免把已出现的凭据裁成无法匹配的尾片段。
  stderr = combined.length > 8000 ? redact(combined).slice(-8000) : combined
}
child.stdout.on('data', (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)))
child.stderr.on('data', (chunk: Buffer) => consumeStderr(stderrDecoder.write(chunk)))
child.once('error', error => { operation.error = redact(error.message) })
child.once('close', async code => {
  consumeStdout(stdoutDecoder.end())
  consumeStderr(stderrDecoder.end())
  line(pending)
  const stopped = stopPromise ? await stopPromise : false
  let beforeLaunch = false
  try { beforeLaunch = sdkInstance(config.root, operation)?.sdk_operation_id !== operation.id } catch { /* 无法读取登记时保留未知。 */ }
  operation.status = stopping ? (stopped || beforeLaunch && !operation.runtime_started
    || result?.status === 'stopped' && result.runtime_started === false ? 'stopped' : 'unknown') : result?.status === 'unknown' ? 'unknown'
    : result?.status === 'stopped' ? 'stopped' : result?.status === 'failed' ? 'failed'
    : code === 0 && result?.status === 'completed' ? 'completed' : beforeLaunch ? 'failed' : 'unknown'
  if (operation.status === 'unknown') operation.error = stopping ? operation.error || '未能确认 SDK 实例已停止，请核对实例状态'
    : redact(result?.message || stderr || '未收到最终执行回执，结果待核对；请查询或停止原实例，平台不会自动重跑。')
  if (result) {
    operation.session_id = result.session_id
    operation.final_response = typeof result.final_response === 'string' ? result.final_response : ''
  }
  if (operation.status === 'failed') operation.error = redact(result?.error || result?.message || operation.error || stderr || `SDK 调试程序退出（${code}），没有返回完成回执`)
  save()
  rmSync(join(directory, 'input.json'), { force: true })
  rmSync(join(directory, 'model-policy.json'), { force: true })
})
if (existsSync(join(directory, 'stop-requested'))) void stop()

import { spawn } from 'node:child_process'

/** 大文件命令不设固定时限；继承导出 Worker 进程组，取消等待子命令实际退出。 */
export async function agentCommand(command: string, args: string[], options: { signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; capture?: boolean } = {}): Promise<string> {
  options.signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failed: Error | undefined, force: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      child.kill('SIGTERM')
      force = setTimeout(() => { child.kill('SIGKILL') }, 2000)
      force.unref()
    }
    child.stdout.on('data', (data: Buffer) => { if (options.capture !== false) stdout = (stdout + data.toString()).slice(-16 * 1024 * 1024) })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000) })
    child.once('error', error => { failed = error })
    child.once('close', code => {
      if (force) clearTimeout(force)
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error('导出已取消'))
      else if (failed) reject(new Error(`${command} 无法执行：${failed.message}`))
      else if (code !== 0) reject(new Error(`${command} 执行失败（${code}）${stderr.trim() ? `：${stderr.trim()}` : ''}`))
      else resolve(stdout)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}

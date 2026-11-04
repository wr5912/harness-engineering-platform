import { spawnSync } from 'node:child_process'
import { constants, openSync } from 'node:fs'

export function openModelLock(file: string, create = true): number {
  return openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600)
}

/** flock 使用继承的同一文件描述符；父进程关闭后由内核释放，不删除锁文件。 */
export function tryModelLock(descriptor: number, shared = false): boolean {
  const result = spawnSync('flock', [shared ? '--shared' : '--exclusive', '--nonblock', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', descriptor] })
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error('模型配置文件锁失败')
}

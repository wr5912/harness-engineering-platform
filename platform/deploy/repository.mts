import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './fsutil.mts'

export function snapshotRepository(source: string, target: string, bundle: string): { commit: string; dirty: boolean; origin: string } {
  const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim()
  const dirty = Boolean(run('git', ['-C', source, 'status', '--porcelain']).trim())
  const origin = run('git', ['-C', source, 'remote', 'get-url', 'origin']).trim()
  if (/^https?:/.test(origin)) {
    const url = new URL(origin)
    if (url.username || url.password || url.search) throw new Error('Git origin 不能含凭据')
  }
  mkdirSync(target, { recursive: true })
  mkdirSync(join(bundle, '..'), { recursive: true })
  // 通过 bundle 的锁定提交检出，既保留完整历史，也不复制工作树临时文件。
  run('git', ['-C', source, 'bundle', 'create', bundle, 'HEAD'])
  restoreRepository(target, bundle, commit, origin, true)
  return { commit, dirty, origin }
}

export function restoreRepository(target: string, bundle: string, commit: string, origin: string, checkout = false): void {
  if (existsSync(join(target, '.git'))) throw new Error(`目标已有 Git 元数据：${target}`)
  const git = (args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', '-C', target, ...args])
  git(['init', '--quiet', '-b', 'main'])
  git(['fetch', '--quiet', bundle, 'HEAD'])
  git(['reset', checkout ? '--hard' : '--mixed', commit])
  git(['remote', 'add', 'origin', origin])
}

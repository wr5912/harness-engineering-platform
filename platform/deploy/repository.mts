import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run, safeRelative } from './fsutil.mts'

export function snapshotRepository(source: string, target: string, bundle: string, workingTree = false): { commit: string; dirty: boolean; origin: string } {
  const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim()
  const dirty = Boolean(run('git', ['-C', source, 'status', '--porcelain']).trim())
  const origin = run('git', ['-C', source, 'remote', 'get-url', 'origin']).trim()
  if (/^https?:/.test(origin)) {
    const url = new URL(origin)
    if (url.username || url.password || url.search) throw new Error('Git origin 不能含凭据')
  }
  // Git 文件须能被容器的非 root 用户读取；归档和凭据另行保留私有权限。
  const previousMask = process.umask(0o022)
  try {
    mkdirSync(target, { recursive: true })
    mkdirSync(join(bundle, '..'), { recursive: true })
    // bundle 保留原始历史；工作树快照不会生成提交或带入被忽略的缓存和 HOME。
    run('git', ['-C', source, 'bundle', 'create', bundle, 'HEAD'])
    restoreRepository(target, bundle, commit, origin, !workingTree)
    if (workingTree) {
      const files = new Set(run('git', ['-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))
      for (const file of files) {
        const relative = safeRelative(file), from = join(source, relative), to = join(target, relative)
        let stat
        try { stat = lstatSync(from) } catch (error: any) { if (error.code === 'ENOENT') continue; throw error }
        if (stat.isDirectory()) continue // 原文件在工作树中被目录替代，实际子文件由 ls-files 收集。
        const ancestors = relative.split('/').slice(0, -1)
        if (ancestors.some((_, index) => lstatSync(join(source, ...ancestors.slice(0, index + 1))).isSymbolicLink())) continue
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`工作树包含不支持的文件类型：${relative}`)
        mkdirSync(dirname(to), { recursive: true })
        if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
        else cpSync(from, to, { preserveTimestamps: true })
      }
      if (run('git', ['-C', source, 'rev-parse', 'HEAD']).trim() !== commit) throw new Error('仓库 HEAD 在打包时变化，请重新打包')
    }
  } finally { process.umask(previousMask) }
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

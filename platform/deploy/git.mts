import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cpSync } from 'node:fs'
import { assertNoBundledGlibc, isGlibcLibrary, run } from './fsutil.mts'

function which(command: string): string {
  for (const directory of (process.env.PATH || '').split(':')) {
    if (!directory) continue
    const candidate = join(directory, command)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`PATH 中找不到 ${command}`)
}

function copyPreservingPath(source: string, destinationRoot: string): void {
  const target = join(destinationRoot, source)
  mkdirSync(dirname(target), { recursive: true })
  const stat = statSync(source)
  if (stat.isDirectory()) cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
  else copyFileSync(source, target)
}

export interface GitBundleResult {
  version: string
  source: string
  path: string
}

export function assertGitBundle(source: string): void {
  if (!existsSync(join(source, 'git')) || (existsSync(join(source, 'root')) && !existsSync(join(source, 'root', 'usr', 'bin', 'git')))) {
    throw new Error('Git 离线资源缺少可执行入口或包内二进制')
  }
  if (existsSync(join(source, 'root'))) assertNoBundledGlibc(join(source, 'root'))
}

export function collectSystemGit(destination: string): GitBundleResult {
  const git = which('git')
  const version = run(git, ['--version']).trim()
  copyPreservingPath(git, join(destination, 'root'))
  for (const path of ['/usr/lib/git-core', '/usr/share/git-core', '/usr/share/git']) {
    if (existsSync(path)) copyPreservingPath(path, join(destination, 'root'))
  }
  let ldd = ''
  try { ldd = run('ldd', [git]) } catch { ldd = '' }
  for (const line of ldd.split('\n')) {
    const match = line.match(/=>\s+(\/\S+)/) || line.match(/^\s*(\/\S+)\s+\(/)
    // ELF 使用目标系统加载器；不能把准备机的 glibc 注入该加载器。
    if (match && !isGlibcLibrary(match[1])) copyPreservingPath(match[1], join(destination, 'root'))
  }
  const libDir = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const wrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$BASE/root/lib/${libDir}-linux-gnu:$BASE/root/lib:$BASE/root/usr/lib/${libDir}-linux-gnu\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GIT_EXEC_PATH="$BASE/root/usr/lib/git-core"
export GIT_TEMPLATE_DIR="$BASE/root/usr/share/git-core/templates"
exec "$BASE/root${git}" "$@"
`
  const wrapperPath = join(destination, 'git')
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 })
  chmodSync(wrapperPath, 0o755)
  return { version, source: 'system', path: wrapperPath }
}

export function copyGitBundle(source: string, destination: string): GitBundleResult {
  if (!existsSync(source)) throw new Error(`Git 离线资源不存在：${source}`)
  assertGitBundle(source)
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
  const wrapper = join(destination, 'git')
  if (!existsSync(wrapper)) throw new Error(`Git 离线资源缺少 git 入口：${wrapper}`)
  chmodSync(wrapper, 0o755)
  const version = run(wrapper, ['--version']).trim()
  return { version, source: 'bundle', path: wrapper }
}

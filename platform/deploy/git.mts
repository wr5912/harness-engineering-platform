import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
  const binary = join(destination, 'root', 'usr', 'bin', 'git')
  mkdirSync(dirname(binary), { recursive: true })
  copyFileSync(git, binary)
  chmodSync(binary, statSync(git).mode & 0o777)
  for (const path of ['/usr/lib/git-core', '/usr/share/git-core', '/usr/share/git']) {
    if (existsSync(path)) copyPreservingPath(path, join(destination, 'root'))
  }
  // 网络传输由 git-core 中的独立 ELF 执行；只收集 git 主程序会遗漏 libcurl 等依赖。
  const seen = new Set<string>()
  function collectLibraries(path: string): void {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) collectLibraries(join(path, name))
      return
    }
    const key = `${stat.dev}:${stat.ino}`
    if (!stat.isFile() || seen.has(key)) return
    seen.add(key)
    const header = Buffer.alloc(4), fd = openSync(path, 'r')
    try { readSync(fd, header, 0, 4, 0) } finally { closeSync(fd) }
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return
    let ldd: string
    try { ldd = run('ldd', [path]) }
    catch (error) { throw new Error(`无法收集 Git 程序依赖 ${path}：${error instanceof Error ? error.message : error}`) }
    if (/=>\s+not found/.test(ldd)) throw new Error(`Git 程序依赖缺失 ${path}：${ldd.trim()}`)
    for (const line of ldd.split('\n')) {
      const match = line.match(/=>\s+(\/\S+)/) || line.match(/^\s*(\/\S+)\s+\(/)
      // ELF 使用目标系统加载器；不能把准备机的 glibc 注入该加载器。
      if (match && !isGlibcLibrary(match[1])) copyPreservingPath(match[1], join(destination, 'root'))
    }
  }
  collectLibraries(git)
  if (existsSync('/usr/lib/git-core')) collectLibraries('/usr/lib/git-core')
  const libDir = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const wrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$BASE/root/lib/${libDir}-linux-gnu:$BASE/root/lib:$BASE/root/usr/lib/${libDir}-linux-gnu\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GIT_EXEC_PATH="$BASE/root/usr/lib/git-core"
export GIT_TEMPLATE_DIR="$BASE/root/usr/share/git-core/templates"
exec "$BASE/root/usr/bin/git" "$@"
`
  const wrapperPath = join(destination, 'git')
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 })
  chmodSync(wrapperPath, 0o755)
  assertGitBundle(destination)
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

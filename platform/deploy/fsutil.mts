import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-8).join('\n')
    throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）${detail ? '：' + detail : ''}`)
  }
  return result.stdout
}

export function ensureEmptyDir(path: string): void {
  if (!existsSync(path)) { mkdirSync(path, { recursive: true }); return }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目标不是普通目录：${path}`)
  if (readdirSync(path).length > 0) throw new Error(`目标目录已存在且非空：${path}；请使用新目录或先人工迁移`)
}

export function copyTree(source: string, target: string, filter?: (source: string, target: string) => boolean): void {
  mkdirSync(dirname(target), { recursive: true })
  if (!filter && !existsSync(target)) {
    run('/bin/cp', ['-a', '--no-preserve=ownership', '--', source, target])
    return
  }
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter,
  })
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 })
}

export function isSubpath(parent: string, child: string): boolean {
  const base = resolve(parent) + sep
  return resolve(child).startsWith(base)
}

export function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split('/').includes('..')) {
    throw new Error(`归档路径不安全：${value}`)
  }
  return value
}

export function tarList(archive: string): string[] {
  const output = run('tar', ['-tzf', archive])
  return output.split('\n').map(line => line.trim()).filter(Boolean)
}

export function assertSafeArchive(archive: string): void {
  for (const name of tarList(archive)) {
    const cleaned = name.replace(/^\.\//, '')
    if (!cleaned || cleaned === '.') continue
    if (cleaned.startsWith('/') || cleaned.split('/').includes('..')) {
      throw new Error(`归档包含不安全路径：${name}`)
    }
  }
}

export function tarCreate(directory: string, archive: string): void {
  mkdirSync(dirname(archive), { recursive: true })
  run('tar', ['-C', directory, '-czf', archive, '.'])
}

export function tarExtract(archive: string, directory: string): void {
  mkdirSync(directory, { recursive: true })
  run('tar', ['-xzf', archive, '-C', directory, '--no-same-owner'])
}

export function defaultSkippedNames(): Set<string> {
  return new Set(['.git', 'node_modules', 'lib', '__pycache__', '.pytest_cache', 'dist', 'coverage', '.local'])
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function relativePortable(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

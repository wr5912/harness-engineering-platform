import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { copyTree, run } from './fsutil.mts'

export interface InstalledRuntime {
  node: string
  pnpm?: string
  git?: string
  dsh?: string
  python: string
  versions: Record<string, string>
  warnings: string[]
  env: NodeJS.ProcessEnv
}

export function ensureDshScopeLink(dshRoot: string): void {
  const scope = join(dshRoot, 'packages', 'core', 'scope')
  const link = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-scope')
  if (!existsSync(scope) || existsSync(link)) return
  mkdirSync(join(dshRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync('../../packages/core/scope', link, 'dir')
}

function firstFile(directory: string, suffix: string): string | undefined {
  if (!existsSync(directory)) return undefined
  return readdirSync(directory).sort().map(name => join(directory, name)).find(path => path.endsWith(suffix))
}

function toolVersion(command: string, args: string[] = ['--version'], env?: NodeJS.ProcessEnv): string {
  try { return run(command, args, { env }).trim() } catch { return 'unknown' }
}

function systemCommand(name: string, usable = false): string | undefined {
  for (const directory of (process.env.PATH || '').split(':')) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (existsSync(candidate) && (!usable || toolVersion(candidate) !== 'unknown')) return candidate
  }
  return undefined
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

export function installRuntime(bundle: string, prefix: string, dataRoot: string): InstalledRuntime {
  const offline = join(bundle, 'offline')
  const runtime = join(prefix, 'runtime')
  const bin = join(prefix, 'bin')
  mkdirSync(runtime, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const warnings: string[] = []

  const nodeDirectory = join(runtime, 'node')
  const nodeArchive = firstFile(join(offline, 'node'), '.tar.xz')
  if (nodeArchive) {
    mkdirSync(nodeDirectory, { recursive: true })
    run('tar', ['-xJf', nodeArchive, '-C', nodeDirectory, '--strip-components=1'])
  } else if (existsSync(join(offline, 'node', 'bin', 'node'))) {
    copyTree(join(offline, 'node'), nodeDirectory)
  } else {
    throw new Error('安装包缺少 Node 24 运行时')
  }
  const node = join(nodeDirectory, 'bin', 'node')
  if (!existsSync(node)) throw new Error('包内 Node 运行时缺少 bin/node')

  let pnpm: string | undefined
  if (existsSync(join(offline, 'pnpm'))) {
    copyTree(join(offline, 'pnpm'), join(runtime, 'pnpm'))
    pnpm = join(runtime, 'pnpm', 'bin', 'pnpm')
    if (existsSync(pnpm)) chmodSync(pnpm, 0o755)
  }
  if (!pnpm || !existsSync(pnpm)) {
    warnings.push('安装包未包含可用的 pnpm；构建阶段将回退系统 pnpm')
    pnpm = systemCommand('pnpm')
  }

  let git: string | undefined
  if (existsSync(join(offline, 'git'))) {
    copyTree(join(offline, 'git'), join(runtime, 'git'))
    git = join(runtime, 'git', 'git')
    if (existsSync(git)) chmodSync(git, 0o755)
  }
  if (!git || toolVersion(git) === 'unknown') {
    warnings.push('安装包未包含可用的 Git 客户端；将回退系统 Git')
    git = systemCommand('git', true)
  }
  if (!git) throw new Error('安装包和系统都没有可执行的 Git 客户端（git --version 失败）')

  let dsh: string | undefined
  if (existsSync(join(offline, 'dsh'))) {
    copyTree(join(offline, 'dsh'), join(runtime, 'dsh'))
    ensureDshScopeLink(join(runtime, 'dsh'))
    const candidate = join(runtime, 'dsh', 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(candidate)) dsh = candidate
  }
  const systemDsh = systemCommand('dsh')
  if (!dsh) warnings.push('安装包未包含 DSH 安装树；平台启动将回退系统 dsh')
  if (!dsh && !systemDsh) warnings.push('安装包和系统都没有 dsh；平台启动将失败')

  let python = systemCommand('python3') ?? 'python3'
  const portable = join(offline, 'python')
  const pythonTar = firstFile(portable, '.tar.gz')
  if (pythonTar) {
    mkdirSync(join(runtime, 'python'), { recursive: true })
    run('tar', ['-xzf', pythonTar, '-C', join(runtime, 'python'), '--strip-components=1'])
    python = join(runtime, 'python', 'bin', 'python3')
  } else if (existsSync(join(portable, 'bin', 'python3'))) {
    copyTree(portable, join(runtime, 'python'))
    python = join(runtime, 'python', 'bin', 'python3')
  }
  if (!existsSync(python)) throw new Error('安装包缺少 Python 3.10+，系统 PATH 中也没有 python3')

  const pathParts: string[] = [join(nodeDirectory, 'bin')]
  if (pnpm) pathParts.push(dirname(pnpm))
  pathParts.push(dirname(git))
  pathParts.push(bin)
  const pythonPath = existsSync(join(portable, 'site')) ? join(runtime, 'python-site') : ''
  if (pythonPath) copyTree(join(portable, 'site'), pythonPath)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_PROGRAM_ROOT: prefix,
    HARNESS_ASSET_ROOT: dataRoot,
    HARNESS_PYTHON: python,
    HEP_NODE: node,
    HEP_PYTHON: python,
    PATH: [...pathParts, process.env.PATH || ''].join(':'),
  }
  if (dsh) env.HEP_DSH = dsh
  if (systemDsh) env.HEP_SYSTEM_DSH = systemDsh
  if (pythonPath) env.PYTHONPATH = [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(':')
  const envFile = join(bin, 'hep-env.sh')
  const lines = [
    '# 由离线安装器生成，仅用于当前安装目录。',
    `export HARNESS_PROGRAM_ROOT=${shellQuote(prefix)}`,
    `export HARNESS_ASSET_ROOT=${shellQuote(dataRoot)}`,
    `export HARNESS_PYTHON=${shellQuote(python)}`,
    `export HEP_NODE=${shellQuote(node)}`,
    `export HEP_PYTHON=${shellQuote(python)}`,
  ]
  if (dsh) lines.push(`export HEP_DSH=${shellQuote(dsh)}`)
  if (systemDsh) lines.push(`export HEP_SYSTEM_DSH=${shellQuote(systemDsh)}`)
  if (pythonPath) lines.push(`export PYTHONPATH=${shellQuote(pythonPath)}\${PYTHONPATH:+:"$PYTHONPATH"}`)
  lines.push(`export PATH=${shellQuote(pathParts.join(':') + ':')}"$PATH"`)
  writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o644 })

  const dshPath = join(bin, 'dsh')
  const dshWrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$BASE/hep-env.sh"
if [ -n "\${HEP_DSH:-}" ]; then exec "$HEP_NODE" "$HEP_DSH" "$@"; fi
if [ -n "\${HEP_SYSTEM_DSH:-}" ]; then exec "$HEP_SYSTEM_DSH" "$@"; fi
echo "dsh: 安装包和系统中都没有可用的 DSH" >&2
exit 127
`
  writeFileSync(dshPath, dshWrapper, { mode: 0o755 })
  const startWrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$BASE/hep-env.sh"
exec "$HEP_PYTHON" "$HARNESS_PROGRAM_ROOT/platform/dsh-platform" start "$@"
`
  writeFileSync(join(bin, 'hep-start'), startWrapper, { mode: 0o755 })
  chmodSync(dshPath, 0o755)

  const versions: Record<string, string> = {
    node: toolVersion(node),
    python: toolVersion(python),
  }
  if (pnpm) versions.pnpm = toolVersion(pnpm, ['--version'], env)
  if (git) versions.git = toolVersion(git)
  if (dsh) versions.dsh = toolVersion(node, [dsh, '--version'])
  return { node, pnpm, git, dsh, python, versions, warnings, env }
}

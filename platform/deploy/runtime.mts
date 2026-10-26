import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
    throw new Error('安装包缺少可用的 pnpm')
  }

  let git: string | undefined
  if (existsSync(join(offline, 'git'))) {
    copyTree(join(offline, 'git'), join(runtime, 'git'))
    git = join(runtime, 'git', 'git')
    if (existsSync(git)) chmodSync(git, 0o755)
  }
  if (!git || toolVersion(git) === 'unknown') {
    throw new Error('安装包缺少可执行的 Git 客户端（git --version 失败）')
  }

  let dsh: string | undefined
  if (existsSync(join(offline, 'dsh'))) {
    copyTree(join(offline, 'dsh'), join(runtime, 'dsh'))
    ensureDshScopeLink(join(runtime, 'dsh'))
    const candidate = join(runtime, 'dsh', 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(candidate)) dsh = candidate
  }
  if (!dsh) throw new Error('安装包缺少已构建的 DSH CLI')

  let python = ''
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
  if (!python || !existsSync(python)) throw new Error('安装包缺少可移植 Python 3.10+')

  const pathParts: string[] = [join(nodeDirectory, 'bin')]
  if (pnpm) pathParts.push(dirname(pnpm))
  pathParts.push(dirname(git))
  pathParts.push(dirname(python))
  pathParts.push(bin)
  const pythonSite = existsSync(join(portable, 'site')) ? join(portable, 'site') : join(runtime, 'python/site')
  const pythonPath = join(runtime, 'python-site')
  if (existsSync(pythonSite)) copyTree(pythonSite, pythonPath)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_PROGRAM_ROOT: prefix,
    HARNESS_ASSET_ROOT: dataRoot,
    HARNESS_PYTHON: python,
    HEP_NODE: node,
    HEP_PYTHON: python,
    HEP_OFFLINE: '1',
    PYTHONHOME: join(runtime, 'python'),
    LD_LIBRARY_PATH: [join(runtime, 'python', 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    PATH: [...pathParts, process.env.PATH || ''].join(':'),
  }
  if (dsh) env.HEP_DSH = dsh
  if (pythonPath) env.PYTHONPATH = [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(':')
  const envFile = join(bin, 'hep-env.sh')
  const lines = [
    '# 由安装器生成；路径随程序目录移动，启动地址由数据工作区维护。',
    `export HARNESS_PROGRAM_ROOT=\${HEP_ROOT:-${shellQuote(prefix)}}`,
    `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-${shellQuote(dataRoot)}}`,
    'export HARNESS_PYTHON="$HARNESS_PROGRAM_ROOT/runtime/python/bin/python3"',
    'export HEP_PYTHON="$HARNESS_PYTHON"',
    'export HEP_NODE="$HARNESS_PROGRAM_ROOT/runtime/node/bin/node"',
    'export HEP_DSH="$HARNESS_PROGRAM_ROOT/runtime/dsh/apps/cli/lib/bin.js"',
    'export HEP_OFFLINE=1',
    'export PYTHONHOME="$HARNESS_PROGRAM_ROOT/runtime/python"',
    'export LD_LIBRARY_PATH="$PYTHONHOME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    'export PYTHONPATH="$HARNESS_PROGRAM_ROOT/runtime/python-site${PYTHONPATH:+:$PYTHONPATH}"',
    'export PATH="$HARNESS_PROGRAM_ROOT/runtime/node/bin:$HARNESS_PROGRAM_ROOT/runtime/pnpm/bin:$HARNESS_PROGRAM_ROOT/runtime/git:$HARNESS_PROGRAM_ROOT/runtime/python/bin:$HARNESS_PROGRAM_ROOT/bin:$PATH"',
  ]
  writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o644 })

  const dshPath = join(bin, 'dsh')
  const dshWrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEP_ROOT=$(CDPATH= cd -- "$BASE/.." && pwd)
. "$BASE/hep-env.sh"
exec "$HEP_NODE" "$HEP_DSH" "$@"
`
  writeFileSync(dshPath, dshWrapper, { mode: 0o755 })
  const startWrapper = `#!/bin/sh
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BASE/../platform/dsh-platform" start "$@"
`
  writeFileSync(join(bin, 'hep-start'), startWrapper, { mode: 0o755 })
  chmodSync(dshPath, 0o755)

  const versions: Record<string, string> = {
    node: toolVersion(node),
    python: toolVersion(python, ['--version'], env),
  }
  if (pnpm) versions.pnpm = toolVersion(pnpm, ['--version'], env)
  if (git) versions.git = toolVersion(git)
  if (dsh) versions.dsh = toolVersion(node, [dsh, '--version'])
  if (Object.values(versions).some(version => version === 'unknown')) throw new Error('包内工具无法执行或无法读取版本')
  run(node, ['-e', 'if(Number(process.versions.node.split(".")[0])<24) process.exit(1)'], { env })
  run(python, ['-c', 'import sys,yaml; assert sys.version_info >= (3,10)'], { env })
  const expected = JSON.parse(readFileSync(join(prefix, 'platform/plugin/package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-client-connection']
  if (versions.dsh !== expected) throw new Error(`包内 DSH ${versions.dsh} 与平台 ${expected} 不兼容`)
  return { node, pnpm, git, dsh, python, versions, warnings, env }
}

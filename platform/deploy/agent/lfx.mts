import { chmodSync, copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentCommand } from './process.mts'
import type { AgentPackageHooks } from './types.mts'

/** 在标准目标容器内准备依赖，不复制开发机虚拟环境，也不构建派生镜像。 */
export async function stageLfxRuntime(input: { programRoot: string; staging: string; arch: string; image: string }, hooks: AgentPackageHooks = {}) {
  if (input.arch !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Error('LFX 独立运行资源须在目标架构的在线准备机生成')
  hooks.onProgress?.({ stage: 'extensions', message: '正在标准容器内安装锁定的 LFX Python 依赖' })
  const destination = join(input.staging, 'runtime/lfx')
  mkdirSync(destination, { recursive: true })
  for (const name of ['requirements.txt', 'hep_lfx.py', 'server.py']) {
    copyFileSync(join(input.programRoot, 'platform/mcp/lfx', name), join(destination, name))
    chmodSync(join(destination, name), 0o444)
  }
  const uv = realpathSync((await agentCommand('which', ['uv'], { signal: hooks.signal })).trim())
  const container = `harness-agent-lfx-${randomUUID()}`
  const common = ['run', '--rm', '--name', container, '--pull', 'never', '--platform', `linux/${input.arch}`, '--user', `${process.getuid!()}:${process.getgid!()}`,
    '--mount', `type=bind,src=${destination},dst=/output`]
  try {
    await agentCommand('docker', [...common, '--mount', `type=bind,src=${uv},dst=/usr/local/bin/uv,readonly`,
      '--env', 'UV_CACHE_DIR=/tmp/uv-cache', '--entrypoint', '/usr/local/bin/uv', input.image,
      'python', 'install', '--install-dir', '/output/python', '--no-bin', '3.12'], { signal: hooks.signal, capture: false })
    const entries = readdirSync(join(destination, 'python'), { withFileTypes: true })
    // uv 的次版本别名含准备容器绝对路径，部署包只保留真实解释器和相对入口。
    for (const entry of entries) if (entry.isSymbolicLink()) rmSync(join(destination, 'python', entry.name))
    const interpreters = entries.filter(entry => entry.isDirectory() && /^cpython-3\.12\.\d+-/.test(entry.name)).map(entry => entry.name)
    if (interpreters.length !== 1) throw new Error('独立 Python 3.12 安装未返回唯一解释器')
    symlinkSync(`python/${interpreters[0]}/bin/python3.12`, join(destination, 'python3'))
    await agentCommand('docker', [...common, '--mount', `type=bind,src=${uv},dst=/usr/local/bin/uv,readonly`,
      '--env', 'UV_CACHE_DIR=/tmp/uv-cache', '--entrypoint', '/usr/local/bin/uv', input.image,
      'pip', 'sync', '--python', '/output/python3', '--target', '/output/site-packages', '--only-binary', ':all:', '/output/requirements.txt'], { signal: hooks.signal, capture: false })
    const deployed = '/opt/standalone/runtime/lfx'
    await agentCommand('docker', ['run', '--rm', '--name', container, '--pull', 'never', '--platform', `linux/${input.arch}`, '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--mount', `type=bind,src=${destination},dst=${deployed},readonly`, '--network', 'none', '--env', `PYTHONPATH=${deployed}/site-packages:${deployed}`, '--entrypoint', `${deployed}/python3`, input.image,
      '-B', '-c', 'from importlib.metadata import version; assert version("lfx") == "1.13.1"; import hep_lfx'], { signal: hooks.signal, capture: false })
  } finally {
    await agentCommand('docker', ['rm', '--force', container], { capture: false }).catch(() => {})
  }
}

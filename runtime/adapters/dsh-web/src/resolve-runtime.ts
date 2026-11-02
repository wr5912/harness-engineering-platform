import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 解析当前进程真正装载的 Runtime；不把系统 shell 包装器当成 Node 包入口。 */
export function runtimeRequire(name: string, containerManifest?: string): NodeRequire {
  const candidates = containerManifest ? [containerManifest] : [
    process.env.HARNESS_DSH_ENTRY,
    process.argv[1],
    fileURLToPath(import.meta.url),
    new URL('../../../../platform/plugin/package.json', import.meta.url).pathname,
  ]
  for (const entry of candidates) {
    if (!entry) continue
    let canonical: string
    try {
      canonical = realpathSync(entry)
    } catch { continue }
    const require = createRequire(canonical)
    // 原生 CLI 只直接依赖启动入口；服务包由同一安装中的 bundle 或 Agent 持有。
    // 按这些公开包的依赖解析，避免回退另一份 Runtime 并改写真正的启动来源。
    const anchors = [require]
    for (const owner of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-agent']) {
      try { anchors.push(createRequire(require.resolve(owner))) } catch { /* 当前组合可以不含此包。 */ }
    }
    for (const anchor of anchors) {
      try { anchor.resolve(name) } catch { continue }
      if (!containerManifest) process.env.HARNESS_DSH_ENTRY = canonical
      return anchor
    }
  }
  throw new Error(`Web 路径适配器无法从当前 Runtime 解析 ${name}`)
}

export async function runtimeModule(name: string, containerManifest?: string): Promise<any> {
  return import(pathToFileURL(runtimeRequire(name, containerManifest).resolve(name)).href)
}

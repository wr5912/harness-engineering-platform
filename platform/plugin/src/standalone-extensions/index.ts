import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface StandaloneExtension {
  id: string
  entry: string
  sha256: string
  sourceDigest: string
}

/** 只装载导出时明确冻结的业务实现；不扫描或执行工作区源码。 */
export async function populateStandaloneExtensions(ctx: any, config: { extensions?: StandaloneExtension[] }, root: string) {
  for (const item of config.extensions ?? []) {
    if (item.id !== 'security-operations-compositions' || item.entry !== `runtime/extensions/${item.id}/plugin.mjs`
      || !/^[0-9a-f]{64}$/.test(item.sha256) || !/^[0-9a-f]{64}$/.test(item.sourceDigest)) throw new Error('独立智能体业务扩展声明无效')
    const base = realpathSync(root), entry = realpathSync(join(base, item.entry))
    if (!entry.startsWith(base + sep) || createHash('sha256').update(readFileSync(entry)).digest('hex') !== item.sha256) throw new Error('独立智能体业务扩展文件已变化，请重新安装原包')
    const extension = ctx.platformMcp?.compositionExtension ?? ctx.standaloneCompositionExtension
    if (!extension || extension.id) throw new Error('独立智能体业务扩展登记冲突')
    const plugin = await import(pathToFileURL(resolve(entry)).href)
    if (typeof plugin.populate !== 'function') throw new Error('独立智能体业务扩展入口无效')
    plugin.populate(ctx, { root: base, sourceDigest: item.sourceDigest })
  }
}

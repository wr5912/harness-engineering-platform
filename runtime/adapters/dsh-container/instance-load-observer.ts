import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { digest, verifyFiles } from './instance-assets.ts'

export const name = 'harness-instance-load-observer'
export const inject = ['agentPresets']

/** 由本次 DSH 进程核对挂载字节、Preset 登记和本地插件装载；不调用模型、工具或外部 MCP。 */
export function apply(ctx: any) {
  const expected = JSON.parse(readFileSync('/opt/harness-asset-load/expected.json', 'utf8'))
  const verifyMountedFiles = () => {
    try { verifyFiles(expected.files) }
    catch (error) {
      writeFileSync('/tmp/hep-asset-load.json', JSON.stringify({ ok: false, nonce: expected.nonce,
        error: error instanceof Error ? error.message : String(error), pid: process.pid }), { mode: 0o600 })
      throw error
    }
  }
  verifyMountedFiles()
  let checking = false, completed = false
  const check = async () => {
    if (checking || completed) return
    checking = true
    try {
      const entries = [...ctx.loader.entries()].filter((entry: any) => {
        if (entry.disabled || typeof entry.options?.name !== 'string') return false
        const base = entry.parent?.tree?.ctx?.baseUrl ?? 'file:///'
        const name = entry.options.name
        const path = name.startsWith('/') ? name : name.startsWith('file:') || name.startsWith('.') ? fileURLToPath(new URL(name, base)) : ''
        return path && expected.files.some((file: any) => file.path === path || file.path.startsWith(`${path}/`))
      })
      if (entries.some((entry: any) => entry.fiber?.state !== 2)) return
      const document = await ctx.agentPresets.readDocument(expected.preset_id)
      if (!document || typeof document.content !== 'string') return
      if (!ctx.agentPresets.inspectCompositions().some((item: any) => item.id === expected.preset_id)) return
      const inventory = (await ctx.agentPresets.compositionInventory()).find((item: any) => item.id === expected.preset_id)
      if (!inventory || inventory.rows.some((row: any) => row.enabled && /^(?:\/|file:|\.)/.test(row.moduleName)
        && row.fiberState !== 2)) return
      verifyMountedFiles()
      writeFileSync('/tmp/hep-asset-load.json', JSON.stringify({ ok: true, nonce: expected.nonce,
        source_id: expected.source_id, digest: expected.digest, files_digest: digest(expected.files),
        preset_id: expected.preset_id, loaded_at: new Date().toISOString(), pid: process.pid }), { mode: 0o600 })
      completed = true
    } catch {
      // 启动期间 Preset 可能尚未登记；由 CLI 的有界等待给出未核验结果。
    } finally { checking = false }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void check() }, 200)
    void check()
    return () => clearInterval(timer)
  })
}

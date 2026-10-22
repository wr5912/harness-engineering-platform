import { instanceStateRoot, workspaceConfigPath } from '../workspace.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, unwatchFile, watch, watchFile } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { PLATFORM_DOMAINS, type PlatformDomain } from './client.ts'

export type PlatformInvalidation = { revision: number; domains: PlatformDomain[]; ids: string[] }
type Options = { docker?: boolean; stateRoot?: string; minIntervalMs?: number }
const IGNORED = new Set(['node_modules', '.git', '.venv', '__pycache__', 'lib', 'dist', '.cache', 'cache', 'history', 'RuntimeHOME', 'dsh-home', 'sessions', 'attachments'])
const RUN_DIRECTORY = /^run-/

/** 观察已有事实源；通知只含稳定标识，不携带文件内容、配置或运行日志。 */
export function createPlatformEvents(assetRoot: string, options: Options = {}) {
  const root = resolve(assetRoot)
  const minIntervalMs = options.minIntervalMs ?? 1000
  let revision = 0
  let started = false
  let disposed = false
  let lastSent = 0
  const listeners = new Set<(event: PlatformInvalidation) => void>()
  const watchers = new Map<string, { close(): void }>()
  const pollingDirectories = new Set<string>()
  const streams = new Set<() => void>()
  let rescan: ReturnType<typeof setTimeout> | undefined
  let docker: ChildProcess | undefined
  let dockerRetry: ReturnType<typeof setTimeout> | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  const pendingDomains = new Set<PlatformDomain>()
  const pendingIds = new Set<string>()
  const notify = (domains: readonly PlatformDomain[], ids: readonly string[] = []) => {
    if (disposed) return
    for (const domain of domains) pendingDomains.add(domain)
    for (const id of ids) if (/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) pendingIds.add(id)
    if (pending) return
    // 首次通知保留 100ms 合并窗口；持续写入时按最小间隔发送，避免把文件变化放大成每秒多帧。
    const wait = Math.max(100, lastSent + minIntervalMs - Date.now())
    pending = setTimeout(() => {
      pending = undefined
      lastSent = Date.now()
      const event = { revision: ++revision, domains: [...pendingDomains], ids: [...pendingIds] }
      pendingDomains.clear(); pendingIds.clear()
      for (const listener of listeners) listener(event)
    }, wait)
  }
  const stateRoot = instanceStateRoot(root, options.stateRoot)
  function relevant(path: string) {
    const parts = path.split(sep)
    return !parts.some(part => IGNORED.has(part) || part === 'credentials' || part.endsWith('.llm-api-key'))
      && !/\.(?:tmp|swp|log)$/.test(path)
  }
  function sourceFile(name: string) {
    return relevant(name) && /\.(?:md|ya?ml|jsonl?|[cm]?js|[jt]sx?|toml|txt|csv|py|sh|svg)$/.test(name)
  }
  function entries(directory: string, filename?: string) {
    try {
      return readdirSync(directory, { withFileTypes: true }).filter(entry => relevant(entry.name)
        && (!filename || entry.name === filename) && (entry.isDirectory() || (entry.isFile() && sourceFile(entry.name))))
    } catch { return [] }
  }
  function observePolling(directory: string, domains: PlatformDomain[], filename?: string) {
    const listing = () => entries(directory, filename).map(entry => entry.name).sort().join('\n')
    if (!watchers.has(directory)) {
      let previous = listing()
      const changed = (current: import('node:fs').Stats, before: import('node:fs').Stats) => {
        const next = listing()
        if (next !== previous || current.ino !== before.ino) {
          previous = next; notify(domains)
          if (!rescan) rescan = setTimeout(() => { rescan = undefined; scan() }, 80)
        }
      }
      watchFile(directory, { interval: 1000, persistent: false }, changed)
      watchers.set(directory, { close: () => unwatchFile(directory, changed) })
    }
    for (const entry of entries(directory, filename)) {
      if (!entry.isFile()) continue
      const file = join(directory, entry.name)
      if (watchers.has(file)) continue
      const changed = () => notify(domains)
      watchFile(file, { interval: 1000, persistent: false }, changed)
      watchers.set(file, { close: () => unwatchFile(file, changed) })
    }
  }
  function observe(directory: string, domains: PlatformDomain[], recursive: boolean, filename?: string) {
    if (!existsSync(directory)) return
    if (pollingDirectories.has(directory)) observePolling(directory, domains, filename)
    else if (!watchers.has(directory)) {
      try {
        const watcher = watch(directory, (kind, name) => {
          const changed = name?.toString()
          if (changed && (!relevant(changed) || (filename && changed !== filename))) return
          // 目录增删仍需刷新；二进制文件内容变化无需重读业务数据。
          if (changed && !sourceFile(changed) && kind !== 'rename') return
          notify(domains)
          if (kind === 'rename' && !rescan) rescan = setTimeout(() => { rescan = undefined; scan() }, 80)
        })
        watcher.on('error', () => {
          watcher.close(); watchers.delete(directory); pollingDirectories.add(directory)
          observePolling(directory, domains, filename); notify(domains)
        })
        watchers.set(directory, watcher)
      } catch {
        // 共享桌面主机可能用尽 inotify；降级只 stat 事实源，不改变宿主限制。
        pollingDirectories.add(directory)
        observePolling(directory, domains, filename)
      }
    }
    if (!recursive) return
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !relevant(entry.name)) continue
        // Run 证据在评测期间被高频重写；Run 列表只需感知 run 目录的增删，不进入 run 内部。
        if (entry.name === 'runs') { observeRunRoots(join(directory, entry.name), domains); continue }
        observe(join(directory, entry.name), domains, true)
      }
    } catch { /* 删除或重命名期间，父目录通知会重新核对。 */ }
  }
  /** 只观察 runs 目录的直接子项；run 内部内容变化由 Run 详情按需读取，不触发列表失效。 */
  function observeRunRoots(directory: string, domains: PlatformDomain[]) {
    if (!existsSync(directory)) return
    if (pollingDirectories.has(directory)) { observePolling(directory, domains); return }
    if (watchers.has(directory)) return
    try {
      const watcher = watch(directory, (kind, name) => {
        if (kind !== 'rename') return
        const changed = name?.toString()
        if (changed && !RUN_DIRECTORY.test(changed)) return
        notify(domains)
        if (!rescan) rescan = setTimeout(() => { rescan = undefined; scan() }, 80)
      })
      watcher.on('error', () => {
        watcher.close(); watchers.delete(directory); pollingDirectories.add(directory)
        observePolling(directory, domains); notify(domains)
      })
      watchers.set(directory, watcher)
    } catch {
      // 文件监听额度不足时只比较 runs 目录的直接项，不进入 run 内部。
      pollingDirectories.add(directory)
      observePolling(directory, domains)
    }
  }
  function scan() {
    if (disposed) return
    for (const [directory, watcher] of watchers) if (!existsSync(directory)) { watcher.close(); watchers.delete(directory) }
    observe(join(root, 'agents'), ['catalog', 'agents'], true)
    observe(join(root, 'evolution'), ['catalog', 'agents'], false)
    observe(join(root, 'evolution/experiments'), ['catalog', 'agents'], true)
    observe(join(root, 'evolution/datasets'), ['agents'], true)
    observe(join(root, 'releases'), ['catalog', 'agents'], true)
    const sourcesDirectory = dirname(workspaceConfigPath(root, 'sources.json'))
    const compositionsDirectory = dirname(workspaceConfigPath(root, 'mcp-compositions.json'))
    // 独立工作区将两份配置放在同一目录，只注册一个覆盖两种变化的观察器。
    if (sourcesDirectory === compositionsDirectory) observe(sourcesDirectory, ['catalog', 'agents', 'instances', 'mcp'], false)
    else {
      observe(sourcesDirectory, ['catalog', 'agents', 'instances'], false, 'sources.json')
      observe(compositionsDirectory, ['mcp'], false, 'mcp-compositions.json')
    }
    observe(stateRoot, ['instances', 'agents'], true)
    // 尚无实例目录时，观察其既有父目录以捕获首次登记。
    if (!existsSync(stateRoot)) observe(resolve(stateRoot, '..'), ['instances', 'agents'], false, basename(stateRoot))
  }
  function followDocker() {
    if (disposed || options.docker === false) return
    docker = spawn('docker', ['events', '--filter', 'type=container', '--filter', 'label=com.docker.compose.project', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let remaining = ''
    let missing = false
    docker.on('error', error => { missing = (error as NodeJS.ErrnoException).code === 'ENOENT' })
    docker.stdout?.on('data', chunk => {
      remaining += chunk.toString()
      const lines = remaining.split('\n'); remaining = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.Actor?.Attributes?.['com.docker.compose.project']?.startsWith('dsh-dev-')) notify(['instances', 'agents'])
        } catch { /* Docker 的非 JSON 输出不进入客户端。 */ }
      }
      if (remaining.length > 64 * 1024) remaining = ''
    })
    docker.on('close', () => {
      docker = undefined
      if (disposed) return
      notify(['instances', 'agents'])
      if (!missing) { dockerRetry = setTimeout(followDocker, 3000); dockerRetry.unref() }
    })
  }
  const start = () => { if (started || disposed) return; started = true; scan(); followDocker() }
  const dispose = () => {
    disposed = true
    if (rescan) clearTimeout(rescan)
    if (pending) clearTimeout(pending)
    if (dockerRetry) clearTimeout(dockerRetry)
    docker?.kill()
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    pollingDirectories.clear()
    for (const close of streams) close()
    streams.clear()
    listeners.clear()
  }
  const fetch = async (request: Request) => {
    const encoder = new TextEncoder()
    let cleanup = (_closeBody = true) => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const send = (event: PlatformInvalidation) => {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n')) }, 15_000)
        heartbeat.unref()
        cleanup = (closeBody = true) => {
          if (closed) return
          closed = true; clearInterval(heartbeat); listeners.delete(send); streams.delete(cleanup)
          request.signal.removeEventListener('abort', aborted)
          if (closeBody) controller.close()
        }
        listeners.add(send); streams.add(cleanup)
        const aborted = () => cleanup()
        request.signal.addEventListener('abort', aborted, { once: true })
        send({ revision, domains: [...PLATFORM_DOMAINS], ids: [] })
        if (request.signal.aborted) cleanup()
      },
      cancel() { cleanup(false) },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  return {
    notify, start, dispose, fetch,
    subscribe(listener: (event: PlatformInvalidation) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    register(ctx: Context) {
      // 此项控制请求体读取；GET 没有请求体，响应仍由原生桥持续流式发送。
      ctx.connection.fetch.register({ path: '/api/harness-platform/events', methods: ['GET'], requestBody: 'buffered', fetch })
      ctx.effect(() => { start(); return dispose })
    },
  }
}

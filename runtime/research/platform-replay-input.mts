import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { runtimeModule, runtimeRequire } from '../adapters/dsh-web/src/resolve-runtime.ts'
import { workspaceIdentity } from '../../platform/plugin/src/workspace.ts'
import { redactRunText } from '../../platform/plugin/src/agents/run-files.ts'
import { assetText } from '../../platform/plugin/src/agents/asset-text.ts'

type MapValue = Record<string, any>
export interface ReplayCollectionOptions {
  url: string; assetRoot: string; replayConfigFile: string; out: string
  datasetId?: string; recordId?: string; runId?: string
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[0-9a-f]{64}$/
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const object = (value: unknown): value is MapValue => !!value && typeof value === 'object' && !Array.isArray(value)
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }
function json(file: string) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('LOCAL_JSON_UNREADABLE') } }
function baseUrl(value: string) {
  const url = new URL(value)
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'PLATFORM_URL_INVALID')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}
function writeNew(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }

function safePublicText(raw: string, secrets = new Set<string>()) {
  if ([...secrets].some(value => raw.includes(value))) return false
  let before: unknown
  try { before = JSON.parse(raw) } catch { return redactRunText(raw) === raw }
  return same(before, JSON.parse(redactRunText(raw)))
}
function platformReadBinding(assetRoot: string, value: string) {
  requireValue(isAbsolute(assetRoot), 'ABSOLUTE_WORKSPACE_AND_OUTPUT_REQUIRED')
  const root = realpathSync(assetRoot), url = baseUrl(value), identity = workspaceIdentity(root)
  const registered = json(join(root, 'config/business-access.json'))?.gateway?.managementUrl
  requireValue(typeof registered === 'string' && baseUrl(registered).href === url.href, 'PLATFORM_MANAGEMENT_URL_MISMATCH')
  const stateFile = join(root, '.local/platform-service/state.json')
  if (existsSync(stateFile)) {
    const state = json(stateFile)
    requireValue(typeof state.url === 'string' && baseUrl(state.url).href === url.href && resolve(state.dataRoot) === root, 'PLATFORM_SERVICE_WORKSPACE_MISMATCH')
  }
  return { root, url, identity }
}
type ObservedRequest = { url: string; endpoint: string; rpc_id: string; body: string }
export interface PlatformReadObserver {
  request(info: ObservedRequest): unknown
  response(info: ObservedRequest, ticket: unknown, response: { status: number; bytes: Uint8Array; safe: boolean }): void
}

interface PlatformClientOptions { url: string; assetRoot: string; observer?: PlatformReadObserver }
const READ_ENDPOINTS = ['inventory', 'agents/datasets/list', 'agents/datasets/read', 'agents/datasets/source', 'agents/runs/trace'] as const
/** collector与原生Session取证保持只读；写工具不能改变此端点集合。 */
export function createPlatformReadClient(options: PlatformClientOptions) { return createPlatformRpcClient(options, READ_ENDPOINTS) }

/** 正式CLI共同通信载体；调用模块在源码中固定本任务所用端点，不接受命令行端点。 */
export async function createPlatformRpcClient(options: PlatformClientOptions, endpoints: readonly string[]) {
  const { root, url, identity } = platformReadBinding(options.assetRoot, options.url)
  const file = join(root, '.local/credentials/admin.json')
  requireValue(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && realpathSync(file) === file, 'PLATFORM_ACCOUNT_NOT_DEDICATED')
  const account = json(file)
  requireValue(typeof account.username === 'string' && account.username && typeof account.password === 'string' && account.password, 'PLATFORM_ACCOUNT_INVALID')
  const secrets = new Set<string>([account.password])
  let cookie = '', context: any, Socket: any, mounted = false
  const sockets = new Set<any>()
  try {
    const login = await fetch(new URL('login', url), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: account.username, password: account.password }) })
    requireValue(login.status === 303, 'PLATFORM_LOGIN_FAILED')
    const cookies = login.headers.getSetCookie().map(value => value.split(';')[0]!).filter(value => value.startsWith('harness_platform_session='))
    requireValue(cookies.length === 1, 'PLATFORM_LOGIN_COOKIE_INVALID')
    cookie = cookies[0]!; secrets.add(cookie); secrets.add(cookie.slice(cookie.indexOf('=') + 1))
    const [{ Context }, { installConnection }] = await Promise.all([runtimeModule('@deepseek-ai/cordis'), runtimeModule('@deepseek-ai/dsh-client-connection/client')])
    context = new Context()
    const platformEndpoints = new Set(endpoints)
    installConnection(context, { interactions: 'none', transport: { streamBaseUrl: url.href,
      createWebSocket: (value: string) => {
        const target = new URL(value)
        requireValue(Socket && target.host === url.host && target.pathname === url.pathname + 'api/remote.mux' && !target.search && !target.hash, 'READONLY_SESSION_SOCKET_REQUIRED')
        const socket = new Socket(target.href, { headers: { cookie, origin: url.origin } }); sockets.add(socket)
        socket.once('close', () => sockets.delete(socket)); return socket
      },
      fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
        const target = new URL(String(input), url), logical = target.pathname.slice(url.pathname.length), native = logical.startsWith('api/'), prefix = native ? 'api/' : 'harness-platform/', endpoint = logical.slice(prefix.length)
        requireValue(target.origin === url.origin && logical.startsWith(prefix) && !target.search && !target.hash && init.method === 'POST'
          && (native ? endpoint === 'session/page' : platformEndpoints.has(endpoint)), 'READONLY_RPC_TARGET_REQUIRED')
        requireValue(typeof init.body === 'string', 'RPC_REQUEST_UNSAFE')
        const body = JSON.parse(init.body); requireValue(body.method === endpoint, 'RPC_ENDPOINT_MISMATCH')
        const info = { url: target.href, endpoint, rpc_id: body.rpcId, body: init.body }, observer = native ? undefined : options.observer
        const ticket = observer?.request(info)
        const response = await fetch(target, { ...init, redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30000)]), headers: { ...Object.fromEntries(new Headers(init.headers)), origin: url.origin, cookie } })
        if (observer) {
          const bytes = new Uint8Array(await response.clone().arrayBuffer())
          let raw: string
          try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('RPC_RESPONSE_NOT_UTF8') }
          observer.response(info, ticket, { status: response.status, bytes, safe: safePublicText(raw, secrets) })
        }
        return response
      } } })
    async function rpc(endpoint: string, payload: MapValue) {
      const result = await context.connection.rpc.call('/harness-platform', endpoint, payload)
      requireValue(result?.ok === true, 'PLATFORM_RPC_REJECTED'); return result.value as MapValue
    }
    const inventory = await rpc('inventory', {})
    requireValue(inventory.root === root && inventory.workspace?.id === identity.id && inventory.workspace?.root === root, 'ONLINE_WORKSPACE_MISMATCH')
    return { workspace: identity, url: url.href, rpc, isSafeText: (raw: string) => safePublicText(raw, secrets),
      isSafeAssetText: (path: string, text: string) => ![...secrets].some(secret => text.includes(secret)) && !assetText(path, text).redacted,
      async readSessionEvents(sessionId: string) {
        if (!mounted) {
          const gatewayRequire = createRequire(runtimeRequire('@deepseek-ai/dsh-api-gateway').resolve('@deepseek-ai/dsh-api-gateway'))
          const [ws, registry, gateway, remote] = await Promise.all([import(pathToFileURL(gatewayRequire.resolve('ws')).href), runtimeModule('@deepseek-ai/dsh-typert-registry/client'), runtimeModule('@deepseek-ai/dsh-api-gateway/client'), runtimeModule('@deepseek-ai/dsh-api-session-controller/remote')])
          Socket = ws.default; registry.apply(context); gateway.apply(context); await context.remote.$mount(remote.default); mounted = true
        }
        const signal = AbortSignal.timeout(30000), stream = context.remote.session.follow({ address: { kind: 'session', sessionId }, maxMessages: 30 }, signal)
        let baseline: any
        try { for await (const frame of stream) { requireValue(frame.type === 'snapshot', 'SESSION_FOLLOW_SNAPSHOT_REQUIRED'); baseline = frame; break } }
        finally { stream.dispose() }
        requireValue(baseline?.header?.id === sessionId && Number.isSafeInteger(baseline.cursor) && baseline.cursor >= -1, 'SESSION_FOLLOW_IDENTITY_INVALID')
        const rows = new Map<number, any>(), pages: any[] = []
        let page = baseline
        while (true) {
          requireValue(Array.isArray(page.records) && typeof page.hasMore === 'boolean', 'SESSION_PAGE_INVALID')
          let added = 0
          for (const row of page.records) {
            const event = row?.event
            requireValue(row.type === 'event' && Number.isSafeInteger(event?.seq) && event.seq >= 0 && event.seq <= baseline.cursor, 'SESSION_EVENT_SEQUENCE_INVALID')
            if (rows.has(event.seq)) requireValue(same(rows.get(event.seq), event), 'SESSION_PAGE_CONFLICT')
            else { rows.set(event.seq, event); added++ }
          }
          pages.push({ count: page.records.length, first_seq: page.records[0]?.event?.seq ?? null, last_seq: page.records.at(-1)?.event?.seq ?? null, has_more: page.hasMore })
          if (!page.hasMore) break
          requireValue(added > 0 && page.records.length > 0, 'SESSION_PAGE_NO_PROGRESS')
          const first = Math.min(...page.records.map((row: any) => row.event.seq))
          const result = await context.remote.session.page({ address: { kind: 'session', sessionId }, throughSeq: baseline.cursor, beforeSeq: first, maxMessages: 40 }, signal)
          requireValue(result.ok === true, 'SESSION_PAGE_RPC_REJECTED'); page = result.value
        }
        const events = [...rows.values()].sort((a, b) => a.seq - b.seq)
        requireValue(events.length === baseline.cursor + 1 && events.every((event, index) => event.seq === index), 'SESSION_HISTORY_INCOMPLETE')
        return { session_id: sessionId, cursor: baseline.cursor, events, pages }
      },
      async close() { for (const socket of sockets) socket.close(); cookie = ''; secrets.clear(); await context.fiber.dispose() },
    }
  } catch (error) {
    for (const socket of sockets) socket.close(); cookie = ''; secrets.clear(); if (context) await context.fiber.dispose(); throw error
  }
}

/** 使用真实HTTP取证；不调用本地业务handler、不生成标签或模型回执。 */
export async function collectReplayInputs(options: ReplayCollectionOptions) {
  requireValue(isAbsolute(options.assetRoot) && isAbsolute(options.out), 'ABSOLUTE_WORKSPACE_AND_OUTPUT_REQUIRED')
  requireValue(options.runId ? !options.datasetId && !options.recordId : options.datasetId && options.recordId, 'SELECT_RUN_OR_DATASET_RECORD')
  const { root, url, identity } = platformReadBinding(options.assetRoot, options.url), out = resolve(options.out)
  requireValue(!existsSync(out), 'OUTPUT_ALREADY_EXISTS')
  const config = json(options.replayConfigFile)
  requireValue(object(config) && safePublicText(JSON.stringify(config)), 'REPLAY_CONFIG_UNSAFE')
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out, { mode: 0o700 })
  const manifest: MapValue = { schema_version: 'platform-replay-collection/v1', status: 'partial', complete: false,
    platform_url: url.href, workspace: identity, started_at: new Date().toISOString(), mode: options.runId ? 'batch' : 'collect',
    ...(options.runId ? { run_id: options.runId } : { dataset_id: options.datasetId, record_id: options.recordId }), requests: [], records: [] }
  function saveManifest() {
    const temporary = join(out, 'manifest.tmp')
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, join(out, 'manifest.json'))
  }
  saveManifest()
  let client: Awaited<ReturnType<typeof createPlatformReadClient>> | undefined
  type HeldReceipt = { entry: MapValue; body: string; bytes: Uint8Array; stem: string }
  let heldFragments: HeldReceipt[] | undefined
  function persistReceipt({ entry, body, bytes, stem }: HeldReceipt) {
    writeFileSync(join(out, `${stem}.request.json`), body, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(out, `${stem}.json`), bytes, { flag: 'wx', mode: 0o600 })
    Object.assign(entry, { request_file: `${stem}.request.json`, response_file: `${stem}.json`, response_body_saved: true, response_body_sha256: sha(bytes) })
  }
  try {
    client = await createPlatformReadClient({ url: url.href, assetRoot: root, observer: {
      request(info) {
        requireValue(safePublicText(info.body), 'RPC_REQUEST_UNSAFE')
        const index = manifest.requests.length + 1, stem = `receipts/${String(index).padStart(6, '0')}`
        const entry: MapValue = { index, url: info.url, endpoint: info.endpoint, rpc_id: info.rpc_id, received_at: new Date().toISOString(),
          request_sha256: sha(info.body), response_body_saved: false }
        manifest.requests.push(entry); saveManifest(); return { entry, stem }
      },
      response(info, ticket, response) {
        const { entry, stem } = ticket as { entry: MapValue; stem: string }
        entry.http_status = response.status
        if (!response.safe) { entry.blocked = 'RPC_RESPONSE_UNSAFE'; saveManifest(); throw new Error('RPC_RESPONSE_UNSAFE') }
        mkdirSync(join(out, 'receipts'), { recursive: true })
        const received = { entry, body: info.body, bytes: response.bytes, stem }
        // 分片在完整决策通过同一脱敏合同后才落盘。
        if (heldFragments) heldFragments.push(received)
        else persistReceipt(received)
        saveManifest()
      },
    } })
    const rpc = client.rpc
    manifest.online_workspace_verified = true; saveManifest()
    let datasets: string[]
    if (options.runId) {
      const listed = await rpc('agents/datasets/list', { run_id: options.runId, include_eligibility: false })
      requireValue(Array.isArray(listed.datasets) && listed.datasets.every((item: any) => typeof item.id === 'string' && item.run_id === options.runId), 'DATASET_LIST_IDENTITY_MISMATCH')
      datasets = [...new Set<string>(listed.datasets.map((item: any) => item.id))]
    } else datasets = [options.datasetId!]

    let sourceCache: { key: string; pages: MapValue[] } | undefined
    let traceCache: { key: string; pages: MapValue[]; covered: number } | undefined
    for (const datasetId of datasets) {
      const readback = await rpc('agents/datasets/read', { dataset_id: datasetId }), dataset = readback.dataset
      requireValue(dataset?.schema_version === 2 && dataset.id === datasetId && hashPattern.test(readback.sha256) && Array.isArray(dataset.records)
        && (!options.runId || dataset.run_id === options.runId), 'DATASET_READ_IDENTITY_MISMATCH')
      const records = options.runId ? dataset.records : dataset.records.filter((record: any) => record?._meta?.id === options.recordId)
      requireValue(records.length > 0 && (options.runId || records.length === 1), 'SELECTED_RECORD_NOT_FOUND')
      for (const record of records) {
        const meta = record?._meta
        requireValue(object(meta) && typeof meta.id === 'string' && typeof meta.decision_id === 'string' && meta.run_id === dataset.run_id
          && meta.trace_path === dataset.path && meta.trace_sha256 === dataset.source_sha256 && hashPattern.test(meta.trace_sha256), 'RECORD_SOURCE_IDENTITY_MISMATCH')
        const selected = { run_id: dataset.run_id, path: dataset.path, source_sha256: dataset.source_sha256 }
        const first = await rpc('agents/datasets/source', { ...selected, cursor: 0, limit: 3 })
        requireValue(first.kind === 'decisions' && first.run_id === selected.run_id && first.path === selected.path && first.source_sha256 === selected.source_sha256
          && hashPattern.test(first.source_identity_sha256) && Array.isArray(first.decisions) && first.source_bundle?.issues?.length === 0
          && same(first.source_bundle, dataset.source_bundle) && same(first.source_version, dataset.source_version)
          && ['agent_id', 'experiment_id'].every(key => first[key] === dataset[key] && first[key] === meta[key]), 'SOURCE_IDENTITY_MISMATCH')
        const key = JSON.stringify([selected, first.source_identity_sha256])
        if (sourceCache && sourceCache.pages[0]?.path === first.path && sourceCache.pages[0].run_id === first.run_id) {
          requireValue(sourceCache.key === key, 'SOURCE_CHANGED_DURING_COLLECTION')
        }
        if (sourceCache?.key !== key) sourceCache = { key, pages: [first] }
        else requireValue(same(sourceCache.pages[0], first), 'SOURCE_CHANGED_DURING_COLLECTION')
        let page = sourceCache.pages.find(page => page.decisions.some((item: any) => item.decision_id === meta.decision_id))
        while (!page) {
          const last = sourceCache.pages.at(-1)!, next = last.next_cursor
          requireValue(Number.isSafeInteger(next) && next > last.cursor, 'SELECTED_DECISION_NOT_FOUND_OR_NO_PROGRESS')
          const fetched = await rpc('agents/datasets/source', { ...selected, source_identity_sha256: first.source_identity_sha256, cursor: next, limit: 3 })
          requireValue(fetched.kind === 'decisions' && fetched.cursor === next && fetched.source_identity_sha256 === first.source_identity_sha256
            && fetched.source_sha256 === first.source_sha256 && fetched.path === first.path && Array.isArray(fetched.decisions), 'SOURCE_PAGE_IDENTITY_MISMATCH')
          sourceCache.pages.push(fetched)
          if (fetched.decisions.some((item: any) => item.decision_id === meta.decision_id)) page = fetched
        }
        const descriptor = page.decisions.find((item: any) => item.decision_id === meta.decision_id)
        let decision: MapValue = descriptor
        if (descriptor.detail_required) {
          heldFragments = []
          let readInput = descriptor.read_input, content = '', complete = false
          requireValue(hashPattern.test(descriptor.content_sha256) && Number.isSafeInteger(descriptor.total_characters) && descriptor.total_characters >= 0, 'DECISION_DESCRIPTOR_INVALID')
          while (!complete) {
            requireValue(object(readInput) && readInput.cursor === content.length && readInput.run_id === selected.run_id && readInput.path === selected.path
              && readInput.source_sha256 === selected.source_sha256 && readInput.source_identity_sha256 === first.source_identity_sha256
              && readInput.decision_id === meta.decision_id && readInput.content_sha256 === descriptor.content_sha256, 'FRAGMENT_CONTINUATION_INVALID')
            const fragment = await rpc('agents/datasets/source', readInput)
            requireValue(fragment.kind === 'decision_fragment' && fragment.run_id === selected.run_id && fragment.path === selected.path
              && fragment.source_sha256 === selected.source_sha256 && fragment.source_identity_sha256 === first.source_identity_sha256
              && fragment.decision_id === meta.decision_id && fragment.content_sha256 === descriptor.content_sha256
              && fragment.cursor === content.length && fragment.total_characters === descriptor.total_characters && typeof fragment.fragment === 'string'
              && fragment.fragment.length > 0, 'FRAGMENT_IDENTITY_OR_PROGRESS_MISMATCH')
            content += fragment.fragment
            requireValue(content.length <= descriptor.total_characters, 'FRAGMENT_LENGTH_MISMATCH')
            complete = fragment.complete === true
            requireValue(complete ? fragment.next_cursor === null && fragment.read_input === null && content.length === descriptor.total_characters
              : fragment.next_cursor === content.length, 'FRAGMENT_CURSOR_MISMATCH')
            readInput = fragment.read_input
          }
          requireValue(sha(content) === descriptor.content_sha256, 'FRAGMENT_CONTENT_SHA_MISMATCH')
          decision = JSON.parse(content)
          requireValue(object(decision) && client.isSafeText(content), 'DECISION_CONTENT_UNSAFE')
          for (const held of heldFragments) persistReceipt(held)
          heldFragments = undefined; saveManifest()
        }
        requireValue(decision.decision_id === meta.decision_id && same(decision.anchor, meta.cutoff), 'DECISION_CUTOFF_MISMATCH')
        const anchor = decision.anchor
        requireValue(Number.isSafeInteger(anchor?.line) && anchor.line > 0 && anchor.path === selected.path && anchor.source_sha256 === selected.source_sha256, 'NATIVE_ANCHOR_REQUIRED')
        if (traceCache?.key !== key || traceCache.covered > anchor.line) traceCache = { key, pages: [], covered: 0 }
        while (traceCache.covered < anchor.line) {
          const start = traceCache.covered
          const trace = await rpc('agents/runs/trace', { ...selected, cursor: start, limit: Math.min(500, anchor.line - start) })
          requireValue(trace.run_id === selected.run_id && trace.path === selected.path && trace.source_sha256 === selected.source_sha256
            && trace.source?.role === 'target' && trace.source.collection_status === 'available' && Array.isArray(trace.events) && trace.events.length > 0, 'TRACE_SOURCE_UNAVAILABLE')
          let line = start
          for (const row of trace.events) {
            requireValue(row.ref?.line === ++line && row.ref.path === selected.path && row.ref.source_sha256 === selected.source_sha256
              && line <= anchor.line, 'TRACE_PREFIX_GAP_OR_FUTURE')
          }
          requireValue(trace.next_cursor === null ? line === trace.total_lines : trace.next_cursor === line, 'TRACE_CURSOR_MISMATCH')
          traceCache.pages.push(trace); traceCache.covered = line
        }
        requireValue(same(traceCache.pages.at(-1)!.events.at(-1)!.ref, anchor), 'TRACE_ANCHOR_MISMATCH')
        const finalSource = await rpc('agents/datasets/source', { ...selected, cursor: 0, limit: 3 })
        requireValue(same(finalSource, first), 'SOURCE_CHANGED_DURING_COLLECTION')
        const input = { readback, record_id: meta.id, source_page: page, source_decision: decision, trace_pages: traceCache.pages }
        const number = manifest.records.length + 1, path = options.runId ? `inputs/${String(number).padStart(6, '0')}/input.json` : 'input.json'
        writeNew(join(out, path), { input, config })
        manifest.records.push({ dataset_id: datasetId, record_id: meta.id, input_file: path, platform_file_sha256: readback.sha256,
          source_sha256: first.source_sha256, source_identity_sha256: first.source_identity_sha256,
          decision_content_sha256: descriptor.detail_required ? descriptor.content_sha256 : sha(JSON.stringify(decision)), native_prefix_through_line: anchor.line })
        saveManifest()
      }
    }
    manifest.status = 'complete'; manifest.complete = true; manifest.finished_at = new Date().toISOString(); saveManifest()
    return { status: 'complete', out, manifest: join(out, 'manifest.json'), records: manifest.records.length, requests: manifest.requests.length,
      manifest_sha256: sha(readFileSync(join(out, 'manifest.json'))) }
  } catch (error) {
    // 外部正文和JSON解析异常可能含敏感值；只传播本实现的稳定诊断码。
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'COLLECTION_FAILED'
    for (const held of heldFragments ?? []) held.entry.blocked = 'DECISION_FRAGMENTS_NOT_VERIFIED'
    heldFragments = undefined
    manifest.status = 'partial'; manifest.error_code = code; saveManifest()
    throw new Error(code)
  } finally { await client?.close() }
}

async function main(args: string[]) {
  const [action, ...rest] = args, values: Record<string, string> = {}
  requireValue(['collect', 'batch'].includes(action ?? '') && rest.length % 2 === 0, 'COLLECT_OR_BATCH_REQUIRED')
  const allowed = new Set(['url', 'asset-root', 'dataset-id', 'record-id', 'run-id', 'replay-config', 'out'])
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!.replace(/^--/, '')
    requireValue(rest[index]!.startsWith('--') && allowed.has(key) && !Object.hasOwn(values, key) && rest[index + 1], 'CANONICAL_OPTIONS_REQUIRED')
    values[key] = rest[index + 1]!
  }
  requireValue(action === 'batch' ? values['run-id'] && !values['dataset-id'] && !values['record-id'] : values['dataset-id'] && values['record-id'] && !values['run-id'], 'SELECT_RUN_OR_DATASET_RECORD')
  const result = await collectReplayInputs({ url: values.url!, assetRoot: values['asset-root']!, datasetId: values['dataset-id'], recordId: values['record-id'],
    runId: values['run-id'], replayConfigFile: values['replay-config']!, out: values.out! })
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'COLLECTION_FAILED'; process.stderr.write(JSON.stringify({ status: 'failed', error_code: code }) + '\n'); process.exitCode = 1 })
}

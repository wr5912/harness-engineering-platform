import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatformRpcClient } from './platform-replay-input.mts'
import { VERSION_ID } from '../../platform/plugin/src/version-id.ts'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[0-9a-f]{64}$/
function check(value: unknown, code: string): asserts value { if (!value) throw Error(code) }
function relativePath(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\\') && !isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..') }
function pinnedText(file: string, expected: string) {
  check(isAbsolute(file) && hashPattern.test(expected), 'PINNED_SOURCE_REQUIRED')
  const bytes = readFileSync(file); check(sha(bytes) === expected, 'SOURCE_SHA_CHANGED')
  check(bytes.length <= 1024 * 1024 && !bytes.includes(0), 'EDIT_SOURCE_NOT_TEXT')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  check(sha(text) === expected, 'SOURCE_UTF8_BYTES_CHANGED'); return { text, bytes: bytes.length }
}
export interface AssetImportOptions { url: string; assetRoot: string; agentId: string; experimentId: string; sourceManifest: string; expectedManifestSha256: string; out: string }

/** 仅通过实际登记平台的edit/CAS写入；不执行源码、不复制本地业务资产。 */
export async function importCandidateSources(options: AssetImportOptions) {
  const identity = VERSION_ID.exec(options.experimentId)
  check(identity && identity[1] === options.agentId, 'CANDIDATE_IDENTITY_REQUIRED')
  check(isAbsolute(options.out) && !existsSync(options.out), 'NEW_ABSOLUTE_OUTPUT_REQUIRED')
  const manifestText = pinnedText(options.sourceManifest, options.expectedManifestSha256).text, source = JSON.parse(manifestText)
  check((source.agent ?? source.agent_id) === options.agentId && source.parent_experiment !== options.experimentId && Array.isArray(source.files) && source.files.length > 0, 'SOURCE_MANIFEST_IDENTITY_INVALID')
  const sourceRoot = realpathSync(dirname(options.sourceManifest)), targetRoot = `evolution/experiments/${options.experimentId}/candidate/`
  const inputs = source.files.map((entry: any) => {
    check(relativePath(entry.path) && hashPattern.test(entry.sha256), 'SOURCE_MANIFEST_FILE_INVALID')
    const expected = entry.expected_sha256 === undefined ? null : entry.expected_sha256
    check(expected === null || typeof expected === 'string' && hashPattern.test(expected), 'SOURCE_TARGET_BASELINE_INVALID')
    const file = resolve(sourceRoot, entry.path), target = entry.target_path ?? `dsh/managed/compute-workflow/${entry.path}`
    check(file.startsWith(sourceRoot + sep) && realpathSync(file) === file && relativePath(target), 'SOURCE_OR_TARGET_PATH_INVALID')
    const value = pinnedText(file, entry.sha256)
    check(entry.bytes === undefined || entry.bytes === value.bytes, 'SOURCE_SIZE_CHANGED')
    return { file, source_path: entry.path, path: targetRoot + target, sha256: entry.sha256, expected_sha256: expected, ...value }
  })
  check(new Set(inputs.map((input: any) => input.path)).size === inputs.length, 'DUPLICATE_CANDIDATE_TARGET')
  mkdirSync(dirname(options.out), { recursive: true }); mkdirSync(options.out, { mode: 0o700 })
  const receipt: any = { schema_version: 'platform-asset-edit/v1', status: 'partial', agent_id: options.agentId, experiment_id: options.experimentId,
    source_manifest: options.sourceManifest, source_manifest_sha256: options.expectedManifestSha256,
    tool_sources: Object.fromEntries(['platform-asset-edit.mts', 'platform-replay-input.mts'].map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))])), requests: [], files: [] }
  function save() { const temp = join(options.out, 'receipt.tmp'); writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, join(options.out, 'receipt.json')) }
  save()
  let client: Awaited<ReturnType<typeof createPlatformRpcClient>> | undefined
  try {
    client = await createPlatformRpcClient({ url: options.url, assetRoot: options.assetRoot, observer: {
      request(info) {
        const row = { index: receipt.requests.length + 1, endpoint: info.endpoint, url: info.url, rpc_id: info.rpc_id, request_body_sha256: sha(info.body) }
        receipt.requests.push(row); save(); return row
      },
      response(_info, ticket, response) {
        const row = ticket as any
        Object.assign(row, { http_status: response.status, response_body_sha256: sha(response.bytes), body_saved: false })
        // 此工具仅保存HTTP正文摘要；源码的变量表达式由公共assetText合同检查，不能套用Run日志脱敏。
        save()
      },
    } }, ['inventory', 'agents/edit/read', 'agents/edit/preview', 'agents/edit/apply'])
    receipt.platform = { url: client.url, workspace: client.workspace }; save()
    async function readTarget(path: string) {
      const value = await client!.rpc('agents/edit/read', { experiment_id: options.experimentId, path })
      check(value.path === path && value.editable === true && value.redacted !== true && typeof value.content === 'string'
        && (value.exists === false ? value.sha256 === null && value.content === '' : value.exists === true && hashPattern.test(value.sha256) && sha(value.content) === value.sha256), 'EDIT_READBACK_INVALID')
      return value
    }
    for (const input of inputs) {
      check(client.isSafeAssetText(input.path, input.text), 'ASSET_SOURCE_UNSAFE')
      pinnedText(options.sourceManifest, options.expectedManifestSha256); pinnedText(input.file, input.sha256)
      const row: any = { source_path: input.source_path, path: input.path, source_sha256: input.sha256, expected_sha256: input.expected_sha256, bytes: input.bytes, status: 'reading' }
      receipt.files.push(row); save()
      const before = await readTarget(input.path); row.before_sha256 = before.sha256
      if (before.sha256 === input.sha256) { row.status = 'already_identical'; row.readback_sha256 = before.sha256; save(); continue }
      check(before.sha256 === input.expected_sha256, 'SOURCE_TARGET_BASELINE_CHANGED')
      const payload = { experiment_id: options.experimentId, edits: [{ path: input.path, content: input.text, expected_sha256: input.expected_sha256 }] }
      const preview = await client.rpc('agents/edit/preview', payload), draft = preview.edits?.[0]
      check(preview.edits?.length === 1 && draft.path === input.path && draft.before_sha256 === before.sha256 && draft.after_sha256 === input.sha256 && draft.redacted !== true, 'EDIT_PREVIEW_MISMATCH')
      row.status = 'apply_pending'; save()
      try {
        const applied = await client.rpc('agents/edit/apply', payload)
        check(applied.written?.length === 1 && applied.written[0].path === input.path && applied.written[0].sha256 === input.sha256, 'EDIT_APPLY_RECEIPT_MISMATCH')
        row.apply_acknowledged = true
      } catch { row.apply_acknowledged = false }
      // 请求失败或回执未知后只读核对，不自动重发写入；同字节已存在也不冒称收到成功回执。
      const after = await readTarget(input.path); row.readback_sha256 = after.sha256
      check(after.sha256 === input.sha256 && after.content === input.text, 'ASSET_APPLY_NOT_CONFIRMED')
      row.status = row.apply_acknowledged ? 'applied_and_readback' : 'readback_verified_after_unconfirmed_apply'; save()
    }
    receipt.status = 'complete'; save()
    return { status: 'complete', out: options.out, experiment_id: options.experimentId, files: receipt.files.length, applied: receipt.files.filter((row: any) => row.apply_acknowledged).length, receipt_sha256: sha(readFileSync(join(options.out, 'receipt.json'))) }
  } catch (error) {
    receipt.error_code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ASSET_IMPORT_FAILED'; save(); throw Error(receipt.error_code)
  } finally { await client?.close() }
}

export async function main(args: string[]) {
  check(args[0] === 'import' && args.length % 2 === 1, 'ASSET_IMPORT_ARGUMENTS_REQUIRED')
  const allowed = new Set(['url', 'asset-root', 'agent-id', 'experiment-id', 'source-manifest', 'expected-manifest-sha256', 'out']), values: Record<string, string> = {}
  for (let index = 1; index < args.length; index += 2) { const name = args[index]!.slice(2); check(args[index]!.startsWith('--') && allowed.has(name) && !Object.hasOwn(values, name) && args[index + 1], 'ASSET_IMPORT_ARGUMENTS_REQUIRED'); values[name] = args[index + 1]! }
  check(Object.keys(values).length === allowed.size, 'ASSET_IMPORT_BINDINGS_REQUIRED')
  const result = await importCandidateSources({ url: values.url!, assetRoot: values['asset-root']!, agentId: values['agent-id']!, experimentId: values['experiment-id']!, sourceManifest: values['source-manifest']!, expectedManifestSha256: values['expected-manifest-sha256']!, out: values.out! })
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ASSET_IMPORT_FAILED'; process.stderr.write(JSON.stringify({ status: 'partial', error_code: code }) + '\n'); process.exitCode = 2 })

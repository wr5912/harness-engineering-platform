import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { versionIdentity, versionSource } from '../../../platform/plugin/src/agents/version-source.ts'
import { candidateDigest, dataPath } from '../../../platform/plugin/src/tasks/files.ts'
import { reuseParentDependencies } from '../../../platform/plugin/src/agents/plugin-dependency-reuse.ts'

const yamlLibrary = () => createRequire(join(process.env.HARNESS_PROGRAM_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), 'platform/plugin/package.json'))('js-yaml')
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const git = (root: string, args: string[]) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, timeout: 30_000, maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('无法读取固定 Git 评测来源')
  return result.stdout
}

/** 只物化同一提交内的选定 Agent/版本；原 Candidate、索引和分支均不写入。 */
export function materializeEvaluationSource(root: string, id: string, ref: string) {
  if (!/^git:[a-f0-9]{40}$/.test(ref)) throw new Error('source_ref 必须是 git:<40位提交>')
  const commit = ref.slice(4), identity = versionIdentity(root, id, commit)
  versionSource(root, id, commit)
  const prefixes = [`evolution/experiments/${id}/candidate/`, `agents/${identity.agent_id}/`]
  const fixed = new Set([`evolution/experiments/${id}/change.yaml`, `evolution/experiments/${id}/hypothesis.md`,
    `evolution/experiments/${id}/decision.md`, 'config/sources.json', 'workspace.json'])
  const entries = git(root, ['ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean).flatMap(row => {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row)
    if (!match || !fixed.has(match[3]) && !prefixes.some(prefix => match[3].startsWith(prefix))
      && !new RegExp(`^evolution/experiments/(?:EXP|VAR)-${identity.agent_id}-[0-9]{3}(?:-r[0-9a-f]{12})?/change\\.yaml$`).test(match[3])) return []
    const path = match[3]
    if (path.split('/').some(part => ['runs', '.git', '.local', 'node_modules', 'RuntimeHOME', 'sessions', 'cache', '__pycache__'].includes(part)) || path.endsWith('.llm-api-key')) return []
    if (!['100644', '100755'].includes(match[1])) throw new Error('固定评测来源不能包含链接或特殊文件')
    return [{ path, mode: match[1] === '100755' ? 0o755 : 0o644, object: match[2] }]
  })
  if (!entries.some(entry => entry.path === `agents/${identity.agent_id}/evaluation.md`)) throw new Error('固定提交缺少同版本评测定义')
  const cache = dataPath(root, `.local/evaluation-sources/${commit}/${id}`), marker = join(cache, 'snapshot.json')
  const validate = () => {
    const manifest = JSON.parse(readFileSync(marker, 'utf8'))
    if (manifest.commit !== commit || manifest.experiment_id !== id || manifest.files.length !== entries.length) throw new Error('固定评测来源缓存身份不一致')
    for (const [index, entry] of entries.entries()) {
      const file = dataPath(cache, entry.path), record = manifest.files[index]
      if (!lstatSync(file).isFile() || (lstatSync(file).mode & 0o111 ? 0o755 : 0o644) !== entry.mode
        || record.path !== entry.path || record.object !== entry.object || record.sha256 !== sha(readFileSync(file))) throw new Error('固定评测来源缓存已变化')
    }
    const candidateSha = candidateDigest(join(cache, `evolution/experiments/${id}/candidate`))
    if (candidateSha !== manifest.candidate_sha256) throw new Error('固定评测来源缓存包含额外或已变化的资产')
    return { root: cache, source_ref: ref, commit, agent_id: identity.agent_id, experiment_id: id, candidate_sha256: candidateSha }
  }
  if (existsSync(cache)) return validate()
  const temporary = `${cache}.${randomUUID()}`
  mkdirSync(temporary, { recursive: true })
  try {
    const files = entries.map(entry => {
      const bytes = git(root, ['cat-file', 'blob', entry.object]), target = dataPath(temporary, entry.path)
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { mode: entry.mode })
      return { ...entry, sha256: sha(bytes) }
    })
    const candidate = join(temporary, `evolution/experiments/${id}/candidate`)
    const dependencies = reuseParentDependencies(root, id, candidate)
    const candidateSha = candidateDigest(candidate)
    writeFileSync(join(temporary, 'snapshot.json'), JSON.stringify({ commit, experiment_id: id, files, candidate_sha256: candidateSha, dependency_reuse: dependencies }))
    try { renameSync(temporary, cache) } catch (error) { if (!existsSync(cache)) throw error }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  return validate()
}

export type McpFixture = { schema_version: 1; mode: 'mock'; connections: { server_id: string; original_url: string; url: string; enabled?: boolean }[] }
export function validateMcpFixture(input: unknown): McpFixture {
  const value = input as McpFixture
  if (!value || value.schema_version !== 1 || value.mode !== 'mock' || Object.keys(value).some(key => !['schema_version', 'mode', 'connections'].includes(key))
    || !Array.isArray(value.connections) || !value.connections.length) throw new Error('MCP fixture 必须明确 schema_version=1、mode=mock 和连接映射')
  const ids = new Set<string>()
  for (const row of value.connections) {
    if (!row || Object.keys(row).some(key => !['server_id', 'original_url', 'url', 'enabled'].includes(key))
      || typeof row.server_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.server_id) || ids.has(row.server_id)
      || row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('MCP fixture 连接身份重复或字段无效')
    ids.add(row.server_id)
    for (const text of [row.original_url, row.url]) {
      let url: URL
      try { url = new URL(text) } catch { throw new Error('MCP fixture 地址无效') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some(key => /token|secret|password|credential|auth|api.?key/i.test(key))) throw new Error('MCP fixture 地址不能包含凭据或非 HTTP 协议')
    }
  }
  return value
}

// 静态解析并保留 DSH 的 !!js 标量，绝不在来源检查阶段执行表达式。
class Expression { text: string; constructor(text: string) { this.text = text } }
const expressionSchema = (yaml: any) => yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (text: string) => new Expression(text),
  predicate: (value: unknown) => value instanceof Expression, represent: (value: Expression) => value.text,
}))

export function projectMcpFixture(candidate: string, fixtureBytes: Buffer) {
  const yaml = yamlLibrary(), schema = expressionSchema(yaml)
  if (fixtureBytes.length > 128 * 1024) throw new Error('MCP fixture 超过 128 KiB')
  const fixture = validateMcpFixture(JSON.parse(fixtureBytes.toString('utf8')))
  const harness = yaml.load(readFileSync(join(candidate, 'harness.yaml'), 'utf8'))
  const paths = ['dsh/managed/web-profile.seed.patch.yml', harness.loadable_assets.profile_patch]
  let servers: any[] | undefined
  for (const path of [...new Set(paths)]) {
    const file = dataPath(candidate, path)
    if (!existsSync(file)) continue
    const rows = yaml.load(readFileSync(file, 'utf8'), { schema })
    for (const row of Array.isArray(rows) ? rows : []) for (const item of [row, ...(row.insert ?? [])]) {
      if (item.id === 'mcp-session-manager' && Array.isArray(item.config?.servers)) servers = item.config.servers
    }
  }
  if (!servers) throw new Error('所选版本没有可映射的 MCP 管理器连接')
  const mappings = fixture.connections.map(row => {
    const server = servers!.find(server => server.id === row.server_id)
    const field = server?.specUrl ? 'specUrl' : 'url'
    if (!server || server[field] !== row.original_url) throw new Error(`MCP fixture 原链接与固定来源不一致：${row.server_id}`)
    return { ...row, field }
  })
  const projected = servers.map(server => {
    const mapping = mappings.find(row => row.server_id === server.id)
    // Mock 边界不继承原目标访问凭据；其余名称、工具选择与分组保持来源原值。
    if (!mapping) return server
    const { apiKey: _key, loginUsername: _user, loginPassword: _password, authType: _auth, authHeader: _header, loginUrl: _login, loginTokenPath: _tokenPath, headers: _headers, ...publicServer } = server
    return { ...publicServer, [mapping.field]: mapping.url, ...(mapping.enabled === undefined ? {} : { enabled: mapping.enabled }), headers: [] }
  })
  return { metadata: { schema_version: 1, mode: 'mock', sha256: sha(fixtureBytes), connections: mappings },
    patch: yaml.dump([{ id: 'mcp-session-manager', config: { servers: projected } }], { schema, noRefs: true, lineWidth: -1 }) }
}

export function renderMcpFixtureCompose(compose: string, patchPath: string): string {
  const yaml = yamlLibrary()
  const document = yaml.load(compose), service = document.services.dsh
  const position = service.command.indexOf('--no-open')
  if (position < 0) throw new Error('被测 Compose 缺少原生启动入口')
  service.command.splice(position, 0, '--patch', '/opt/harness-evaluation/mcp.fixture.patch.yml')
  service.volumes.push({ type: 'bind', source: patchPath, target: '/opt/harness-evaluation/mcp.fixture.patch.yml', read_only: true })
  return yaml.dump(document, { noRefs: true, lineWidth: -1 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, root, id, ref] = process.argv.slice(2)
    const value = action === 'source' ? materializeEvaluationSource(root, id, ref)
      : action === 'fixture' ? projectMcpFixture(root, readFileSync(id))
        : action === 'compose' ? renderMcpFixtureCompose(readFileSync(0, 'utf8'), root) : (() => { throw new Error('未知评测输入操作') })()
    process.stdout.write(JSON.stringify(value))
  } catch (error) { process.stderr.write((error as Error).message + '\n'); process.exitCode = 1 }
}

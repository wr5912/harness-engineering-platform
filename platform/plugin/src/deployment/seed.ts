import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import ts from 'typescript'
import { DEFAULT_SCHEMA, Type, load as loadYaml } from 'js-yaml'
import { McpConfigStore } from '../mcp/store.ts'
import { COMPOSITION_SERVICE_ID, readCompositions, type CompositionEntry, type CompositionVersion } from '../mcp/compositions.ts'
import { versionSource, assertStandaloneVersionSupported } from '../agents/version-source.ts'
import { workspaceConfigPath } from '../workspace.ts'

type ModelProjection = (agentId: string, selection?: { provider: string; model: string; reasoningEffort?: string }, candidatePath?: string) => Promise<{ policy: any; environment: Record<string, string> }>
type Document = { name: string; content: string }
type FixedReference = { compositionId: string; versionId: string }
const staticYaml = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))

/** 只读取明确的固定身份；不运行 Candidate 的模块、表达式或 YAML 指令。 */
function fixedReferences(documents: Document[]): FixedReference[] {
  const found = new Map<string, FixedReference>()
  const add = (compositionId: unknown, versionId: unknown) => {
    if (compositionId === undefined && versionId === undefined) return
    if (typeof compositionId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(compositionId)
      || typeof versionId !== 'string' || !/^[0-9a-f]{64}$/.test(versionId)) throw new Error('固定编排身份无法静态确定，请核对当前版本的 compositionId 和 versionId')
    found.set(`${compositionId}:${versionId}`, { compositionId, versionId })
  }
  const visited = new WeakSet<object>()
  const visitData = (value: any) => {
    if (!value || typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)
    if (Object.hasOwn(value, 'compositionId') && Object.hasOwn(value, 'versionId')) add(value.compositionId, value.versionId)
    for (const item of Object.values(value)) visitData(item)
  }
  for (const document of documents) {
    if (!document.content.includes('compositionId') || !document.content.includes('versionId')) continue
    if (/\.ya?ml$/i.test(document.name)) {
      visitData(loadYaml(document.content, { schema: staticYaml }))
      continue
    }
    if (!/\.(?:json|[cm]?js|ts)$/i.test(document.name)) continue
    const file = ts.createSourceFile(document.name, document.content, ts.ScriptTarget.Latest, true)
    const constants = new Map<string, string | null>()
    const literal = (node: ts.Node | undefined): string | undefined => {
      if (!node) return undefined
      if (ts.isStringLiteralLike(node)) return node.text
      if (ts.isIdentifier(node)) return constants.get(node.text) ?? undefined
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression)
      return undefined
    }
    function collect(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const value = ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const && node.initializer && ts.isStringLiteralLike(node.initializer) ? node.initializer.text : null
        constants.set(node.name.text, constants.has(node.name.text) ? null : value)
      } else if ((ts.isParameter(node) || ts.isBindingElement(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) && node.name && ts.isIdentifier(node.name)) constants.set(node.name.text, null)
      ts.forEachChild(node, collect)
    }
    collect(file)
    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        const fields = new Map<string, ts.Node | undefined>()
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) fields.set(property.name.text, property.initializer)
          else if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, property.name)
        }
        if (fields.has('compositionId') && fields.has('versionId')) {
          const compositionId = literal(fields.get('compositionId')), versionId = literal(fields.get('versionId'))
          let parent: ts.Node | undefined = node.parent
          while (parent && !(ts.isPropertyAssignment(parent) && /^(?:fixedCompositions|fixedBindings)$/.test(parent.name.getText(file).replace(/["']/g, '')))) parent = parent.parent
          if (parent && compositionId === undefined && versionId === undefined) throw new Error('固定编排身份无法静态确定，请在当前版本中明确 compositionId 和 versionId')
          add(compositionId, versionId)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return [...found.values()]
}

/** 仅从所选资产查连接身份；凭据直接进入打包种子，不进入预览或任务记录。 */
export function createDeploymentSeed(assetRoot: string, modelProjection: ModelProjection) {
  return async (input: { agent_id: string; experiment_id: string }, signal: AbortSignal) => {
    const source = versionSource(assetRoot, input.experiment_id)
    assertStandaloneVersionSupported(source)
    if (source.agent_id !== input.agent_id) throw new Error('所选版本不属于当前智能体')
    const candidate = join(assetRoot, source.candidate_root)
    const documents: Document[] = []
    function scan(path: string) {
      for (const name of readdirSync(path)) {
        signal.throwIfAborted()
        if (['node_modules', '.git', '.venv', 'venv', 'sessions', 'cache', '__pycache__', '__tests__'].includes(name) || name === '.env' || name.endsWith('.llm-api-key') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) continue
        const file = join(path, name), stat = lstatSync(file)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) scan(file)
        else if (stat.isFile() && stat.size < 8 * 1024 * 1024 && /\.(?:json|ya?ml|md|[cm]?js|ts)$/.test(name)) documents.push({ name: file, content: readFileSync(file, 'utf8') })
      }
    }
    scan(candidate)
    const text = documents.map(document => document.content).join('\n')
    const environment: Record<string, string> = {}
    const envFile = join(candidate, 'workspace', '.env')
    if (existsSync(envFile)) Object.assign(environment, parseEnv(readFileSync(envFile, 'utf8')))
    for (const name of source.optional_env_names ?? []) if (process.env[name] !== undefined) environment[name] = process.env[name]!
    const notices: string[] = []
    let projected: Awaited<ReturnType<ModelProjection>> | undefined
    try { projected = await modelProjection(input.agent_id, undefined, join(assetRoot, 'evolution/experiments', input.experiment_id, 'candidate')); Object.assign(environment, projected.environment) }
    catch { notices.push('当前模型连接未能完整导出，可在目标环境通过 agent configure 配置；本地业务 Provider 仍保留。') }
    signal.throwIfAborted()
    let configuration: any = { servers: [], groups: [], sharedToken: '' }
    if (existsSync(workspaceConfigPath(assetRoot, 'mcp-manager.json'))) configuration = new McpConfigStore(assetRoot, () => {}).view().value
    const mentioned = (id: string) => {
      const literal = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?:mcp__|mcp/groups/|["'\\s])${literal}(?:__|/|["'\\s])`).test(text)
    }
    const groups = configuration.groups.filter((group: any) => mentioned(group.id))
    const direct = configuration.servers.filter((server: any) => mentioned(server.id) || mentioned(server.serverName ?? server.id))
    const memberIds = new Set<string>(groups.flatMap((group: any) => group.members.map((member: any) => member.serverId)))
    const mountServerIds = [...new Set<string>([...groups.map((group: any) => group.id), ...direct.map((server: any) => server.id)])]
    const catalog = readCompositions(workspaceConfigPath(assetRoot, 'mcp-compositions.json')).catalog
    const names = new Set(groups.flatMap((group: any) => group.members.filter((m: any) => m.serverId === 'platform-compositions').flatMap((m: any) => m.names ?? [])))
    const selected = new Map<string, Map<string, CompositionVersion>>()
    const published = new Map<string, string>()
    const neededServers = new Set<string>([...memberIds, ...direct.map((server: any) => server.id)])
    const include = (id: string, versionId: string, current = false, visiting = new Set<string>()) => {
      signal.throwIfAborted()
      const key = `${id}:${versionId}`
      if (visiting.has(key)) throw new Error('所选编排存在循环固定版本依赖，无法独立导出')
      const version = catalog.compositions.find(entry => entry.id === id)?.versions?.find(item => item.versionId === versionId)
      if (!version) throw new Error(`编排 ${id} 的固定版本 ${versionId.slice(0, 12)} 不存在，未替换为其他版本`)
      if (current) published.set(id, versionId)
      const versions = selected.get(id) ?? new Map<string, CompositionVersion>()
      if (versions.has(versionId)) return
      versions.set(versionId, version); selected.set(id, versions)
      const config = version.config
      for (const connection of [config.connectionId, config.alertsConnectionId, config.bindings?.socConnectionId, config.bindings?.reportConnectionId]) {
        if (connection && connection !== COMPOSITION_SERVICE_ID) neededServers.add(connection)
      }
      for (const step of config.steps ?? []) include(step.compositionId, step.versionId, false, new Set([...visiting, key]))
    }
    const explicit = fixedReferences(documents)
    for (const reference of explicit) include(reference.compositionId, reference.versionId)
    for (const entry of catalog.compositions) {
      if (!entry.published) continue
      const tool = entry.published.toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const directTool = new RegExp(`mcp__(?:compositions|platform-compositions)__${tool}(?![A-Za-z0-9_.-])`).test(text)
      if (names.has(entry.published.toolName) || directTool) include(entry.id, entry.publishedVersionId!, true)
      if (directTool && !mountServerIds.includes(COMPOSITION_SERVICE_ID)) mountServerIds.push(COMPOSITION_SERVICE_ID)
    }
    for (const name of names) if (!catalog.compositions.some(entry => entry.published?.toolName === name)) throw new Error(`所选 MCP 分组中的编排工具 ${name} 尚未发布，请核对分组后重试`)
    const entries: CompositionEntry[] = [...selected].map(([id, versions]) => {
      const version = versions.get(published.get(id) ?? '') ?? versions.values().next().value!
      return { id, published: { ...version.config, ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}) }, publishedVersionId: version.versionId, versions: [...versions.values()] }
    })
    const servers = configuration.servers.filter((server: any) => neededServers.has(server.id))
    for (const id of neededServers) if (id !== COMPOSITION_SERVICE_ID && !servers.some((server: any) => server.id === id)) throw new Error(`所选业务编排引用的 MCP 连接 ${id} 尚未配置，请补齐连接后重试`)
    const compositions = { schema_version: catalog.schema_version, compositions: entries }
    return { seed: { agentId: input.agent_id, experimentId: input.experiment_id, modelPatch: projected?.policy.patch ?? [], defaultModel: projected?.policy.default,
      environment, mcp: { servers, groups, sharedToken: configuration.sharedToken, mountServerIds }, compositions }, notices }
  }
}

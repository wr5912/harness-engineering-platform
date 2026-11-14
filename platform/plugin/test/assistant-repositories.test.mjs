import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { assistantWorkspaceScope } from '../src/workspace.ts'
import { currentRepositorySource, resolveRepository, listRepositories } from '../src/assistant/repositories.ts'
import { createAssistant } from '../src/assistant/index.ts'
import { bindConversationWorkspace } from '../src/conversation-workspace.ts'

function fixture(t) {
  const lab = mkdtempSync(join(tmpdir(), 'assistant-repositories-')), manager = join(lab, 'manager-workspace'), root = join(manager, 'harness-engineering-platform-data'), repository = join(manager, 'business-agents')
  t.after(() => rmSync(lab, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'), { recursive: true }); mkdirSync(repository)
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('remote', 'add', 'origin', 'git@github.com:fixture/business.git')
  writeFileSync(join(repository, 'AGENTS.md'), '业务仓库项目规则。'); git('add', '.'); git('commit', '-m', 'fixture')
  const entry = { id: 'business-agents', url: 'git@github.com:fixture/business.git', ref: 'main', path: '../business-agents', commit: git('rev-parse', 'HEAD') }
  const save = () => {
    writeFileSync(join(root, 'config/repositories.json'), JSON.stringify({ schemaVersion: 1, repositories: [entry] }))
    writeFileSync(join(root, 'config/assistant-workspace.json'), JSON.stringify({
      schemaVersion: 1, kind: 'platform-assistant-business-workspace', defaultRepositoryId: 'manager-workspace', workspaceRoot: '..',
      allowedRepositoryIds: ['data', 'business-agents'], businessRepositoryId: 'business-agents',
      excludedRepositoryIds: ['harness-engineering-platform', 'platform-manager-dsh-home'], roles: {
        data: 'business-runtime-and-history', 'business-agents': 'business-definition-acceptance-and-harness',
        'harness-engineering-platform': 'tool-source-only', 'platform-manager-dsh-home': 'runtime-identity-only',
      },
    }))
  }
  save()
  return { root, manager, lab, repository, entry, git, save }
}

test('按真实 Git identity 解析目标，dirty 不伪装为提交来源，坏锁不阻断默认manager-workspace', t => {
  const f = fixture(t)
  const before = resolveRepository(f.root, 'business-agents')
  assert.equal(before.workspace, f.repository); assert.equal(before.commit, f.entry.commit); assert.equal(before.dirty, false)
  writeFileSync(join(f.repository, 'draft.txt'), '未提交内容')
  assert.equal(resolveRepository(f.root, 'business-agents').dirty, true)
  f.entry.commit = 'f'.repeat(40); f.save()
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /锁定提交不一致/)
  const listed = listRepositories(f.root)
  assert.equal(listed.default_repository_id, 'manager-workspace')
  assert.equal(listed.repositories[0].id, 'manager-workspace'); assert.equal(listed.repositories[0].available, true)
  assert.equal(listed.repositories[1].id, 'data'); assert.equal(listed.repositories[1].available, true)
  assert.equal(listed.repositories[2].available, false)
  assert.throws(() => resolveRepository(f.root, '../business'), /未登记/)
  assert.throws(() => resolveRepository(f.root, 'harness-engineering-platform'), /业务工作区/)
  f.entry.commit = before.commit; f.entry.agent_path = '../harness-engineering-platform-data'; f.save()
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /相对路径/)
})

test('HTTP GitLab 主源与 GitHub 镜像并存时，按登记地址解析而不依赖 origin 名称', t => {
  const f = fixture(t)
  f.git('remote', 'rename', 'origin', 'github')
  f.entry.url = 'http://gitlab.example.invalid/ai-soc/business-agents.git'
  f.git('remote', 'add', 'gitlab', f.entry.url); f.save()
  assert.equal(resolveRepository(f.root, 'business-agents').url, f.entry.url)
  assert.equal(listRepositories(f.root).repositories.find(item => item.id === 'business-agents').available, true)
  f.git('remote', 'remove', 'gitlab')
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /远端与登记不一致/)
  for (const url of ['http://user@gitlab.example.invalid/repo.git', 'http://gitlab.example.invalid/repo.git?token=private-value']) {
    f.entry.url = url; f.save()
    assert.throws(() => listRepositories(f.root), /不能携带凭据或查询参数/)
  }
})

test('business-agents 的 GitLab 登记可核对 GitHub 镜像，回执保留登记 URL', t => {
  const f = fixture(t)
  f.entry.url = 'http://172.16.138.233/ai-soc/business-agents.git'; f.save()
  f.git('remote', 'set-url', 'origin', 'git@github.com:wr5912/business-agents.git')
  const repository = resolveRepository(f.root, 'business-agents')
  assert.equal(repository.url, f.entry.url)
  assert.equal(repository.commit, f.entry.commit)
  f.git('remote', 'set-url', 'origin', 'git@github.com:someone/business-agents.git')
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /远端与登记不一致/)
})

test('当前来源策略独立于历史仓库快照，非 172.16 环境优先 GitHub', t => {
  const f = fixture(t)
  f.entry.url = 'http://172.16.138.233/ai-soc/business-agents.git'; f.save()
  const policy = currentRepositorySource(f.root, 'business-agents')
  assert.equal(policy.repository_id, 'business-agents')
  assert.equal(policy.effective_transport_url, 'git@github.com:wr5912/business-agents.git')
  assert.deepEqual(policy.transport_candidates, ['git@github.com:wr5912/business-agents.git', 'http://172.16.138.233/ai-soc/business-agents.git'])
})

test('业务工作区只暴露 data 与 business-agents，程序仓和管理 HOME 保持运行时角色', t => {
  const f = fixture(t), scope = assistantWorkspaceScope(f.root)
  assert.deepEqual(scope.allowed_repository_ids, ['data', 'business-agents'])
  assert.deepEqual(scope.excluded_repository_ids, ['harness-engineering-platform', 'platform-manager-dsh-home'])
  assert.equal(scope.default_repository_id, 'manager-workspace')
  assert.equal(scope.business_repository_id, 'business-agents')
  assert.equal(scope.roots.data, f.root)
  assert.equal(scope.roots.business_agents, f.repository)
  assert.equal(scope.manager_workspace_root, f.manager)
  assert.equal(scope.roles['harness-engineering-platform'], 'tool-source-only')
  assert.equal(scope.roles['platform-manager-dsh-home'], 'runtime-identity-only')
  writeFileSync(join(f.root, 'config/assistant-workspace.json'), JSON.stringify({
    schemaVersion: 1, kind: 'platform-assistant-business-workspace', defaultRepositoryId: 'manager-workspace', workspaceRoot: '..',
    allowedRepositoryIds: ['data', 'business-agents', 'harness-engineering-platform'], businessRepositoryId: 'business-agents',
    excludedRepositoryIds: ['platform-manager-dsh-home'], roles: scope.roles,
  }))
  assert.throws(() => assistantWorkspaceScope(f.root), /契约无效/)
  writeFileSync(join(f.root, 'config/assistant-workspace.json'), JSON.stringify({
    schemaVersion: 1, kind: 'platform-assistant-business-workspace', defaultRepositoryId: 'manager-workspace', workspaceRoot: '..',
    allowedRepositoryIds: ['data', 'business-agents'], businessRepositoryId: 'business-agents',
    excludedRepositoryIds: ['harness-engineering-platform'], roles: scope.roles,
  }))
  assert.throws(() => assistantWorkspaceScope(f.root), /契约无效/)
})

test('管理工作区要求真实业务目录，目录链接不能代替迁移', t => {
  const f = fixture(t), outside = join(f.lab, 'old-business-agents')
  renameSync(f.repository, outside)
  symlinkSync(outside, f.repository, 'dir')
  assert.throws(() => assistantWorkspaceScope(f.root), /真实目录/)
})

test('目标仓库预备会话只创建不投递，续接固定来源且冷恢复不随当前选择漂移', async t => {
  const f = fixture(t), ctx = new Context()
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  const sessions = new Map(), prompts = []; let count = 0
  const services = {
    controller: {
      async create({ cwd }) { const id = `session-${++count}`; sessions.set(id, ctx.sessions.create(id, { meta: { cwd } })); return { sessionId: id } },
      async resolveAgent(id) { return { agent: { id, session: sessions.get(id) } } },
      async prompt(request) { prompts.push(request) }, cancel() {},
    },
    skills: {}, projections: ctx.sessionProjections, record: appendPluginRecord, notify() {},
  }
  let assistant = createAssistant(f.root, async () => ({ ok: true, value: {} }), services)
  t.after(async () => { await assistant.dispose(); await ctx.fiber.dispose() })
  const call = (action, body = {}) => assistant.handler(action, body, new AbortController().signal)
  const defaultSession = await call('prepare-session')
  assert.equal(defaultSession.ok, true, JSON.stringify(defaultSession))
  assert.equal(defaultSession.value.repository.id, 'manager-workspace')
  assert.equal(defaultSession.value.repository.kind, 'workspace')
  assert.equal(defaultSession.value.repository.commit, null, '父目录不是一个 Git 仓库')
  assert.equal(sessions.get(defaultSession.value.session_id).header.cwd, f.manager)
  const dataSession = await call('prepare-session', { repository_id: 'data' })
  assert.equal(dataSession.ok, true)
  assert.equal(sessions.get(dataSession.value.session_id).header.cwd, f.manager)
  assert.equal(dataSession.value.repository.workspace, f.root, '业务目标保留真实仓库路径，不注册为原生工作区')
  const prepared = await call('prepare-session', { repository_id: 'business-agents' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); const id = prepared.value.session_id
  assert.equal(sessions.get(id).header.cwd, f.manager); assert.equal(prompts.length, 0)
  assert.equal(prepared.value.repository.workspace, f.repository)
  const status = await call('status', { session_id: id })
  assert.equal(status.ok, true, JSON.stringify(status)); assert.deepEqual(status.value.business_workspace.allowed_repository_ids, ['data', 'business-agents'])
  assert.deepEqual(status.value.business_workspace.excluded_repository_ids, ['harness-engineering-platform', 'platform-manager-dsh-home'])
  const task = { session_id: id, request_id: 'fixed-request', task: '读取仓库项目规则' }
  assert.equal((await call('session', task)).ok, true)
  assert.match(prompts[0].content[1].text, /当前来源事实/)
  assert.match(prompts[0].content[1].text, /github\.com:fixture\/business/)
  assert.equal((await call('session', task)).ok, true); assert.equal(prompts.length, 1)
  assert.equal((await call('session', { ...task, repository_id: 'data' })).ok, false)
  assert.equal((await call('session', { cwd: '/tmp' })).ok, false)
  await assistant.dispose(); assistant = createAssistant(f.root, async () => ({ ok: true, value: {} }), services)
  f.entry.commit = 'f'.repeat(40); f.save()
  const state = await call('status', { session_id: id })
  assert.equal(state.value.repository.commit, prepared.value.repository.commit)
  assert.equal(state.value.repository.workspace, f.repository)
  assert.equal((await call('session', { ...task, request_id: 'second-request', task: '继续原会话' })).ok, true)
  assert.equal(prompts.length, 2)
  const oldData = join(f.lab, 'old-data')
  writeFileSync(join(f.root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture', legacyRoots: [oldData] }))
  sessions.set('legacy-session', ctx.sessions.create('legacy-session', { meta: { cwd: oldData } }))
  const resumed = await call('session', { session_id: 'legacy-session', task: '继续旧任务' })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(sessions.get('legacy-session').header.cwd, oldData, '历史会话 cwd 不被改写')
  assert.equal((await call('status', { session_id: 'legacy-session' })).value.repository.id, 'data')
})

test('原生工作区只绑定 manager，清除其他登记且仅保护绑定工作区的删除', async t => {
  const f = fixture(t), creates = [], deleted = [], requests = []; let dispose
  const legacyData = { id: 'ws-data', path: f.root, sessionIds: ['legacy-data-session'] }
  const legacyBusiness = { id: 'ws-business', path: f.repository, sessionIds: ['legacy-business-session'] }
  const unrelated = join(f.lab, 'unrelated-workspace'); mkdirSync(unrelated)
  writeFileSync(join(unrelated, 'history.txt'), '保留其他目录和历史会话')
  const legacyOther = { id: 'ws-other', path: unrelated, sessionIds: ['legacy-other-session'] }
  const rows = [legacyData, legacyBusiness, legacyOther]
  const registry = {
    async create(path) { let row = rows.find(item => item.path === path); if (!row) { row = { id: 'ws-manager', path, sessionIds: [] }; rows.push(row) }; return row },
    list: () => rows, async delete(id) { const index = rows.findIndex(item => item.id === id); if (index < 0) return false; deleted.push(id); rows.splice(index, 1); return true },
  }
  const native = async request => { creates.push(request); return { sessionId: 'native-session' } }
  const nativeDelete = async function (request) {
    assert.equal(this, services.workspaceController)
    requests.push(request)
    if (!await registry.delete(request.workspaceId)) throw new Error('workspace/not-found')
    return { deleted: true }
  }
  const services = { workspaceRegistry: registry, workspaceController: { delete: nativeDelete }, sessionController: { create: native } }
  await bindConversationWorkspace({ get: name => services[name], effect: callback => { dispose = callback() } }, f.root)
  assert.deepEqual(rows.map(item => item.path), [f.manager])
  assert.deepEqual(deleted, ['ws-data', 'ws-business', 'ws-other'], '清理时不因原生数组原地删除而遗漏登记')
  const manager = rows[0]
  await services.sessionController.create({ agentPreset: 'standard' })
  assert.equal(creates.at(-1).workspaceId, manager.id)
  await services.sessionController.create({ cwd: f.manager, agentPreset: 'standard' })
  assert.equal(creates.at(-1).workspaceId, manager.id)
  assert.equal(creates.at(-1).cwd, undefined)
  for (const path of [f.root, f.repository, unrelated, tmpdir()]) {
    await assert.rejects(registry.create(path), /不能添加其他工作区/)
    await assert.rejects(services.sessionController.create({ cwd: path }), /不能添加其他工作区/)
  }
  for (const name of ['harness-engineering-platform', 'platform-manager-dsh-home']) {
    const path = join(f.lab, name); mkdirSync(path)
    await assert.rejects(registry.create(path), /不能添加其他工作区/)
  }
  await assert.rejects(services.workspaceController.delete({ workspaceId: manager.id }), /manager-workspace 不能移除/)
  assert.deepEqual(requests, [], '保护绑定工作区时不触发原生删除')
  rows.push(legacyOther)
  const request = { workspaceId: legacyOther.id }
  assert.deepEqual(await services.workspaceController.delete(request), { deleted: true })
  assert.equal(requests.at(-1), request, '其他工作区删除沿用原生请求和回执')
  await assert.rejects(services.workspaceController.delete({ workspaceId: 'missing' }), /workspace\/not-found/)
  assert.deepEqual(rows.map(item => item.path), [f.manager])
  assert.deepEqual(legacyData.sessionIds, ['legacy-data-session'])
  assert.deepEqual(legacyBusiness.sessionIds, ['legacy-business-session'])
  assert.deepEqual(legacyOther.sessionIds, ['legacy-other-session'])
  assert.equal(readFileSync(join(unrelated, 'history.txt'), 'utf8'), '保留其他目录和历史会话')
  dispose()
  assert.equal(services.sessionController.create, native)
  assert.equal(services.workspaceController.delete, nativeDelete)
  assert.equal(readFileSync(join(f.repository, 'AGENTS.md'), 'utf8'), '业务仓库项目规则。')
})

test('数据仓库无分支或无origin仍保留真实提交，地址中的凭据不进入回执', t => {
  const f = fixture(t)
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('add', '.'); git('commit', '-m', 'fixture'); const commit = git('rev-parse', 'HEAD')
  git('checkout', '--detach', 'HEAD')
  assert.equal(resolveRepository(f.root, 'data').commit, commit)
  git('remote', 'add', 'origin', 'https://account:private-password@example.invalid/data.git?token=private-token')
  const snapshot = resolveRepository(f.root, 'data')
  assert.equal(snapshot.commit, commit); assert.equal(snapshot.ref, null)
  assert.equal(snapshot.url, 'https://example.invalid/data.git')
  assert.doesNotMatch(JSON.stringify(snapshot), /private-password|private-token/)
})

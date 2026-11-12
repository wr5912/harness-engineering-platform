import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { resolveRepository, listRepositories } from '../src/assistant/repositories.ts'
import { createAssistant } from '../src/assistant/index.ts'
import { bindConversationWorkspace } from '../src/conversation-workspace.ts'

function fixture(t) {
  const lab = mkdtempSync(join(tmpdir(), 'assistant-repositories-')), root = join(lab, 'data'), repository = join(lab, 'business')
  t.after(() => rmSync(lab, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'), { recursive: true }); mkdirSync(repository)
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('remote', 'add', 'origin', 'git@github.com:fixture/business.git')
  writeFileSync(join(repository, 'AGENTS.md'), '业务仓库项目规则。'); git('add', '.'); git('commit', '-m', 'fixture')
  const entry = { id: 'business-agents', url: 'git@github.com:fixture/business.git', ref: 'main', path: '../business', commit: git('rev-parse', 'HEAD') }
  const save = () => writeFileSync(join(root, 'config/repositories.json'), JSON.stringify({ schemaVersion: 1, repositories: [entry] }))
  save()
  return { root, repository, entry, git, save }
}

test('按真实 Git identity 解析目标，dirty 不伪装为提交来源，坏锁不阻断默认data', t => {
  const f = fixture(t)
  const before = resolveRepository(f.root, 'business-agents')
  assert.equal(before.workspace, f.repository); assert.equal(before.commit, f.entry.commit); assert.equal(before.dirty, false)
  writeFileSync(join(f.repository, 'draft.txt'), '未提交内容')
  assert.equal(resolveRepository(f.root, 'business-agents').dirty, true)
  f.entry.commit = 'f'.repeat(40); f.save()
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /锁定提交不一致/)
  const listed = listRepositories(f.root)
  assert.equal(listed.repositories[0].id, 'data'); assert.equal(listed.repositories[0].available, true)
  assert.equal(listed.repositories[1].available, false)
  assert.throws(() => resolveRepository(f.root, '../business'), /未登记/)
  f.entry.commit = before.commit; f.entry.agent_path = '../data'; f.save()
  assert.throws(() => resolveRepository(f.root, 'business-agents'), /相对路径/)
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
  const prepared = await call('prepare-session', { repository_id: 'business-agents' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); const id = prepared.value.session_id
  assert.equal(sessions.get(id).header.cwd, f.repository); assert.equal(prompts.length, 0)
  const task = { session_id: id, request_id: 'fixed-request', task: '读取仓库项目规则' }
  assert.equal((await call('session', task)).ok, true)
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
})

test('原生工作区只接受已登记根，保留目标cwd并撤销其他登记，卸载恢复原生接口', async t => {
  const f = fixture(t), rows = [], creates = []; let dispose
  const registry = {
    async create(path) { let row = rows.find(item => item.path === path); if (!row) { row = { id: `ws-${rows.length}`, path, sessionIds: [] }; rows.push(row) }; return row },
    list: () => rows, async delete(id) { rows.splice(rows.findIndex(item => item.id === id), 1); return true },
  }
  const native = async request => { creates.push(request); return { sessionId: 'native-session' } }
  const services = { workspaceRegistry: registry, workspaceController: { delete() {} }, sessionController: { create: native } }
  await bindConversationWorkspace({ get: name => services[name], effect: callback => { dispose = callback() } }, f.root)
  const target = rows.find(item => item.path === f.repository)
  assert.ok(target)
  await services.sessionController.create({ cwd: f.repository, agentPreset: 'standard' })
  assert.equal(creates.at(-1).workspaceId, target.id)
  assert.equal(creates.at(-1).cwd, undefined)
  await assert.rejects(registry.create(tmpdir()), /不能添加其他工作区/)
  await assert.rejects(services.sessionController.create({ cwd: tmpdir() }), /不能添加其他工作区/)
  dispose(); assert.equal(services.sessionController.create, native)
  assert.equal(readFileSync(join(f.repository, 'AGENTS.md'), 'utf8'), '业务仓库项目规则。')
})

test('数据仓库无分支或无origin仍保留真实提交，地址中的凭据不进入回执', t => {
  const f = fixture(t)
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('add', '.'); git('commit', '-m', 'fixture'); const commit = git('rev-parse', 'HEAD')
  git('checkout', '--detach', 'HEAD')
  assert.equal(resolveRepository(f.root).commit, commit)
  git('remote', 'add', 'origin', 'https://account:private-password@example.invalid/data.git?token=private-token')
  const snapshot = resolveRepository(f.root)
  assert.equal(snapshot.commit, commit); assert.equal(snapshot.ref, null)
  assert.equal(snapshot.url, 'https://example.invalid/data.git')
  assert.doesNotMatch(JSON.stringify(snapshot), /private-password|private-token/)
})

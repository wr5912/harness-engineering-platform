import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { load as loadYaml } from 'js-yaml'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const plugin = fileURLToPath(new URL('../', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

async function rpc(handler, action, input) {
  const result = await handler(action, input, new AbortController().signal)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}

function assertLocalLinks(workspace, file) {
  for (const [, link] of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const [path, anchor] = link.split('#')
    const target = resolve(dirname(file), path)
    assert.ok(target.startsWith(workspace + sep), `引用应位于自身工作区：${link}`)
    assert.ok(existsSync(target), `缺少本地引用：${link}`)
    assert.equal(lstatSync(target).isSymbolicLink(), false)
    if (anchor) assert.ok(readFileSync(target, 'utf8').includes(`## ${anchor}`), `缺少段落定位：${link}`)
  }
}

test('Wiki 经真实资产接口形成可读独立副本，并按来源合同挂载；管理更新不传播到其他 Agent 或版本', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'wiki-integration-'))
  const root = join(temporary, 'data')
  const previous = { HARNESS_PROGRAM_ROOT: process.env.HARNESS_PROGRAM_ROOT, HARNESS_ASSET_ROOT: process.env.HARNESS_ASSET_ROOT }
  process.env.HARNESS_PROGRAM_ROOT = repo
  process.env.HARNESS_ASSET_ROOT = root
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(temporary, { recursive: true, force: true })
  })
  const outfile = join(temporary, 'agents.mjs')
  await build({ entryPoints: [join(plugin, 'src/agents/index.ts')], outfile, bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/dsh-client-connection'] })
  const { createAgentsHandler } = await import(pathToFileURL(outfile).href)

  const targets = [
    { agent: 'agent-one', id: 'EXP-agent-one-001-r000000000001', active: 'EXP-agent-one-001-r000000000001' },
    { agent: 'agent-one', id: 'EXP-agent-one-002-r000000000002', active: 'EXP-agent-one-001-r000000000001' },
    { agent: 'agent-two', id: 'EXP-agent-two-001-r000000000003', active: 'EXP-agent-two-001-r000000000003' },
  ]
  for (const target of targets) {
    target.candidate = join(root, 'evolution/experiments', target.id, 'candidate')
    write(join(root, 'agents', target.agent, 'manifest.yaml'), `agent_id: ${target.agent}\nactive_experiment: ${target.active}\n`)
    write(join(root, 'evolution/experiments', target.id, 'change.yaml'), `experiment_id: ${target.id}\nagent_id: ${target.agent}\nstatus: active\n`)
    write(join(target.candidate, 'harness.yaml'), `loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: ${target.agent}\n  profile_patch: dsh/managed/agent.patch.yml\ncredential_environment_keys: []\n`)
    write(join(target.candidate, 'dsh/workspace/AGENTS.md'), `# ${target.agent}\n\n按既有职责回答。\n`)
    write(join(target.candidate, `dsh/presets/${target.agent}/agent.cordis.yml`), '[]\n')
    write(join(target.candidate, 'dsh/managed/agent.patch.yml'), '[]\n')
  }
  const management = join(root, 'knowledge/maintenance')
  const original = '检修前确认设备停机，等待 30 分钟。\n'
  const originalSha = hash(original)
  write(join(management, 'raw/guide.txt'), original)
  const documents = {
    'index.md': `# 检修知识\n\n[操作规程](wiki/guide.md)\n\n## sources\n\n原件：guide.txt；SHA-256：${originalSha}。原件由管理库保存，未随业务副本部署。\n`,
    'wiki/guide.md': '# 检修规则\n\n检修前确认设备停机，等待 30 分钟。\n\n[资料段落](../readable/guide.md#paragraph-1)；[来源登记](../index.md#sources)。\n',
    'readable/guide.md': `# 文本阅读副本\n\n## paragraph-1\n\n${original}`,
  }
  for (const [path, content] of Object.entries(documents)) write(join(management, path), content)

  const handler = createAgentsHandler(root)
  for (const target of targets) {
    const detail = await rpc(handler, 'detail', { agent_id: target.agent, ...(target.id !== target.active ? { experiment_id: target.id } : {}) })
    assert.equal(detail.experiment.id, target.id)
    assert.equal(detail.agent.manifest.active_experiment, target.active)
    assert.equal(detail.selection.basis, target.id === target.active ? 'active_experiment' : 'explicit')
    const harness = loadYaml((await rpc(handler, 'edit/read', { experiment_id: target.id, path: 'candidate/harness.yaml' })).content)
    target.workspace = resolve(target.candidate, harness.loadable_assets.workspace)
    assert.equal(detail.declared.source_contract.workspace, target.workspace)
    assert.equal(resolve(root, detail.declared.loadable_source.candidate_root, 'workspace'), target.workspace)

    const edits = []
    for (const path of Object.keys(documents)) {
      const content = readFileSync(join(management, path), 'utf8')
      const file = relative(root, join(target.workspace, 'knowledge/maintenance', path))
      const before = await rpc(handler, 'edit/read', { experiment_id: target.id, path: file })
      assert.equal(before.exists, false)
      assert.equal(before.sha256, null)
      edits.push({ path: file, content, expected_sha256: before.sha256 })
    }
    const emptyHash = await handler('edit/apply', { experiment_id: target.id, edits: [{ ...edits[0], expected_sha256: '' }] }, new AbortController().signal)
    assert.equal(emptyHash.ok, false)
    assert.equal(emptyHash.error.code, 'conflict')
    const rolePath = relative(root, join(target.workspace, 'AGENTS.md'))
    const role = await rpc(handler, 'edit/read', { experiment_id: target.id, path: rolePath })
    edits.push({ path: rolePath, content: `${role.content}\n检修相关问题先读取[检修知识](knowledge/maintenance/index.md)，再按需读取有关主题；资料不改变现有权限。\n`, expected_sha256: role.sha256 })
    await rpc(handler, 'edit/preview', { experiment_id: target.id, edits })
    const saved = await rpc(handler, 'edit/apply', { experiment_id: target.id, edits })
    target.snapshot = new Map()
    for (const edit of edits) {
      const after = await rpc(handler, 'edit/read', { experiment_id: target.id, path: edit.path })
      assert.equal(after.content, edit.content)
      assert.equal(after.sha256, hash(edit.content))
      assert.equal(saved.written.find(item => item.path === edit.path).sha256, after.sha256)
      target.snapshot.set(edit.path, after.sha256)
      assertLocalLinks(target.workspace, join(root, edit.path))
    }
  }

  // 运行时挂载计划使用真实来源解析器，既不启动容器也不调用模型。
  const planResult = spawnSync(process.env.HARNESS_PYTHON || 'python3', [join(repo, 'runtime/adapters/dsh-container/source_contract.py'), '--source', `experiment:${targets[0].id}`, '--repo', root, '--mount-plan', 'subject'], { cwd: root, encoding: 'utf8' })
  assert.equal(planResult.status, 0, planResult.stderr)
  const workspaceMount = JSON.parse(planResult.stdout).mounts.find(item => item.purpose === 'harness-workspace')
  assert.deepEqual(workspaceMount, { host: targets[0].workspace, container: '/work/harness/workspace', mode: 'ro', purpose: 'harness-workspace' })

  const revised = original.replace('30 分钟', '60 分钟')
  write(join(management, 'raw/guide-v2.txt'), revised)
  write(join(management, 'index.md'), documents['index.md'] + `\n新版原件：guide-v2.txt；SHA-256：${hash(revised)}。\n`)
  write(join(management, 'wiki/guide.md'), documents['wiki/guide.md'].replace('30 分钟', '60 分钟'))
  write(join(management, 'readable/guide.md'), documents['readable/guide.md'].replace('30 分钟', '60 分钟'))
  assert.equal(hash(readFileSync(join(management, 'raw/guide.txt'))), originalSha)
  for (const target of targets) {
    for (const [path, expected] of target.snapshot) assert.equal((await rpc(handler, 'edit/read', { experiment_id: target.id, path })).sha256, expected)
  }

  // 对选定新版本的后续修改也不能影响同 Agent 旧版本或另一个 Agent。
  const selected = targets[1]
  const selectedPath = relative(root, join(selected.workspace, 'knowledge/maintenance/wiki/guide.md'))
  const before = await rpc(handler, 'edit/read', { experiment_id: selected.id, path: selectedPath })
  await rpc(handler, 'edit/apply', { experiment_id: selected.id, edits: [{ path: selectedPath, content: before.content.replace('30 分钟', '60 分钟'), expected_sha256: before.sha256 }] })
  assert.notEqual((await rpc(handler, 'edit/read', { experiment_id: selected.id, path: selectedPath })).sha256, before.sha256)
  for (const target of [targets[0], targets[2]]) {
    for (const [path, expected] of target.snapshot) assert.equal((await rpc(handler, 'edit/read', { experiment_id: target.id, path })).sha256, expected)
  }
})

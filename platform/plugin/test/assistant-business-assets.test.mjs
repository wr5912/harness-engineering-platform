import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { assistantConfiguration, managementSkill, managementSkills } from '../src/assistant/business-assets.ts'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const sdk = async name => import(pathToFileURL(sdkRequire.resolve(name)).href)
const [{ Context }, { SkillRegistry }, { FileSystemSkillProvider }] = await Promise.all([
  sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-skill'), sdk('@deepseek-ai/dsh-skill-filesystem'),
])
function fixture(t, { empty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'management-native-skills-'))
  const ctx = new Context()
  new SkillRegistry(ctx, {})
  let provider
  ctx.skills.registerProvider(control => provider = new FileSystemSkillProvider(ctx, control, { includeDefaultRoots: false, customSkillDirs: [join(root, '.agents/skills')], watch: false }))
  const writeSkill = (name, body = `真实技能 ${name}`) => {
    const path = join(root, '.agents/skills', name, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\nname: ${name}\ndescription: 原生技能加载验收\n---\n${body}`)
    provider.observeHostMutation(path)
    return path
  }
  if (!empty) {
    writeFileSync(join(root, 'AGENTS.md'), '当前工作区的管理原则')
    for (const name of managementSkills) writeSkill(name)
  }
  t.after(async () => { await provider.dispose(); await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { root, ctx, writeSkill, provider }
}

test('真实原生注册表装载全部管理技能，正文变更下一次读取生效', async t => {
  const f = fixture(t)
  const config = await assistantConfiguration(f.root, f.ctx.skills)
  assert.equal(config.ready, true)
  assert.equal(config.missing.length, 0)
  assert.equal(config.assets.length, managementSkills.length + 1)
  assert.equal(config.tasks['reviewing-agent-skills'], true)
  assert.ok(config.assets.filter(asset => asset.name !== 'AGENTS.md').every(asset => asset.path.startsWith(join(f.root, '.agents/skills'))))
  const previous = await managementSkill(f.root, f.ctx.skills, 'user-facing-output')
  const path = f.writeSkill('user-facing-output', '改用用户任务结果开头。')
  const changed = await managementSkill(f.root, f.ctx.skills, 'user-facing-output')
  assert.equal(changed.content, '改用用户任务结果开头。')
  assert.notEqual(changed.sha256, previous.sha256)
  assert.equal(changed.path, path)
  assert.match(readFileSync(path, 'utf8'), /name: user-facing-output/)
})

test('旧引导入口使用工作区管理配置，不再要求或发布已退役技能', async t => {
  const f = fixture(t)
  const context = { skill: 'harness-guided-workflow', agent_id: 'fixed-agent' }
  const config = await assistantConfiguration(f.root, f.ctx.skills, context)
  assert.equal(config.ready, true)
  assert.equal(config.requested_skill, 'workspace-management')
  assert.equal(config.tasks['workspace-management'], true)
  assert.equal(config.tasks['harness-guided-workflow'], undefined)
  assert.ok(!config.assets.some(asset => asset.name === 'harness-guided-workflow'))
  assert.deepEqual(config.missing, [])
  assert.deepEqual(context, { skill: 'harness-guided-workflow', agent_id: 'fixed-agent' }, '配置查询不得改写调用方上下文')
  rmSync(join(f.root, '.agents/skills/workspace-management/SKILL.md'))
  assert.equal((await assistantConfiguration(f.root, f.ctx.skills, context)).ready, false, '兼容旧名不能绕过真实工作区技能校验')
})

test('空白数据工作区可查询配置，缺失或不可装载技能不以文件存在冒充就绪', async t => {
  const f = fixture(t, { empty: true })
  assert.equal((await assistantConfiguration(f.root, f.ctx.skills)).ready, false)
  writeFileSync(join(f.root, 'AGENTS.md'), '管理原则')
  f.writeSkill('workspace-management')
  f.writeSkill('user-facing-output')
  assert.equal((await assistantConfiguration(f.root, f.ctx.skills)).core_ready, true)
  const path = f.writeSkill('decision-sample-extraction')
  writeFileSync(path, '---\nname: invalid-name\ndescription: 名称不一致\n---\n不能加载')
  f.provider.observeHostMutation(path)
  assert.equal((await assistantConfiguration(f.root, f.ctx.skills, { skill: 'decision-sample-extraction' })).ready, false)
})

test('Candidate技能软链接不能替代管理技能，即使仍位于同一数据根', async t => {
  const f = fixture(t)
  const target = join(f.root, 'evolution/candidate/role.md')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '---\nname: user-facing-output\ndescription: Candidate角色\n---\n业务角色')
  const path = join(f.root, '.agents/skills/user-facing-output/SKILL.md')
  rmSync(path)
  symlinkSync(target, path)
  f.provider.observeHostMutation(path)
  await assert.rejects(() => managementSkill(f.root, f.ctx.skills, 'user-facing-output'), /不在当前数据工作区/)
  assert.equal((await assistantConfiguration(f.root, f.ctx.skills)).core_ready, false)
})

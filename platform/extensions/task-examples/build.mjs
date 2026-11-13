import { managerHome } from '../../manager-home.mts'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.env.HARNESS_ASSET_ROOT || (() => { throw new Error('请设置 HARNESS_ASSET_ROOT') })())
if (!process.env.HARNESS_PROGRAM_ROOT) throw new Error('请设置 HARNESS_PROGRAM_ROOT 指向平台程序仓库')
const programRequire = createRequire(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/package.json'))
const { build } = programRequire('esbuild')
const { load, dump } = programRequire('js-yaml')
const userFacingOutput = readFileSync(join(managerHome(root), '.agents/skills/user-facing-output/SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
if (!userFacingOutput) throw new Error('面向用户的表达原则不能为空')
const prefix = ['EXP-daily-inspection-assistant-002-', 'EXP-autonomous-training-researcher-001-', 'EXP-multi-step-research-analyst-001-']
const available = readdirSync(join(root, 'evolution/experiments'))
const selected = process.argv.length > 2 ? process.argv.slice(2) : prefix.map(value => {
  const matches = available.filter(id => id.startsWith(value))
  if (matches.length !== 1) throw new Error('样例来源不唯一，请明确传入需要构建的Experiment ID：' + value)
  return matches[0]
})
if (new Set(selected).size !== selected.length || selected.some(id => !available.includes(id) || !(prefix.some(value => id.startsWith(value)) || /^EXP-inspection-delivery-demo-\d{3}-r[0-9a-f]{12}$/.test(id)) || !/^EXP-[a-z0-9-]+-r[0-9a-f]{12}$/.test(id))) throw new Error('构建目标必须是已存在且不重复的任务样例Experiment')
for (const id of selected) {
  await build({ entryPoints: [join(directory, 'src/runtime.ts')],
    outfile: join(root, 'evolution/experiments', id, 'candidate/dsh/managed/task-example-tools.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: false })
  const agentId = id.slice(4).replace(/-\d{3}-r[0-9a-f]{12}$/, '')
  const presetPath = join(root, 'evolution/experiments', id, 'candidate/dsh/presets', agentId, 'agent.cordis.yml')
  const preset = load(readFileSync(presetPath, 'utf8'))
  const persona = Array.isArray(preset) && preset.find(plugin => plugin.id === 'persona')
  if (!persona?.config || typeof persona.config !== 'object') throw new Error('样例Preset缺少persona配置：' + id)
  persona.config.suffix = '你的工作目录是 {{cwd}}。\n\n' + userFacingOutput
  writeFileSync(presetPath, '# persona.config.suffix由extensions/task-examples/build.mjs生成，来源为管理助手HOME .agents/skills/user-facing-output/SKILL.md正文；该字段不直接编辑。\n' + dump(preset, { lineWidth: -1, noRefs: true }))
  console.log(id)
}

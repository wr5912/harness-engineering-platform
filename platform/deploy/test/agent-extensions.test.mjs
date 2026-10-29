import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { stageSelectedExtensions } from '../agent/extensions.mts'
import { populateStandaloneExtensions } from '../../plugin/src/standalone-extensions/index.ts'

const programRoot = fileURLToPath(new URL('../../../', import.meta.url))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
const run = (data, args) => { const result = spawnSync('git', ['-C', data, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-extensions-')), assetRoot = join(root, 'data'), staging = join(root, 'stage'), business = join(assetRoot, 'extensions/security-operations')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceDirectory = 'evolution/experiments/EXP-soc-001/candidate/dsh/managed/threat-analysis'
  write(join(assetRoot, sourceDirectory, 'algorithm.py'), 'import json\nfrom pathlib import Path\nVALUE="固定算法原文"\n')
  write(join(assetRoot, sourceDirectory, 'catalog/fixture.json'), '{"source":"固定目录"}\n')
  write(join(assetRoot, sourceDirectory + '.mjs'), 'export const inferFrozen=async()=>({frozen:true});\n')
  run(assetRoot, ['init', '-q']); run(assetRoot, ['add', '.']); run(assetRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', '固定算法'])
  const commit = run(assetRoot, ['rev-parse', 'HEAD'])
  write(join(assetRoot, 'workspace.json'), JSON.stringify({ extensions: [{ id: 'security-operations-compositions', path: 'extensions/security-operations' }, { id: 'unrelated', path: 'extensions/unrelated' }] }))
  write(join(assetRoot, 'extensions/unrelated/secret.txt'), '不可入包')
  write(join(business, 'build.mjs'), 'throw new Error("不可执行旧构建脚本")\n')
  write(join(business, 'src/threat/source.ts'), `export const THREAT_SOURCE_COMMIT = '${commit}'\nexport const THREAT_SOURCE_DIRECTORY = '${sourceDirectory}'\nthrow new Error('原Git缓存入口不应执行')\n`)
  write(join(business, 'src/threat/runtime.ts'), "import {loadThreatSource} from './source.ts'; export const createThreatRuntime=(root,services,options)=>({execute:async()=>({...await loadThreatSource(root),inference:await services.inferFrozen()}),options});\n")
  write(join(business, 'src/threat-services.ts'), "import {ensureThreatSource} from './threat/source.ts';import {pathToFileURL} from 'node:url';export const createNativeThreatServices=(root)=>({inferFrozen:async()=>{const source=await ensureThreatSource(root);return (await import(pathToFileURL(source.bridgeModule).href)).inferFrozen()}});\n")
  write(join(business, 'src/asset-alerts.ts'), 'export const assetAlertsFlow={assetArguments:input=>({assetId:Number(input.asset)})};\n')
  const compositions = { compositions: [{ id: 'parent', published: { kind: 'composite', steps: [{ compositionId: 'stage', versionId: 'frozen' }] } }, { id: 'stage', versions: [{ versionId: 'frozen', config: { kind: 'threat-stage', stage: 'collect' } }] }] }
  return { root, assetRoot, staging, business, commit, sourceDirectory, input: { programRoot, assetRoot, staging, compositions } }
}
function context() { const cleanup = [], extension = {}; return { cleanup, ctx: { standaloneCompositionExtension: extension, platformMcp: { compositionExtension: extension, servers: { get: () => [] } }, effect: task => cleanup.push(task()) } } }

test('无业务编排不读工作区声明；只递归选中发布项的固定子版本', async t => {
  const x = fixture(t)
  assert.deepEqual(await stageSelectedExtensions({ ...x.input, assetRoot: '/does-not-exist', compositions: undefined }), { extensions: [], sources: [] })
  assert.equal(existsSync(x.staging), false)
  const info = await stageSelectedExtensions(x.input)
  assert.equal(info.extensions.length, 1)
  assert.equal(info.fixedSource.commit, x.commit)
  assert.ok(info.sources.every(item => item.path.startsWith('extensions/security-operations/src/')))
  assert.equal(existsSync(join(x.staging, 'assets')), false)
  assert.equal(readFileSync(join(x.staging, 'runtime/extensions/security-operations-compositions/fixed-source/threat-analysis/algorithm.py'), 'utf8'), 'import json\nfrom pathlib import Path\nVALUE="固定算法原文"\n')
})

test('冻结业务扩展经原生接缝登记，固定算法与inferFrozen在没有数据Git时可用', async t => {
  const x = fixture(t), info = await stageSelectedExtensions(x.input), { ctx, cleanup } = context()
  rmSync(join(x.assetRoot, '.git'), { recursive: true })
  await populateStandaloneExtensions(ctx, info, x.staging)
  assert.equal(ctx.standaloneCompositionExtension.id, 'security-operations-compositions')
  assert.deepEqual(ctx.standaloneCompositionExtension.flow.assetArguments({ asset: '123' }), { assetId: 123 })
  const result = await ctx.standaloneCompositionExtension.threat.execute()
  assert.equal(result.commit, x.commit); assert.deepEqual(result.inference, { frozen: true })
  assert.ok(result.root.startsWith(resolve(x.staging)))
  for (const dispose of cleanup) dispose()
  assert.deepEqual(ctx.standaloneCompositionExtension, {})
})

test('未知扩展、产物篡改、固定算法篡改和索引删项明确拒绝', async t => {
  const x = fixture(t), info = await stageSelectedExtensions(x.input)
  await assert.rejects(populateStandaloneExtensions(context().ctx, { extensions: [{ ...info.extensions[0], id: 'untrusted' }] }, x.staging), /声明无效/)
  const entry = join(x.staging, info.extensions[0].entry), original = readFileSync(entry)
  chmodSync(entry, 0o644)
  writeFileSync(entry, 'throw new Error("不应执行")\n')
  await assert.rejects(populateStandaloneExtensions(context().ctx, info, x.staging), /文件已变化/)
  writeFileSync(entry, original)
  const { ctx } = context(); await populateStandaloneExtensions(ctx, info, x.staging)
  const base = join(x.staging, 'runtime/extensions/security-operations-compositions/fixed-source')
  chmodSync(join(base, 'threat-analysis/algorithm.py'), 0o644)
  writeFileSync(join(base, 'threat-analysis/algorithm.py'), 'tampered')
  await assert.rejects(ctx.standaloneCompositionExtension.threat.execute(), /threat_source_integrity_failed/)
  const index = JSON.parse(readFileSync(join(base, 'index.json'), 'utf8')); index.files = index.files.filter(item => !item.path.endsWith('algorithm.py')); chmodSync(join(base, 'index.json'), 0o644); writeFileSync(join(base, 'index.json'), JSON.stringify(index))
  await assert.rejects(ctx.standaloneCompositionExtension.threat.execute(), /threat_source_integrity_failed/)
})

test('缺少业务声明、固定算法、循环与缺少版本引用均阻止导出', async t => {
  const x = fixture(t)
  writeFileSync(join(x.assetRoot, 'workspace.json'), '{}')
  await assert.rejects(stageSelectedExtensions(x.input), /工作区声明/)
  writeFileSync(join(x.assetRoot, 'workspace.json'), JSON.stringify({ extensions: [{ id: 'security-operations-compositions', path: 'extensions/security-operations' }] }))
  await assert.rejects(stageSelectedExtensions({ ...x.input, compositions: { compositions: [{ id: 'a', published: { kind: 'composite', steps: [{ compositionId: 'a', versionId: 'missing' }] } }] } }), /缺少所引用/)
  const loop = { kind: 'composite', steps: [{ compositionId: 'a', versionId: 'v1' }] }
  await assert.rejects(stageSelectedExtensions({ ...x.input, compositions: { compositions: [{ id: 'a', published: loop, versions: [{ versionId: 'v1', config: loop }] }] } }), /循环/)
  rmSync(join(x.assetRoot, '.git'), { recursive: true })
  await assert.rejects(stageSelectedExtensions(x.input), /固定算法来源不可用/)
})

test('额外Python环境、未准备Node依赖和取消不被误报为完整', async t => {
  const x = fixture(t)
  write(join(x.business, 'requirements.txt'), 'requests==2.32.0\n')
  await assert.rejects(stageSelectedExtensions(x.input), /额外 Python 环境/)
  rmSync(join(x.business, 'requirements.txt'))
  write(join(x.business, 'src/asset-alerts.ts'), "import undeclared from 'missing-external-module'; export const assetAlertsFlow=undeclared;\n")
  await assert.rejects(stageSelectedExtensions(x.input), /未准备的外部 Node 依赖/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(stageSelectedExtensions({ ...x.input, signal: aborted.signal }), { name: 'AbortError' })
})

test('仅SOC查询流程不携带威胁分析固定算法', async t => {
  const x = fixture(t), info = await stageSelectedExtensions({ ...x.input, compositions: { compositions: [{ published: { flow: 'soc-asset-alerts' } }] } })
  assert.equal(info.extensions.length, 1)
  assert.equal(info.fixedSource, undefined)
  assert.equal(existsSync(join(x.staging, 'runtime/extensions/security-operations-compositions/fixed-source')), false)
})

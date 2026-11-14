import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshLinkedAgentAssets } from '../agent/runtime/linked-assets.mts'

const program = fileURLToPath(new URL('../../../', import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'linked-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const harness = join(root, 'repo/agents/test-agent')
  mkdirSync(join(root, 'assets')); mkdirSync(join(root, 'runtime/projections/managed'), { recursive: true })
  mkdirSync(harness, { recursive: true }); writeFileSync(join(harness, 'harness.yaml'), 'id: test-agent\n')
  symlinkSync(join(harness, 'harness.yaml'), join(root, 'assets/harness.yaml'))
  for (const name of ['managed', 'presets', 'workspace']) {
    mkdirSync(join(harness, 'dsh', name), { recursive: true })
    symlinkSync(join(harness, 'dsh', name), join(root, 'assets', name))
  }
  writeFileSync(join(harness, 'dsh/managed/index.mjs'), "export const inject=['businessRuntime']; export function apply() {}")
  writeFileSync(join(root, 'runtime/projections/managed/previous'), 'previous')
  writeFileSync(join(root, 'agent'), 'compose up -d --force-recreate --wait dsh\n', { mode: 0o755 })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', schemaVersion: 1,
    source: { agentId: 'test-agent', profile: 'web' }, files: [], image: { tag: 'keep-this-image' } }))
  writeFileSync(join(root, 'runtime/compose.yaml'), JSON.stringify({ services: { dsh: { volumes: [
    { source: './runtime/projections/managed', target: '/opt/dsh-managed' },
    { source: '/old/agents/test-agent', target: '/old/agents/test-agent' },
  ] } } }))
  return { root, harness }
}
test('软链接资产更新刷新投影、保留源字节与镜像、纠正迁移后的挂载来源', t => {
  const { root, harness } = fixture(t)
  const result = refreshLinkedAgentAssets(root, program)
  assert.equal(result.harnessRoot, realpathSync(harness))
  assert.equal(result.projected, 1)
  assert.equal(readFileSync(join(result.backup, 'projection/previous'), 'utf8'), 'previous')
  assert.match(readFileSync(join(harness, 'dsh/managed/index.mjs'), 'utf8'), /businessRuntime/)
  assert.doesNotMatch(readFileSync(join(root, 'runtime/projections/managed/index.mjs'), 'utf8'), /businessRuntime/)
  const m = JSON.parse(readFileSync(join(root, 'manifest.json')))
  assert.equal(m.image.tag, 'keep-this-image')
  assert(m.files.some(entry => entry.path === 'assets/managed' && entry.type === 'symlink'))
  const mounts = JSON.parse(readFileSync(join(root, 'runtime/compose.yaml'))).services.dsh.volumes
  assert.deepEqual(mounts[1], { source: harness, target: '/old/agents/test-agent' })
  assert(mounts.some(m => m.source === harness && m.target === harness && m.read_only))
  assert.match(readFileSync(join(root, 'agent'), 'utf8'), /--force-recreate --always-recreate-deps --wait dsh/)
})
test('链接不属于同一 Harness 时在修改现场前拒绝', t => {
  const { root } = fixture(t)
  rmSync(join(root, 'assets/workspace')); symlinkSync(join(root, 'assets'), join(root, 'assets/workspace'))
  assert.throws(() => refreshLinkedAgentAssets(root, program), /同一 Harness/)
  assert.equal(readFileSync(join(root, 'runtime/projections/managed/previous'), 'utf8'), 'previous')
})
test('生成失败恢复原投影与运行元数据', t => {
  const { root } = fixture(t)
  const before = readFileSync(join(root, 'runtime/compose.yaml'), 'utf8')
  assert.throws(() => refreshLinkedAgentAssets(root, join(root, 'missing-program')))
  assert.equal(readFileSync(join(root, 'runtime/compose.yaml'), 'utf8'), before)
  assert.equal(readFileSync(join(root, 'runtime/projections/managed/previous'), 'utf8'), 'previous')
})
test('保留仅安装在旧投影中的插件依赖，且不写入 Harness 源', t => {
  const { root, harness } = fixture(t)
  writeFileSync(join(harness, 'dsh/managed/index.mjs'), 'export function apply() {}')
  mkdirSync(join(harness, 'dsh/managed/plugin'), { recursive: true })
  writeFileSync(join(harness, 'dsh/managed/plugin/package.json'), '{"name":"test-plugin"}')
  mkdirSync(join(root, 'runtime/projections/managed/plugin/node_modules/dependency'), { recursive: true })
  writeFileSync(join(root, 'runtime/projections/managed/plugin/node_modules/dependency/index.js'), 'export default 1')
  refreshLinkedAgentAssets(root, program)
  assert.equal(readFileSync(join(root, 'state/managed-dependencies/plugin/node_modules/dependency/index.js'), 'utf8'), 'export default 1')
  const mounts = JSON.parse(readFileSync(join(root, 'runtime/compose.yaml'))).services.dsh.volumes
  assert(mounts.some(m => m.target === '/opt/dsh-managed/plugin/node_modules' && m.read_only))
  assert(mounts.some(m => m.target === '/opt/dsh-managed' && m.source === './runtime/projections/managed'))
  assert.equal(realpathSync(join(root, 'runtime/projections/managed/plugin/node_modules')), join(root, 'runtime/projections/managed/plugin/node_modules'))
  refreshLinkedAgentAssets(root, program)
  assert.equal(readFileSync(join(root, 'runtime/projections/managed/index.mjs'), 'utf8'), 'export function apply() {}')
})

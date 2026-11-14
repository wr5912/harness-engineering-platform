import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { prepareAgentResources } from '../agent/prepare.mts'
import { previewAgentPackage, packAgent } from '../agent/pack.mts'
import { inspectAgentSnapshot } from '../agent/snapshot.mts'
import { fixture, write, catalog } from './agent-fixture.mjs'

async function prepareBusinessDependency(f) {
  const image = JSON.parse(readFileSync(join(f.resources, 'resources.json'), 'utf8')).image
  write(join(f.candidate, 'dsh/managed/import-plugin/package.json'), '{"dependencies":{"fixture":"1.0.0"},"peerDependencies":{"@deepseek-ai/cordis":"4.0.5"}}')
  const modules = join(f.data, '.local/asset-dependencies', f.id, 'legacy/node_modules')
  write(join(modules, 'fixture/package.json'), '{"name":"fixture","version":"1.0.0"}')
  write(join(modules, 'fixture/index.js'), 'export default "legacy-host-byte"\n')
  write(join(f.data, '.local/asset-dependencies', f.id, 'current.json'), '{"digest":"legacy"}')
  return { image, modules }
}

test('标准镜像覆盖声明后，旧准备目录变化不进入新包', async t => {
  const f = fixture(t), prepared = await prepareBusinessDependency(f)
  catalog(f, { fixture: '1.0.0' })
  assert.equal(previewAgentPackage(f.input).resourceReady, true)
  const result = await packAgent(f.input, { onProgress(progress) {
    if (progress.stage === 'snapshot') write(join(prepared.modules, 'fixture/index.js'), 'ignored host cache\n')
  } })
  assert.ok(result.archive)
  assert.equal(result.manifest.schemaVersion, 2)
  assert.deepEqual(result.manifest.files, [])
})

test('资源准备仅保存共享镜像，不把业务准备目录变成部署依赖', async t => {
  const f = fixture(t), prepared = await prepareBusinessDependency(f), target = join(f.root, 'image-cache')
  catalog(f, { fixture: '1.0.0' })
  const input = { ...f.input, resourcesDir: target, imageArchive: join(f.resources, 'images/dsh-runtime.tar') }
  const result = await prepareAgentResources(input)
  assert.deepEqual(result.manifest.dependencies, [])
  assert.equal(existsSync(join(target, 'dependencies')), false)
  rmSync(join(f.data, '.local/asset-dependencies', f.id), { recursive: true })
  assert.equal(previewAgentPackage(input).resourceReady, true)
  assert.ok((await packAgent(input)).archive)
})

test('宿主依赖不能补偿标准镜像缺失或不兼容的版本', async t => {
  const f = fixture(t)
  await prepareBusinessDependency(f)
  for (const dependencies of [{}, { fixture: '2.0.0' }]) {
    catalog(f, dependencies)
    assert.equal(previewAgentPackage(f.input).resourceReady, false)
    await assert.rejects(prepareAgentResources(f.input), /标准镜像/)
    await assert.rejects(packAgent(f.input), /标准镜像/)
  }
})

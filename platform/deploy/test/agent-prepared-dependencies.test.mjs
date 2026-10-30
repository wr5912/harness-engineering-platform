import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createAssetDependenciesHandler } from '../../plugin/src/agents/asset-dependencies.ts'
import { prepareAgentResources } from '../agent/prepare.mts'
import { previewAgentPackage, packAgent } from '../agent/pack.mts'
import { inspectAgentSnapshot } from '../agent/snapshot.mts'
import { fixture, write } from './agent-fixture.mjs'

async function prepareBusinessDependency(f) {
  const image = JSON.parse(readFileSync(join(f.resources, 'resources.json'), 'utf8')).image
  write(join(f.candidate, 'dsh/managed/import-plugin/package.json'), '{"dependencies":{"fixture":"1.0.0"},"peerDependencies":{"@deepseek-ai/cordis":"4.0.5"}}')
  const command = async (_name, args) => {
    if (args.includes('--image-identity-for')) return JSON.stringify({ tag: image.tag, fingerprint: image.fingerprint })
    if (args[0] === 'image') return JSON.stringify({ Id: image.id, Config: { Labels: { 'org.ai-agent-harness.dsh.image-build-fingerprint': image.fingerprint } } })
    if (args.includes('python3')) return JSON.stringify({ python_version: '3.11.2', python_abi: 'cp311', os: 'linux', libc: 'glibc-2.36', architecture: 'x86_64' })
    if (args.includes('npm')) {
      const directory = args[args.indexOf('-v') + 1].slice(0, -':/prepare:rw'.length)
      write(join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-test' } } }))
      if (args.includes('ci')) {
        write(join(directory, 'node_modules/fixture/package.json'), '{"name":"fixture","version":"1.0.0"}')
        write(join(directory, 'node_modules/fixture/index.js'), 'export default "fixed-prepared-byte"\n')
      }
      return ''
    }
    throw new Error('Unexpected dependency preparation command')
  }
  const prepared = await createAssetDependenciesHandler(f.data, { command })({ experiment_id: f.id })
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.value.status, 'ready')
  return { image, modules: prepared.value.mounts[0].source }
}

test('直接导出已准备依赖冻结字节及镜像身份，复制前变化不进入安装包', async t => {
  const f = fixture(t), prepared = await prepareBusinessDependency(f)
  assert.equal(previewAgentPackage(f.input).resourceReady, true)
  const snapshot = inspectAgentSnapshot(f.input), dependency = snapshot.dependencies[0]
  assert.deepEqual(dependency.preparedTarget, { image: prepared.image.tag, imageId: prepared.image.id })
  assert.ok(dependency.preparedFiles.some(file => file.path === 'fixture/index.js'))
  const result = await packAgent(f.input)
  assert.ok(result.manifest.files.some(file => file.path === 'assets/managed/import-plugin/node_modules/fixture/index.js'))
  const before = readdirSync(f.out).filter(name => name.endsWith('.tar.gz')).length
  await assert.rejects(packAgent(f.input, { onProgress(progress) {
    if (progress.stage === 'snapshot') write(join(prepared.modules, 'fixture/index.js'), 'changed during export\n')
  } }), /业务依赖在导出期间变化/)
  assert.equal(readdirSync(f.out).filter(name => name.endsWith('.tar.gz')).length, before)
  assert.equal(readdirSync(f.out).some(name => name.endsWith('.partial')), false)
})

test('准备资源保留依赖目标镜像和锁摘要；原准备目录移除后仍可独立消费', async t => {
  const f = fixture(t), prepared = await prepareBusinessDependency(f), target = join(f.root, 'prepared-import')
  const input = { ...f.input, resourcesDir: target, imageArchive: join(f.resources, 'images/dsh-runtime.tar'), dockerAssetsDir: join(f.resources, 'docker') }
  const result = await prepareAgentResources(input)
  assert.deepEqual(result.manifest.dependencies[0].preparedTarget, { image: prepared.image.tag, imageId: prepared.image.id })
  assert.ok(result.manifest.dependencies[0].lockSha256)
  write(join(target, 'resources.json'), JSON.stringify({ ...result.manifest, image: { ...result.manifest.image, id: 'sha256:' + 'c'.repeat(64) } }))
  assert.equal((await prepareAgentResources(input)).manifest.image.id, prepared.image.id)
  rmSync(join(f.data, '.local/asset-dependencies', f.id), { recursive: true })
  assert.equal(previewAgentPackage(input).resourceReady, true)
  assert.ok((await packAgent(input)).archive)
  result.manifest.dependencies[0].preparedTarget.imageId = 'sha256:' + 'b'.repeat(64)
  write(join(target, 'resources.json'), JSON.stringify(result.manifest))
  assert.equal(previewAgentPackage(input).resourceReady, false)
  await assert.rejects(packAgent(input), /缺少|另一标准镜像/)
  assert.equal(existsSync(join(target, 'dependencies/managed/import-plugin/node_modules/fixture/index.js')), true)
})

test('依赖资源准备期间来源变化会保留未完成状态', async t => {
  const f = fixture(t), prepared = await prepareBusinessDependency(f), target = join(f.root, 'interrupted-import')
  await assert.rejects(prepareAgentResources({ ...f.input, resourcesDir: target,
    imageArchive: join(f.resources, 'images/dsh-runtime.tar'), dockerAssetsDir: join(f.resources, 'docker') }, { onProgress(progress) {
    if (progress.stage === 'dependencies') write(join(prepared.modules, 'fixture/index.js'), 'changed during prepare\n')
  } }), /业务依赖在准备期间变化/)
  assert.equal(existsSync(join(target, 'resources.json')), false)
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.prepare-')), false)
})

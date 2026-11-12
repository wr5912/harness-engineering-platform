import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture, write } from './agent-fixture.mjs'
import { defaultAgentResourcesDir, inspectAgentResources, prepareAgentResources } from '../agent/prepare.mts'
import { previewAgentPackage } from '../agent/pack.mts'
import { inspectAgentSnapshot } from '../agent/snapshot.mts'

test('Web 插件复用原生客户端 React，服务端与其他必需依赖仍须准备', t => {
  const f = fixture(t), manifest = join(f.candidate, 'dsh/managed/web-plugin/package.json')
  const pkg = { dsh: { client: { platform: 'web' } }, peerDependencies: { react: '^18.2.0' } }
  write(manifest, JSON.stringify(pkg))
  assert.deepEqual(inspectAgentSnapshot(f.input).dependencies, [])
  write(manifest, JSON.stringify({ ...pkg, dependencies: { react: '^18.2.0' }, peerDependencies: { fixture: '1.0.0' } }))
  assert.deepEqual(inspectAgentSnapshot(f.input).dependencies[0].dependencies, ['react', 'fixture'])
  write(manifest, JSON.stringify({ peerDependencies: pkg.peerDependencies }))
  assert.deepEqual(inspectAgentSnapshot(f.input).dependencies[0].dependencies, ['react'])
})

test('目标架构资源可由另一架构的已准备镜像与Docker归档导入，不依赖目标宿主工具链', async t => {
  const f = fixture(t, 'arm64'), target = join(f.root, 'imported-arm64'), stages = []
  const result = await prepareAgentResources({ ...f.input, resourcesDir: target,
    imageArchive: join(f.resources, 'images/dsh-runtime.tar'), dockerAssetsDir: join(f.resources, 'docker') }, { onProgress: item => stages.push(item.stage) })
  assert.equal(result.manifest.arch, 'arm64')
  assert.equal(result.manifest.image.arch, 'arm64')
  assert.ok(existsSync(join(target, 'images/dsh-runtime.tar')))
  assert.equal(inspectAgentResources({ ...f.input, resourcesDir: target }).issues.length, 0)
  assert.ok(stages.includes('resources'))
})

test('资源架构不符、离线组件缺失会在导出前呈现明确缺口', t => {
  const f = fixture(t)
  assert.equal(defaultAgentResourcesDir(f.input), join(f.program, '.local/deploy-assets/amd64'))
  const target = join(f.root, 'not-prepared')
  assert.equal(inspectAgentResources({ ...f.input, resourcesDir: target }).issues[0].code, 'resources_missing')
  const manifest = JSON.parse(readFileSync(join(f.resources, 'resources.json'), 'utf8'))
  manifest.arch = 'arm64'
  write(join(f.resources, 'resources.json'), JSON.stringify(manifest))
  assert.match(inspectAgentResources(f.input).issues[0].message, /清单无效/)
})

test('准备中止保持既有运行资源，临时结果不替换当前缓存', async t => {
  const f = fixture(t), controller = new AbortController()
  const previous = readFileSync(join(f.resources, 'resources.json'), 'utf8')
  controller.abort(new Error('取消资源准备'))
  await assert.rejects(prepareAgentResources({ ...f.input, imageArchive: join(f.resources, 'images/dsh-runtime.tar'), dockerAssetsDir: join(f.resources, 'docker') }, { signal: controller.signal }), /取消资源准备/)
  assert.equal(readFileSync(join(f.resources, 'resources.json'), 'utf8'), previous)
})

test('发行版构建后缀使用上游版本下载，无法识别的版本在导出镜像前失败', async t => {
  const f = fixture(t), bin = join(f.root, 'bin'), calls = join(f.root, 'downloads.txt')
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  t.after(() => { process.env.PATH = previousPath })
  write(join(bin, 'docker'), '#!/bin/sh\ncase "$1" in version) echo 29.1.3;; compose) echo 2.40.3+ds1-0ubuntu1~22.04.1;; *) exit 90;; esac\n', 0o755)
  write(join(bin, 'curl'), `#!/bin/sh
while [ "$1" != "--output" ]; do shift; done
target="$2"
url="$3"
printf '%s\\n' "$url" >> '${calls}'
case "$url" in *.tgz) cp '${join(f.resources, 'docker/docker-fixture.tgz')}' "$target";; *) cp '${join(f.resources, 'docker/docker-compose')}' "$target";; esac
`, 0o755)
  const result = await prepareAgentResources({ ...f.input, resourcesDir: join(f.root, 'normalized'), imageArchive: join(f.resources, 'images/dsh-runtime.tar') })
  assert.equal(result.manifest.docker.version, '29.1.3')
  assert.equal(result.manifest.docker.composeVersion, '2.40.3')
  assert.match(readFileSync(calls, 'utf8'), /releases\/download\/v2\.40\.3\/docker-compose-linux-x86_64/)
  write(join(bin, 'docker'), '#!/bin/sh\necho 2.40.3-rc.1\n', 0o755)
  const stages = []
  await assert.rejects(prepareAgentResources({ ...f.input, resourcesDir: join(f.root, 'invalid') }, { onProgress: item => stages.push(item.stage) }), /无法解析/)
  assert.deepEqual(stages, [])
})

test('另一 Agent 同路径但不同锁文件的缓存不被预览当成当前版本依赖', t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/managed/local-provider/package.json'), JSON.stringify({ name: 'local-provider', dependencies: { fixture: '1.0.0' } }))
  write(join(f.resources, 'dependencies/managed/local-provider/node_modules/fixture/index.js'), 'export default true')
  const manifest = JSON.parse(readFileSync(join(f.resources, 'resources.json'), 'utf8'))
  manifest.dependencies.push({ path: 'managed/local-provider', lockSha256: 'a'.repeat(64), files: [] })
  write(join(f.resources, 'resources.json'), JSON.stringify(manifest))
  const preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.issues.some(item => item.code === 'dependencies_missing'))
})

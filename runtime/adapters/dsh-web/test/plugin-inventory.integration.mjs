import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const adapterRoot = fileURLToPath(new URL('../', import.meta.url))
const containerAdapterRoot = fileURLToPath(new URL('../../dsh-container/', import.meta.url))
const sourceContract = fileURLToPath(new URL('../../dsh-container/source_contract.py', import.meta.url))
const lock = JSON.parse(readFileSync(new URL('../../dsh-container/source.lock.json', import.meta.url), 'utf8'))

test('锁定 Runtime 的原生 DeepSeek 插件清单保留自研适配器身份，缺版本时不虚构版本', () => {
  const resolved = spawnSync('python3', [sourceContract, '--field', 'image.local_image_tag'], { encoding: 'utf8' })
  assert.equal(resolved.status, 0, resolved.stderr || resolved.error?.message)
  const image = resolved.stdout.trim()
  const result = spawnSync('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '-i',
    '--mount', `type=bind,source=${adapterRoot},target=/opt/dsh-web,readonly`,
    '--mount', `type=bind,source=${containerAdapterRoot},target=/opt/dsh-adapter,readonly`,
    '--entrypoint', 'node', image, '--input-type=module', '-',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    input: `
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire('/opt/dsh/apps/cli/package.json')
const packageName = '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
const nativeManifest = JSON.parse(readFileSync(require.resolve(packageName + '/package.json'), 'utf8'))
assert.equal(nativeManifest.version, ${JSON.stringify(lock.cli_version)})
const { apply } = await import(pathToFileURL(require.resolve(packageName)).href)

function prepare(entries) {
  let contribution
  const tree = { ctx: { baseUrl: 'file:///opt/dsh-web/package.json' } }
  const ctx = {
    baseUrl: tree.ctx.baseUrl,
    get: () => undefined,
    loader: { entries: () => entries.map(name => ({
      options: { name }, parent: { tree }, disabled: false,
      // FiberState.ACTIVE 是被编译擦除的 const enum，锁定 Runtime 的实际值为 2。
      fiber: { state: 2 },
    })) },
    deepseekLlmApiExtensions: { register(field, provider) {
      assert.equal(field, 'dsh_plugin_packages')
      contribution = provider
    } },
  }
  apply(ctx, { enabled: true })
  return contribution.prepare({ body: {}, signal: new AbortController().signal })
}

const wrappers = ['container-webserver', 'container-web-app', 'platform-webserver']
  .map(name => '/opt/dsh-web/lib/' + name + '.mjs')
for (const wrapper of wrappers) assert.ok(existsSync(wrapper), '先构建 Web 适配器：' + wrapper)
const manifest = JSON.parse(readFileSync('/opt/dsh-web/package.json', 'utf8'))
assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0)
assert.deepEqual(await prepare(wrappers), { value: {
  version: 1, packages: [{ name: manifest.name, version: manifest.version }],
} })
const scheduleManifest = JSON.parse(readFileSync('/opt/dsh-adapter/schedule-compat/package.json', 'utf8'))
assert.deepEqual(await prepare([...wrappers, '/opt/dsh-adapter/schedule-compat/root-scope.ts']), { value: {
  version: 1, packages: [
    { name: scheduleManifest.name, version: scheduleManifest.version },
    { name: manifest.name, version: manifest.version },
  ],
} })

const fixture = mkdtempSync(join(tmpdir(), 'dsh-web-inventory-'))
try {
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: '@fixture/missing-version', type: 'module' }))
  const module = join(fixture, 'plugin.mjs')
  writeFileSync(module, 'export default {}')
  assert.deepEqual(await prepare([module]), { value: {
    version: 1, packages: [{ name: '@fixture/missing-version' }],
  } })
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log('真实锁版 provider：适配器包身份完整；原生 rc.2 对无版本包只上报名称。')
`,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
})

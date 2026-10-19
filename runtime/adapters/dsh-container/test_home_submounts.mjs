import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { decodeMountPath } from './tree-digest.mjs'

const mode = process.env.DSH_HARNESS_MODE
assert.equal(mode, 'verification')
const manifestPath = '/var/lib/dsh/profiles/web/package.json'
const paths = [
  '/var/lib/dsh/cordis.patch.yml',
  manifestPath,
  '/var/lib/dsh/AGENTS.md',
  '/var/lib/dsh/.env',
  '/work/harness/workspace/.env',
]
const modulePaths = [
  '/var/lib/dsh/node_modules',
  '/var/lib/dsh/profiles/node_modules',
  '/var/lib/dsh/profiles/web/node_modules',
]
const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const fields = line.split(' ')
    return { target: decodeMountPath(fields[4]), options: fields[5].split(',') }
  })

assert.ok(mounts.some(item => item.target === '/var/lib/dsh' && item.options.includes('rw')))
// 适配层脚本以只读 bind 提供，脚本改动不需要重建镜像；这里核对只读且不可写。
assert.ok(mounts.some(item => item.target === '/opt/dsh-adapter' && item.options.includes('ro')),
  '/opt/dsh-adapter must be an exact read-only bind mount')
for (const name of ['verify-load.mjs', 'tree-digest.mjs', 'prepare-verification-home.mjs']) {
  assert.ok(existsSync(`/opt/dsh-adapter/${name}`), `${name} must be provided by the adapter mount`)
}
assert.throws(() => writeFileSync('/opt/dsh-adapter/.probe', 'forbidden'),
  error => error.code === 'EROFS' || error.code === 'EACCES')
for (const path of paths) {
  assert.ok(mounts.some(item => item.target === path && item.options.includes('ro')))
  assert.throws(() => {
    const descriptor = openSync(path, 'r+')
    closeSync(descriptor)
  }, error => error.code === 'EROFS' || error.code === 'EACCES')
}
const webPatch = '/var/lib/dsh/profiles/web/cordis.patch.yml'
assert.ok(!mounts.some(item => item.target === webPatch), 'Web settings patch must not be a file bind')
const webPatchDescriptor = openSync(webPatch, 'r+')
closeSync(webPatchDescriptor)
for (const path of modulePaths) {
  assert.ok(mounts.some(item => item.target === path && item.options.includes('ro')))
  assert.throws(() => writeFileSync(`${path}/shadow-package.js`, 'forbidden'),
    error => error.code === 'EROFS' || error.code === 'EACCES')
}
// 被测容器中不得出现判分材料或开发身份指令。
for (const path of ['/work/reference', '/work/eval-input', '/work/AGENTS.md', '/work/AGENTS.local.md']) {
  assert.ok(!existsSync(path), `${path} must be absent in the subject container`)
  assert.ok(!mounts.some(item => item.target === path), `${path} must not be mounted in the subject container`)
}

const first = readFileSync(paths[0])
assert.match(first.toString('utf8'), /^\s*(?:#[^\n]*\n)*\[\]\s*$/)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.deepEqual(manifest.dsh.profile.bundles.slice(0, 2), [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
])
assert.equal(manifest.dsh.profile.patchReload, 'startup')
assert.equal(manifest.dsh.profile.bundles.length, 2)
assert.deepEqual(manifest.dependencies, {})
assert.equal(readFileSync('/var/lib/dsh/AGENTS.md').length, 0)
for (const path of ['/var/lib/dsh/.env', '/work/harness/workspace/.env']) {
  assert.match(readFileSync(path, 'utf8'), /^(?:\s*#[^\n]*\n)+\s*$/)
}
for (const path of modulePaths.filter(path => path !== '/var/lib/dsh/profiles/node_modules')) {
  assert.deepEqual(readdirSync(path), ['POLICY.md'])
}

const writableProbe = '/var/lib/dsh/.submount-rw-proof'
writeFileSync(writableProbe, 'runtime-data-volume-writable', { flag: 'wx' })
unlinkSync(writableProbe)

console.log(JSON.stringify({
  status: 'engine-subfile-bind-proof',
  dsh_mode: mode,
  home_mount: 'rw',
  controlled_file_mounts: paths.length,
  controlled_module_mounts: modulePaths.length,
  writable_profile_module_paths: 0,
  read_only_context_mounts: 0,
  controlled_patch_sha256: createHash('sha256').update(first).digest('hex'),
  note: 'Docker mount semantics only; no DSH Profile or Plugin activation was tested.',
}))

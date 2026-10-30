import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeMountPath, fileSnapshot } from './tree-digest.mjs'
import { installationClosure, validateFallback } from './prepare-verification-home.mjs'

const mode = process.env.DSH_HARNESS_MODE
if (mode !== 'verification') {
  throw new Error('DSH_HARNESS_MODE must be verification')
}
let source
try {
  source = JSON.parse(process.env.DSH_EXPECT_SOURCE_JSON ?? '')
} catch {
  throw new Error('missing or invalid selected DSH source contract')
}
const sourceSelector = /^experiment:(?:EXP|VAR)-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{3}(?:-r[0-9a-f]{12})?$/
const sourceKinds = new Set(['experiment'])
if (source?.schema_version !== '2.1' || !sourceSelector.test(source.source_id) || !sourceKinds.has(source.source_kind)
  || source.profile !== 'web' || !source.patch?.startsWith('/opt/dsh-managed/')
  || source.evaluation_patch !== '/opt/dsh-adapter/evaluation-registry.patch.yml'
  || !source.preset?.startsWith('/opt/dsh-presets/')
  || (source.guard !== null && !source.guard?.startsWith('/opt/dsh-managed/'))
  || typeof source.preset_id !== 'string' || source.preset_id.length === 0
  || !Array.isArray(source.config_markers) || source.config_markers.length === 0
  || (source.reference_root !== null && typeof source.reference_root !== 'string')) {
  throw new Error('selected DSH source contract is incomplete')
}

const roots = [
  { key: 'workspace', path: '/work/harness/workspace', expected: process.env.DSH_EXPECT_WORKSPACE_TREE_SHA },
  { key: 'presets', path: '/opt/dsh-presets', expected: process.env.DSH_EXPECT_PRESETS_TREE_SHA },
  { key: 'managed', path: '/opt/dsh-managed', expected: process.env.DSH_EXPECT_MANAGED_TREE_SHA },
]
const gradingMaterialPaths = ['/work/reference', '/work/eval-input']

const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const fields = line.split(' ')
    return { target: decodeMountPath(fields[4]), options: fields[5].split(',') }
  })

function fileSha(path, maxBytes = 256 * 1024, allowEmpty = false) {
  const state = lstatSync(path)
  if (!state.isFile() || state.isSymbolicLink() || state.size > maxBytes || (!allowEmpty && state.size === 0)) {
    throw new Error(`controlled file is not bounded regular data: ${path}`)
  }
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

// 适配层脚本由只读 bind 挂载提供，不烘焙进镜像：脚本改动只需重启实例。
// 这里同时核对"是精确只读挂载"与"字节等于宿主审查过的文件"。
const adapterMount = mounts.find(entry => entry.target === '/opt/dsh-adapter')
if (!adapterMount || !adapterMount.options.includes('ro')) {
  throw new Error('adapter scripts are not provided by an exact read-only bind mount')
}
const adapterScriptEvidence = {}
for (const script of [
  { key: 'verify_load', path: '/opt/dsh-adapter/verify-load.mjs', expected: process.env.DSH_EXPECT_VERIFY_SCRIPT_SHA },
  { key: 'prepare_home', path: '/opt/dsh-adapter/prepare-verification-home.mjs', expected: process.env.DSH_EXPECT_PREPARE_SCRIPT_SHA },
  { key: 'tree_digest', path: '/opt/dsh-adapter/tree-digest.mjs', expected: process.env.DSH_EXPECT_TREE_SCRIPT_SHA },
]) {
  const digest = fileSha(script.path, 64 * 1024)
  if (!script.expected || digest !== script.expected) {
    throw new Error(`mounted adapter script differs from the reviewed file: ${script.path}`)
  }
  adapterScriptEvidence[script.key] = { mount_mode: 'ro', sha256: digest, size: lstatSync(script.path).size }
}

const mountEvidence = {}

// 被测容器不能携带判分材料或已退役的开发会话指令。
for (const path of [...gradingMaterialPaths, '/work/AGENTS.md', '/work/AGENTS.local.md']) {
  if (existsSync(path) || mounts.some(entry => entry.target === path)) {
    throw new Error(`the subject container must not carry grading material or development instructions: ${path}`)
  }
}

for (const item of roots) {
  if (!existsSync(item.path)) throw new Error(`asset mount missing: ${item.key}`)
  const mount = mounts.find(entry => entry.target === item.path)
  if (!mount) throw new Error(`asset path is not an exact bind mount: ${item.key}`)
  const expectedMode = 'ro'
  if (!mount.options.includes(expectedMode)) {
    throw new Error(`asset mount mode mismatch: ${item.key}, expected ${expectedMode}`)
  }
  const snapshot = fileSnapshot(item.path)
  if (!item.expected || snapshot.tree_sha256 !== item.expected) {
    throw new Error(`host/container asset tree mismatch: ${item.key}`)
  }
  mountEvidence[item.key] = { mount_mode: expectedMode, ...snapshot }
}

const homeMount = mounts.find(entry => entry.target === '/var/lib/dsh')
if (!homeMount || !homeMount.options.includes('rw')) {
  throw new Error('independent DSH_HOME volume is absent or read-only')
}

const homeControlEvidence = {}
{
  const controls = [
    {
      key: 'home_user_patch',
      path: '/var/lib/dsh/cordis.patch.yml',
      expected: process.env.DSH_EXPECT_USER_PATCH_SHA,
    },
    {
      key: 'global_agent_instructions',
      path: '/var/lib/dsh/AGENTS.md',
      expected: process.env.DSH_EXPECT_GLOBAL_AGENTS_SHA,
    },
    {
      key: 'home_bootstrap_env',
      path: '/var/lib/dsh/.env',
      expected: process.env.DSH_EXPECT_BOOTSTRAP_ENV_SHA,
    },
    {
      key: 'workspace_bootstrap_env',
      path: '/work/harness/workspace/.env',
      expected: process.env.DSH_EXPECT_BOOTSTRAP_ENV_SHA,
    },
  ]
  controls.push({
    key: 'web_profile_manifest',
    path: '/var/lib/dsh/profiles/web/package.json',
    expected: process.env.DSH_EXPECT_WEB_MANIFEST_SHA,
  })
  for (const control of controls) {
    const mount = mounts.find(entry => entry.target === control.path)
    if (!mount || !mount.options.includes('ro')) {
      throw new Error(`controlled DSH_HOME file is not an exact read-only bind: ${control.key}`)
    }
    const state = lstatSync(control.path)
    if (!state.isFile() || state.isSymbolicLink()
      || (control.key !== 'global_agent_instructions' && state.size === 0)
      || state.size > 64 * 1024) {
      throw new Error(`controlled DSH_HOME file is not a bounded regular file: ${control.key}`)
    }
    const bytes = readFileSync(control.path)
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (!control.expected || actual !== control.expected) {
      throw new Error(`host/container DSH_HOME control digest mismatch: ${control.key}`)
    }
    homeControlEvidence[control.key] = { mount_mode: 'ro', sha256: actual, size: bytes.length }
  }

  const homePatch = readFileSync('/var/lib/dsh/cordis.patch.yml', 'utf8')
  if (!/^\s*(?:#[^\n]*\n)*\[\]\s*$/.test(homePatch)) {
    throw new Error('DSH_HOME user Patch is not the controlled empty deny-layer')
  }
  const webPatchPath = '/var/lib/dsh/profiles/web/cordis.patch.yml'
  const webPatchState = lstatSync(webPatchPath)
  if (mounts.some(entry => entry.target === webPatchPath)
    || !webPatchState.isFile() || webPatchState.isSymbolicLink()
    || webPatchState.nlink !== 1 || webPatchState.size === 0 || webPatchState.size > 64 * 1024) {
    throw new Error('Web profile settings patch is not a bounded writable volume file')
  }
  const webPatchBytes = readFileSync(webPatchPath)
  homeControlEvidence.web_runtime_patch = {
    mount_mode: 'volume-rw',
    sha256: `sha256:${createHash('sha256').update(webPatchBytes).digest('hex')}`,
    size: webPatchBytes.length,
  }
  const manifestPath = '/var/lib/dsh/profiles/web/package.json'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  const baseBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const scheduleBundles = [...baseBundles, '@deepseek-ai/dsh-experimental-schedule-bundle']
  if (manifest.name !== 'dsh-profile-web' || manifest.private !== true
    || Object.keys(manifest.dependencies ?? {}).length !== 0
    || manifest.dsh?.profile?.patchReload !== 'startup'
    || (JSON.stringify(bundles) !== JSON.stringify(baseBundles)
      && JSON.stringify(bundles) !== JSON.stringify(scheduleBundles))) {
    throw new Error('web Profile manifest differs from locked startup tuple')
  }
  for (const path of ['/var/lib/dsh/.env', '/work/harness/workspace/.env']) {
    const content = readFileSync(path, 'utf8')
    if (!/^(?:\s*#[^\n]*\n)+\s*$/.test(content) || /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=/m.test(content)) {
      throw new Error(`bootstrap environment deny-layer contains assignments: ${path}`)
    }
  }
  if (!/^\s*$/.test(readFileSync('/var/lib/dsh/AGENTS.md', 'utf8'))) {
    throw new Error('global DSH_HOME Agent instructions are not semantically empty')
  }
}

const moduleEvidence = {}
const deniedModulePaths = [
  '/var/lib/dsh/node_modules',
  '/var/lib/dsh/profiles/web/node_modules',
]
for (const path of deniedModulePaths) {
  const mount = mounts.find(entry => entry.target === path)
  if (!mount || !mount.options.includes('ro')) {
    throw new Error(`DSH_HOME module deny-layer is not an exact read-only mount: ${path}`)
  }
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()
    || JSON.stringify(readdirSync(path)) !== JSON.stringify(['POLICY.md'])) {
    throw new Error(`DSH_HOME module deny-layer contains package entries: ${path}`)
  }
  const markerSha = fileSha(join(path, 'POLICY.md'), 64 * 1024)
  if (!process.env.DSH_EXPECT_MODULE_DENY_SHA || markerSha !== process.env.DSH_EXPECT_MODULE_DENY_SHA) {
    throw new Error(`DSH_HOME module deny-layer marker mismatch: ${path}`)
  }
  moduleEvidence[path] = { mount_mode: 'ro', module_entries: 0, policy_sha256: markerSha }
}

const fallbackPath = '/var/lib/dsh/profiles/node_modules'
const fallbackMount = mounts.find(entry => entry.target === fallbackPath)
if (!fallbackMount || !fallbackMount.options.includes('ro')) {
  throw new Error('trusted installation fallback is not an exact read-only volume mount')
}
const closure = installationClosure('/opt/dsh/apps/cli/package.json')
const linkedFallback = validateFallback(fallbackPath, closure, true)
const profileRequire = createRequire('/var/lib/dsh/profiles/web/cordis.yml')
const criticalModules = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-agent-instructions',
]
if (JSON.parse(readFileSync('/var/lib/dsh/profiles/web/package.json', 'utf8'))
  .dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-schedule-bundle')) {
  criticalModules.push('@deepseek-ai/dsh-experimental-schedule-bundle')
}
const nativeResolution = linkedFallback ? undefined : await (await import(
  createRequire('/opt/dsh/apps/cli/package.json').resolve('@deepseek-ai/dsh-app-boot')
)).createRuntimeResolution({ installAnchor: '/opt/dsh/apps/cli/package.json' })
for (const name of criticalModules) {
  if (!closure.has(name)) throw new Error(`critical DSH module is outside pinned installation closure: ${name}`)
  if (linkedFallback) {
    let first
    for (const path of profileRequire.resolve.paths(name) ?? []) {
      const candidate = join(path, name)
      if (existsSync(join(candidate, 'package.json'))) {
        first = candidate
        break
      }
    }
    if (!first || !realpathSync.native(first).startsWith('/opt/dsh/')) {
      throw new Error(`critical module resolution escaped immutable image tree: ${name}`)
    }
  } else {
    const entry = nativeResolution.entries.find(item => item.name === name && item.scope === 'installation')
    if (!entry || !realpathSync.native(entry.packageDir).startsWith('/opt/dsh/')) {
      throw new Error(`critical native module resolution escaped immutable image tree: ${name}`)
    }
  }
}
moduleEvidence[fallbackPath] = {
  mount_mode: 'ro',
  pinned_installation_symlinks: linkedFallback ? closure.size : 0,
  resolution_backend: linkedFallback ? 'links' : 'native',
  critical_modules_resolved_inside_image: criticalModules.length,
}

const dump = spawnSync(process.execPath, [
  '/opt/dsh/apps/cli/lib/bin.js',
  '--profile', source.profile,
  '--patch', source.patch,
  '--patch', source.evaluation_patch,
  '--dump-config',
], {
  cwd: '/work/harness/workspace',
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  timeout: 20_000,
  killSignal: 'SIGKILL',
})
if (dump.error?.code === 'ETIMEDOUT') {
  throw new Error('DSH profile composition timed out after 20 seconds; child was killed')
}
if (dump.error) {
  throw new Error(`DSH profile composition could not start (${dump.error.code ?? 'unknown'})`)
}
if (dump.status !== 0) {
  // 不输出原始 stderr；它可能包含 MCP URL、Token 或其他私有配置。
  throw new Error(`DSH profile composition failed (exit=${String(dump.status ?? dump.signal)})`)
}

for (const marker of source.config_markers) {
  if (!dump.stdout.includes(marker)) {
    throw new Error(`DSH composed config missing expected marker: ${marker}`)
  }
}
for (const preset of ['evaluation-judge', 'scenario-analysis']) {
  if (!dump.stdout.includes(`preset-${preset}`)) {
    throw new Error(`declarative ${preset} preset missing from evaluation composition`)
  }
}

// 评测组合不开放出厂或用户 Preset 根。
if (/\bincludeShippedRoot:\s*true\b/.test(dump.stdout) || /\bincludeUserRoot:\s*true\b/.test(dump.stdout)
  || /\bdefault:\s*cordis\b/.test(dump.stdout)) {
  throw new Error('verification composition must not expose the shipped cordis preset or a writable preset root')
}

// --dump-config 只展开全局 Profile，不展开每个 Agent Preset 的 agent.cordis.yml。
// 因此 Guard 仅能在本探针里核对 Preset 声明与挂载文件；实际插件激活须另取证。
let guardPresent = false
if (source.guard !== null) {
  const presetConfig = readFileSync(source.preset, 'utf8')
  if (!presetConfig.includes(source.guard) || !existsSync(source.guard)) {
    throw new Error('Preset Guard declaration or managed Guard file is missing')
  }
  guardPresent = true
}

console.log(JSON.stringify({
  status: 'mount-and-config-composition-only',
  source_id: source.source_id,
  agent_id: source.agent_id,
  dsh_mode: mode,
  profile: source.profile,
  patch: source.patch,
  mounts: mountEvidence,
  grading_material: {
    exposed_paths: [],
    note: 'The subject role receives no grading material; the negative assertion above proves the requirement, acceptance-threshold and expected-answer paths are absent.',
  },
  adapter_scripts: adapterScriptEvidence,
  dsh_home_mount_mode: 'rw',
  controlled_home_controls: homeControlEvidence,
  controlled_module_resolution: moduleEvidence,
  composed_config_sha256: `sha256:${createHash('sha256').update(dump.stdout).digest('hex')}`,
  expected_markers_present: source.config_markers.length,
  preset_guard_declaration_present: guardPresent,
  limitations: 'Read-only HOME/Module/.env controls and a locked startup manifest prove only mount and resolution identity, not Plugins/MCP or Preset actually activated; no Agent session, real protocol, final business state, or Release acceptance was tested.',
}))

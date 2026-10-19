import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectProfile } from './profile-compat.ts'
import { ensureTarget } from './prepare-verification-home.mjs'
import { clockForAgent } from './schedule-compat/root-scope.ts'

test('legacy Schedule profile projects without changing its fixed source and permits only exact HOME migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-compat-'))
  try {
    const source = join(dir, 'source.json')
    const original = JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-schedule-bundle'],
      patchReload: 'startup',
    } } })
    writeFileSync(source, original)
    const target = join(dir, 'projection/web-profile.package.json')
    assert.equal(projectProfile(source, target), target)
    assert.equal(projectProfile(source, target), target)
    assert.equal(readFileSync(source, 'utf8'), original)
    assert.equal(statSync(target).mode & 0o222, 0)
    assert.deepEqual(JSON.parse(readFileSync(target)).dsh.profile.bundles,
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const home = join(dir, 'home-package.json')
    writeFileSync(home, original)
    ensureTarget(home, target, false, false, source)
    assert.equal(readFileSync(home, 'utf8'), readFileSync(target, 'utf8'))
    writeFileSync(home, `${original}\n`)
    assert.throws(() => ensureTarget(home, target, false, false, source), /differs from controlled/)
    const settings = join(dir, 'cordis.patch.yml')
    writeFileSync(settings, '# user settings\n')
    ensureTarget(settings, source, false, true)
    assert.equal(readFileSync(settings, 'utf8'), '# user settings\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Schedule compatibility never loads reminder plugins for children or other presets', async () => {
  const original = process.env.DSH_EVAL_TARGET_PRESET
  process.env.DSH_EVAL_TARGET_PRESET = 'business'
  try {
    const agent = (header) => ({ session: { header }, ctx: { plugin() { throw new Error('must not load') } } })
    await clockForAgent({}, agent({ agentPreset: 'standard' }))
    await clockForAgent({}, agent({ agentPreset: 'business', origin: 'subagent', delegationDepth: 1 }))
  } finally {
    if (original === undefined) delete process.env.DSH_EVAL_TARGET_PRESET
    else process.env.DSH_EVAL_TARGET_PRESET = original
  }
})

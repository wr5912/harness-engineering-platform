import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyDataDependencies } from '../data.mts'

test('业务插件只装入目标资源中的依赖，缺项时拒绝离线包', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-data-deps-'))
  try {
    const data = join(root, 'data'), assets = join(root, 'assets')
    const relative = 'evolution/experiments/example/candidate/dsh/managed/voice'
    mkdirSync(join(data, 'config'), { recursive: true })
    writeFileSync(join(data, 'config/sources.json'), JSON.stringify({ sources: { example: { candidate_root: 'evolution/experiments/example/candidate/dsh' } } }))
    mkdirSync(join(data, relative), { recursive: true })
    writeFileSync(join(data, relative, 'package.json'), JSON.stringify({ dependencies: { '@example/runtime': '1.0.0' } }))
    assert.throws(() => copyDataDependencies(data, assets), /离线资源缺少业务插件依赖/)
    mkdirSync(join(assets, 'data', relative, 'node_modules/@example/runtime'), { recursive: true })
    const dependency = join(assets, 'data', relative, 'node_modules/@example/runtime')
    writeFileSync(join(dependency, 'index.js'), 'export default true', { mode: 0o600 })
    chmodSync(dependency, 0o700)
    writeFileSync(join(assets, 'data', relative, 'cache'), '不装入')
    copyDataDependencies(data, assets)
    assert.ok(existsSync(join(data, relative, 'node_modules/@example/runtime')))
    assert.equal(statSync(join(data, relative, 'node_modules/@example/runtime')).mode & 0o777, 0o755)
    assert.equal(statSync(join(data, relative, 'node_modules/@example/runtime/index.js')).mode & 0o777, 0o644)
    assert.equal(statSync(dependency).mode & 0o777, 0o700)
    assert.equal(existsSync(join(data, relative, 'cache')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

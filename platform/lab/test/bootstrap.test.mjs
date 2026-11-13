import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../hep-lab-bootstrap.sh')
const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), '../../hep-lab')

test('standalone bootstrap is executable without the source cwd', () => {
  const syntax = spawnSync('sh', ['-n', script], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const help = spawnSync(script, ['--help'], { cwd: '/tmp', encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--destination/)
  assert.match(help.stdout, /hep-lab CLI/)

  const version = spawnSync(script, ['--version'], { cwd: '/tmp', encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^hep-lab-bootstrap \d+\.\d+\.\d+\n$/)

  const delegated = spawnSync(wrapper, ['bootstrap', '--help'], { cwd: '/tmp', encoding: 'utf8' })
  assert.equal(delegated.status, 0, delegated.stderr)
  assert.match(delegated.stdout, /hep-lab CLI/)
})

test('bootstrap is pinned and derives the four repositories from data locks', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /DEFAULT_DATA_COMMIT="[0-9a-f]{40}"/)
  assert.match(source, /PROGRAM_COMMIT=\$\{HEP_LAB_PROGRAM_COMMIT:-\}/)
  assert.match(source, /locks\/repositories\.yaml/)
  assert.match(source, /platform_manager_dsh_home/)
  assert.match(source, /business_agents/)
  assert.match(source, /--platform-commit/)
  assert.match(source, /--platform-manager-dsh-home-commit/)
  assert.match(source, /--business-agents-commit/)
})

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
if (!process.env.HARNESS_PROGRAM_ROOT) throw new Error('测试需要 HARNESS_PROGRAM_ROOT')
const result = spawnSync(process.execPath, ['--import', join(directory, 'test-bootstrap.mjs'), '--test', join(directory, 'src/**/*.test.mjs'), join(directory, 'tests/*.test.mjs'), join(directory, 'tests/test.mjs')], {
  cwd: join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin'), stdio: 'inherit',
  env: { ...process.env, HARNESS_ASSET_ROOT: process.env.HARNESS_ASSET_ROOT || resolve(process.env.HARNESS_PROGRAM_ROOT, '../harness-engineering-platform-data') },
})
process.exit(result.status ?? 1)

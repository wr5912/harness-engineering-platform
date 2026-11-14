import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const runtimeFiles = ['standalone-bootstrap.js', 'standalone-plugin.js', 'standalone-bridge.js', 'standalone-connection.js', 'standalone-knowledge.js', 'model-binding-runtime.js']
export const sdkFiles = ['sdk-runner.mts', 'sdk-preset.mts', 'sdk-profile.patch.yml', 'sdk-module-links.mts', 'prepare-verification-home.mjs', 'runtime-packages.mjs']
export function stageStandalone(target: string, program = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')) {
  mkdirSync(target, { recursive: true })
  for (const file of runtimeFiles) cpSync(join(program, 'platform/plugin/lib', file), join(target, file))
  const adapter = join(program, 'runtime/adapters/dsh-container')
  for (const file of sdkFiles) cpSync(join(adapter, file), join(target, file))
  cpSync(join(adapter, 'runtime-compat'), join(target, 'runtime-compat'), { recursive: true })
  cpSync(join(adapter, 'standalone-deps'), join(target, 'dependencies'), { recursive: true, filter: source => !source.includes('/node_modules') })
  const web = join(program, 'runtime/adapters/dsh-web/lib')
  const manifestPath = join(web, 'build.outputs.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = manifest.files
  if (manifest.schemaVersion !== 1 || !Array.isArray(files) || !files.length || new Set(files).size !== files.length
    || !files.every((name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_-]+\.mjs$/.test(name))) throw new Error(`Web 构建输出清单无效：${manifestPath}；请重新构建平台插件`)
  mkdirSync(join(target, 'web'), { recursive: true })
  for (const file of ['build.outputs.json', ...files]) cpSync(join(web, file), join(target, 'web', file))
  writeFileSync(join(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) stageStandalone(resolve(process.argv[2]))

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
try { require.resolve('esbuild'); require.resolve('typescript') } catch {
  if (process.env.HEP_OFFLINE === '1') throw new Error('离线模式缺少 Web 构建依赖；请重新打包完整 node_modules')
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' })
  if (install.status !== 0) throw new Error('Web 路径适配器依赖安装失败')
}
const { build } = await import('esbuild')
await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(['index', 'platform-webserver', 'container-webserver', 'container-web-app', 'client-urls-worker']
    .map(name => [name, `src/${name}.ts`])),
  outdir: resolve(root, 'lib'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  legalComments: 'none',
  banner: { js: "import { createRequire as __webCreateRequire } from 'node:module'; import { fileURLToPath as __webFilePath } from 'node:url'; import { dirname as __webDirname } from 'node:path'; const require = __webCreateRequire(import.meta.url); const __filename = __webFilePath(import.meta.url); const __dirname = __webDirname(__filename);" },
})

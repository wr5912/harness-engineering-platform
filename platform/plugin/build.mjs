import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

execFileSync(process.execPath, [fileURLToPath(new URL('../../runtime/adapters/dsh-web/build.mjs', import.meta.url))], { stdio: 'inherit' })

export const managerSource = fileURLToPath(new URL('../../plugins/mcp-manager', import.meta.url))
export const managerSources = {
  name: 'existing-mcp-manager',
  setup(build) {
    build.onResolve({ filter: /^harness-mcp-manager-/ }, args => ({ path: args.path, namespace: 'manager-source' }))
    build.onLoad({ filter: /.*/, namespace: 'manager-source' }, async ({ path }) => {
      let contents
      if (path.endsWith('client')) {
        const original = await readFile(resolve(managerSource, 'client.tsx'), 'utf8')
        const start = original.indexOf('    const formName =')
        const end = original.indexOf('    function apply(ctx)')
        if (start < 0 || end <= start) throw new Error('MCP 管理客户端装载合同已变化')
        const client = original.slice(start, end)
        contents = `import * as React from 'react'; const { useEffect, useState, useRef } = React;
${client}
export { Manager };`
      } else if (path.endsWith('openapi')) {
        const original = await readFile(resolve(managerSource, 'openapi.ts'), 'utf8')
        contents = `import { appendQueryParameter } from ${JSON.stringify(resolve('src/mcp/openapi.ts'))};\nfunction platformTimeout(server: any) { const timeout = AbortSignal.timeout(server.platformTimeoutMs ?? 20_000); return server.platformSignal ? AbortSignal.any([server.platformSignal, timeout]) : timeout }\n${original.replaceAll('AbortSignal.timeout(20_000)', 'platformTimeout(server)').replace('const { response, credential } = await authorizedFetch(source.server', 'const server = source.server\n  const { response, credential } = await authorizedFetch(source.server').replace("if (parameter.in === 'query') for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter.name, String(entry))", "if (parameter.in === 'query') appendQueryParameter(url.searchParams, parameter, value)")}\nexport { execute };`
      } else {
        contents = (await readFile(resolve(managerSource, 'index.ts'), 'utf8'))
          .replace("createRequire('/opt/dsh/packages/mcp/mcp-client/package.json')", "resolveRuntimeRequire('@deepseek-ai/schemastery', existsSync('/opt/dsh/packages/mcp/mcp-client/package.json') ? '/opt/dsh/packages/mcp/mcp-client/package.json' : undefined)")
          .replace("const z = runtimeRequire", "const platformRequire = createRequire(import.meta.url)\nconst z = runtimeRequire")
          .replaceAll("runtimeRequire('@modelcontextprotocol/", "platformRequire('@modelcontextprotocol/")
          .replace("from './openapi.mjs'", "from 'harness-mcp-manager-openapi'")
          .replace('if (server.specUrl) {', 'if (server.platformComposition) {\n      if (!config.platformClient) throw new Error("已发布编排服务未装载")\n      server.platformClient = config.platformClient\n      continue\n    }\n    if (server.specUrl) {')
          .replace('const url = resolvedUrl(server)\n', 'if (server.platformComposition) return run(server.platformClient)\n  const url = resolvedUrl(server)\n')
          .replace("transport: 'streamable-http',\n              serverName:", "transport: 'streamable-http',\n              ...(server.platformComposition ? { toolCallTimeoutMs: 36 * 60_000 } : {}),\n              serverName:")
          .replace('Boolean(server.specUrl || resolvedUrl(server))', 'Boolean(server.platformComposition || server.specUrl || resolvedUrl(server))')
          .replace('!(server.specUrl || resolvedUrl(server))', '!(server.platformComposition || server.specUrl || resolvedUrl(server))')
          .replace('source.tools.map(({ name, description }: any) => ({ name, description }))', 'source.tools.map(({ name, description, inputSchema }: any) => ({ name, description, inputSchema }))')
        if (!["async (request: any, extra: any) => runRequest('tools/call'",
          "async (request: any, extra: any) => runRequest('resources/read'",
          'readGroupResource(target, request.params.uri, extra?.mcpReq?.signal ?? extra?.signal)',
          'readManagedResource({ ...server, platformSignal: signal ?? server.platformSignal }, upstreamUri)'
        ].every(anchor => contents.includes(anchor))) throw new Error('MCP 分组请求取消信号装载合同已变化')
      }
      if (!path.endsWith('client') && !path.endsWith('openapi')) {
        // 从同一个原生 HTTP 处理函数提取业务 dispatch，供 AI 工具复用。
        const adminStart = contents.indexOf("  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/mcp-manager'")
        const dispatchStart = contents.indexOf('      const server = current.servers.find', adminStart)
        const dispatchEnd = contents.indexOf('    } catch (error)', dispatchStart)
        if (adminStart < 0 || dispatchStart < 0 || dispatchEnd < 0) throw new Error('MCP 管理 dispatch 合同已变化')
        const dispatchBody = contents.slice(dispatchStart, dispatchEnd).replaceAll('send(res, ', 'reply(')
        const dispatcher = `  const runPlatformDispatch = async (request: any, signal?: AbortSignal) => {
          signal?.throwIfAborted()
          const current = snapshot(config)
          const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 36 * 60_000 ? request.timeoutMs : undefined
          current.servers = current.servers.map((server: any) => ({ ...server, platformSignal: signal, platformTimeoutMs: timeoutMs }))
          const reply = (status: number, value: any) => ({ status, value })
          try { ${dispatchBody} } catch (error) { return reply(400, { error: error instanceof Error ? error.message : String(error) }) }
        }
        const platformDispatch = (request: any, signal?: AbortSignal) => config.withManagement
          ? config.withManagement(() => runPlatformDispatch(request, signal)) : runPlatformDispatch(request, signal)
        config.platformDispatch?.(platformDispatch)
`
        contents = contents.slice(0, dispatchStart) + `      const outcome = await platformDispatch(request)\n      return send(res, outcome.status, outcome.value)\n` + contents.slice(dispatchEnd)
        contents = contents.slice(0, adminStart) + dispatcher + contents.slice(adminStart)
        contents = `import { existsSync } from 'node:fs';\nimport { runtimeRequire as resolveRuntimeRequire } from ${JSON.stringify(resolve('../../runtime/adapters/dsh-web/src/resolve-runtime.ts'))};\n${contents}`
      }
      return { contents, loader: path.endsWith('client') ? 'tsx' : 'ts', resolveDir: managerSource }
    })
  },
}

const { name } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
// 固定已打包执行代码的身份，不能用运行时工作树替代实际装载制品。
const implementationFiles = ['definition.ts', 'compositions.ts', 'executor.ts', 'index.ts', 'openapi.ts', 'native.ts', 'nested.ts', 'extension.ts', 'control.ts', 'manager.ts', 'platform-manager.ts']
  .map(file => `platform/plugin/src/mcp/${file}`)
  .concat(['platform/plugin/build.mjs', 'platform/plugin/package.json', 'platform/plugin/pnpm-lock.yaml', 'platform/plugin/src/index.ts',
    'platform/plugin/src/evaluation/model-attempts.ts', 'platform/plugin/src/workflows/graph.ts',
    ...['contracts.ts', 'core.ts', 'gateway.ts', 'group-link.ts', 'providers.ts', 'reports.ts', 'runtime.ts'].map(file => `platform/plugin/src/business-control/${file}`),
    ...['index.ts', 'openapi.ts'].map(file => `plugins/mcp-manager/${file}`),
    'platform/plugin/src/mcp/store.ts'])
const implementationHash = createHash('sha256')
for (const file of implementationFiles) implementationHash.update(file).update('\0').update(await readFile(new URL('../../' + file, import.meta.url)))
const implementationDefine = { __PLATFORM_MCP_IMPLEMENTATION_DIGEST__: JSON.stringify(implementationHash.digest('hex')) }
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  loader: { '.svg': 'dataurl' },
  legalComments: 'none',
  define: implementationDefine,
  plugins: [managerSources],
})
await build({ entryPoints: ['src/mcp/manager.ts'], outfile: 'lib/mcp-manager.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', plugins: [managerSources], legalComments: 'none', define: implementationDefine })
await build({ entryPoints: ['src/mcp/platform-manager.ts'], outfile: 'lib/platform-mcp-manager.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', plugins: [managerSources], legalComments: 'none', define: implementationDefine })
await build({ entryPoints: ['src/business-control/runtime.ts'], outfile: 'lib/business-runtime.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', legalComments: 'none' })
await build({ entryPoints: ['src/business-control/index.ts'], outfile: 'lib/business-gateway.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', legalComments: 'none' })
await build({ entryPoints: ['src/business-control/core.ts'], outfile: 'lib/business-control.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', legalComments: 'none' })
await build({ entryPoints: ['src/models/runtime.ts'], outfile: 'lib/model-runtime.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', legalComments: 'none' })
// 独立业务 Host 包不声明管理客户端；薄入口继续复用同一份已构建实现。
await build({ entryPoints: ['business/runtime.ts', 'business/mcp-manager.ts'], outdir: 'business', bundle: false,
  platform: 'node', target: 'node24', format: 'esm', legalComments: 'none' })
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  loader: { '.svg': 'dataurl' },
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  legalComments: 'none',
  plugins: [managerSources],
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
})

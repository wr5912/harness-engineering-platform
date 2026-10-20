import { createMcpHandler } from './index.ts'
import { digestOf, redacted } from './openapi.ts'
import { loadOpenApi, execute } from 'harness-mcp-manager-openapi'
import type { ThreatRuntime, CompositionExtension } from './extension.ts'
import { managedServer } from './control.ts'

export function createManagedMcpHandler(assetRoot: string, servers: () => any[], options: { threat?: ThreatRuntime; extension?: CompositionExtension } = {}) {
  return createMcpHandler(assetRoot, {
    servers,
    threat: options.threat,
    extension: options.extension,
    native: {
      async load(connection, signal) {
        const server = servers().find(item => item.id === connection.id && item.enabled !== false)
        if (!server?.specUrl) throw new Error('组合依赖的 OpenAPI 服务器未启用')
        return { ...await loadOpenApi({ ...managedServer(assetRoot, server, () => servers().find(item => item.id === connection.id)), platformSignal: signal }), connection }
      },
      async call(source, operationId, args, signal) {
        signal?.throwIfAborted()
        const operation = source.operations.get(operationId)
        if (!operation) throw new Error(`OpenAPI 操作不存在：${operationId}`)
        const { response, text } = await execute(source, operation, args)
        let json
        try { json = redacted(JSON.parse(text)) } catch { json = text }
        return { ok: response.ok, status: response.status, json,
          receipt: { connectionId: source.connection.id, specDigest: digestOf(source.spec), operationId,
            method: operation.method.toUpperCase(), path: operation.path, schemaDigest: digestOf(operation.raw) } }
      },
    },
  })
}

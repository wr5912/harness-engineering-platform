import type { CompositionFlow } from '@harness-platform/mcp/extension'

const failed = (code: string, message: string) => ({ code, message })
export const assetAlertsFlow: CompositionFlow = {
  steps: config => [
    { step: 'asset', title: '查询资产', connectionId: config.connectionId, operationId: 'get_soc_asset_by_asset_id', input: { assetId: '$input.asset' }, output: 'asset' },
    { step: 'alerts', title: '查询相关告警', connectionId: config.alertsConnectionId, operationId: 'list_detect_alert', input: { req: { assetId: '$state.assetId', pageNum: 1, pageSize: '$input.limit', windowSeconds: 2592000 } }, output: 'alerts' },
  ],
  assetArguments(input) {
    const assetId = Number(input.asset)
    if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new Error('资产 ID 必须是正安全整数')
    return { assetId }
  },
  assetResult(reply, input) {
    const asset = reply.json?.data, assetId = asset?.assetId
    return { asset, assetId, error: reply.json?.code !== 200 ? failed('business_failed', '资产查询业务失败')
      : assetId !== Number(input.asset) ? failed('mapping_failed', '资产查询结果与请求不一致') : undefined }
  },
  alertsArguments: (input, assetId) => ({ req: { assetId: String(assetId), pageNum: 1, pageSize: input.limit, windowSeconds: 2592000 } }),
  alertsResult(reply) {
    const data = reply.json?.data
    return { items: data?.groups, summary: data, error: reply.json?.code !== 200 ? failed('business_failed', '告警查询业务失败')
      : !Array.isArray(data?.groups) ? failed('mapping_failed', '告警查询结果缺少分组列表') : undefined }
  },
  succeeded: reply => reply.ok && reply.json?.code === 200,
}

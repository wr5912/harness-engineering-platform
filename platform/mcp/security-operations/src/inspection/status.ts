/** 巡检直接呈现SOC当前状态；来源证据保留，不在本端重新判定时效或覆盖状态。 */
export function classifyStatus(asset: any) {
  const facts = { online: asset.online, onlineBasis: asset.onlineBasis, lastSeenAt: asset.lastSeenAt, lastProbeAt: asset.lastProbeAt, probeState: asset.probeState, stateEvidence: asset.stateEvidence }
  if (asset.online === 'online') return { status: 'normal', message: '在线', facts }
  if (asset.online === 'offline') return { status: 'abnormal', message: '离线', facts, recommendation: '核实设备离线情况；尚未执行处置。' }
  if (asset.online === 'unknown') return { status: 'unknown', message: 'SOC未采集到状态数据', facts }
  return { status: 'unknown', message: 'SOC未返回有效状态字段', facts }
}

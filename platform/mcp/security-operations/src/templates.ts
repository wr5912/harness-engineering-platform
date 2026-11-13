import { COMPOSITION_SERVICE_ID, type Catalog, type CompositionConfig, type ThreatBindings, type ThreatStage } from '@harness-platform/mcp/compositions'

export const THREAT_STAGES: { stage: ThreatStage; title: string; description: string }[] = [
  { stage: 'collect', title: '威胁分析：取证与快判', description: '认领一次事件，采集证据并执行名单快判，冻结完整研判输入。' },
  { stage: 'infer', title: '威胁分析：完整研判', description: '复用冻结证据执行一次模型研判，并保留原契约校验结果。' },
  { stage: 'writeback', title: '威胁分析：结果回写', description: '生成报告 HTML，并将同一运行的完成或失败结果回写 SOC。' },
  { stage: 'report', title: '威胁分析：报告保存与交付', description: '保存已生成的报告，返回实际下载地址及固定交付摘要。' },
]

export function seedThreatCompositions(catalog: Catalog, bindings: ThreatBindings) {
  for (const { stage, title, description } of THREAT_STAGES) {
    const id = `threat-${stage}`
    if (!catalog.compositions.some(entry => entry.id === id)) catalog.compositions.push({ id, draft: {
      toolName: `threat_${stage}`, title, description, connectionId: COMPOSITION_SERVICE_ID, kind: 'threat-stage', stage,
      bindings: { socConnectionId: bindings.socConnectionId, reportConnectionId: bindings.reportConnectionId,
        ...(stage === 'infer' && bindings.model ? { model: { ...bindings.model } } : {}) },
    } })
  }
  if (!catalog.compositions.some(entry => entry.id === 'threat-analysis')) {
    const draft: CompositionConfig = { toolName: 'analyze_threat_incident', title: '威胁分析：组合流程',
      description: '按事件 ID 执行取证快判、必要的完整研判、结果回写和报告交付。', connectionId: COMPOSITION_SERVICE_ID, kind: 'composite',
      steps: THREAT_STAGES.map(({ stage }) => ({ id: stage, compositionId: `threat-${stage}`, versionId: '',
        inputMap: stage === 'collect' ? { incident_id: '$input.incident_id' } : { run_id: '$steps.collect.run_id' },
        when: ({ collect: 'always', infer: 'five_source', writeback: 'claimed', report: 'completed' } as const)[stage] })),
    }
    catalog.compositions.push({ id: 'threat-analysis', draft })
  }
}

import type { ReactNode } from 'react'
import { DetailDrawer } from '../components/detail-drawer.tsx'

export interface VariantSourceExperiment {
  id: string
  agent_id: string
  change?: Record<string, unknown>
}

type Source = { experimentId: string | null; agentId: string | null; ref: string | null; available: boolean }

function text(value: unknown) { return typeof value === 'string' && value.trim() ? value : null }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 只读取已有声明，不从编号、相关引用或当前父版内容推导固定来源。 */
export function variantSourceInfo(experiment: VariantSourceExperiment, experiments: VariantSourceExperiment[]) {
  const change = experiment.change ?? {}
  const parentId = text(change.parent_experiment_id)
  const parentRef = text(change.parent_ref) ?? (parentId ? text(change.baseline_ref) : null)
  const baselineRef = text(change.baseline_ref)
  function source(experimentId: string | null, ref: string | null): Source {
    const found = experimentId ? experiments.find(item => item.id === experimentId) : undefined
    return { experimentId, agentId: found?.agent_id ?? null, ref, available: Boolean(found) }
  }
  const fusion = Array.isArray(change.fusion_sources) ? change.fusion_sources : []
  const fusionSources = fusion.flatMap(value => {
    if (typeof value === 'string') return [source(value, null)]
    const item = record(value), id = text(item.experiment_id), ref = text(item.ref)
    return id || ref ? [source(id, ref)] : []
  })
  const generation = record(record(change.compute_variant).generation)
  const runIds = [...new Set(Array.isArray(generation.source_run_ids) ? generation.source_run_ids.filter((id): id is string => Boolean(text(id))) : [])]
  const entryPath = text(generation.entry_path)
  const codePath = entryPath && !entryPath.startsWith('/') && !entryPath.includes('\\') && !entryPath.split('/').some(part => !part || part === '.' || part === '..')
    ? `evolution/experiments/${experiment.id}/candidate/${entryPath}` : null
  return {
    parent: source(parentId, parentRef), baselineRef,
    firstExperiment: !parentId && !text(change.parent_ref) && baselineRef === 'none:first-experiment',
    fusionSources, generationMode: text(generation.mode), runIds, entryPath, codePath,
    diagnosticOwner: parentId ? { agentId: experiments.find(item => item.id === parentId)?.agent_id ?? experiment.agent_id, experimentId: parentId } : null,
  }
}

export function VariantSourcePanel({ experiment, experiments, onSelectSource, onOpenRun, onOpenCode, children, active = true }: {
  experiment: VariantSourceExperiment
  experiments: VariantSourceExperiment[]
  onSelectSource?(agentId: string, experimentId: string): void
  onOpenRun?(runId: string, agentId: string, experimentId: string): void
  onOpenCode?(path: string): void
  children?: ReactNode
  active?: boolean
}) {
  const info = variantSourceInfo(experiment, experiments)
  function sourceDetails(source: Source, label: string) {
    return <>
      <p>{source.experimentId ?? '版本 ID 未记录'}</p>
      <p>固定来源：<code>{source.ref ?? '未记录'}</code></p>
      {source.experimentId && <button type="button" disabled={!source.available || !onSelectSource}
        onClick={() => source.agentId && onSelectSource?.(source.agentId, source.experimentId!)}>{label}</button>}
      {source.experimentId && !source.available && <p className="agent-empty">当前工作区未找到该版本。</p>}
    </>
  }
  return <section className="agent-variant-source" aria-label="版本来源与继承">
    <DetailDrawer title="版本来源与继承" active={active} identity={experiment.id}>
    <dl className="harness-fields">
      <div><dt>直接父版</dt><dd>{info.parent.experimentId
        ? sourceDetails(info.parent, '查看父版当前详情')
        : info.firstExperiment ? '首版本（无既有对照）' : <><p>父版本未记录</p>{(info.parent.ref || info.baselineRef) && <p>{info.parent.ref ? '固定来源' : '固定基线'}：<code>{info.parent.ref || info.baselineRef}</code></p>}</>}
      </dd></div>
      <div><dt>融合来源</dt><dd>{info.fusionSources.length
        ? <ul className="agent-source-list">{info.fusionSources.map((source, index) => <li key={`${source.experimentId}:${source.ref}:${index}`}>{sourceDetails(source, '查看融合来源当前详情')}</li>)}</ul>
        : '未记录'}</dd></div>
      {info.generationMode && <div><dt>生成方式</dt><dd>{info.generationMode === 'langgraph-aot' ? 'LangGraph 代码生成（langgraph-aot）' : info.generationMode}</dd></div>}
      {info.runIds.length > 0 && <div><dt>诊断 Run</dt><dd><ul className="agent-source-list">{info.runIds.map(runId => <li key={runId}><code>{runId}</code>{info.diagnosticOwner
        ? <button type="button" disabled={!onOpenRun} onClick={() => onOpenRun?.(runId, info.diagnosticOwner!.agentId, info.diagnosticOwner!.experimentId)}>查看诊断报告</button>
        : <span> · 所属父版未记录</span>}</li>)}</ul></dd></div>}
      {info.entryPath && <div><dt>源码入口</dt><dd><code>{info.entryPath}</code><p><button type="button" disabled={!info.codePath || !onOpenCode} onClick={() => info.codePath && onOpenCode?.(info.codePath)}>查看生成源码</button></p></dd></div>}
    </dl>
    {children}
    {(info.parent.experimentId || info.fusionSources.length > 0) && <p className="agent-empty">固定引用记录生成时的来源；打开来源详情查看的是该版本当前可编辑的资产。</p>}
    </DetailDrawer>
  </section>
}

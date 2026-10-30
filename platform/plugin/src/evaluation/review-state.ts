export type ReviewContract = {
  schema_version: 1
  effect_scope: 'business-evidence'
  source_scope: 'frozen-harness'
  model_route: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }
  model_policy_sha256: string
  model_policy_snapshot: { path: string; sha256: string }
}
export type SourceDiagnosis = {
  status: 'completed' | 'incomplete' | 'not_requested'
  conclusion: 'findings' | 'no_findings' | 'inconclusive'
  reason: string
  required_parts?: number
  read_parts?: number
  scope?: { bundle: string; path: string; total_lines: number; sha256: string; read_ranges: [number, number][]; complete: boolean }[]
  findings?: { category: string; observed_gap: string; root_cause_hypothesis: string; support_case_ids: string[]; counterexample_case_ids: string[]; alternative: string; falsification: string; evidence_refs: string[] }[]
  analysis_session?: { session_id: string; route: unknown; evidence_ref: string } | null
  diagnostic?: { stage: string; reason: string; evidence_ref: string } | null
}

export const separatedReview = (contract: unknown): contract is ReviewContract => Boolean(contract && typeof contract === 'object'
  && (contract as ReviewContract).schema_version === 1 && (contract as ReviewContract).effect_scope === 'business-evidence'
  && (contract as ReviewContract).source_scope === 'frozen-harness')

export function sourceDiagnosisLabel(diagnosis?: SourceDiagnosis | null): string {
  if (diagnosis?.status === 'not_requested') return '未请求'
  if (diagnosis?.status === 'incomplete') return '未完成 · 源码未核实完整'
  if (diagnosis?.status === 'completed') return diagnosis.conclusion === 'findings' ? '已完成 · 有诊断发现'
    : diagnosis.conclusion === 'no_findings' ? '已完成 · 所列范围未形成发现' : '已完成 · 无法判定'
  return '状态待核对'
}

export function effectReviewLabel(status: unknown): string {
  return status === 'completed' ? '已完成' : status === 'not_requested' ? '未请求'
    : status === 'failed' ? '复核失败' : status === 'running' ? '进行中' : '状态待核对'
}

export function reviewMethodLabel(source: { review_mode?: string; review_contract?: unknown } | undefined): string {
  if (source?.review_mode === 'none') return '未请求 AI 复核'
  if (source?.review_mode !== 'ai') return '未记录'
  return separatedReview(source.review_contract) ? '业务效果与源码分别评估' : source.review_contract === undefined ? '历史综合证据复核' : '评估方法待核对'
}

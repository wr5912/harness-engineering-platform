/** 决策输入与监督目标共用的可执行合同；不包含 Node 依赖，可由界面直接校验。 */
export type DecisionQuestion = { type: 'choice' | 'noul' | 'score'; instructions: string; criteria?: Record<string, string> | string[] }
export type DecisionTask = { id: string; semantics: 'recommended_decision' | 'observed_action' }
export type DecisionInputEvidence = {
  schema_version: 1; session_id: string; dataset_id: string; record_id: string; run_id: string; path: string;
  trace_sha256: string; source_bundle_sha256: string; state_sha256: string;
  read_method: 'datasets/read' | 'datasets/source' | 'datasets/source-fragments';
  receipt_refs: { call_id: string; call_seq: number; result_seq: number }[];
  content_sha256?: string; source_identity_sha256?: string;
}
export type DecisionInputEvidenceBinding = Pick<DecisionInputEvidence, 'session_id' | 'dataset_id' | 'record_id' | 'run_id' | 'path' | 'trace_sha256' | 'source_bundle_sha256' | 'state_sha256'>
export type DecisionReview = { kind: 'ai_delegated'; session_id: string; model: { provider: string; model: string; [key: string]: unknown }; reviewed_at: string; purpose: 'functional_validation'; input_evidence?: DecisionInputEvidence }
export type DecisionTarget = { label: string | boolean | number; probabilities?: Record<string, number>; provenance: Record<string, any>; basis: string; status: 'suggested' | 'reviewed' | 'rejected'; decision_time_reviewed: boolean; reviewed_at?: string | null; review?: DecisionReview }
export function isDecisionTargetReviewed(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const value = target as Pick<DecisionTarget, 'status' | 'review'>
  return value.status === 'reviewed' && (value.review?.kind !== 'ai_delegated' || !!value.review.input_evidence)
}
export const DECISION_SPLITS = ['unassigned', 'train', 'development', 'calibration', 'test'] as const
export const DECISION_EXTRACTION_CONTRACT = {
  schema_version: 2,
  language: 'workflow、题目说明、选项说明、等级说明、basis 和跳过原因优先使用中文。字段名、枚举、工具名、实际动作、来源和英文原始证据保持原值；observed_action 的 action_name 与 label 均保留真实动作名，例如 respond 不译为回复。',
  source: {
    identity: 'agent_id、experiment_id、run_id 由服务器依据实际 Run 目录和清单核对；source_version 仅表示该历史 Run 的冻结 candidate_sha256/git_version，dirty:true 不代表当前固定父版。新批次及每条 _meta 保存该身份，客户端不能改绑；历史缺失字段不改写原件。',
    pagination: '所有 source 回执最多 16000 个 JSON 字符。省略 path 时 kind:sources，files 为目录当前页；所有续读均携带 next_cursor、source_sha256 和 source_identity_sha256。后者固定完整 Run 清单、inputs.lock 与所选文件依赖，包含历史 Candidate/dirty 身份；不能只核对 trace 摘要。选择 path 后重新 cursor:0，不携带目录页摘要。kind:decisions 不再重复 files。',
    fragments: 'detail_required:true 时 state:null 仅表示正文另页，不能当作没有输入；用该决策 read_input 调同一 datasets/source。kind:decision_fragment 的 fragment 为完整决策 JSON 的连续文本段，携带 source_sha256/source_identity_sha256/content_sha256 按 next_cursor 续读直至 complete:true；拼接并 JSON.parse 后才核对 state.messages 全前缀及 available_tools。未完整读取不能编造标签。',
    limits: '目录 limit 为1–20条，默认8；决策页 limit 为1–3条，默认3；决策分片 limit 为1–6000个字符，默认4000。首次页提供抽取合同，后续页省略。超过96 KiB的决策输入仍可完整分片核对，但不能截断成当前训练候选。',
  },
  preview: {
    required_fields: ['run_id', 'path', 'source_sha256', 'samples'],
    source_path: '一个预览仅针对所选 Run 的同一条 path；所有 samples 的 decision_id 必须来自该 path 的决策分页，不得混入其他文件。',
    samples_max: 40,
    skipped: { optional: true, type: 'string[]', max_items: 100, max_item_length: 2000, instructions: '每项必须为非空跳过原因字符串；不接受对象数组或字典，不提供时视为空数组。' },
  },
  sample_fields: ['decision_id', 'action_name', 'workflow', 'task', 'questions', 'targets'],
  workflow: '非空业务流程名称，最多 200 字符',
  task: { id: '稳定的业务任务标识，最多 200 字符', semantics: ['recommended_decision', 'observed_action'] },
  questions: '一个或多个命名问题，键为 1–80 位英文、数字、下划线或短横线；每题含 type、instructions、criteria（noul 可省略）',
  targets: '与 questions 键精确对应；每题含 label、basis，可选 probabilities；输入不含标签、来源或审核信息',
  types: { choice: 'criteria 为至少两个互斥且有真实依据的候选映射，同一情形不能同时满足多个选项；兜底须排除已列选项，label 精确匹配候选键', noul: 'label 为布尔值；criteria 如提供，仅有 false/true', score: 'criteria 为有序且不同的等级说明，label 为从 0 开始的等级索引' },
  probabilities: '可选完整概率映射，choice 使用候选键，noul 使用 false/true，score 使用等级索引字符串；全部有限且位于 [0,1]，总和与 1 的误差不超过 1e-5（不改写原始概率），label 位于最大概率集合；硬标签不自动补 one-hot',
  provenance: '预览仅产生未经校准的 model_suggestion，服务器固定 Session/模型/技能来源；不得自称人工标注、教师聚合或 reviewed。observed_action 语义仅保存与真实动作名一致的 choice 硬标签，来源由服务器固定。',
  state: '由服务器从当前决策前材料生成；不得加入当前动作、后果、标签或不可见回复。逐题复核须确认输入足以回答问题。',
  export: '仅新版、来源仍有效、逐题 reviewed 且完成决策时点核对的显式 split 可导出；保留实际复核方式，AI 委托复核仅用于功能验证，不等同人工或独立真值。unassigned 不进入训练。旧格式只读候选。',
} as const

const MODEL_SAMPLE_FIELDS = ['decision_id', 'action_name', 'workflow', 'task', 'question_name', 'question', 'target'] as const
const MODEL_SUBMISSION = {
  transport: 'single-question-v1', action: 'datasets/preview',
  required_fields: ['path', 'source_sha256', ...MODEL_SAMPLE_FIELDS],
  run_id: '可省略，由服务器绑定当前固定 Run；显式提供时必须一致。',
  source_path: 'path 使用所选来源文件；decision_id 必须来自该文件的决策分页。',
  question_name: '1–80 位英文、数字、下划线或短横线命名；与 question、target 同级。',
  question: '单个 {type,instructions,criteria?} 对象；choice、noul、score 及 criteria 规则见 types。',
  target: '单个 {label,basis,probabilities?} 对象；不提供 provenance、status 或审核字段。',
  skipped: DECISION_EXTRACTION_CONTRACT.preview.skipped,
  instructions: '每次提交一题，不手写 samples 数组或 questions/targets 命名映射。程序组装公开 v2 格式并沿用来源、决策和标签校验；预览成功自动保存回读，仍为 suggested。仅跳过时提供 path、source_sha256、skipped，不提供单题字段。',
} as const

/** 模型传输合同只替换提交形状；公共数据集合同和存储格式保持不变。 */
export function decisionExtractionModelContract() {
  const { preview: _preview, sample_fields: _fields, questions: _questions, targets: _targets, ...semantics } = DECISION_EXTRACTION_CONTRACT
  return { ...semantics, model_submission: MODEL_SUBMISSION }
}

/** 仅组装传输字段；所有业务判定继续交给 datasets/preview 的当前校验器。 */
export function normalizeDecisionModelSubmission(input: Record<string, any>): Record<string, any> {
  const flat = MODEL_SAMPLE_FIELDS.some(key => Object.hasOwn(input, key))
  if (!flat) return !Object.hasOwn(input, 'samples') && Object.hasOwn(input, 'skipped') ? { ...input, samples: [] } : input
  if (Object.hasOwn(input, 'samples')) error('单题字段与 samples 不能混用')
  exactKeys(input, ['run_id', 'path', 'source_sha256', 'source_identity_sha256', 'skipped', ...MODEL_SAMPLE_FIELDS], 'model_submission')
  for (const key of MODEL_SAMPLE_FIELDS) if (!Object.hasOwn(input, key)) error(`单题提交缺少 ${key}`)
  if (typeof input.question_name !== 'string') error('question_name 必须为问题名称字符串')
  const { decision_id, action_name, workflow, task, question_name, question, target, ...source } = input
  return { ...source, samples: [{ decision_id, action_name, workflow, task, questions: { [question_name]: question }, targets: { [question_name]: target } }] }
}

/** 抽取工具只描述模型需提供的字段；业务校验与服务器生成字段继续由当前合同负责。 */
export function decisionExtractionToolParameters(actions: readonly string[]) {
  const contract = DECISION_EXTRACTION_CONTRACT
  const text = { type: 'string' }
  // 原生 SDK 的 additionalProperties 仅支持布尔值；动态键的值类型仍由现有业务校验器核对。
  const choiceCriteria = { type: 'object', additionalProperties: true, description: '候选键到非空说明字符串的映射。' }
  const question = {
    oneOf: Object.entries(contract.types).map(([type, description]) => ({
      type: 'object', additionalProperties: false, required: ['type', 'instructions', ...(type === 'noul' ? [] : ['criteria'])],
      description, properties: {
        type: { type: 'string', enum: [type] }, instructions: { ...text, description: '依据当前决策前可见材料提出的问题，优先中文。' },
        criteria: type === 'score' ? { type: 'array', items: text }
          : type === 'noul' ? { type: 'object', additionalProperties: false, required: ['false', 'true'], properties: { false: text, true: text } } : choiceCriteria,
      },
    })),
  }
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...actions] },
      input: {
        type: 'object', additionalProperties: false,
        description: `context 使用空对象；research/read-reference 使用 topic；datasets/source、datasets/list 使用固定 run_id。datasets/preview 每次一题，提供 ${MODEL_SUBMISSION.required_fields.join('、')}。${MODEL_SUBMISSION.instructions} ${contract.language}`,
        properties: {
          run_id: { ...text, description: MODEL_SUBMISSION.run_id },
          topic: { type: 'string', enum: ['decision-samples'] },
          path: { ...text, description: MODEL_SUBMISSION.source_path },
          source_sha256: { ...text, description: '逐字使用 datasets/source 返回的来源摘要。' },
          source_identity_sha256: { ...text, description: '完整来源身份摘要，绑定Run清单、inputs.lock及所选文件依赖；所有续读必填，preview亦可原样传回防止来源改绑。' },
          cursor: { type: 'integer', description: 'datasets/source 返回的 next_cursor；首次读取可省略。' },
          limit: { type: 'integer', description: '目录1–20条，决策页1–3条，decision_id分片1–6000字符；通常使用read_input。' },
          content_sha256: { ...text, description: '决策分片正文摘要；按read_input或上一片回执原样续读，不能猜测。' },
          decision_id: { ...text, description: '所选来源分页返回的 decision_id。' },
          action_name: { ...text, description: '同一决策 observed_action.name 的原值。' },
          workflow: { ...text, description: contract.workflow },
          task: { type: 'object', additionalProperties: false, required: Object.keys(contract.task), properties: {
            id: { ...text, description: contract.task.id }, semantics: { type: 'string', enum: [...contract.task.semantics] },
          } },
          question_name: { ...text, description: MODEL_SUBMISSION.question_name },
          question,
          target: { type: 'object', additionalProperties: false, required: ['label', 'basis'], description: `${contract.probabilities}。${contract.provenance}`, properties: {
            label: { oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'integer' }] },
            basis: { ...text, description: '分清决策前证据、推断与不确定性，优先中文。' },
            probabilities: { type: 'object', additionalProperties: true, description: contract.probabilities },
          } },
          skipped: { type: 'array', items: text, description: `${contract.preview.skipped.instructions} 最多 ${contract.preview.skipped.max_items} 项，每项最多 ${contract.preview.skipped.max_item_length} 字符。` },
        },
      },
    },
    required: ['action', 'input'], additionalProperties: false,
  }
}

function error(message: string): never { throw new Error(message) }
function map(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : error('需要 JSON 对象') }
export function decisionText(value: unknown, name: string, max = 6000): string { return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : error(`${name} 为空或过长`) }
function exactKeys(value: Record<string, any>, allowed: string[], name: string) { if (Object.keys(value).some(key => !allowed.includes(key))) error(`${name} 含有输入与目标合同之外的字段`) }
export function validateDecisionInputEvidence(raw: unknown, expected: Partial<DecisionInputEvidenceBinding> = {}): DecisionInputEvidence {
  const value = map(raw)
  const bindings = ['session_id', 'dataset_id', 'record_id', 'run_id', 'path', 'trace_sha256', 'source_bundle_sha256', 'state_sha256'] as const
  exactKeys(value, ['schema_version', ...bindings, 'read_method', 'receipt_refs', 'content_sha256', 'source_identity_sha256'], 'input_evidence')
  if (value.schema_version !== 1 || !['datasets/read', 'datasets/source', 'datasets/source-fragments'].includes(value.read_method)) error('决策输入阅读证据版本或方式无效')
  for (const key of bindings) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim()) error(`input_evidence.${key} 无效`)
    if (expected[key] !== undefined && value[key] !== expected[key]) error(`input_evidence.${key} 与当前输入不一致`)
  }
  for (const key of ['trace_sha256', 'source_bundle_sha256', 'state_sha256', 'content_sha256', 'source_identity_sha256'] as const) {
    if ((bindings as readonly string[]).includes(key) || value[key] !== undefined || value.read_method === 'datasets/source-fragments') {
      if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])) error(`input_evidence.${key} 摘要无效`)
    }
  }
  if (!Array.isArray(value.receipt_refs) || !value.receipt_refs.length) error('决策输入阅读证据缺少实际工具回执')
  const callIds = new Set<string>(), sequences = new Set<number>()
  const receipt_refs = value.receipt_refs.map((raw: unknown) => {
    const ref = map(raw)
    exactKeys(ref, ['call_id', 'call_seq', 'result_seq'], 'input_evidence.receipt_refs')
    if (typeof ref.call_id !== 'string' || !ref.call_id.trim() || !Number.isSafeInteger(ref.call_seq) || ref.call_seq < 0 || !Number.isSafeInteger(ref.result_seq) || ref.result_seq <= ref.call_seq || callIds.has(ref.call_id) || sequences.has(ref.result_seq)) error('决策输入阅读回执定位无效或重复')
    callIds.add(ref.call_id); sequences.add(ref.result_seq)
    return { call_id: ref.call_id, call_seq: ref.call_seq, result_seq: ref.result_seq }
  })
  return { schema_version: 1, ...Object.fromEntries(bindings.map(key => [key, value[key]])) as DecisionInputEvidenceBinding,
    read_method: value.read_method, receipt_refs, ...(value.content_sha256 !== undefined ? { content_sha256: value.content_sha256 } : {}), ...(value.source_identity_sha256 !== undefined ? { source_identity_sha256: value.source_identity_sha256 } : {}) }
}
export function validateDecisionInputQuestion(raw: unknown): DecisionQuestion {
  const value = map(raw), type = value.type
  exactKeys(value, ['type', 'instructions', 'criteria'], 'question')
  if (!['choice', 'noul', 'score'].includes(type)) error('题型必须是 choice、noul 或 score')
  const result: DecisionQuestion = { type, instructions: decisionText(value.instructions, 'instructions') }
  if (type === 'choice') {
    const criteria = map(value.criteria), keys = Object.keys(criteria)
    if (keys.length < 2 || keys.length > 32 || keys.some(key => !key.trim() || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key))) error('choice 至少需要两个有效候选')
    const entries = keys.map(key => [key, decisionText(criteria[key], '候选说明', 2000)] as const)
    if (new Set(entries.map(([, description]) => description)).size !== keys.length) error('候选说明不能重复')
    result.criteria = Object.fromEntries(entries)
  } else if (type === 'noul') {
    if (value.criteria !== undefined) {
      const criteria = map(value.criteria)
      if (Object.keys(criteria).sort().join(',') !== 'false,true') error('noul criteria 只能包含 false 和 true')
      result.criteria = { false: decisionText(criteria.false, 'false 说明'), true: decisionText(criteria.true, 'true 说明') }
    }
  } else {
    if (!Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > 32) error('score 需要有序等级列表')
    const criteria: string[] = value.criteria.map((entry: unknown) => decisionText(entry, '等级说明', 2000))
    if (new Set(criteria).size !== criteria.length) error('score 等级说明不能重复')
    result.criteria = criteria
  }
  return result
}
export function validateDecisionTask(raw: unknown): DecisionTask {
  const value = map(raw)
  exactKeys(value, ['id', 'semantics'], 'task')
  if (!['recommended_decision', 'observed_action'].includes(value.semantics)) error('task.semantics 必须明确区分推荐决策与观察动作')
  return { id: decisionText(value.id, 'task.id', 200), semantics: value.semantics }
}
export function validateDecisionLabel(question: DecisionQuestion, raw: unknown): { label: string | number | boolean; probabilities?: Record<string, number> } {
  const value = map(raw), label = value.label
  let keys: string[]
  if (question.type === 'choice') { keys = Object.keys(question.criteria!); if (typeof label !== 'string' || !Object.hasOwn(question.criteria!, label)) error('label 必须精确匹配候选键') }
  else if (question.type === 'noul') { keys = ['false', 'true']; if (typeof label !== 'boolean') error('noul label 必须是布尔值') }
  else { keys = (question.criteria as string[]).map((_, index) => String(index)); if (!Number.isInteger(label) || label < 0 || label >= keys.length) error('score label 超出等级范围') }
  const result = { label } as { label: string | number | boolean; probabilities?: Record<string, number> }
  if (value.probabilities !== undefined) {
    const probabilities = map(value.probabilities)
    if (Object.keys(probabilities).sort().join('\u0000') !== [...keys].sort().join('\u0000')) error('probabilities 必须精确覆盖全部候选或等级')
    const values = keys.map(key => probabilities[key])
    if (values.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) || Math.abs(values.reduce((sum, item) => sum + item, 0) - 1) > 1e-5) error('probabilities 必须为有限的 0–1 概率且总和为 1')
    if (probabilities[String(label)] < Math.max(...values) - 1e-9) error('label 必须位于最大概率候选集合')
    result.probabilities = Object.fromEntries(keys.map(key => [key, probabilities[key]]))
  }
  return result
}
export function validateDecisionQuestions(raw: unknown): Record<string, DecisionQuestion> {
  const value = map(raw), keys = Object.keys(value)
  if (!keys.length || keys.length > 32 || keys.some(key => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) error('questions 需要 1–32 个有效命名问题')
  return Object.fromEntries(keys.map(key => [key, validateDecisionInputQuestion(value[key])]))
}
export function validateDecisionTargets(questions: Record<string, DecisionQuestion>, raw: unknown): Record<string, DecisionTarget> {
  const value = map(raw), keys = Object.keys(questions)
  if (Object.keys(value).sort().join('\u0000') !== [...keys].sort().join('\u0000')) error('questions 与 targets 的命名键必须精确对应')
  return Object.fromEntries(keys.map(key => {
    const target = map(value[key]), provenance = map(target.provenance)
    if (!['model_suggestion', 'human_annotation', 'ai_annotation', 'observed_action'].includes(provenance.kind)) error('标签来源必须是可核对的模型建议、人工标注、AI 标注或观察动作；本版本不支持教师聚合来源')
    if (!['suggested', 'reviewed', 'rejected'].includes(target.status) || typeof target.decision_time_reviewed !== 'boolean') error('逐题复核状态或决策时点声明无效')
    if (target.status === 'reviewed' && target.decision_time_reviewed !== true) error('请先核对该题与当前决策及决策前材料一致')
    let review: DecisionReview | undefined
    if (target.review != null) {
      const value = map(target.review), model = map(value.model)
      exactKeys(value, ['kind', 'session_id', 'model', 'reviewed_at', 'purpose', 'input_evidence'], 'review')
      if (value.kind !== 'ai_delegated' || value.purpose !== 'functional_validation' || !['reviewed', 'rejected'].includes(target.status)
        || typeof value.reviewed_at !== 'string' || !Number.isFinite(Date.parse(value.reviewed_at)) || new Date(value.reviewed_at).toISOString() !== value.reviewed_at
        || target.status === 'reviewed' && target.reviewed_at !== value.reviewed_at) error('AI 委托复核身份、用途、时间或状态无效')
      review = { kind: value.kind, session_id: decisionText(value.session_id, 'review.session_id', 200),
        model: { ...model, provider: decisionText(model.provider, 'review.model.provider', 200), model: decisionText(model.model, 'review.model.model', 200) },
        reviewed_at: value.reviewed_at, purpose: value.purpose, ...(value.input_evidence !== undefined ? { input_evidence: validateDecisionInputEvidence(value.input_evidence, { session_id: value.session_id }) } : {}) }
    }
    return [key, { ...validateDecisionLabel(questions[key]!, target), provenance, basis: decisionText(target.basis, 'basis'), status: target.status, decision_time_reviewed: target.status === 'reviewed' && target.decision_time_reviewed === true, ...(target.reviewed_at !== undefined ? { reviewed_at: target.reviewed_at } : {}), ...(review ? { review } : {}) }]
  }))
}

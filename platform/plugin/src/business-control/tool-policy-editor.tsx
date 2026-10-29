import { useLayoutEffect, useState } from 'react'
import type { AgentToolPolicy, AgentToolRule, OperationKind, ToolPolicyEffect } from './contracts.ts'

export const toolKinds: { value: OperationKind; label: string; description: string }[] = [
  { value: 'read', label: '查询信息', description: '查询工具中的业务数据' },
  { value: 'write', label: '修改数据', description: '新增、修改或删除业务数据' },
  { value: 'resource', label: '读取资源', description: '读取 MCP 服务提供的资源' },
  { value: 'publish', label: '发布结果', description: '发布报告与业务结果' },
]
export const effectLabels: Record<ToolPolicyEffect, string> = { allow: '允许（基础范围内）', deny: '禁止', confirm: '需要确认' }
export type PolicyOperation = { id: string; label: string; kind?: OperationKind }

/** 允许尚未填完的数组继续编辑；正式完整性由保存校验负责。 */
export function editableToolPolicy(value: unknown): value is AgentToolPolicy {
  if (!value || typeof value !== 'object') return false
  const policy = value as AgentToolPolicy
  return typeof policy.serverId === 'string' && Array.isArray(policy.rules) && policy.rules.every(rule => rule && typeof rule === 'object'
    && rule.when && typeof rule.when === 'object' && !Array.isArray(rule.when)
    && [rule.operationIds, rule.kinds, rule.when.riskLevels, rule.when.scenarioIds, rule.when.operationTags].every(value => value === undefined || Array.isArray(value) && value.every(item => typeof item === 'string')))
}

export function policyInputError(policy: AgentToolPolicy): { field: string; message: string } | null {
  if (!['allow', 'deny', 'confirm'].includes(policy.defaultEffect)) return { field: 'default', message: '请选择服务的默认处理方式。' }
  for (const [index, rule] of policy.rules.entries()) {
    const invalid = (value?: string[]) => value !== undefined && (!value.length || value.some(item => !item.trim()))
    if (invalid(rule.operationIds)) return { field: `rule-${index}-tools`, message: '指定工具时，请至少选择一个工具。' }
    if (invalid(rule.kinds) || rule.kinds?.some(kind => !toolKinds.some(item => item.value === kind))) return { field: `rule-${index}-kinds`, message: '请选择至少一种有效的工具操作类型。' }
    if (invalid(rule.when.riskLevels) || rule.when.riskLevels?.some(level => !['low', 'high', 'unknown'].includes(level))) return { field: `rule-${index}-risk`, message: '请选择有效的风险状态。' }
    if (invalid(rule.when.scenarioIds)) return { field: `rule-${index}-scenarios`, message: '场景名称或代码不能包含空项。' }
    if (invalid(rule.when.operationTags)) return { field: `rule-${index}-tags`, message: '操作标签不能包含空项。' }
    if (!['allow', 'deny', 'confirm'].includes(rule.effect)) return { field: `rule-${index}-effect`, message: '请选择条件匹配后的处理方式。' }
  }
  return null
}

export function policyRangeWarnings(policy: AgentToolPolicy, allowedKinds: readonly string[], operations: readonly PolicyOperation[]): string[] {
  if (allowedKinds.includes('*')) return []
  const kinds = new Set<OperationKind>()
  for (const rule of policy.rules) {
    if (rule.effect === 'deny') continue
    for (const kind of rule.kinds ?? []) if (!allowedKinds.includes(kind)) kinds.add(kind)
    for (const id of rule.operationIds ?? []) { const kind = operations.find(item => item.id === id)?.kind; if (kind && !allowedKinds.includes(kind)) kinds.add(kind) }
  }
  return [...kinds].map(kind => `${toolKinds.find(item => item.value === kind)?.label || kind}超出当前智能体的通用范围，规则不能授予这类操作。`)
}

const splitCodes = (text: string) => text ? text.split(/[,，]/).map(value => value.trim()) : undefined
const toggle = <T extends string>(values: readonly T[] | undefined, value: T, checked: boolean): T[] | undefined => {
  const result = checked ? [...new Set([...(values ?? []), value])] : (values ?? []).filter(item => item !== value)
  return result.length ? result : undefined
}

export function toolRuleSummary(rule: AgentToolRule, operations: readonly PolicyOperation[]): string {
  const parts: string[] = []
  if (rule.when.riskLevels) parts.push(`风险为${rule.when.riskLevels.map(level => ({ low: '低风险', high: '高风险', unknown: '第三方明确未知' })[level]).join('或') || '待选择'}`)
  if (rule.when.scenarioIds) parts.push(`场景为${rule.when.scenarioIds.join('或') || '待填写'}`)
  if (rule.when.operationTags) parts.push(`操作属于${rule.when.operationTags.map(tag => (tag === 'sensitive' ? '敏感' : tag === 'dangerous' ? '危险' : tag)).join('或') || '待选择'}`)
  const tools = rule.operationIds ? `工具${rule.operationIds.map(id => operations.find(item => item.id === id)?.label || id).join('、') || '待选择'}` : ''
  const kinds = rule.kinds ? rule.kinds.map(kind => toolKinds.find(item => item.value === kind)?.label || kind).join('、') || '操作类型待选择' : ''
  return `当${parts.join('，且') || '任何情况'} → ${[tools, kinds].filter(Boolean).join('，且') || '所有工具操作'} → ${effectLabels[rule.effect] || '处理方式待选择'}`
}

export function ToolPolicyEditor({ serverId, value, fieldPrefix, operations, allowedKinds, automaticRiskEnabled, onChange, onAdjustBase, focusRequest }: {
  serverId: string; value?: AgentToolPolicy; fieldPrefix: string; operations: readonly PolicyOperation[]; allowedKinds: readonly string[]
  automaticRiskEnabled: boolean; onChange(value: AgentToolPolicy | undefined): void; onAdjustBase(): void; focusRequest?: { field: string; token: number }
}) {
  const [editingIndex, setEditingIndex] = useState(0)
  const [advanced, setAdvanced] = useState(false)
  useLayoutEffect(() => {
    const matched = focusRequest?.field.match(/-rule-(\d+)-/)
    setEditingIndex(matched ? Number(matched[1]) : 0); setAdvanced(false)
  }, [serverId, focusRequest?.token])
  const change = (next: Partial<AgentToolPolicy>) => onChange({ serverId, defaultEffect: 'allow', rules: [], ...value, ...next })
  const changeRule = (index: number, next: Partial<AgentToolRule>) => change({ rules: (value?.rules ?? []).map((rule, at) => at === index ? { ...rule, ...next } : rule) })
  const warnings = value ? policyRangeWarnings(value, allowedKinds, operations) : []
  return <section className="harness-gateway-tool-policy" data-gateway-field={fieldPrefix} tabIndex={-1} aria-label="当前 MCP 服务的操作规则">
    <label className="harness-gateway-settings-field">未命中条件时<select data-gateway-field={`${fieldPrefix}-default`} value={value?.defaultEffect ?? 'legacy'} onChange={event => event.target.value === 'legacy' ? onChange(undefined) : change({ defaultEffect: event.target.value as ToolPolicyEffect })}>
      {!value && <option value="legacy">沿用已有基础权限</option>}<option value="allow">按基础权限允许</option><option value="deny">禁止</option><option value="confirm">需要确认</option>
    </select></label>
    {!automaticRiskEnabled && <p className="harness-gateway-description">自动评估已关闭：依赖风险、业务场景或操作标签的条件暂不执行；默认处理和仅按工具或操作类型的规则仍生效。</p>}
    {warnings.length > 0 && <div className="harness-gateway-policy-warning" role="status">{warnings.map(text => <p key={text}>{text}</p>)}<button type="button" onClick={onAdjustBase}>调整通用范围</button></div>}
    <div className="harness-gateway-policy-rule-heading"><h4>条件规则</h4><button type="button" onClick={() => { change({ rules: [...(value?.rules ?? []), { kinds: [], when: { riskLevels: [] }, effect: 'deny' }] }); setEditingIndex(value?.rules.length ?? 0); setAdvanced(false) }}>添加条件规则</button></div>
    {!value?.rules.length && <p className="harness-gateway-description">尚无条件规则，使用上方默认处理。</p>}
    <ul className="harness-gateway-rule-list">{(value?.rules ?? []).map((rule, index) => <li key={index}><button type="button" aria-pressed={index === Math.min(editingIndex, value!.rules.length - 1)} title={toolRuleSummary(rule, operations)} onClick={() => { setEditingIndex(index); setAdvanced(false) }}>{toolRuleSummary(rule, operations)}</button><button type="button" aria-label={`移除规则 ${index + 1}`} onClick={() => { change({ rules: value!.rules.filter((_, at) => at !== index) }); setEditingIndex(Math.max(0, index < editingIndex ? editingIndex - 1 : Math.min(editingIndex, value!.rules.length - 2))) }}>移除</button></li>)}</ul>
    {(() => {
      const index = Math.min(editingIndex, (value?.rules.length ?? 0) - 1), rule = value?.rules[index]
      if (!rule) return null

      const mode = rule.operationIds !== undefined && rule.kinds !== undefined ? 'combined' : rule.operationIds !== undefined ? 'tools' : rule.kinds !== undefined ? 'kinds' : 'all'
      const conditions = [rule.when.riskLevels !== undefined ? 'risk' : '', rule.when.scenarioIds !== undefined ? 'scenario' : '', rule.when.operationTags !== undefined ? 'tags' : ''].filter(Boolean)
      const condition = advanced || conditions.length > 1 ? 'combined' : conditions[0] || 'any'
      const when = (next: Partial<AgentToolRule['when']>) => { if (condition === 'combined') setAdvanced(true); changeRule(index, { when: { ...rule.when, ...next } }) }
      const selectCondition = (next: string) => {
        if (next === 'combined') { setAdvanced(true); return }
        setAdvanced(false); changeRule(index, { when: next === 'risk' ? { riskLevels: rule.when.riskLevels ?? [] } : next === 'scenario' ? { scenarioIds: rule.when.scenarioIds ?? [] } : next === 'tags' ? { operationTags: rule.when.operationTags ?? [] } : {} })
      }
      const candidates = [...operations, ...(rule.operationIds ?? []).filter(id => !operations.some(item => item.id === id)).map(id => ({ id, label: `${id}（原规则保留）` }))]
      return <article className="harness-gateway-policy-rule"><header><strong>编辑规则 {index + 1}</strong></header><label className="harness-gateway-settings-field">适用情况<select aria-label={`规则 ${index + 1} 适用情况`} value={condition} onChange={event => selectCondition(event.target.value)}><option value="risk">风险状态</option><option value="scenario">业务场景</option><option value="tags">敏感或危险操作</option><option value="any">任何情况</option><option value="combined">组合条件（高级）</option></select></label>
        <div className="harness-gateway-rule-fields">{condition === 'any' && <p className="harness-gateway-description">不附加第三方条件，只按下方工具或操作类型匹配。</p>}{(condition === 'risk' || condition === 'combined') && <fieldset className="harness-gateway-rule-condition" data-gateway-field={`${fieldPrefix}-rule-${index}-risk`} tabIndex={-1}><legend>风险状态</legend><div className="harness-gateway-choice-list">{([['low', '低风险'], ['high', '高风险'], ['unknown', '第三方明确为未知']] as const).map(([level, label]) => <label key={level}><input type="checkbox" checked={rule.when.riskLevels?.includes(level) ?? false} onChange={event => when({ riskLevels: toggle(rule.when.riskLevels, level, event.target.checked) ?? (condition === 'combined' ? undefined : []) })}/>{label}</label>)}</div><small>缺少或过期的证据不等于“未知”。</small></fieldset>}
        {(condition === 'scenario' || condition === 'combined') && <label>业务场景<input data-gateway-field={`${fieldPrefix}-rule-${index}-scenarios`} value={rule.when.scenarioIds?.join(', ') ?? ''} onChange={event => when({ scenarioIds: splitCodes(event.target.value) ?? (condition === 'combined' ? undefined : []) })} placeholder="与第三方约定的场景名称或代码，多个用逗号分隔"/><small>只有第三方返回对应场景证据时才匹配。</small></label>}
        {(condition === 'tags' || condition === 'combined') && <fieldset className="harness-gateway-rule-condition"><legend>操作性质（第三方认定）</legend><div className="harness-gateway-choice-list">{[['sensitive', '敏感操作'], ['dangerous', '危险操作']].map(([tag, label]) => <label key={tag}><input type="checkbox" checked={rule.when.operationTags?.includes(tag) ?? false} onChange={event => when({ operationTags: toggle(rule.when.operationTags, tag, event.target.checked) ?? (condition === 'combined' ? undefined : []) })}/>{label}</label>)}</div>{(condition === 'combined' || rule.when.operationTags?.some(tag => !['sensitive', 'dangerous'].includes(tag))) && <label>其他约定标签<input data-gateway-field={`${fieldPrefix}-rule-${index}-tags`} value={rule.when.operationTags?.filter(tag => !['sensitive', 'dangerous'].includes(tag)).join(', ') ?? ''} onChange={event => { const tags = [...(rule.when.operationTags ?? []).filter(tag => ['sensitive', 'dangerous'].includes(tag)), ...(splitCodes(event.target.value) ?? [])]; when({ operationTags: tags.length ? tags : condition === 'combined' ? undefined : [] }) }}/></label>}</fieldset>}
        <div className="harness-gateway-rule-decision">        <label>适用的操作<select value={mode} onChange={event => changeRule(index, { operationIds: event.target.value === 'tools' ? [] : undefined, kinds: event.target.value === 'kinds' ? [] : undefined })}><option value="all">所有工具操作</option><option value="kinds">按操作类型</option><option value="tools">指定工具</option>{mode === 'combined' && <option value="combined">工具与类型同时匹配（原规则）</option>}</select></label>        <label>匹配后处理<select data-gateway-field={`${fieldPrefix}-rule-${index}-effect`} value={rule.effect} onChange={event => changeRule(index, { effect: event.target.value as ToolPolicyEffect })}>{Object.entries(effectLabels).map(([effect, label]) => <option key={effect} value={effect}>{label}</option>)}</select></label></div>
        {(mode === 'kinds' || mode === 'combined') && <fieldset className="harness-gateway-rule-condition" data-gateway-field={`${fieldPrefix}-rule-${index}-kinds`} tabIndex={-1}><legend>操作类型</legend><div className="harness-gateway-choice-list">{toolKinds.map(kind => <label key={kind.value} title={kind.description}><input type="checkbox" checked={rule.kinds?.includes(kind.value) ?? false} onChange={event => { const kinds = toggle(rule.kinds, kind.value, event.target.checked); changeRule(index, { kinds: kinds ?? [] }) }}/>{kind.label}</label>)}</div></fieldset>}
        {(mode === 'tools' || mode === 'combined') && <fieldset className="harness-gateway-rule-condition" data-gateway-field={`${fieldPrefix}-rule-${index}-tools`} tabIndex={-1}><legend>指定工具</legend>{candidates.length ? <div className="harness-gateway-choice-list">{candidates.map(item => <label key={item.id}><input type="checkbox" checked={rule.operationIds?.includes(item.id) ?? false} onChange={event => changeRule(index, { operationIds: toggle(rule.operationIds, item.id, event.target.checked) ?? [] })}/>{item.label}</label>)}</div> : <p>当前服务没有可用的操作定义；可先选择操作类型，或补充“操作定义”。</p>}</fieldset>}
</div>
      </article>
    })()}
    <p className="harness-gateway-description">同一条件内任选一项，不同条件需同时满足。多条规则冲突时先禁止、再需确认、最后允许；风险、场景和操作性质均来自第三方，不由平台自行推断。</p>
    {value && <button type="button" className="harness-gateway-text-button" onClick={() => onChange(undefined)}>移除此服务策略，恢复沿用基础权限</button>}
  </section>
}

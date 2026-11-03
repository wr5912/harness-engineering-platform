type Schema = Record<string, any>
type Path = (string | number)[]
type Draft = { mode?: 'form' | 'json'; fields?: Record<string, { text: string; basis: string; error?: string }> }
const absent = Symbol('未填写')
const has = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const schemaType = (schema: Schema) => schema.type ?? (schema.properties ? 'object' : undefined)
const complex = (schema: Schema) => ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if'].some(key => has(schema, key))
const clone = (value: any) => JSON.parse(JSON.stringify(value))
const basis = (value: any) => value === undefined ? '<未填写>' : JSON.stringify(value)
const same = (left: any, right: any): boolean => left === right || Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((item, i) => same(item, right[i]))
  || object(left) && object(right) && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => has(right, key) && same(left[key], right[key]))

function check(schema: Schema, value: any, name: string, errors: string[], depth = 0) {
  if (depth > 20 || !object(schema)) return
  const type = schemaType(schema)
  const types = Array.isArray(type) ? type : type ? [type] : []
  const matches = (kind: string) => kind === 'null' ? value === null : kind === 'array' ? Array.isArray(value)
    : kind === 'object' ? object(value) : kind === 'integer' ? Number.isInteger(value)
      : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind
  if (types.length && !(value === null && schema.nullable) && !types.some(matches)) {
    errors.push(`${name}：需要${types.join(' / ')}类型`); return
  }
  if (has(schema, 'const') && !same(value, schema.const)) errors.push(`${name}：必须使用声明的固定值`)
  if (Array.isArray(schema.enum) && !schema.enum.some((item: any) => same(item, value))) errors.push(`${name}：请选择允许的取值`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) errors.push(`${name}：至少${schema.minLength}个字符`)
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) errors.push(`${name}：最多${schema.maxLength}个字符`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${name}：不能小于${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${name}：不能大于${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${name}：必须大于${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${name}：必须小于${schema.exclusiveMaximum}`)
  }
  if (object(value)) {
    for (const key of schema.required ?? []) if (!has(value, key)) errors.push(`${name === '参数' ? '' : `${name}.`}${key}：必填`)
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key]
      if (child) check(child, item, name === '参数' ? key : `${name}.${key}`, errors, depth + 1)
      else if (schema.additionalProperties === false) errors.push(`${name}.${key}：未定义的字段`)
      else if (object(schema.additionalProperties)) check(schema.additionalProperties, item, `${name}.${key}`, errors, depth + 1)
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${name}：至少${schema.minItems}项`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${name}：最多${schema.maxItems}项`)
    if (object(schema.items)) value.forEach((item, i) => check(schema.items, item, `${name}[${i + 1}]`, errors, depth + 1))
  }
}

function seed(schema: Schema, required = false, depth = 0): any {
  if (!object(schema) || depth > 20) return absent
  const candidates = [has(schema, 'default') ? schema.default : absent, has(schema, 'const') ? schema.const : absent,
    ...(required ? [...(Array.isArray(schema.examples) ? schema.examples : []), ...(has(schema, 'example') ? [schema.example] : [])] : [])]
  for (const candidate of candidates) {
    if (candidate === absent || candidate === undefined) continue
    const errors: string[] = []
    check(schema, candidate, '参数', errors)
    if (!errors.length) return clone(candidate)
  }
  if (required && !complex(schema) && schemaType(schema) === 'object') {
    const value: Record<string, any> = {}
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      const initial = seed(child as Schema, (schema.required ?? []).includes(name), depth + 1)
      if (initial !== absent) Object.defineProperty(value, name, { value: initial, enumerable: true, configurable: true, writable: true })
    }
    if (Object.keys(value).length) return value
  }
  return absent
}

/** 自动准备已声明的值；没有依据的业务输入留给用户填写。 */
export function initialArguments(schema: Schema = {}): string {
  const value = seed(schema, true)
  return JSON.stringify(object(value) ? value : {}, null, 2)
}

export function parameterErrors(schema: Schema = {}, text: string): string[] {
  let value: any
  try { value = JSON.parse(text) } catch { return ['参数 JSON 无法解析，请检查括号、引号和逗号。'] }
  if (!object(value)) return ['调用参数必须是 JSON 对象。']
  const errors: string[] = []
  check(schema, value, '参数', errors)
  return errors
}

/** 只提示简单模板变量，不推定必填要求；实际展开继续由现有调用链处理。 */
export function templateParameterSchema(uriTemplate: string): Schema {
  const properties: Record<string, Schema> = {}
  const expressions = uriTemplate.match(/\{[^{}]*\}/g) ?? []
  const remainder = uriTemplate.replace(/\{[^{}]*\}/g, '')
  if (!expressions.length || /[{}]/.test(remainder) || expressions.some(expression => !/^\{[+#./?&]?[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*\}$/.test(expression))) {
    return { type: 'object', description: '此模板不在当前服务支持的表达式范围内；可使用 JSON 填写，具体要求由模板和服务核对。' }
  }
  for (const expression of expressions) {
    const inside = expression.slice(1, -1)
    for (const name of inside.replace(/^[+#./?&]/, '').split(',')) {
      if (has(properties, name)) return { type: 'object', description: '此模板包含重复变量；请使用 JSON 核对参数并由服务检查模板。' }
      Object.defineProperty(properties, name, { value: { description: '模板变量使用 JSON 填写，例如 "asset-1"、10 或 ["x", "y"]。类型与必填要求由模板和服务核对。' }, enumerable: true })
    }
  }
  return { type: 'object', properties }
}

const labels: Record<string, string> = { string: '文本', number: '数值', integer: '整数', boolean: '布尔', object: '对象', array: '数组', null: '空值' }
const typeLabel = (schema: Schema) => (Array.isArray(schemaType(schema)) ? schemaType(schema) : [schemaType(schema)]).map((type: string) => labels[type] ?? type ?? '任意 JSON').join(' / ')
const constraints = (schema: Schema) => [
  typeof schema.minimum === 'number' ? `最小值 ${schema.minimum}` : '', typeof schema.maximum === 'number' ? `最大值 ${schema.maximum}` : '',
  typeof schema.exclusiveMinimum === 'number' ? `大于 ${schema.exclusiveMinimum}` : '', typeof schema.exclusiveMaximum === 'number' ? `小于 ${schema.exclusiveMaximum}` : '',
  typeof schema.minLength === 'number' ? `至少 ${schema.minLength} 个字符` : '', typeof schema.maxLength === 'number' ? `最多 ${schema.maxLength} 个字符` : '',
  typeof schema.minItems === 'number' ? `至少 ${schema.minItems} 项` : '', typeof schema.maxItems === 'number' ? `最多 ${schema.maxItems} 项` : '',
].filter(Boolean).join(' · ')
const at = (value: any, path: Path) => path.reduce((current, key) => current != null && has(current, String(key)) ? current[key] : undefined, value)
function changed(value: any, path: Path, next: any) {
  const result = clone(value)
  let current = result
  path.slice(0, -1).forEach((key, index) => {
    if (!has(current, String(key)) || !object(current[key]) && !Array.isArray(current[key])) Object.defineProperty(current, key, { value: typeof path[index + 1] === 'number' ? [] : {}, enumerable: true, configurable: true, writable: true })
    current = current[key]
  })
  const key = path.at(-1)!
  if (next === absent) delete current[key]
  else Object.defineProperty(current, key, { value: next, enumerable: true, configurable: true, writable: true })
  return result
}

/** React 由宿主注入，平台提取器与原生 MCP 页面共用同一编辑器。 */
export function createParameterEditor(React: any) {
  return function ParameterEditor({ schema = {}, value, onChange, label = '调用参数', disabled = false,
    draftState, onDraftStateChange, onValidityChange }: { schema?: Schema; value: string; onChange: (value: string) => void; label?: string; disabled?: boolean;
      draftState?: Draft; onDraftStateChange?: (value: Draft) => void; onValidityChange?: (valid: boolean) => void }) {
    const [localDraft, setLocalDraft] = React.useState({} as Draft)
    const [notice, setNotice] = React.useState('')
    const draft: Draft = draftState ?? localDraft
    const setDraft = (next: Draft) => { if (onDraftStateChange) onDraftStateChange(next); else setLocalDraft(next) }
    let parsed: Record<string, any> | undefined
    try { const data = JSON.parse(value); if (object(data)) parsed = data } catch { /* 原文保留在 JSON 编辑区。 */ }
    const fields = draft.fields ?? {}
    const activeErrors = Object.entries(fields).filter(([key, item]) => item.basis === basis(at(parsed, JSON.parse(key))) && item.error).map(([, item]) => item.error!)
    React.useEffect(() => { onValidityChange?.(!!parsed && !activeErrors.length) }, [value, draft, onValidityChange])
    const setField = (path: Path, next: any, raw?: { text: string; error?: string }) => {
      const key = JSON.stringify(path), nextFields = { ...fields }
      if (raw) nextFields[key] = { ...raw, basis: basis(next === absent ? undefined : next) }
      else delete nextFields[key]
      setDraft({ ...draft, fields: nextFields }); setNotice('')
      if (parsed) onChange(JSON.stringify(changed(parsed, path, next), null, 2))
    }
    const editRaw = (path: Path, text: string) => {
      try { setField(path, JSON.parse(text)) }
      catch {
        setDraft({ ...draft, fields: { ...fields, [JSON.stringify(path)]: { text, basis: basis(at(parsed, path)), error: `${path.join('.')}：JSON 无法解析，请修正后再调用。` } } })
      }
    }
    const showForm = () => {
      if (!parsed) { setNotice('请先修正参数 JSON，原文已保留。'); return }
      if (activeErrors.length) { setNotice('请先修正当前字段的输入，原文已保留。'); return }
      setDraft({ ...draft, mode: 'form' }); setNotice('')
    }
    const showJson = () => {
      if (activeErrors.length) { setNotice('请先修正当前字段的输入，原文已保留。'); return }
      setDraft({ mode: 'json' }); setNotice('')
    }
    const reset = () => {
      const initial = initialArguments(schema)
      if ((value !== initial || activeErrors.length) && !window.confirm('恢复服务声明的默认值和必填示例？当前参数输入将被替换。')) return
      setDraft({ mode: draft.mode }); setNotice(''); onChange(initial)
    }
    const rawInput = (path: Path, field: Schema, present: any) => {
      const cached = fields[JSON.stringify(path)]
      const text = cached?.basis === basis(present) ? cached.text : present === undefined ? '' : JSON.stringify(present, null, 2)
      return <><textarea className="mcp-parameter-raw" aria-label={`${path.join('.')} JSON`} disabled={disabled} rows={4} spellCheck={false} value={text}
        onChange={(event: any) => editRaw(path, event.target.value)} />
        <small className="mcp-parameter-hint">{complex(field) ? '此字段包含复杂定义，使用 JSON 填写；完整约束由服务核对。' : '使用 JSON 填写此字段。'}</small>
        {cached?.basis === basis(present) && cached.error && <p className="mcp-parameter-error" role="alert">{cached.error}</p>}</>
    }
    const renderField = (name: string, field: Schema, path: Path, required: boolean, depth = 0): any => {
      const present = at(parsed, path), isSet = present !== undefined, type = schemaType(field)
      const simpleType = Array.isArray(type) ? type.filter((item: string) => item !== 'null')[0] : type
      const canForm = !complex(field) && depth < 8 && (!Array.isArray(type) || type.filter((item: string) => item !== 'null').length === 1)
      const title = field.title && field.title !== name ? `${field.title} · ${name}` : name
      const key = JSON.stringify(path), cached = fields[key]
      const source = has(field, 'default') ? `服务默认值：${JSON.stringify(field.default)}` : has(field, 'const') ? `固定值：${JSON.stringify(field.const)}`
        : required && (field.examples?.length || has(field, 'example')) ? `示例（可修改）：${JSON.stringify(field.examples?.[0] ?? field.example)}` : ''
      let control
      if (canForm && Array.isArray(field.enum)) control = <select aria-label={path.join('.')} disabled={disabled} value={isSet ? JSON.stringify(present) : ''}
        onChange={(event: any) => setField(path, event.target.value === '' ? absent : JSON.parse(event.target.value))}>
        <option value="">{required ? '请选择' : '未设置'}</option>{field.enum.map((item: any) => <option key={JSON.stringify(item)} value={JSON.stringify(item)}>{typeof item === 'string' ? item : JSON.stringify(item)}</option>)}</select>
      else if (canForm && simpleType === 'object') control = <details className="mcp-parameter-object" open={required || isSet}>
        <summary>{isSet ? '编辑子字段' : '展开填写子字段'}</summary>
        <div className="mcp-parameter-fields">{Object.entries(field.properties ?? {}).map(([child, definition]) => renderField(child, definition as Schema, [...path, child], (field.required ?? []).includes(child), depth + 1))}
          {Object.keys(present ?? {}).filter(child => !has(field.properties ?? {}, child)).map(child => renderField(child, object(field.additionalProperties) ? field.additionalProperties : {}, [...path, child], false, depth + 1))}
          {!Object.keys(field.properties ?? {}).length && rawInput(path, field, present)}
          {!required && isSet && <button type="button" disabled={disabled || !!activeErrors.length} onClick={() => setField(path, absent)}>移除此对象</button>}</div>
      </details>
      else if (canForm && simpleType === 'array' && object(field.items)) control = <div className="mcp-parameter-array">
        {Array.isArray(present) ? present.map((item, index) => <div className="mcp-parameter-item" key={`${present.length}:${index}`}>
          {renderField(`第 ${index + 1} 项`, field.items, [...path, index], true, depth + 1)}
          <button type="button" aria-label={`删除 ${path.join('.')} 第 ${index + 1} 项`} disabled={disabled || !!activeErrors.length}
            onClick={() => setField(path, present.filter((_: any, position: number) => position !== index))}>删除</button></div>) : null}
        <button type="button" disabled={disabled || !!activeErrors.length || typeof field.maxItems === 'number' && (present?.length ?? 0) >= field.maxItems}
          onClick={() => { const initial = seed(field.items, true); setField(path, [...(Array.isArray(present) ? present : []), initial !== absent ? initial : schemaType(field.items) === 'object' ? {} : schemaType(field.items) === 'array' ? [] : schemaType(field.items) === 'string' ? '' : null]) }}>添加条目</button>
        {!required && isSet && <button type="button" disabled={disabled || !!activeErrors.length} onClick={() => setField(path, absent)}>移除此数组</button>}
      </div>
      else if (canForm && simpleType === 'boolean') control = <select aria-label={path.join('.')} disabled={disabled} value={isSet ? JSON.stringify(present) : ''}
        onChange={(event: any) => setField(path, event.target.value === '' ? absent : JSON.parse(event.target.value))}>
        <option value="">{required ? '请选择' : '未设置'}</option><option value="true">是（true）</option><option value="false">否（false）</option>
        {(field.nullable || Array.isArray(type) && type.includes('null')) && <option value="null">空值（null）</option>}</select>
      else if (canForm && ['string', 'number', 'integer'].includes(simpleType)) control = <input aria-label={path.join('.')} type="text" inputMode={simpleType === 'string' ? undefined : 'decimal'} disabled={disabled}
        placeholder={required ? '请填写' : '未设置，不提交此字段'} value={cached?.basis === basis(present) ? cached.text : isSet ? String(present) : ''}
        onChange={(event: any) => {
          const text = event.target.value
          if (!text) { setField(path, absent); return }
          if (simpleType === 'string') { setField(path, text); return }
          const number = Number(text)
          if (text.trim() && Number.isFinite(number)) setField(path, number, { text })
          else setDraft({ ...draft, fields: { ...fields, [key]: { text, basis: basis(present), error: `${path.join('.')}：请填写有效数值。` } } })
        }} />
      else control = rawInput(path, field, present)
      return <div className="mcp-parameter-field" key={key}>
        <div className="mcp-parameter-label"><strong>{title}{required && <span aria-label="必填"> *</span>}</strong><small className="mcp-parameter-meta">{typeLabel(field)} · {required ? '必填' : '可选'}</small></div>
        {field.description && <p className="mcp-parameter-description">{field.description}</p>}{control}
        {source && <small className="mcp-parameter-hint">{source}</small>}
        {constraints(field) && <small className="mcp-parameter-hint">{constraints(field)}</small>}
        {present === null && <small className="mcp-parameter-hint">当前为 JSON 空值 null。</small>}
        {canForm && ['number', 'integer'].includes(simpleType) && cached?.basis === basis(present) && cached.error && <p className="mcp-parameter-error" role="alert">{cached.error}</p>}
        {!required && isSet && !['object', 'array'].includes(simpleType) && <button type="button" className="mcp-parameter-unset" disabled={disabled} onClick={() => setField(path, absent)}>不提交此字段</button>}
      </div>
    }
    const jsonOnly = complex(schema) || !has(schema, 'properties') && schema.additionalProperties !== false
    const jsonMode = draft.mode === 'json' || !parsed || jsonOnly
    const errors = parameterErrors(schema, value).filter(error => jsonMode || !error.endsWith('：必填'))
    return <div className="mcp-parameter-editor">
      <div className="mcp-parameter-modes" role="group" aria-label={`${label}编辑方式`}>
        <button type="button" aria-pressed={!jsonMode} disabled={disabled || jsonOnly} onClick={showForm}>表单填写</button>
        <button type="button" aria-pressed={jsonMode} disabled={disabled} onClick={showJson}>JSON 编辑</button>
      </div>
      {schema.description && <p className="mcp-parameter-hint">{schema.description}</p>}
      {notice && <p className="mcp-parameter-error" role="alert">{notice}</p>}
      {!!errors.length && <div className="mcp-parameter-error" role="alert">{errors.map(error => <p key={error}>{error}</p>)}</div>}
      {jsonMode ? <label className="mcp-field">{label} JSON<textarea className="mcp-parameter-raw" aria-label={`${label} JSON`} disabled={disabled} spellCheck={false} rows={12} value={value}
        onChange={(event: any) => { setDraft({ mode: 'json' }); setNotice(''); onChange(event.target.value) }} /></label>
        : <><p className="mcp-parameter-hint">* 为必填项；可选字段未填写时不提交。复杂字段可用 JSON 填写。</p>
          <div className="mcp-parameter-fields">{Object.entries(schema.properties ?? {}).map(([name, definition]) => renderField(name, definition as Schema, [name], (schema.required ?? []).includes(name)))}
            {Object.keys(parsed!).filter(name => !has(schema.properties ?? {}, name)).map(name => renderField(name, object(schema.additionalProperties) ? schema.additionalProperties : {}, [name], false))}</div>
          {!Object.keys(schema.properties ?? {}).length && !Object.keys(parsed!).length && <p className="mcp-parameter-hint">没有声明可填写的字段。若服务接受额外参数，可切换 JSON 编辑。</p>}</>}
      <div className="mcp-parameter-actions"><button type="button" disabled={disabled} onClick={reset}>恢复默认值</button></div>
    </div>
  }
}

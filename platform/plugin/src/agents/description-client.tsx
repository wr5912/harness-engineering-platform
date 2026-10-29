import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { useEffect, useRef, useState } from 'react'
import { load } from 'js-yaml'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { instanceWebUrl } from '../instances/url.ts'

type Asset = { path: string; content: string; sha256: string }
type Skill = Asset & { name: string; description: string; body: string }
type Description = { harness: Asset; preset: Asset | null; name: string; description: string; skills: Skill[]; skillPrefix: string }
type Editor = { kind: 'profile' | 'skill' | 'new-skill'; skill?: Skill; skillId?: string; name: string; description: string; body: string }
const object = (text: string): Record<string, any> => {
  const value = load(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('当前文件不是可编辑的 YAML 对象，请使用资产编辑器核对。')
  return value as Record<string, any>
}
const skillParts = (content: string) => {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/.exec(content)
  if (!match) throw new Error('技能缺少 YAML 资料区，请先在资产编辑器补齐。')
  return { header: match[1], metadata: match[2], separator: match[3], body: match[4] }
}

/** 只替换实际编辑的标量，保留文件其余属性、注释和技能正文。复杂 YAML 交给原资产编辑器。 */
export function replaceDescriptionField(text: string, key: string, value: string, parent?: string) {
  const parsed = object(text)
  const lines = text.split('\n')
  let start = 0, end = lines.length, indent = 0
  if (parent) {
    const index = lines.findIndex(line => new RegExp('^' + parent + ':\\s*(?:#.*)?$').test(line.replace(/\r$/, '')))
    if (index < 0 || !parsed[parent] || typeof parsed[parent] !== 'object' || Array.isArray(parsed[parent])) throw new Error('当前 YAML 结构需要使用资产编辑器修改。')
    start = index + 1
    end = lines.findIndex((line, i) => i >= start && /\S/.test(line) && !/^\s|^#/.test(line))
    if (end < 0) end = lines.length
    indent = lines.slice(start, end).find(line => /^\s+[^#\s]/.test(line))?.match(/^\s*/)?.[0].length ?? 2
  }
  const pattern = new RegExp('^ {' + indent + '}' + key + ':')
  const at = lines.findIndex((line, index) => index >= start && index < end && pattern.test(line))
  const replacement = ' '.repeat(indent) + key + ': ' + JSON.stringify(value)
  if (at < 0) lines.splice(end, 0, replacement)
  else {
    let stop = at + 1
    while (stop < end && (/^\s*$/.test(lines[stop]) || (lines[stop].match(/^ */)?.[0].length ?? 0) > indent)) stop++
    // 尾部空行留在原位置，不随块标量移除。
    while (stop > at + 1 && /^\s*$/.test(lines[stop - 1])) stop--
    lines.splice(at, stop - at, replacement)
  }
  const result = lines.join('\n')
  const next = object(result)
  if ((parent ? next[parent]?.[key] : next[key]) !== value) throw new Error('字段无法安全映射，请使用资产编辑器。')
  const original = parent ? parsed[parent][key] : parsed[key]
  if (parent) next[parent][key] = original
  else next[key] = original
  if (original === undefined) { if (parent) delete next[parent][key]; else delete next[key] }
  if (JSON.stringify(next) !== JSON.stringify(parsed)) throw new Error('此次表单修改影响了其他属性，请使用资产编辑器。')
  return result
}

export function AgentDescriptionPanel({ rpc, detail, agentId, onSaved, onEditAsset, onDirtyChange, onAssistant, active = true }: {
  active?: boolean; rpc: PlatformPageProps['rpc']; detail: any; agentId: string; onSaved(): void; onEditAsset(path: string): void
  onDirtyChange(dirty: boolean): void; onAssistant?(task: string, context: Record<string, unknown>): Promise<void>
}) {
  const [value, setValue] = useState<Description | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [viewSkill, setViewSkill] = useState<Skill | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [instances, setInstances] = useState<Array<{ name: string; state: string; source_id: string }>>([])
  const [instanceName, setInstanceName] = useState('')
  const [instanceUrl, setInstanceUrl] = useState('')
  const [instanceMessage, setInstanceMessage] = useState('')
  const [instancesLoading, setInstancesLoading] = useState(false), [instanceUrlLoading, setInstanceUrlLoading] = useState(false)
  const instanceRequest = useRef(0)
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [failedPaths, setFailedPaths] = useState<string[]>([])
  const [sourceChanged, setSourceChanged] = useState(false)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const sequence = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const experimentId = detail.experiment.id
  const base = `evolution/experiments/${experimentId}/candidate`
  async function call(method: string, body: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, 'agents/' + method, body)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as any
  }
  useEffect(() => {
    const request = ++sequence.current
    if (editorRef.current) { setSourceChanged(true); return }
    setSourceChanged(false)
    setValue(null); setError(''); setFailedPaths([])
    const read = (path: string) => call('edit/read', { experiment_id: experimentId, path }).then(value => {
      if (value.kind !== 'text') throw new Error('资料不是可读取的文本：' + path)
      return value as Asset
    })
    void (async () => {
      const harness = await read(base + '/harness.yaml')
      const data = object(harness.content), assets = data.loadable_assets ?? {}
      const paths = new Set<string>(detail.editable_files ?? [])
      const presetPath = `${base}/${assets.preset_root ?? 'dsh/presets'}/${assets.preset_id ?? agentId}/preset.yml`
      const prefix = `${base}/${assets.workspace ?? 'dsh/workspace'}/.agents/skills/`
      const preset = paths.has(presetPath) ? await read(presetPath) : null
      const results = await Promise.allSettled([...paths].filter(path => path.startsWith(prefix) && path.endsWith('/SKILL.md')).map(async path => {
        const asset = await read(path), parts = skillParts(asset.content), fields = object(parts.metadata)
        return { ...asset, name: typeof fields.name === 'string' ? fields.name : path.slice(prefix.length, -9), description: typeof fields.description === 'string' ? fields.description : '', body: parts.body }
      }))
      if (request !== sequence.current) return
      setValue({ harness, preset, name: typeof data.agent?.name === 'string' ? data.agent.name : agentId, description: preset && typeof object(preset.content).description === 'string' ? object(preset.content).description : '', skillPrefix: prefix, skills: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []) })
      setFailedPaths(results.flatMap(result => result.status === 'rejected' ? [String(result.reason?.message ?? result.reason)] : []))
    })().catch(error => { if (request === sequence.current) setError(error instanceof Error ? error.message : '读取失败') })
    return () => { sequence.current++ }
  }, [rpc, experimentId, detail.candidate_sha256, retry])
  const initial = editor?.kind === 'skill' ? editor.skill : value
  const dirty = Boolean(editor && (editor.kind === 'new-skill' ? editor.skillId || editor.name || editor.description || editor.body : editor.name !== initial?.name || editor.description !== initial?.description || editor.kind === 'skill' && editor.body !== editor.skill?.body))
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const open = Boolean(editor || viewSkill || exportOpen)
  useEffect(() => {
    if (!dialog.current) return
    if (active && open && !dialog.current.open) { opener.current = document.activeElement as HTMLElement; dialog.current.showModal() }
    else if ((!active || !open) && dialog.current.open) { dialog.current.close(); if (active) opener.current?.focus() }
  }, [open, active])
  useEffect(() => {
    if (!exportOpen) return
    const request = ++instanceRequest.current
    setInstances([]); setInstanceName(''); setInstanceUrl(''); setInstanceMessage(''); setInstancesLoading(true)
    void rpc.call(CHANNEL, 'instances/list', {}).then(result => {
      if (request !== instanceRequest.current) return
      if (!result.ok) throw new Error(result.error.message)
      const rows = ((result.value as any).instances ?? []).filter((item: any) => item.source_id === `experiment:${experimentId}`)
      setInstances(rows); setInstanceName(rows.length === 1 ? rows[0].name : ''); setInstanceMessage(rows.length ? '选择实例可预览其当前接入信息。' : '此版本尚无已登记实例。')
    }).catch(error => { if (request === instanceRequest.current) setInstanceMessage(`关联实例读取失败：${error instanceof Error ? error.message : '请稍后重试'}`) })
      .finally(() => { if (request === instanceRequest.current) setInstancesLoading(false) })
    return () => { instanceRequest.current++ }
  }, [exportOpen, experimentId, rpc])
  useEffect(() => {
    if (!exportOpen || !instanceName) { setInstanceUrl(''); setInstanceUrlLoading(false); return }
    let current = true
    setInstanceUrl(''); setInstanceMessage(''); setInstanceUrlLoading(true)
    void rpc.call(CHANNEL, 'instances/url', { name: instanceName }).then(result => {
      if (!current) return
      if (!result.ok) throw new Error(result.error.message)
      setInstanceUrl(instanceWebUrl(result.value as any, window.location.hostname)); setInstanceMessage('接入地址来自所选实例当前登记信息。')
    }).catch(error => { if (current) setInstanceMessage(`接入信息暂不可用：${error instanceof Error ? error.message : '请到实例管理核对状态'}`) })
      .finally(() => { if (current) setInstanceUrlLoading(false) })
    return () => { current = false }
  }, [exportOpen, instanceName, rpc])
  function close() {
    if (busy || dirty && !window.confirm('当前资料有未保存修改。确认放弃草稿？')) return
    setEditor(null); setViewSkill(null); setExportOpen(false); setPreview(null); setMessage('')
    if (sourceChanged) { editorRef.current = null; setRetry(value => value + 1) }
  }
  function openSource(path: string) {
    if (busy || dirty && !window.confirm('放弃未保存资料并查看原始资产？')) return
    setEditor(null); setViewSkill(null); setExportOpen(false); setPreview(null); onDirtyChange(false); onEditAsset(path)
  }
  function edits() {
    if (!editor || !value) return []
    if (editor.kind === 'profile') {
      const rows = []
      if (editor.name !== value.name) rows.push({ path: value.harness.path, content: replaceDescriptionField(value.harness.content, 'name', editor.name.trim(), 'agent'), expected_sha256: value.harness.sha256 })
      if (value.preset && editor.description !== value.description) rows.push({ path: value.preset.path, content: replaceDescriptionField(value.preset.content, 'description', editor.description), expected_sha256: value.preset.sha256 })
      return rows
    }
    if (editor.kind === 'new-skill') {
      const id = editor.skillId?.trim() ?? ''
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) throw new Error('技能 ID 请使用不超过 64 字符的小写 kebab-case。')
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editor.name.trim())) throw new Error('技能名请使用小写 kebab-case。')
      if (!editor.description.trim() || !editor.body.trim()) throw new Error('请填写技能说明与正文。')
      const path = value.skillPrefix + id + '/SKILL.md'
      if ((detail.editable_files ?? []).includes(path)) throw new Error('此技能 ID 已有资产，请换一个 ID 或编辑现有技能。')
      return [{ path, content: `---\nname: ${JSON.stringify(editor.name.trim())}\ndescription: ${JSON.stringify(editor.description.trim())}\n---\n${editor.body}`, expected_sha256: null }]
    }
    const skill = editor.skill!, parts = skillParts(skill.content)
    let metadata = replaceDescriptionField(parts.metadata, 'name', editor.name.trim())
    metadata = replaceDescriptionField(metadata, 'description', editor.description)
    return [{ path: skill.path, content: parts.header + metadata + parts.separator + editor.body, expected_sha256: skill.sha256 }]
  }
  async function save(apply: boolean) {
    if (busy || !editor || !dirty) return
    if (sourceChanged) { setMessage('保存依据已变化，请保留草稿并核对最新资产，不能沿用旧预览保存。'); return }
    const request = sequence.current
    setBusy(true); setMessage('')
    try {
      const rows = edits()
      if (!rows.length) { setMessage('没有需要保存的修改。'); return }
      const result = await call(apply ? 'edit/apply' : 'edit/preview', { experiment_id: experimentId, edits: rows })
      if (request !== sequence.current) return
      if (apply) { setEditor(null); setPreview(null); setRetry(value => value + 1); setMessage('版本资料已保存；运行实例的装载状态请到实例管理核对。'); onSaved() }
      else { setPreview(result); setMessage('校验通过，尚未保存。请核对变更内容。') }
    } catch (error) { if (request === sequence.current) setMessage(`${error instanceof Error ? error.message : '请求失败'}；草稿已保留，请核对最新文件后重试。`) }
    finally { setBusy(false) }
  }
  const selectedInstance = instances.find(item => item.name === instanceName)
  const exported = value ? { agent_id: agentId, experiment_id: experimentId, name: value.name, description: value.description, skills: value.skills.map(skill => ({ name: skill.name, description: skill.description, asset: skill.path })), ...(selectedInstance ? { instance: { name: selectedInstance.name, state: selectedInstance.state, url: instanceUrl || null } } : {}) } : null
  function downloadProfile() {
    if (!exported) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${agentId}-${experimentId}-profile.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="agent-description">
    <div className="agent-description-toolbar"><div className="agent-actions"><button type="button" disabled={!value} onClick={() => { setExportOpen(true); setMessage('') }}>预览与导出</button><button type="button" disabled={!value || !onAssistant} onClick={() => void onAssistant?.('请核对当前选中版本的描述与技能资产，列出资料缺项与可补充内容；先只读核对，不创建额外声明来源。', { page: 'agents', agent_id: agentId, experiment_id: experimentId, candidate_sha256: detail.candidate_sha256 })}>请 AI 补齐资料</button></div></div>
    {sourceChanged && <p role="alert">已保存资产发生变化，当前草稿仍保留。请复制需要保留的输入，取消后重新读取最新资料再编辑。</p>}
    {error && <p role="alert">资料读取失败：{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button><button type="button" onClick={() => onEditAsset(base + '/harness.yaml')}>查看资产来源</button></p>}
    {!value && !error && <LoadingIndicator label="读取版本资料与技能" block />}
    {message && !open && <p role="status">{message}</p>}
    {value && <><section className="agent-description-card"><div className="agent-section-heading"><h3>基本资料</h3><button type="button" onClick={() => { setEditor({ kind: 'profile', name: value.name, description: value.description, body: '' }); setMessage(''); setPreview(null) }}>编辑资料</button></div><p className="agent-description-text">{value.description || '此版本尚未填写简介。'}</p></section>
    <section className="agent-description-card"><div className="agent-section-heading"><h3>技能</h3><div className="agent-actions"><span className="agent-muted">{value.skills.length} 项已发现资产</span><button type="button" onClick={() => { setEditor({ kind: 'new-skill', skillId: '', name: '', description: '', body: '' }); setMessage(''); setPreview(null) }}>新增技能</button></div></div><div className="harness-table-scroll"><table><thead><tr><th>技能</th><th>说明</th><th>操作</th></tr></thead><tbody>{value.skills.map(skill => <tr key={skill.path}><td><strong>{skill.name}</strong></td><td>{skill.description || '未填写说明'}</td><td><div className="agent-actions"><button type="button" onClick={() => setViewSkill(skill)}>查看</button><button type="button" onClick={() => { setEditor({ kind: 'skill', skill, name: skill.name, description: skill.description, body: skill.body }); setMessage(''); setPreview(null) }}>编辑</button></div></td></tr>)}</tbody></table></div>{!value.skills.length && <p className="agent-muted">此版本尚未发现 Skill 资产。</p>}{failedPaths.length > 0 && <details><summary>有 {failedPaths.length} 项技能资料读取失败</summary>{failedPaths.map((text, index) => <p key={index} role="alert">{text}</p>)}</details>}</section></>}
    <dialog ref={dialog} className="harness-asset-dialog agent-description-dialog" aria-labelledby="agent-description-dialog-title" onCancel={event => { event.preventDefault(); close() }}><header className="agent-section-heading"><h2 id="agent-description-dialog-title">{editor ? editor.kind === 'profile' ? '编辑版本资料' : editor.kind === 'new-skill' ? '新增技能' : '编辑技能' : viewSkill ? viewSkill.name : '预览与导出'}</h2><button type="button" disabled={busy} onClick={close}>关闭</button></header><div className="agent-dialog-body">
      {editor && <>{editor.kind === 'new-skill' && <label className="agent-field">技能 ID<input aria-label="新技能 ID" maxLength={64} placeholder="小写 kebab-case，作为技能目录" value={editor.skillId} disabled={busy} onChange={event => { setEditor({ ...editor, skillId: event.target.value, name: editor.name === editor.skillId ? event.target.value : editor.name }); setPreview(null) }}/></label>}<label className="agent-field">名称<input value={editor.name} maxLength={160} disabled={busy} onChange={event => { setEditor({ ...editor, name: event.target.value }); setPreview(null) }}/></label><label className="agent-field">{editor.kind === 'profile' ? '简介' : '技能说明'}<textarea value={editor.description} rows={4} disabled={busy || editor.kind === 'profile' && !value?.preset} onChange={event => { setEditor({ ...editor, description: event.target.value }); setPreview(null) }}/></label>{editor.kind === 'profile' && !value?.preset && <p className="agent-muted">未找到此版本的 Preset 文件，简介保存暂不可用。</p>}{editor.kind !== 'profile' && <label className="agent-field">技能正文<textarea className="agent-editor" value={editor.body} rows={12} disabled={busy} onChange={event => { setEditor({ ...editor, body: event.target.value }); setPreview(null) }}/></label>}{preview && <pre>{preview.edits?.map((edit: any) => edit.diff || '无差异').join('\n')}</pre>}</>}
      {viewSkill && <><p>{viewSkill.description || '未填写说明'}</p><pre>{viewSkill.body}</pre><p className="agent-muted">资产来源：<code>{viewSkill.path}</code></p></>}
      {exportOpen && <>{instances.length > 0 && <label className="agent-field">接入实例<SearchSelect label="预览接入实例" value={instanceName} options={[{ value: '', label: '仅预览版本资料' }, ...instances.map(item => ({ value: item.name, label: item.name, description: item.state }))]} onChange={setInstanceName}/></label>}{instancesLoading || instanceUrlLoading ? <LoadingIndicator label={instancesLoading ? "读取版本关联实例" : "读取所选实例接入信息"} block /> : instanceMessage && <p role="status">{instanceMessage}</p>}{instanceUrl && <p><a href={instanceUrl} target="_blank" rel="noreferrer">打开所选实例</a></p>}<p>当前预览读取此版本已保存的名称、简介及技能。标准描述缺少提供方与输入输出类型等必需字段，暂未接入；可下载已有版本资料 JSON。</p><pre>{JSON.stringify(exported, null, 2)}</pre><div className="agent-actions"><button type="button" onClick={downloadProfile}>下载版本资料 JSON</button><button type="button" disabled>下载标准描述（未接入）</button></div></>}
      {sourceChanged && <p role="alert">保存依据已变化，草稿仍保留。请复制需要的内容，取消后重新读取资料再编辑。</p>}{message && <p role="status">{message}</p>}</div>{editor && <footer className="agent-actions agent-dialog-actions"><button type="button" disabled={busy || sourceChanged || !dirty || !editor.name.trim()} onClick={() => void save(false)}>校验与预览</button><button type="button" className="agent-primary" disabled={busy || sourceChanged || !preview || !dirty || !editor.name.trim()} onClick={() => void save(true)}>{busy ? '正在核对…' : '保存修改'}</button>{editor.kind !== 'new-skill' && <button type="button" disabled={busy} onClick={() => openSource(editor.kind === 'skill' ? editor.skill!.path : value!.harness.path)}>查看原始资产</button>}<button type="button" disabled={busy} onClick={close}>取消</button></footer>}</dialog>
  </div>
}

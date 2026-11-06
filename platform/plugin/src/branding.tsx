import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ConfigForm, SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_BRANDING, type Branding, type BrandingSettings } from './branding-defaults.ts'

export type BrandingForm = ConfigForm<BrandingSettings>

export function useBranding(form: BrandingForm) {
  return useSyncExternalStore(useCallback(listener => form.subscribe(listener), [form]), useCallback(() => form.getSnapshot(), [form]))
}

export function BrandingSettingsRow({ form, describe }: { form: BrandingForm; describe: SettingsDescribeFace }) {
  const snapshot = useBranding(form)
  const read = useSyncExternalStore(useCallback(listener => describe.subscribe(listener), [describe]), useCallback(() => describe.getSnapshot(), [describe]))
  const readable = snapshot.status === 'ready'
  const writable = readable && snapshot.writable
  const current = snapshot.value?.branding ?? DEFAULT_BRANDING
  const [draft, setDraft] = useState<Branding | null>(null)
  const [revision, setRevision] = useState<number>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const value = draft ?? current
  const changed = draft !== null && (draft.name.trim() !== current.name || draft.subtitle.trim() !== current.subtitle)
  const edit = (key: keyof Branding, text: string) => {
    if (!draft) setRevision(snapshot.revision)
    setDraft({ ...value, [key]: text })
    setMessage(''); setFailed(false)
  }
  useEffect(() => { if (!draft) setRevision(snapshot.revision) }, [draft, snapshot.revision])
  const save = async () => {
    if (!value.name.trim()) { setMessage('请输入平台名称。'); setFailed(true); return }
    setSaving(true); setMessage(''); setFailed(false)
    try {
      const accepted = await form.mutate([
        { op: 'set', path: ['branding', 'name'], value: value.name.trim() },
        { op: 'set', path: ['branding', 'subtitle'], value: value.subtitle.trim() },
      ], revision)
      if (!accepted) throw new Error('配置已变化或暂时无法保存。输入已保留，请核对当前名称后再次保存。')
      setDraft(null); setMessage('已保存，已打开的页面会自动更新。')
    } catch (error) {
      setRevision(form.getSnapshot().revision)
      setFailed(true); setMessage(error instanceof Error ? error.message : '保存失败，输入已保留，请重试。')
    } finally { setSaving(false) }
  }
  return <section className="harness-branding-settings" aria-labelledby="platform-branding-heading">
    <style>{`
      .harness-branding-settings{display:grid;gap:16px;color:var(--hep-text);font-size:14px}
      .harness-branding-settings h3,.harness-branding-settings p{margin:0}.harness-branding-settings h3{font-size:16px;font-weight:600}.harness-branding-settings p{color:var(--hep-muted);line-height:1.6}
      .harness-branding-settings label{display:grid;gap:8px}.harness-branding-settings input{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;min-height:40px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);color:var(--hep-text);font:inherit}
      .harness-branding-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.harness-branding-settings button{min-height:36px;padding:7px 12px;border:1px solid var(--hep-primary);border-radius:var(--hep-control-radius);background:var(--hep-primary);color:white;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 1px 2px #183B701A,inset 0 1px 0 #FFFFFF1F}.harness-branding-settings button:hover:not(:disabled){background:var(--hep-primary-hover);border-color:var(--hep-primary-hover)}.harness-branding-settings button:disabled{opacity:.45;cursor:default}
      .harness-branding-settings :is(input,button):focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}.harness-branding-settings input:focus-visible{outline-offset:2px}.harness-branding-settings [role=alert]{color:var(--hep-danger)}
      @media(pointer:coarse){.harness-branding-settings :is(input,button){min-height:44px}}
    `}</style>
    <div><h3 id="platform-branding-heading">平台名称</h3><p>用于顶栏、登录页和浏览器标题，保存后自动生效。</p></div>
    {read.error ? <div><p role="alert">读取配置失败：{read.error}。{read.view ? '当前显示上次读取结果，输入仍保留；重新连接后会自动更新。' : '请检查连接，然后重新读取。'}</p>{!read.view && <button type="button" disabled={read.status === 'loading'} onClick={() => void describe.ensure()}>{read.status === 'loading' ? '正在重试…' : '重新读取配置'}</button>}</div>
      : !readable && <p role="status">{snapshot.status === 'loading' ? '正在读取配置…' : '平台名称配置尚未装载，请刷新页面；若仍不可用，请检查平台更新结果。'}</p>}
    <label>名称<input value={value.name} onChange={event => edit('name', event.target.value)} disabled={saving || !writable} required /></label>
    <label>副标题（可留空）<input value={value.subtitle} onChange={event => edit('subtitle', event.target.value)} disabled={saving || !writable} /></label>
    {draft && snapshot.revision !== revision && <p role="status">其他页面已更新配置，当前名称：{current.name}；副标题：{current.subtitle || '无'}。输入仍保留。</p>}
    {failed && <p>当前名称：{current.name}；副标题：{current.subtitle || '无'}。</p>}
    <div className="harness-branding-actions"><button type="button" disabled={saving || !writable || !changed} onClick={() => void save()}>{saving ? '正在保存…' : '保存平台名称'}</button><span role={failed ? 'alert' : 'status'}>{message}</span></div>
  </section>
}

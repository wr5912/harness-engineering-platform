import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import type { NewAgentReceipt } from './create-agent.ts'

type Result = { ok: true; value: NewAgentReceipt } | { ok: false; error: { code: string; message: string } }

export function CreateAgentDialog({ rpc, active, onClose, onCreated, onSelect }: PlatformPageProps & {
  active: boolean; onClose(): void; onCreated(receipt: NewAgentReceipt): void; onSelect(receipt: NewAgentReceipt): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [agentId, setAgentId] = useState(''), [name, setName] = useState(''), [description, setDescription] = useState(''), [role, setRole] = useState('')
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<NewAgentReceipt | null>(null)
  useEffect(() => { if (active) dialog.current?.showModal(); else dialog.current?.close() }, [active])
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId) && !!name.trim() && !!description.trim() && !!role.trim()
  async function create() {
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      const result = await rpc.call(CHANNEL, 'agents/new', { agent_id: agentId, name, description, role }) as Result
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setReceipt(result.value); onCreated(result.value)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="harness-asset-dialog agent-create-dialog" aria-labelledby="new-agent-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="new-agent-title">新建智能体</h2>
    {receipt ? <><div className="agent-dialog-body"><p role="status">{receipt.note}</p><dl className="harness-fields"><div><dt>智能体</dt><dd>{receipt.name} · {receipt.agent_id}</dd></div><div><dt>首次研究版本</dt><dd>{receipt.experiment_id}</dd></div></dl></div><div className="agent-actions agent-dialog-actions"><button type="button" onClick={() => onSelect(receipt)}>查看新智能体</button><button type="button" onClick={onClose}>关闭</button></div></> : <form className="agent-dialog-form" onSubmit={event => { event.preventDefault(); if (step === 'edit' && valid) setStep('review'); else if (step === 'review') void create() }}>
      <div className="agent-dialog-body">
      <p>描述智能体的职责与工作方式，创建首次研究版本。保存后可继续配置能力、发起评测或创建实例。</p>
      <p className="agent-create-step"><span aria-hidden="true">{step === 'edit' ? '01' : '02'}</span>{step === 'edit' ? '定义身份与职责' : '核对将保存的内容'}</p>
        {step === 'edit' ? <>
          <div className="agent-create-identity-fields"><label className="agent-field">Agent ID<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} value={agentId} placeholder="例如 daily-assistant" onChange={event => setAgentId(event.target.value)} /></label>
          <label className="agent-field">智能体名称<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label></div>
          <label className="agent-field">用途说明<textarea required maxLength={2000} rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <label className="agent-field">角色与工作指令<textarea required maxLength={20000} rows={9} value={role} placeholder="说明要帮助用户完成什么、如何工作、信息不足时怎样补问。不要填写 API Key。" onChange={event => setRole(event.target.value)} /></label>
        </> : <><dl className="harness-fields"><div><dt>Agent ID</dt><dd>{agentId}</dd></div><div><dt>名称</dt><dd>{name}</dd></div><div><dt>用途</dt><dd>{description}</dd></div></dl><h3>角色正文</h3><pre className="harness-asset-content">{role}</pre><p>将使用当前标准 DSH Runtime 来源。角色写入新 Candidate，已有身份装载用例同步替换为该角色的身份和职责检查。</p></>}
      {busy && <p role="status">正在创建并校验角色资产，请等待完成。</p>}
      {error && <p role="alert">{error}；填写内容已保留。</p>}
      </div>
      <div className="agent-actions agent-dialog-actions">{step === 'review' && <button type="button" disabled={busy} onClick={() => { setStep('edit'); setError('') }}>返回修改</button>}<button type="submit" className="agent-primary" disabled={!valid || busy}>{step === 'edit' ? '预览创建内容' : busy ? '正在创建…' : '确认创建智能体'}</button><button type="button" disabled={busy} onClick={onClose}>取消</button></div>
    </form>}
  </dialog>
}

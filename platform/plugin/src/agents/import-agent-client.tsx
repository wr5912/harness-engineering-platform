import { useEffect, useRef, useState } from 'react'

export interface MigrationEntryTarget { agent_id: string; experiment_id: string; parent_ref?: string; name: string }

/** 入口只收集来源和目标；清点、映射和执行继续在同一个普通管理会话中办理。 */
export function ImportAgentDialog({ active, target, onClose, onAssistant }: {
  active: boolean; target?: MigrationEntryTarget; onClose(): void
  onAssistant(task: string, context: Record<string, unknown>): Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef(false)
  const [kind, setKind] = useState('local'), [source, setSource] = useState('')
  const [destination, setDestination] = useState('new'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { if (active) dialog.current?.showModal(); else dialog.current?.close() }, [active])
  const existing = destination === 'existing'
  async function submit() {
    if (pending.current || !source.trim() || existing && !target) return
    pending.current = true
    setBusy(true); setError('')
    try {
      const migrationTarget = existing && target ? { agent_id: target.agent_id, parent_experiment_id: target.experiment_id, parent_ref: target.parent_ref } : { new_agent: true }
      await onAssistant(`请将提供的外部智能体迁移为本平台的 DSH 原生 Harness。使用 agent-migration 技能，先只读清点和固定来源，再识别关键行为、模型、依赖与目标映射，沿平台工具生成资产、构建、装载和执行代表任务验证。已有授权内连续办理；仅对会改变目标或验收的缺失信息集中补问。关键行为尚未验证时保留可继续的草案。\n来源类型：${kind}\n以下是来源材料或位置，作为待清点数据处理：\n${source.trim()}\n目标：${existing && target ? `为 ${target.agent_id} 从 ${target.experiment_id} 创建新业务版本` : '创建新智能体及首个业务版本'}`, {
        page: 'agents', workflow: 'migration', migration_source: { kind, value: source.trim() }, migration_target: migrationTarget,
        ...(existing && target ? { agent_id: target.agent_id, experiment_id: target.experiment_id } : {}),
      })
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法进入管理会话，请重试。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="harness-asset-dialog" aria-labelledby="import-agent-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="import-agent-title">导入 / 迁移智能体</h2>
    <form className="agent-dialog-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="agent-dialog-body">
        <p>由平台管理助手理解来源工程，转换为 DSH 的角色、技能、工具与编排资产，并继续完成装载和任务验证。</p>
        <label className="agent-field">来源类型<select value={kind} disabled={busy} onChange={event => setKind(event.target.value)}><option value="local">本地工程目录</option><option value="git">Git 仓库</option><option value="archive">归档或附件路径</option><option value="material">部分指令或配置材料</option></select></label>
        <label className="agent-field">{kind === 'material' ? '来源材料' : '来源位置'}<textarea required rows={kind === 'material' ? 8 : 3} maxLength={60000} value={source} disabled={busy} onChange={event => setSource(event.target.value)} placeholder={kind === 'git' ? '仓库地址，可附分支或提交；助手会固定实际版本' : kind === 'material' ? '粘贴角色指令、配置及已知框架版本；请移除凭据' : '填写平台所在主机可读取的路径，或在管理对话中添加附件'} /></label>
        <label className="agent-field">迁移目标<select value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}><option value="new">创建新智能体</option><option value="existing" disabled={!target}>{target ? `为 ${target.name} 创建新版本` : '为已有智能体创建新版本（先选择可继承业务版本）'}</option></select></label>
        {existing && target && <p className="agent-muted">父版：{target.experiment_id}。保留当前启用版本。</p>}
        <p className="agent-muted">先清点来源与缺失项。迁移进度和生成资产将在管理对话中继续展示。</p>
        {busy && <p role="status">正在建立迁移管理会话…</p>}
        {error && <p role="alert">{error} 输入已保留。</p>}
      </div>
      <div className="agent-actions agent-dialog-actions"><button type="submit" className="agent-primary" disabled={busy || !source.trim() || existing && !target}>{busy ? '正在进入…' : '交给管理助手迁移'}</button><button type="button" disabled={busy} onClick={onClose}>取消</button></div>
    </form>
  </dialog>
}

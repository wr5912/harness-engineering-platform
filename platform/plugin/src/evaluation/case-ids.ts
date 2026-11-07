export type CaseCatalog = { case_id: string; scene: string }[]
export const placeholderCaseId = (id: string) => /^U-(?:NEW|XXX)(?:-|$)/.test(id)
export const currentCaseId = /^U-[A-Z]+-(?!000)[0-9]{3}$/

/** 从当前用例推导场景缩写，不维护第二份可编辑映射。 */
export function sceneCasePrefix(catalog: CaseCatalog, scene: string): string | undefined {
  const prefixes = new Set(catalog.filter(row => row.scene === scene && currentCaseId.test(row.case_id) && !placeholderCaseId(row.case_id))
    .map(row => row.case_id.split('-')[1]))
  return prefixes.size === 1 ? [...prefixes][0] : undefined
}

export function suggestCaseId(catalog: CaseCatalog, scene: string): string {
  const prefix = sceneCasePrefix(catalog, scene)
  if (!prefix) return ''
  const start = `U-${prefix}-`
  const numbers = catalog.filter(row => currentCaseId.test(row.case_id) && row.case_id.startsWith(start)).map(row => Number(row.case_id.slice(start.length)))
  const index = Math.max(0, ...numbers) + 1
  if (index > 999) return ''
  return `${start}${String(index).padStart(3, '0')}`
}

/** 只约束本次新增、改号或移动的用例，旧文件仍可读取和逐步整改。 */
export function validateCaseIds(before: CaseCatalog, after: CaseCatalog): void {
  for (const row of after) {
    if (before.some(old => old.case_id === row.case_id && old.scene === row.scene)) continue
    if (!currentCaseId.test(row.case_id)) throw new Error(`${row.case_id} 的用例编号必须为 U-场景英文缩写-三位数字，场景缩写仅含大写字母，序号为 001～999`)
    if (placeholderCaseId(row.case_id)) throw new Error(`${row.case_id} 使用了占位缩写；请使用所属场景的英文缩写`)
    const peers = after.filter(item => item.case_id !== row.case_id && item.scene === row.scene && currentCaseId.test(item.case_id) && !placeholderCaseId(item.case_id))
    const prefix = sceneCasePrefix(before.filter(item => item.case_id !== row.case_id), row.scene) ?? sceneCasePrefix(peers, row.scene)
    if (peers.length && !prefix) throw new Error(`${row.scene} 的已有编号缩写不一致，请先明确并统一该场景的英文缩写`)
    if (prefix && !row.case_id.startsWith(`U-${prefix}-`)) throw new Error(`${row.scene} 的用例编号必须以 U-${prefix}- 开头`)
  }
}

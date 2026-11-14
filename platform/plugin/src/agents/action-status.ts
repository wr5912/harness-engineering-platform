/** 研究版本写入已由业务仓 Harness 与 Git tag 取代。 */
export function retiredResearchAction(action: string): boolean {
  return /^(?:versions\/|features\/|fusion\/|compute-variants\/|migrations\/|research\/validate$|decision\/(?:preview|update)$)/.test(action)
    || ['create', 'new'].includes(action)
}

/** EXP 表示业务智能体版本，VAR 表示不可再继承的算力变体。保留旧版无随机后缀的身份。 */
export const VERSION_ID = /^(?:EXP|VAR)-([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{3})(?:-r[0-9a-f]{12})?$/

export function isVariantIdentity(id: string, change?: Record<string, any>): boolean {
  return id.startsWith('VAR-') || Boolean(change?.compute_variant)
    || change?.variant_kind === 'exploratory' || change?.variant_kind === 'end'
    || change?.kind === 'end' || change?.variant === 'end'
}

export function assertInheritableVersion(id: string, change: Record<string, any>) {
  if (isVariantIdentity(id, change)) throw new Error('变体不能作为新版本的继承来源')
}

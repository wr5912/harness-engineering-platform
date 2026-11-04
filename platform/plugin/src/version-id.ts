/** EXP 表示业务智能体版本，VAR 表示不可再继承的算力变体。保留旧版无随机后缀的身份。 */
export const VERSION_ID = /^(?!VAR-.*-\d{3}-[mf]-r[0-9a-f]{12}$)(?:EXP|VAR)-([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{3})(?:-([mf])-r[0-9a-f]{12}|(?:-r[0-9a-f]{12})?)$/

export function versionRole(id: string): 'm' | 'f' | null {
  return VERSION_ID.exec(id)?.[3] as 'm' | 'f' | undefined ?? null
}

export function validVersionId(id: string): boolean {
  return VERSION_ID.test(id) && (!versionRole(id) || id.startsWith('EXP-') && /-r[0-9a-f]{12}$/.test(id))
}

export function isVariantIdentity(id: string, change?: Record<string, any>): boolean {
  return id.startsWith('VAR-') || Boolean(change?.compute_variant)
    || change?.variant_kind === 'exploratory' || change?.variant_kind === 'end'
    || change?.kind === 'end' || change?.variant === 'end'
}

export function assertInheritableVersion(id: string, change: Record<string, any>) {
  if (isVariantIdentity(id, change)) throw new Error('变体不能作为新版本的继承来源')
}

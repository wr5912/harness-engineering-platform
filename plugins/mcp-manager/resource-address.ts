function httpAddress(value: string): { origin: string; suffix: string } | undefined {
  const match = /^(https?:)\/\/([^/?#]+)([/?#].*)?$/i.exec(value)
  if (!match) return
  try {
    const url = new URL(`${match[1]}//${match[2]}`)
    if (!url.username && !url.password) return { origin: url.origin, suffix: match[3] || '/' }
  } catch { /* 非 HTTP 地址保持原值。 */ }
}

/** 只接受唯一的同路径候选，模板占位符及查询参数保持逐字一致。 */
export function matchResourceAddress(value: string, candidates: Set<string>): string | undefined {
  if (candidates.has(value)) return value
  const address = httpAddress(value)
  if (!address) return
  const matches = [...candidates].filter(candidate => httpAddress(candidate)?.suffix === address.suffix)
  return matches.length === 1 ? matches[0] : undefined
}

/** 保存连接地址时同步所有分组；不依赖旧地址仍然可访问。 */
export function migrateServiceOrigins(previous: { servers: any[] }, next: { servers: any[]; groups: any[] }): void {
  for (const server of next.servers) {
    const before = previous.servers.find(item => item.id === server.id)
    if (!before || Boolean(before.specUrl) !== Boolean(server.specUrl)) continue
    const oldAddress = httpAddress(before.specUrl || before.url || '')
    const newAddress = httpAddress(server.specUrl || server.url || '')
    if (!oldAddress || !newAddress || oldAddress.origin === newAddress.origin || oldAddress.suffix !== newAddress.suffix) continue
    for (const group of next.groups) for (const member of group.members ?? []) {
      if (member.serverId !== server.id) continue
      for (const field of ['resourceUris', 'resourceTemplates']) {
        if (!Array.isArray(member[field])) continue
        member[field] = [...new Set(member[field].map((value: string) => {
          const address = httpAddress(value)
          return address?.origin === oldAddress.origin ? newAddress.origin + address.suffix : value
        }))]
      }
    }
  }
}

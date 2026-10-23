/** 配置可以等待补全；实际连接必须具备所选授权方式需要的信息。 */
export function connectionIssue(server: any): string | undefined {
  if (server.platformComposition) return
  if (server.specUrl) {
    if (server.authType === 'login' && (!server.loginUrl || !server.loginUsername || !server.loginPassword || !server.loginTokenPath)) return '登录授权信息待补充'
    if (server.authType === 'credential' && !server.apiKey) return '访问凭据待补充'
  } else {
    if (!server.url) return 'MCP 地址待补充'
    if (server.headers?.some((header: any) => !header.value)) return '请求 Header 凭据待补充'
  }
}

export function assertConnectionReady(server: any): void {
  const issue = connectionIssue(server)
  if (issue) throw new Error(`${server.id}: ${issue}，请在 MCP 管理中补全并保存`)
}

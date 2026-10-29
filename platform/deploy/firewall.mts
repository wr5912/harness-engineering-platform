import { spawnSync } from 'node:child_process'

/** 只开放部署所需的入口，不重载防火墙或暴露容器内部端口。 */
export function prepareDeploymentFirewall(host: string, ports: number[]): string {
  const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } })
  const checked = (command: string, args: string[]) => {
    const result = run(command, args)
    if (result.status !== 0) throw new Error(`防火墙配置失败：${command} ${args.join(' ')}；请以管理员身份放行 ${ports.join('、')}/tcp 后重试`)
    return result.stdout.trim()
  }
  const unique = [...new Set(ports)]
  if (run('firewall-cmd', ['--state']).status === 0) {
    const addresses = checked('ip', ['-j', 'address', 'show'])
    const iface = JSON.parse(addresses).find((entry: any) => entry.addr_info?.some((address: any) => address.local === host))?.ifname
    if (!iface) throw new Error(`无法找到监听地址 ${host} 的网卡；请核对部署地址后配置防火墙`)
    const lookup = run('firewall-cmd', [`--get-zone-of-interface=${iface}`])
    if (lookup.status !== 0 && lookup.status !== 2) throw new Error(`无法读取网卡 ${iface} 的防火墙区域`)
    const assigned = lookup.status === 0 ? lookup.stdout.trim() : ''
    const zone = assigned && assigned !== 'no zone' ? assigned : checked('firewall-cmd', ['--get-default-zone'])
    for (const port of unique) for (const permanent of [false, true]) {
      const args = [`--zone=${zone}`, ...(permanent ? ['--permanent'] : [])]
      if (run('firewall-cmd', [...args, `--query-port=${port}/tcp`]).status !== 0) {
        checked('firewall-cmd', [...args, `--add-port=${port}/tcp`])
      }
    }
    return `firewalld ${zone} 已放行 ${unique.join('、')}/tcp（即时及持久配置）`
  }
  const ufw = run('ufw', ['status'])
  if (ufw.status === 0 && /^Status: active$/m.test(ufw.stdout)) {
    for (const port of unique) checked('ufw', ['allow', 'to', host, 'port', String(port), 'proto', 'tcp'])
    return `UFW 已放行 ${host} 的 ${unique.join('、')}/tcp`
  }
  return `未检测到活动 firewalld/UFW；仍需从客户端核对 ${host} 的 ${unique.join('、')}/tcp 可达性`
}

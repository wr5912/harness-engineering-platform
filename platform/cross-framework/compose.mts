import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 准备：node platform/cross-framework/compose.mts project <数据根>/.local/cross-framework-samples
 * 此命令不停止容器；仅生成引用现有数据与秘密文件的 Compose 投影并验证配置。
 * 恢复：在确认本任务无在途工作后，用相同入口执行 recover <同一目录>。
 * 如 up 中途失败，保留原目录和网络，直接重跑生成结果中的 upCommand；不要清理卷或 HOME。
 */

const PROJECT = 'hep-cross-framework-recovery'
const ownership: Record<string, [string, string]> = {
  'hep-cross-framework-dsh': ['hep.task', 'cross-framework'],
  'hep-cross-framework-dsh-connector': ['hep.sample', 'cross-framework-dsh-connector'],
  'hep-cross-framework-agentscope': ['harness.task', 'cross-framework-access'],
  'hep-cross-framework-agentscope-connector': ['harness.task', 'cross-framework-access'],
  'hep-cross-framework-redis': ['harness.task', 'cross-framework-access'],
  'hep-cross-framework-opencode': ['hep.sample', 'cross-framework-opencode'],
  'hep-cross-framework-opencode-connector': ['hep.sample', 'cross-framework-opencode-connector'],
}
const names = Object.keys(ownership)
const serviceName = (name: string) => name.replace(/^hep-cross-framework-/, '')
function docker(args: string[]) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim() }
  catch { throw new Error(`Docker 操作失败：${args[0] === 'compose' ? 'Compose 配置或恢复' : args[0]}；未输出原始配置、环境值或凭据`) }
}
function inspectOwned() {
  const rows: any[] = JSON.parse(docker(['inspect', ...names]))
  for (const row of rows) {
    const name = row.Name.replace(/^\//, ''), owner = ownership[name]
    if (!owner || row.Config.Labels?.[owner[0]] !== owner[1]) throw new Error('样本身份不匹配，拒绝生成或处置容器')
    if (row.HostConfig.Privileged || row.HostConfig.PidMode === 'host' || row.HostConfig.NetworkMode === 'host'
      || row.Mounts.some((mount: any) => mount.Destination === '/var/run/docker.sock')) throw new Error('样本存在未核定的宿主控制边界，拒绝生成')
  }
  return rows
}
function pairs(values: string[]) { return new Map(values.map(value => { const offset = value.indexOf('='); return [value.slice(0, offset), value.slice(offset + 1)] })) }

/** 从实际任务容器生成不可编辑的 Compose 投影；所有可变数据仍引用其原持久来源。 */
export function projectCompose(stateRoot: string) {
  const root = resolve(stateRoot), file = join(root, 'compose.json'), containers = inspectOwned()
  const credentials = join(root, 'credentials'); mkdirSync(credentials, { recursive: true, mode: 0o700 }); chmodSync(credentials, 0o700)
  const services: Record<string, any> = {}, networks: Record<string, any> = {}, volumes: Record<string, any> = {}
  for (const row of containers) {
    const name = row.Name.replace(/^\//, ''), key = serviceName(name), config = row.Config, host = row.HostConfig
    const image = JSON.parse(docker(['image', 'inspect', row.Image]))[0]
    const original = pairs(image.Config.Env ?? []), environment: Record<string, string> = {}, sensitive: string[] = []
    for (const [name, value] of pairs(config.Env ?? [])) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) throw new Error('环境变量无法无损投影，拒绝输出其内容')
      if (original.get(name) === value) continue
      // 只把本地文件引用写入 Compose；包括模拟占位 key 也不内联。
      if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTHORIZATION/i.test(name)) sensitive.push(`${name}=${value}`)
      else environment[name] = value.replaceAll('$', '$$')
    }
    const labels = Object.fromEntries(Object.entries(config.Labels ?? {}).filter(([name]) => !name.startsWith('com.docker.compose.')))
    const literalCommand = (args: string[]) => args.map(value => value.replaceAll('$', '$$'))
    const service: any = { container_name: name, image: row.Image, pull_policy: 'never', user: config.User || undefined,
      working_dir: config.WorkingDir || undefined, entrypoint: literalCommand(config.Entrypoint ?? []), command: literalCommand(config.Cmd ?? []), labels,
      ...(Object.keys(environment).length ? { environment } : {}), ...(host.ReadonlyRootfs ? { read_only: true } : {}),
      ...(host.CapDrop?.length ? { cap_drop: host.CapDrop } : {}), ...(host.CapAdd?.length ? { cap_add: host.CapAdd } : {}),
      ...(host.SecurityOpt?.length ? { security_opt: host.SecurityOpt } : {}), ...(host.ExtraHosts?.length ? { extra_hosts: host.ExtraHosts } : {}) }
    if (sensitive.length) {
      const secretFile = join(credentials, `${key}.llm-api-key`)
      writeFileSync(secretFile, sensitive.join('\n') + '\n', { mode: 0o600 }); chmodSync(secretFile, 0o600)
      service.env_file = [{ path: secretFile, format: 'raw' }]
    }
    service.volumes = row.Mounts.filter((mount: any) => mount.Type !== 'tmpfs').map((mount: any) => {
      if (mount.Type === 'bind') {
        if (!existsSync(mount.Source)) throw new Error('样本挂载来源已丢失，不创建空目录替代')
        return { type: 'bind', source: mount.Source, target: mount.Destination, read_only: !mount.RW, bind: { create_host_path: false,
          ...(mount.Propagation && mount.Propagation !== 'rprivate' ? { propagation: mount.Propagation } : {}) } }
      }
      if (mount.Type === 'volume') {
        const volumeKey = `existing-${Object.keys(volumes).length}`; volumes[volumeKey] = { external: true, name: mount.Name }
        return { type: 'volume', source: volumeKey, target: mount.Destination, read_only: !mount.RW }
      }
      throw new Error('样本挂载类型暂未支持，不能省略后继续恢复')
    })
    if (host.Tmpfs && Object.keys(host.Tmpfs).length) service.tmpfs = Object.entries(host.Tmpfs).map(([target, flags]) => `${target}:${flags}`)
    const networkMode = host.NetworkMode as string
    if (networkMode.startsWith('container:')) {
      const shared = networkMode.slice('container:'.length), target = containers.find(other => other.Id === shared || other.Name === '/' + shared)
      if (!target || target.Name !== '/hep-cross-framework-redis') throw new Error('共享网络依赖不是本任务 Redis，拒绝恢复')
      service.network_mode = 'service:redis'; service.depends_on = { redis: { condition: 'service_healthy' } }
      if (Object.keys(host.PortBindings ?? {}).length) throw new Error('共享网络样本存在独立端口，不能无损转换')
    } else {
      service.networks = {}
      for (const network of Object.keys(row.NetworkSettings.Networks)) {
        if (!network.startsWith('hep-cross-framework-')) throw new Error('样本连接了未核定网络，拒绝生成')
        networks[network] = { external: true, name: network }
        // 保留原容器名，框架配置中的 connector DNS 不随 Compose 服务名改变。
        service.networks[network] = { aliases: [name, serviceName(name)] }
      }
      const ports = Object.entries(host.PortBindings ?? {}).flatMap(([port, bindings]) => (bindings as any[]).map(binding => {
        if (binding.HostIp !== '127.0.0.1') throw new Error('样本端口不是回环绑定，拒绝扩大访问范围')
        const [target, protocol] = port.split('/')
        return { target: Number(target), published: String(binding.HostPort), host_ip: binding.HostIp, protocol }
      }))
      if (ports.length) service.ports = ports
    }
    if (name === 'hep-cross-framework-redis') service.healthcheck = { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '2s', retries: 15 }
    services[key] = service
  }
  const document = { name: PROJECT, services, networks, ...(Object.keys(volumes).length ? { volumes } : {}),
    'x-hep-generated': { editable: false, source: '本任务实际容器的只读投影；重新运行 compose.mts project 更新', generatedAt: new Date().toISOString(),
      containers: containers.map(row => ({ name: row.Name.replace(/^\//, ''), id: row.Id, image: row.Image })) } }
  writeFileSync(file, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600)
  docker(['compose', '-p', PROJECT, '-f', file, 'config', '--quiet'])
  // config 的完整输出含 env_file 展开值，只在内存核对，禁止输出到终端或证据。
  const normalized = JSON.parse(docker(['compose', '-p', PROJECT, '-f', file, 'config', '--format', 'json']))
  for (const row of containers) {
    const service = normalized.services[serviceName(row.Name.replace(/^\//, ''))]
    const image = JSON.parse(docker(['image', 'inspect', row.Image]))[0], base = pairs(image.Config.Env ?? [])
    for (const [name, value] of pairs(row.Config.Env ?? [])) if (base.get(name) !== value && service.environment?.[name] !== value) throw new Error('Compose 环境投影与当前样本不同，拒绝继续')
    const literal = (args: string[]) => args.map(value => value.replaceAll('$$', '$'))
    if (JSON.stringify(literal(service.command)) !== JSON.stringify(row.Config.Cmd ?? []) || JSON.stringify(literal(service.entrypoint)) !== JSON.stringify(row.Config.Entrypoint ?? [])) throw new Error('Compose 启动命令与当前样本不同，拒绝继续')
  }
  return { file, project: PROJECT, count: containers.length, configurationVerified: true, affected: names,
    upCommand: ['docker', 'compose', '-p', PROJECT, '-f', file, 'up', '-d', '--pull', 'never'] }
}

/** 仅由明确选择 recover 的调用执行；不删除卷、网络、HOME、会话、凭据或任何其他容器。 */
export function recoverCompose(stateRoot: string) {
  const root = resolve(stateRoot), file = join(root, 'compose.json')
  if (!existsSync(file)) throw new Error('先运行 project 并核对恢复范围')
  const projection = JSON.parse(readFileSync(file, 'utf8')), current = inspectOwned()
  for (const row of current) if (!projection['x-hep-generated']?.containers?.some((record: any) => record.id === row.Id && record.image === row.Image)) throw new Error('样本容器已变化，先重新生成 Compose 投影')
  docker(['compose', '-p', PROJECT, '-f', file, 'config', '--quiet'])
  docker(['stop', '--time', '15', ...names])
  docker(['rm', ...names])
  docker(['compose', '-p', PROJECT, '-f', file, 'up', '-d', '--pull', 'never'])
  const restored = inspectOwned()
  const result = { at: new Date().toISOString(), project: PROJECT, containers: restored.map(row => ({ name: row.Name.replace(/^\//, ''), oldId: projection['x-hep-generated'].containers.find((record: any) => record.name === row.Name.replace(/^\//, '')).id,
    id: row.Id, image: row.Image, state: row.State.Status, running: row.State.Running, user: row.Config.User, readOnlyRootfs: row.HostConfig.ReadonlyRootfs })),
    runtimeApisVerified: false, note: '仅证明七个任务容器按原配置重新创建；API、授权撤销、资源调用与秘密读取边界须继续实际复验。' }
  writeFileSync(join(root, 'compose-recovery.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2], root = process.argv[3]
  if (!root || !['project', 'recover'].includes(action)) throw new Error('用法：node platform/cross-framework/compose.mts <project|recover> <样本状态根>')
  const result = action === 'project' ? projectCompose(root) : recoverCompose(root)
  process.stdout.write(JSON.stringify(result) + '\n')
}

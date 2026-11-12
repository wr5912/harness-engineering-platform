import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { agentCommand } from './process.mts'

/** 清理指定独立安装的过程资源，不删除 HOME、共享镜像或其他交付包。 */
export async function cleanupAgentInstallation(prefix: string) {
  const root = realpathSync(prefix)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (manifest.kind !== 'standalone-agent') throw new Error('清理目标不是独立智能体安装目录')
  const compose = join(root, 'runtime/compose.yaml')
  if (!lstatSync(compose).isFile()) throw new Error('清理目标缺少 Compose 配置')
  const deployment = join(root, 'state/deployment.env')
  const projects = new Set<string>()
  if (existsSync(deployment)) {
    if (!lstatSync(deployment).isFile()) throw new Error('清理目标的安装身份不是普通文件')
    const project = /^COMPOSE_PROJECT_NAME=(hep-agent-[a-zA-Z0-9_-]+)$/m.exec(readFileSync(deployment, 'utf8'))?.[1]
    if (!project) throw new Error('清理目标的容器项目身份无效')
    projects.add(project)
  }
  const env = { ...process.env }
  // 只使用该安装的身份和端口，不受当前 Shell 的 Compose 设置影响。
  for (const key of Object.keys(env)) if (/^(COMPOSE_|AGENT_)/.test(key)) delete env[key]
  // 历史探针可能没有 deployment.env；同一目录也可能遗留旧项目，按实际标签和挂载核对归属。
  const ids = (await agentCommand('docker', ['ps', '-aq'], { env })).trim().split(/\s+/).filter(Boolean)
  const containers: any[] = ids.length ? JSON.parse(await agentCommand('docker', ['inspect', ...ids], { env })) : []
  const belongs = (container: any) => {
    const labels = container.Config?.Labels ?? {}
    return labels['com.docker.compose.project.working_dir'] === root
      && labels['com.docker.compose.project.config_files'] === compose
      && container.Mounts?.some((mount: any) => mount.Source === root && mount.Destination === '/opt/standalone')
  }
  for (const container of containers) {
    const project = container.Config?.Labels?.['com.docker.compose.project']
    if (belongs(container) && typeof project === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) projects.add(project)
  }
  if (!projects.size) throw new Error('清理目标缺少安装身份，且没有可核对归属的容器')
  for (const project of projects) {
    if (containers.some(container => container.Config?.Labels?.['com.docker.compose.project'] === project && !belongs(container))) {
      throw new Error('容器项目包含其他安装的容器，拒绝清理')
    }
  }
  for (const project of projects) {
    await agentCommand('docker', ['compose', ...(existsSync(deployment) ? ['--env-file', deployment] : []),
      '--project-directory', root, '--project-name', project, '-f', compose, 'down', '--remove-orphans'], { env })
    const remaining = await agentCommand('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { env })
    if (remaining.trim()) throw new Error('清理后仍有目标容器残留；安装介质已保留，请检查 Docker 状态')
    const networks = await agentCommand('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { env })
    if (networks.trim()) throw new Error('清理后仍有目标网络残留；安装介质已保留，请检查 Docker 状态')
  }
  for (const name of ['images', 'offline']) rmSync(join(root, name), { recursive: true, force: true })
  return { prefix: root, projects: [...projects], cleaned: ['containers', 'network', 'installation-media'], retained: ['image', 'assets', 'config-seed', 'state'] }
}

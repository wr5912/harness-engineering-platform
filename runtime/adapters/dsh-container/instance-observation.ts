/** 一次观察 Docker 容器与卷；CLI 和平台共用同一份实时结果。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
async function listing(args: string[]) {
  try {
    const { stdout } = await execute('docker', args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : []
  } catch {
    return null
  }
}
const [containers, volumes] = await Promise.all([
  listing(['ps', '--all', '--format', '{"ID":{{json .ID}},"Name":{{json .Names}},"Service":{{json (.Label "com.docker.compose.service")}},"Project":{{json (.Label "com.docker.compose.project")}},"State":{{json .State}},"Status":{{json .Status}},"ConfigFiles":{{json (.Label "com.docker.compose.project.config_files")}},"WorkingDir":{{json (.Label "com.docker.compose.project.working_dir")}}}']),
  listing(['volume', 'ls', '--format', '{"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}},"volume":{{json (.Label "com.docker.compose.volume")}}}']),
])
const projects: Record<string, unknown[]> = {}
for (const container of containers ?? []) {
  if (container.Project) (projects[container.Project] ??= []).push(container)
}
const homes: Record<string, string> = {}
for (const volume of volumes ?? []) {
  if (volume.project && volume.volume === `${volume.project}-home`) homes[volume.project] ??= volume.name
}
const inspected = containers?.length ? await listing(['inspect', '--format',
  '{"name":{{json .Name}},"id":{{json .Id}},"started_at":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
  ...containers.map(item => item.ID)]) : []
const generations = Object.fromEntries((inspected ?? []).map(({ name, ...generation }) => [name.replace(/^\//, ''), generation]))
process.stdout.write(JSON.stringify({ projects: containers === null ? null : projects, homes: volumes === null ? null : homes,
  generations: inspected === null ? null : generations }))

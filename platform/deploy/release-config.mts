import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expectedImage, inspectImageArchive, verifyImageInfo } from './image.mts'
import { sha256File } from './manifest.mts'

/** 部署控制面只保存引用；沿用原生模型、接入和 HOME 配置，不复制连接值。 */
export function releasePlan(programRoot: string, dataRoot: string, environment: string) {
  const yaml = createRequire(join(programRoot, 'platform/plugin/package.json'))('js-yaml')
  const configPath = join(dataRoot, 'config/deployment.yaml')
  const config = yaml.load(readFileSync(configPath, 'utf8'))
  const selected = config?.environments?.[environment]
  if (config?.schemaVersion !== 1 || !selected) throw Error(`部署环境不存在或版本无效：${environment}`)
  if (!['amd64', 'arm64'].includes(selected.arch)) throw Error('部署架构须为 amd64 或 arm64')
  const roots: Record<string, string> = { program: programRoot, data: dataRoot, home: join(programRoot, '../platform-manager-dsh-home') }
  const locate = (ref: string): string => {
    const match = /^(program|data|home):(.+)$/.exec(ref ?? '')
    if (!match) throw Error(`配置引用须使用 program:、data: 或 home:：${ref}`)
    return resolve(roots[match[1]], match[2])
  }
  const references = Object.entries(selected.references ?? {}).map(([name, ref]) => ({ name, ref, sha256: sha256File(locate(ref as string)) }))
  const platform = { assetsDir: locate(selected.platform.assetsDir), imageArchive: locate(selected.platform.imageArchive) }
  const agent = { resourcesDir: locate(selected.agent.resourcesDir), mode: selected.agent.mode ?? 'online' }
  if (!['online', 'offline'].includes(agent.mode)) throw Error('独立包模式须为 online 或 offline')
  const expected = expectedImage(programRoot, selected.arch)
  const image = inspectImageArchive(platform.imageArchive, expected.tag)
  const problems = verifyImageInfo(image, { arch: selected.arch, fingerprint: expected.fingerprint })
  if (problems.length) throw Error(problems.join('；'))
  return {
    environment, arch: selected.arch, platform, agent,
    image: { ...expected, id: image.id, arch: selected.arch },
    runtime: { ref: 'program:runtime/adapters/dsh-container/source.lock.json', sha256: sha256File(join(programRoot, 'runtime/adapters/dsh-container/source.lock.json')) },
    config: { path: relative(join(programRoot, '..'), configPath), sha256: sha256File(configPath), references },
  }
}

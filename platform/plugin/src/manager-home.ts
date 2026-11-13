import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function managerHome(dataRoot: string, environment = process.env): string {
  let selected = environment.HARNESS_MANAGER_DSH_HOME
  const locator = join(environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), '.config'), 'harness-engineering-platform/workspace.json')
  if (!selected && existsSync(locator)) {
    const workspace = JSON.parse(readFileSync(locator, 'utf8'))
    if (workspace.assetRoot && resolve(workspace.assetRoot) === resolve(dataRoot)) selected = workspace.managerDshHome
  }
  if (!selected) {
    const sibling = resolve(dataRoot, '..', 'platform-manager-dsh-home')
    if (existsSync(join(sibling, 'profiles/harness-platform/package.json'))) selected = sibling
  }
  if (selected) {
    if (!isAbsolute(selected) || !existsSync(selected) || !statSync(selected).isDirectory()) throw new Error('平台管理助手 HOME 必须是已存在的绝对目录')
    return resolve(selected)
  }
  return join(resolve(dataRoot), '.local/platform-home')
}

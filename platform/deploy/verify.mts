import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inspectDataRoot } from './data.mts'

export interface DeploymentCheck {
  id: string
  status: 'ok' | 'missing' | 'mismatch'
  detail: string
}

export interface VerifyOptions {
  prefix: string
  dataRoot: string
  url?: string
}

export async function verifyDeployment(options: VerifyOptions): Promise<{ checks: DeploymentCheck[]; ok: boolean }> {
  const prefix = resolve(options.prefix)
  const dataRoot = resolve(options.dataRoot)
  const checks: DeploymentCheck[] = []
  const data = inspectDataRoot(dataRoot)
  checks.push({
    id: 'workspace-assets',
    status: data.kind === 'workspace' ? 'ok' : 'missing',
    detail: data.kind === 'workspace' ? `${data.skills} skills, ${data.workspaceId}` : `缺少 ${data.missing.join('、')}`,
  })
  const profile = join(dataRoot, '.local', 'platform-home', 'profiles', 'harness-platform', 'harness-platform.patch.yml')
  if (!existsSync(profile)) {
    checks.push({ id: 'profile', status: 'missing', detail: profile })
  } else {
    const patch = readFileSync(profile, 'utf8')
    const expected = join(dataRoot, '.agents', 'skills')
    checks.push({
      id: 'profile-skills',
      status: patch.includes(expected) ? 'ok' : 'mismatch',
      detail: patch.includes(expected) ? expected : `Profile 未包含 ${expected}`,
    })
  }
  const storage = join(dataRoot, '.local', 'platform-home', 'storages', 'workspace.json')
  if (!existsSync(storage)) {
    checks.push({ id: 'default-workspace', status: 'missing', detail: storage })
  } else {
    const value = JSON.parse(readFileSync(storage, 'utf8')) as any
    const id = value?.global?.defaultWorkspaceId
    const path = id ? value?.tables?.workspaces?.[id]?.path : undefined
    checks.push({
      id: 'default-workspace',
      status: path && resolve(path) === dataRoot ? 'ok' : 'mismatch',
      detail: path ?? '没有 defaultWorkspaceId',
    })
  }
  const launcher = join(prefix, 'bin', 'hep-start')
  checks.push({ id: 'launcher', status: existsSync(launcher) ? 'ok' : 'missing', detail: launcher })
  if (options.url) {
    try {
      const response = await fetch(options.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      checks.push({ id: 'http', status: response.status === 200 || response.status === 303 ? 'ok' : 'mismatch', detail: `${response.status} ${options.url}` })
    } catch (error) {
      checks.push({ id: 'http', status: 'missing', detail: `${options.url}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return { checks, ok: checks.every(check => check.status === 'ok') }
}

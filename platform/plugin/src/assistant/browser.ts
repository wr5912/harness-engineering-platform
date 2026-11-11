import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { platformEntryUrl } from '../business-control/group-link.ts'
import { navigationHash } from '../navigation.ts'
import { programRoot, workspaceLocalPath } from '../workspace.ts'

const pages = ['home', 'conversations', 'agents', 'evaluation', 'instances', 'gateway', 'mcp'] as const
const locator = z.object({
  kind: z.enum(['role', 'label', 'text', 'placeholder', 'test_id']),
  value: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240).optional(),
  exact: z.boolean().optional(),
}).strict()
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), locator }).strict(),
  z.object({ action: z.literal('fill'), locator, value: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('press'), locator, key: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal('wait_for'), text: z.string().trim().min(1).max(500) }).strict(),
])
const screenshot = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('viewport') }).strict(),
  z.object({ scope: z.literal('full_page') }).strict(),
  z.object({ scope: z.literal('element'), locator }).strict(),
])
const inputSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('platform'), page: z.enum(pages) }).strict(),
    z.object({ kind: z.literal('instance'), name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict(),
  ]),
  actions: z.array(action).max(12).default([]),
  screenshot: screenshot.default({ scope: 'viewport' }),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
}).strict()

export type BrowserInspectInput = z.infer<typeof inputSchema>
export type BrowserInspector = (input: unknown, signal: AbortSignal) => Promise<Record<string, any>>

export function parseBrowserInput(input: unknown): BrowserInspectInput {
  return inputSchema.parse(input)
}

function targetUrl(root: string, input: BrowserInspectInput, instanceUrl?: string): string {
  if (input.target.kind === 'instance') {
    if (!instanceUrl) throw new Error('未取得已登记实例入口')
    return instanceUrl
  }
  return `${platformEntryUrl(root)}${navigationHash({ page: input.target.page })}`
}

async function imageRef(signal: AbortSignal): Promise<string> {
  const configured = process.env.DSH_IMAGE_TAG?.trim()
  if (configured) return configured
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  const python = process.env.HARNESS_PYTHON || 'python3'
  const source = join(programRoot(), 'runtime/adapters/dsh-container/source_contract.py')
  const result = await runProcess(python, [source, '--image-identity-for', platform], signal, 30000)
  if (result.code !== 0) throw new Error('无法确定当前锁定的 DSH Runtime 镜像')
  try {
    const value = JSON.parse(result.stdout)
    if (typeof value?.tag !== 'string' || !value.tag.trim()) throw new Error('missing-image-tag')
    return value.tag
  } catch {
    throw new Error('当前 DSH Runtime 镜像身份无效')
  }
}

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function runProcess(command: string, args: string[], signal: AbortSignal, timeout: number, input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: process.env, signal })
    let stdout = '', stderr = '', size = 0, stopped = false
    const collect = (part: 'stdout' | 'stderr') => (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 4 * 1024 * 1024) { stopped = true; child.kill('SIGKILL'); return }
      if (part === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    if (input !== undefined) child.stdin?.end(input)
    const timer = setTimeout(() => { stopped = true; child.kill('SIGKILL') }, timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, childSignal) => {
      clearTimeout(timer)
      if (stopped && !signal.aborted) reject(new Error('浏览器驱动超时或输出超过限制'))
      else resolve({ code, signal: childSignal, stdout, stderr })
    })
  })
}

function driverCommand(image: string, evidenceRoot: string): string[] {
  const driver = join(programRoot(), 'runtime/adapters/dsh-container/dsh-browser-inspect.mjs')
  const containerDriver = '/opt/dsh/apps/web/dsh-browser-inspect.mjs'
  return [
    'run', '--rm', '-i', '--network', 'host', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--shm-size', '256m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env', 'HOME=/tmp',
    '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    '--entrypoint', 'node',
    '--mount', `type=bind,src=${driver},dst=${containerDriver},readonly`,
    '--mount', `type=bind,src=${evidenceRoot},dst=/work/evidence`,
    image, containerDriver,
  ]
}

export function createBrowserInspector(root: string, platform: ConnectionRpcHandler): BrowserInspector {
  return async (value, signal) => {
    const input = parseBrowserInput(value)
    signal.throwIfAborted()
    let instanceUrl: string | undefined
    if (input.target.kind === 'instance') {
      const receipt = await platform('instances/url', { name: input.target.name }, signal, { principal: { kind: 'owner' } } as any)
      const returnedUrl = (receipt as any).value?.url
      if (!receipt.ok || typeof returnedUrl !== 'string') throw new Error(receipt.ok ? '已登记实例没有可浏览入口' : (receipt as any).error?.message ?? '无法读取已登记实例入口')
      instanceUrl = returnedUrl
    }
    const target = targetUrl(root, input, instanceUrl)
    const evidenceRoot = workspaceLocalPath(root, 'browser-inspections', randomUUID())
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    const image = await imageRef(signal)
    const payload = { ...input, target_url: target, evidence_root: '/work/evidence' }
    const result = await runProcess('docker', driverCommand(image, evidenceRoot), signal, input.timeout_ms + 30000, JSON.stringify(payload))
    const line = result.stdout.trim().split('\n').filter(Boolean).at(-1)
    if (!line) throw new Error(result.stderr.trim() || '浏览器驱动没有返回检查结果')
    let valueResult: Record<string, any>
    try { valueResult = JSON.parse(line) } catch { throw new Error('浏览器驱动返回了无法解析的检查结果') }
    if (typeof valueResult !== 'object' || valueResult === null) throw new Error('浏览器驱动返回格式无效')
    if (valueResult.ok && valueResult.screenshot_file) {
      if (valueResult.screenshot_file !== 'screenshot.png') throw new Error('浏览器驱动返回了无效的截图路径')
      const path = join(evidenceRoot, valueResult.screenshot_file)
      const bytes = await readFile(path)
      return { ...valueResult, _screenshot: { path, bytes } }
    }
    return valueResult
  }
}

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defaultRepository, extensionDigest, initializeWorkspace, inspectWorkspace, previewWorkspace, rememberWorkspace, type SetupRequest } from './workspace.ts'
import { managedState } from '../lifecycle.mts'

const execute = promisify(execFile)
const base = '/hep/'
export type BootstrapOptions = { root: string; host: string; port: number; token: string; resultFile: string; programRoot: string; python?: string; prepare?: (root: string) => Promise<void> }

export function handoffService(from: string, to: string, programRoot: string) {
  if (resolve(from) === resolve(to)) return
  const state = managedState(from, programRoot)
  if (!state || state.pid !== process.ppid) return
  if (managedState(to, programRoot)) throw new Error('选定数据工作区已有运行中的平台，请先停止后重试')
  const directory = join(to, '.local/platform-service')
  mkdirSync(directory, { recursive: true })
  const destination = join(directory, 'state.json')
  writeFileSync(destination + '.tmp', JSON.stringify({ ...state, dataRoot: resolve(to) }) + '\n', { mode: 0o600 })
  renameSync(destination + '.tmp', destination)
  rmSync(join(from, '.local/platform-service/state.json'))
  const env = join(programRoot, 'bin/hep-env.sh')
  if (existsSync(env)) {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const previous = `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-${quote(from)}}`
    writeFileSync(env, readFileSync(env, 'utf8').replace(previous, `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-${quote(to)}}`))
  }
}

async function requestBody(req: IncomingMessage): Promise<SetupRequest> {
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
    if (Buffer.byteLength(body) > 16_384) throw new Error('初始化请求过长')
  }
  try { return JSON.parse(body) } catch { throw new Error('初始化请求必须是 JSON 对象') }
}

export async function createBootstrapServer(options: BootstrapOptions) {
  let root = options.root, phase = 'idle', error: string | undefined, exchangeToken: string | undefined = options.token
  const session = randomBytes(32).toString('base64url')
  const prepare = options.prepare ?? (async (assetRoot: string) => {
    try {
      await execute(join(options.programRoot, 'platform/dsh-platform'), ['prepare', ...(process.env.HEP_OFFLINE === '1' ? ['--offline'] : [])], {
        cwd: options.programRoot, env: { ...process.env, HARNESS_ASSET_ROOT: assetRoot }, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
      })
    } catch (failure) {
      const message = String((failure as { stderr?: string }).stderr || '')
      const detail = message.split('\n').find(line => line.startsWith('dsh-platform:'))
      // 只接收受信启动器的结构化错误行，不回传构建进程原始日志或 Git 输出。
      throw new Error(detail && !/(?:password|token|secret|api.?key|sk-)/i.test(detail) ? detail : '平台 prepare 失败；请检查全局 DSH、pnpm 和工作区声明的扩展后重试')
    }
  })
  const server = createServer(async (req, res) => {
    res.setHeader('x-harness-bootstrap', '1')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
    try {
      const url = new URL(req.url || '/', 'http://bootstrap.local')
      if (url.pathname === '/' || url.pathname === '/hep') { res.writeHead(302, { location: base }); res.end(); return }
      if (url.pathname === base && exchangeToken && url.searchParams.get('bootstrap') === exchangeToken) {
        exchangeToken = undefined
        res.writeHead(303, { location: base, 'set-cookie': `harness_bootstrap=${session}; Path=/hep/; HttpOnly; SameSite=Strict` }); res.end(); return
      }
      if (url.pathname === base && req.method === 'GET') {
        const { bootstrapHtml } = await import('./client.ts')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(bootstrapHtml()); return
      }
      if (!url.pathname.startsWith(base + 'bootstrap/')) { reply(404, { error: '初始化入口不存在' }); return }
      if (!(req.headers.cookie || '').split(';').map(v => v.trim()).includes(`harness_bootstrap=${session}`)) { reply(401, { error: '请使用启动器提供的一次性初始化链接' }); return }
      if (url.pathname === base + 'bootstrap/status' && req.method === 'GET') {
        reply(200, { ...await inspectWorkspace(root), repositoryUrl: defaultRepository, phase, error }); return
      }
      if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) { reply(403, { error: '请从初始化页面发起操作' }); return }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(415, { error: '请使用 JSON 请求' }); return }
      const input = await requestBody(req)
      if (url.pathname === base + 'bootstrap/preview') { reply(200, await previewWorkspace(input)); return }
      if (url.pathname !== base + 'bootstrap/apply') { reply(404, { error: '初始化入口不存在' }); return }
      if (phase === 'applying' || phase === 'ready') { reply(409, { error: '初始化正在进行，请等待当前操作完成' }); return }
      phase = 'applying'; error = undefined
      try {
        const plan = await previewWorkspace(input)
        if (input.previewRevision !== plan.revision) throw new Error('初始化内容已变化或尚未预览，请重新预览后执行')
        root = await initializeWorkspace(input)
        const current = await inspectWorkspace(root)
        if (input.action === 'clone' && current.extensions.length) {
          phase = 'idle'
          reply(200, { ok: false, requiresReview: true, root, extensions: current.extensions, normalUrl: current.normalUrl })
          return
        }
        if (extensionDigest(root, current.extensions) !== plan.extensionsDigest) throw new Error('扩展源码在预览后变化，请重新预览后装载')
        await prepare(root)
        handoffService(options.root, root, options.programRoot)
        rememberWorkspace(root)
        writeFileSync(options.resultFile, JSON.stringify({ root }) + '\n', { mode: 0o600, flag: 'wx' })
        phase = 'ready'
        // 回执写完后释放端口，由同一父进程用选定数据根接续正常平台。
        let closing = false
        const handoff = () => { if (!closing) { closing = true; server.close(); server.closeIdleConnections() } }
        if (res.destroyed) handoff()
        else {
          res.once('finish', handoff)
          res.once('close', handoff)
          reply(200, { ok: true, root, normalUrl: current.normalUrl })
        }
      } catch (failure) {
        phase = 'idle'; error = failure instanceof Error ? failure.message : '初始化失败，请检查输入后重试'
        reply(400, { error })
      }
    } catch (failure) { reply(400, { error: failure instanceof Error ? failure.message : '初始化请求失败' }) }
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(options.port, options.host, () => { server.off('error', fail); ok() }) })
  const address = server.address()
  const url = `http://${options.host}:${typeof address === 'object' && address ? address.port : options.port}${base}`
  return { server, url, close: () => new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections() }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('初始化服务需要 Node.js 24 或更新版本')
    if (process.argv[2] === '--check') console.log(JSON.stringify(await inspectWorkspace(process.argv[3])))
    else {
      const options = JSON.parse(process.env.HARNESS_BOOTSTRAP_OPTIONS || '{}')
      const instance = await createBootstrapServer(options)
      console.log(`初始化页面：${instance.url}；请使用启动器给出的一次性访问入口`)
      process.once('SIGTERM', () => instance.close().then(() => process.exit(0)))
      process.once('SIGINT', () => instance.close().then(() => process.exit(130)))
    }
  } catch { console.error('初始化入口无法启动，请检查 Node.js 24、目录权限和端口状态'); process.exitCode = 1 }
}

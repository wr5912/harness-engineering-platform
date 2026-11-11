import { createHash } from 'node:crypto'

type Job = { key: string; controller: AbortController; signal: AbortSignal; waiters: number; running: boolean;
  run: (server: any) => Promise<any>; server: any; resolve: (value: any) => void; reject: (error: unknown) => void; promise: Promise<any>; dispose: () => void }
const jobs = new Map<string, Job>()
const queue: Job[] = []
let running = 0

function pump() {
  while (running < 4 && queue.length) {
    const job = queue.shift()!
    if (job.signal.aborted) continue
    job.running = true; running++
    Promise.resolve().then(() => { job.signal.throwIfAborted(); return job.run({ ...job.server, platformSignal: job.signal }) })
      .then(job.resolve, job.reject).finally(() => {
        running--; if (jobs.get(job.key) === job) jobs.delete(job.key)
        job.dispose(); pump()
      })
  }
}

/** 合并只读发现在途工作；调用者各自取消，不把首个调用者的信号借给其他人。 */
export async function discover<T>(server: any, kind: string, run: (server: any) => Promise<T>): Promise<T> {
  const callerSignal = server.platformSignal as AbortSignal | undefined
  callerSignal?.throwIfAborted()
  const fingerprint = Object.fromEntries(Object.entries(server).filter(([key, value]) => typeof value !== 'function'
    && (!key.startsWith('platform') || ['platformWorkspaceId', 'platformComposition', 'platformToolResources'].includes(key))))
  const key = createHash('sha256').update(JSON.stringify([kind, fingerprint])).digest('hex')
  let job = jobs.get(key)
  if (!job) {
    if (queue.length >= 32) throw new Error(`服务 ${server.id}：发现任务队列已满（4 个执行、32 个等待）；请稍后重试`)
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    let resolve!: Job['resolve'], reject!: Job['reject']
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    job = { key, controller, signal, waiters: 0, running: false, run, server, resolve, reject, promise, dispose: () => {} }
    const current = job
    const aborted = () => {
      if (!current.running) {
        const index = queue.indexOf(current); if (index >= 0) queue.splice(index, 1)
        if (jobs.get(key) === current) jobs.delete(key)
        current.dispose()
      }
      reject(new Error(`服务 ${server.id}：发现${signal.reason?.name === 'TimeoutError' ? '超过 20 秒期限（含排队）' : '已取消'}`))
    }
    signal.addEventListener('abort', aborted, { once: true })
    job.dispose = () => signal.removeEventListener('abort', aborted)
    jobs.set(key, job); queue.push(job)
  }
  const current = job
  current.waiters++
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true; callerSignal?.removeEventListener('abort', aborted)
      if (--current.waiters === 0 && jobs.get(key) === current) {
        jobs.delete(key); current.controller.abort()
      }
      if (error) reject(error); else resolve(value as T)
    }
    const aborted = () => finish(callerSignal?.reason ?? new Error(`服务 ${server.id}：发现已取消`))
    callerSignal?.addEventListener('abort', aborted, { once: true })
    current.promise.then(value => finish(undefined, value), error => finish(error))
    if (callerSignal?.aborted) aborted()
    pump()
  })
}

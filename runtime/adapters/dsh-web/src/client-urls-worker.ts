import { parentPort } from 'node:worker_threads'
import { transformClientUrls } from './client-urls.ts'

// 仍复用唯一转换器；Worker 只隔离 CPU 解析，避免静态首屏使业务租约失效。
parentPort!.on('message', ({ id, source }: { id: number; source: string }) => {
  try { parentPort!.postMessage({ id, code: transformClientUrls(source) }) }
  catch { parentPort!.postMessage({ id }) }
})

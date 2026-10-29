import { previewAgentPackage, packAgent } from '../../../deploy/agent/pack.mts'
import { prepareAgentResources } from '../../../deploy/agent/prepare.mts'

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort(new Error('导出已取消')))
process.on('message', async (message: any) => {
  if (message?.type === 'cancel') { controller.abort(new Error('导出已取消')); return }
  if (message?.type !== 'run') return
  try {
    const hooks = { signal: controller.signal, onProgress: (progress: unknown) => process.send?.({ type: 'progress', progress }) }
    let result
    if (message.command === 'preview') result = await previewAgentPackage(message.input)
    else {
      const preview = await previewAgentPackage(message.input)
      if (!preview.resourceReady && message.input.arch === (process.arch === 'arm64' ? 'arm64' : 'amd64')) await prepareAgentResources(message.input, hooks)
      result = await packAgent(message.input, hooks)
    }
    process.send?.({ type: 'result', result }, () => process.exit(0))
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : '导出未能完成' }, () => process.exit(1))
  }
})

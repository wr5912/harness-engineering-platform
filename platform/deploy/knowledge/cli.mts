import { readFileSync, writeFileSync } from 'node:fs'
import { collectKnowledge } from './index.mts'

// 独立子进程保留现有完整平台 pack 的同步接口；结果文件只在暂存区使用。
const [inputPath, resultPath] = process.argv.slice(2)
try {
  if (!inputPath || !resultPath) throw new Error('缺少知识收集输入')
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  const result = await collectKnowledge(input)
  writeFileSync(resultPath, JSON.stringify(result) + '\n')
  if (result.missing.some(item => item.required)) {
    console.error(`离线知识缺少 ${result.missing.filter(item => item.required).length} 项必需材料；请查看导出预览或生成索引补齐后重试`)
    process.exitCode = 1
  }
} catch {
  console.error('离线参考资料收集未完成，请核对知识来源与打包资源')
  process.exitCode = 1
}

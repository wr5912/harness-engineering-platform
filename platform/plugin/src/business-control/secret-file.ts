import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** 共享密钥属于本地状态：配置保存相对路径，读取时按当前数据根解析。 */
export function resolveBusinessSecretFile(assetRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(assetRoot, value)
}

/** 缺失时初始化；已有文件保留，不因重启覆盖。 */
export function ensureBusinessSecret(assetRoot: string, value: string): string {
  const file = resolveBusinessSecretFile(assetRoot, value)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    try { writeFileSync(file, randomBytes(48), { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (statSync(file).size < 32) throw new Error('业务接入共享密钥必须至少为 32 字节')
  return file
}

/** 官方包由同镜像安装闭包生成链接，业务源码不安装另一份 Runtime。 */
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installationClosure } from './prepare-verification-home.mjs'

export function prepareSdkModuleLinks(destination: string): void {
  const packages = installationClosure('/opt/dsh/apps/cli/package.json')
  for (const [name, installed] of packages) {
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      if (!lstatSync(target).isSymbolicLink() || realpathSync(target) !== realpathSync(installed)) throw new Error(`官方 SDK 依赖投影不一致：${name}`)
      continue
    }
    symlinkSync(installed, target)
  }
}

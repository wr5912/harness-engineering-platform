import { readFileSync } from 'node:fs'

// 固定上游源码的版本常量；local channel 明确表示源码启动，并非官方发行制品。
const cli = JSON.parse(readFileSync('/opt/opencode/packages/cli/package.json', 'utf8'))
Object.assign(globalThis, { OPENCODE_VERSION: cli.version, OPENCODE_CHANNEL: 'local', OPENCODE_ARTIFACT: 'cli-source' })
const credential = JSON.parse(readFileSync('/run/sample/server-credential.json', 'utf8'))
if (typeof credential.password !== 'string' || credential.password.length < 24) throw new Error('样本服务凭据无效')
process.env.OPENCODE_SERVER_PASSWORD = credential.password

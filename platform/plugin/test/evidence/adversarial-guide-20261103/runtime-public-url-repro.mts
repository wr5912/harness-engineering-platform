import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createPlatformReadClient } from '../../runtime/research/platform-replay-input.mts'
const root = mkdtempSync(resolve('.local/audit-guide-20261103/public-url-'))
mkdirSync(join(root, 'config')); mkdirSync(join(root, '.local/platform-service'), { recursive: true })
writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-public-url-audit' }))
const publicUrl = 'https://platform.example.invalid/hep/', internalUrl = 'http://127.0.0.1:18120/hep/'
writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ gateway: { managementUrl: publicUrl } }))
const state = { url: internalUrl, publicUrl, dataRoot: root }
const file = join(root, '.local/platform-service/state.json')
writeFileSync(file, JSON.stringify(state))
let separatedError = ''
try { await createPlatformReadClient({ url: publicUrl, assetRoot: root }) } catch(e) { separatedError = (e as Error).message }
writeFileSync(file, JSON.stringify({ ...state, url: publicUrl }))
let sameError = ''
try { await createPlatformReadClient({ url: publicUrl, assetRoot: root }) } catch(e) { sameError = (e as Error).message }
const result = { separatePublicUrlRejectedBeforeAuthentication: separatedError === 'PLATFORM_SERVICE_WORKSPACE_MISMATCH', separatedError, matchingBindUrlReachesAccountCheck: sameError.includes('ENOENT'), noNetworkOrCredentialsUsed: true }
writeFileSync(resolve('.local/audit-guide-20261103/runtime-public-url-repro.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))

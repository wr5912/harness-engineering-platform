import { sitePath } from './sites.ts'
import { createMountedWebServer, legacyLanConfig } from './index.ts'
import { runtimeModule } from './resolve-runtime.ts'

const { default: WebServer } = await runtimeModule('@deepseek-ai/dsh-host-webserver', '/opt/dsh/packages/host/webserver/package.json')
const { default: z } = await runtimeModule('@deepseek-ai/schemastery', '/opt/dsh/packages/host/webserver/package.json')
export default createMountedWebServer(WebServer, sitePath('assistant'), undefined, legacyLanConfig(WebServer, z))

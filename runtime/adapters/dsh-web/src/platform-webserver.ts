import { sitePath } from './sites.ts'
import { createMountedWebServer, legacyLanConfig } from './index.ts'
import { runtimeModule, runtimeRequire } from './resolve-runtime.ts'

const { default: WebServer } = await runtimeModule('@deepseek-ai/dsh-host-webserver')
const { default: z } = await runtimeModule('@deepseek-ai/schemastery',
  runtimeRequire('@deepseek-ai/dsh-host-webserver').resolve('@deepseek-ai/dsh-host-webserver'))
export default createMountedWebServer(WebServer, sitePath('platform'), 'Harness工程平台', legacyLanConfig(WebServer, z))

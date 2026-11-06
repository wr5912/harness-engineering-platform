import type { Context } from '@deepseek-ai/cordis'
import { runtimeModule } from '../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
import { DEFAULT_BRANDING, type Branding } from './branding-defaults.ts'

const { default: z } = await runtimeModule('@deepseek-ai/schemastery')

export const name = 'platform-branding'
export const Config = z.object({
  branding: z.object({
    name: z.string().pattern(/\S/).default(DEFAULT_BRANDING.name).volatile(),
    subtitle: z.string().default(DEFAULT_BRANDING.subtitle).volatile(),
  }).default({}),
})
export interface Config { branding: { name: { get(): string }; subtitle: { get(): string } } }

declare module '@deepseek-ai/cordis' {
  interface Context { platformBranding: () => Branding }
}

export function apply(ctx: Context, config: Config) {
  ctx.provide('platformBranding', () => ({ name: config.branding.name.get().trim(), subtitle: config.branding.subtitle.get().trim() }))
  ctx.inject(['settings'], child => {
    const settings = child.get('settings') as { configure(patch: { auto: boolean }, owner: typeof ctx.fiber): () => void }
    child.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })
}

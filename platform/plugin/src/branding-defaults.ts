export interface Branding { name: string; subtitle: string }
export interface BrandingSettings { branding: Branding }

export const BRANDING_NAMESPACE = 'platform-branding'
export const DEFAULT_BRANDING: Branding = { name: 'Harness 工程平台', subtitle: 'Harness Engineering Platform' }

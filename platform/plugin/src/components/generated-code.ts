export type GeneratedCodeKind = 'source' | 'artifact' | 'support' | 'binary'
export interface GeneratedCodeFile {
  path: string
  kind: GeneratedCodeKind
  language: string
  entry: boolean
  bytes: number | null
  sha256: string | null
  built_sha256?: string
  matches_build?: boolean
  asset_path?: string
  missing?: boolean
}
export interface GeneratedCodeCatalog {
  identity: string
  files: GeneratedCodeFile[]
  notes: string[]
}
export interface GeneratedCodeRead {
  identity: string
  path: string
  sha256: string
  bytes: number
  content: string
  complete: boolean
  truncated: boolean
  redacted: boolean
}

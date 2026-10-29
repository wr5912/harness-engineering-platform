declare module 'harness-mcp-manager-server' {
  export function assertConnectionReady(server: any): void
  export const name: string
  export const inject: string[]
  export const Config: any
  export function apply(ctx: any, config: any): void
  export function validateConfiguration(value: { servers: any[]; groups: any[]; sharedToken: string }): void
}
declare module 'harness-mcp-manager-client' {
  import type { ComponentType, ReactNode } from 'react'
  export const Manager: ComponentType<{ view: string; onValidationError(): void; publishedService: any; selectedServerId?: string; selectedGroupId?: string; onSelectGroupId?(id: string): void; onSelectServerId?(id?: string): void; onOpenView?(view: string, serverId?: string, groupId?: string): void; toolbarTarget: HTMLElement | null; renderToolbar?(control: ReactNode, container: HTMLElement): ReactNode; PasswordInput?: ComponentType<any>; SearchSelect?: ComponentType<any>; form: { state: any }; write: (ops: any, revision: string) => Promise<any> }>
}
declare module 'harness-mcp-manager-openapi' {
  export function loadOpenApi(server: any): Promise<any>
  export function execute(source: any, operation: any, args: any): Promise<{ response: Response; text: string; uri: string }>
}

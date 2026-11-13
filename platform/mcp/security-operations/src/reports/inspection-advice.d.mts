export const EXECUTION_BOUNDARY: string
export function codeLabel(code: string): string
export function safeText(value: any): string
export function safeLabel(value: any, fallback?: string): string
export function failureReason(item: any): string
export function operationOf(item: any): string
export function buildAdvice(kind: string, item: any, labelText?: string): {
  advice: string
  verification: string
  executionBoundary: string
  evidenceSummary: string
  safeLabel: string
  reasonCode: string
  failed: boolean
}

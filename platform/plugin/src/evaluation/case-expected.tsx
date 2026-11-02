import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

export function CaseExpected({ text, empty = '尚未填写预期行为。' }: { text?: string; empty?: string }) {
  return <div className="harness-eval-answer harness-eval-expected">{text?.trim()
    ? <MarkdownText text={text} labels={{ code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }} />
    : <p className="harness-eval-muted">{empty}</p>}</div>
}

export function CaseExpectedPreview({ text }: { text: string }) {
  return <details className="harness-eval-expected-preview" open><summary>预期行为阅读预览</summary><CaseExpected text={text} /></details>
}

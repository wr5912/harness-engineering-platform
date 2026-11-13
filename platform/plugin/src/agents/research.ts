import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { programRoot } from '../workspace.ts'
import { managerHome } from '../manager-home.ts'
import { RunFileError, redactRunText } from './run-files.ts'

const TOPICS = new Set(['controlled-improvement', 'evaluation-and-evidence', 'inheritance-and-fusion', 'compute-variants', 'decision-samples'])

function containedPath(root: string, path: string) {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new RunFileError('path_rejected', '来源必须位于当前工作区指定目录内')
  let cursor = root
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) throw new RunFileError('not_found', '当前工作区缺少指定资料')
    if (lstatSync(cursor).isSymbolicLink()) throw new RunFileError('path_rejected', '研究资料不得通过符号链接访问')
  }
  return target
}

export function readResearchReference(root: string, topic: unknown) {
  if (typeof topic !== 'string' || !TOPICS.has(topic)) throw new RunFileError('invalid_request', '请选择已有的研究主题')
  const path = `docs/harness-research/${topic}.md`
  const target = containedPath(managerHome(root), path)
  if (!lstatSync(target).isFile() || lstatSync(target).size > 128 * 1024) throw new RunFileError('path_rejected', '研究资料必须是最多 128 KiB 的文本文件')
  const bytes = readFileSync(target)
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new RunFileError('path_rejected', '研究资料必须是 UTF-8 文本') }
  return { topic, path, content: redactRunText(content), sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function researchCommand(root: string, script: string, path: string, signal?: AbortSignal) {
  let stdout = '', exitCode = 0
  try {
    ({ stdout } = await promisify(execFile)(process.env.HARNESS_PYTHON || 'python3', [join(programRoot(), 'runtime/research', script), path], {
      cwd: root, env: { ...process.env, HARNESS_ASSET_ROOT: root, HARNESS_PROGRAM_ROOT: programRoot() },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal,
    }))
  } catch (error) {
    const failed = error as Error & { code?: number | string; stdout?: string; killed?: boolean }
    // 校验不通过也是有效结果；只有工具崩溃、超时或取消作为调用失败。
    if (failed.killed || signal?.aborted || ![1, 2].includes(Number(failed.code)) || !failed.stdout) {
      throw new RunFileError(signal?.aborted ? 'aborted' : 'command_failed', signal?.aborted ? '研究检查已取消' : '研究检查未完成')
    }
    stdout = failed.stdout
    exitCode = Number(failed.code)
  }
  let report: Record<string, unknown>
  try { report = JSON.parse(redactRunText(stdout)) }
  catch { throw new RunFileError('command_failed', '研究检查未返回有效结果') }
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || (script === 'validate_experiment.py' ? typeof report.valid !== 'boolean' || exitCode !== (report.valid ? 0 : 1)
      : !['pass', 'review_required', 'fail', 'error'].includes(String(report.status))
        || exitCode !== (report.status === 'pass' ? 0 : report.status === 'error' ? 2 : 1))) {
    throw new RunFileError('command_failed', '研究检查结果格式无效')
  }
  return { ...report, exit_code: exitCode }
}

export async function validateResearch(root: string, experimentId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const path = `evolution/experiments/${experimentId}`
  if (!lstatSync(containedPath(root, path)).isDirectory()) throw new RunFileError('path_rejected', 'Experiment 必须是当前工作区中的实体目录')
  return { path, ...await researchCommand(root, 'validate_experiment.py', path, signal) }
}

export async function inspectLegacy(root: string, path: unknown, signal?: AbortSignal) {
  if (typeof path !== 'string' || !path.trim()) throw new RunFileError('invalid_request', '缺少待清点的来源路径')
  const target = containedPath(root, path)
  const rel = relative(join(root, 'evolution/history/imports'), target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new RunFileError('path_rejected', '请选择 evolution/history/imports 内的一项来源')
  const source = relative(root, target).split(sep).join('/')
  return { path: source, ...await researchCommand(root, 'inspect_source.py', source, signal) }
}

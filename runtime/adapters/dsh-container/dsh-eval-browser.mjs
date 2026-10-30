#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import {
  SAFETY_STOP_REASONS,
  assertSessionIdentity,
  parseArchive,
  result,
  saveCaseResult,
  saveEvidence,
  turnsFromTrace,
  waitForSessionTree,
  withCaseTimeout,
} from './dsh-eval-common.mjs'

const COMPOSER = '[data-composer-input][contenteditable="true"]'
let evidenceRoot
let startupStage = 'input'

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cases)) throw new Error('invalid-payload')
  for (const name of ['auth_url', 'workspace', 'preset_id', 'evidence_root']) {
    if (typeof payload[name] !== 'string' || payload[name] === '') throw new Error('invalid-payload')
  }
  if (!Number.isInteger(payload.timeout_ms) || payload.timeout_ms < 1) throw new Error('invalid-payload')
  for (const item of payload.cases) {
    if (!item || typeof item !== 'object' || !/^U-[A-Z0-9-]+$/.test(item.case_id ?? '')
      || !Array.isArray(item.inputs) || item.inputs.length === 0
      || item.inputs.some(input => typeof input !== 'string' || input === '')
      || typeof item.expected_behavior !== 'string' || item.expected_behavior === '') {
      throw new Error('invalid-case')
    }
  }
  return payload
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function poll(action, accept, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('case-hard-timeout')
    try {
      const value = await action()
      if (accept(value)) return value
    } catch (error) {
      if (SAFETY_STOP_REASONS.has(error?.message)) throw error
    }
    await delay(300)
  }
  throw new Error('poll-timeout')
}

function diagnostic(error) {
  return `${error?.name ?? 'Error'}:${error?.message ?? 'unknown'}`
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/token=[^&\s]+/g, 'token=<redacted>')
    .slice(0, 300)
}

async function rpc(page, method, args) {
  const response = await page.request.post(new URL(`api/${method}`, page.url()).href, {
    data: {
      type: 'client-request',
      rpcId: `dsh-eval-${crypto.randomUUID()}`,
      method,
      payload: { args },
    },
  })
  if (!response.ok()) throw new Error('runtime-rpc-failed')
  const body = await response.json()
  if (!body?.result?.ok) throw new Error('runtime-rpc-failed')
  return body.result.value
}

async function listSessions(page) {
  const value = await rpc(page, 'session/list', { _request: {} })
  if (!Array.isArray(value?.items)) throw new Error('session-list-failed')
  return value.items
}

async function exportSession(page, sessionId) {
  const url = new URL('api/session.export', page.url())
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('includeDescendants', 'true')
  const response = await page.request.get(url.href)
  if (!response.ok()) throw new Error('session-export-failed')
  return parseArchive(new Uint8Array(await response.body()))
}

async function resolveNewSession(page, existingSessions, input, presetId, workspace, timeoutMs, signal) {
  const session = await poll(
    async () => (await listSessions(page)).find(item =>
      (!existingSessions.has(item.sessionId) || item.updatedAt > existingSessions.get(item.sessionId))
      && item.projections?.values?.turnOutline?.at(-1)?.prompt === input
      && item.origin !== 'subagent' && item.parentSessionId === undefined),
    item => item !== undefined,
    timeoutMs,
    signal,
  )
  return {
    session_id: session.sessionId,
    ...assertSessionIdentity(session, presetId, workspace),
  }
}

async function dismissTestingNotice(page, timeoutMs) {
  const notice = page.getByRole('dialog', { name: /^(Internal Testing Notice|内测声明)$/ })
  try {
    await notice.waitFor({ state: 'visible', timeout: timeoutMs })
    await notice.getByRole('button').last().click({ timeout: timeoutMs })
    return true
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error
    return false
  }
}

async function clickAfterNotice(page, locator, timeoutMs) {
  try {
    await locator.click({ timeout: 5000 })
    return false
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error
    const dismissed = await dismissTestingNotice(page, 5000)
    await locator.click({ timeout: timeoutMs })
    return dismissed
  }
}

async function connectWorkspace(page, workspace, timeoutMs) {
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ })
  const composer = page.locator(COMPOSER).last()
  let noticeDismissed = false
  const state = await poll(async () => {
    noticeDismissed = await dismissTestingNotice(page, 500) || noticeDismissed
    return {
      ready: await composer.isVisible().catch(() => false),
      chooser: await chooser.isVisible().catch(() => false),
    }
  }, value => value.ready || value.chooser, timeoutMs)
  if (state.ready) return { testing_notice_dismissed: noticeDismissed, workspace_action: 'already-registered' }
  noticeDismissed = await clickAfterNotice(page, chooser, timeoutMs) || noticeDismissed
  await page.getByRole('menuitem', { name: /^(Add workspace|添加工作区)/ }).click({ timeout: timeoutMs })
  const dialog = page.getByRole('dialog').last()
  await dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ }).click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
  await composer.waitFor({ timeout: timeoutMs })
  return { testing_notice_dismissed: noticeDismissed, workspace_action: 'selected' }
}

async function send(page, text, timeoutMs) {
  const composer = page.locator(COMPOSER).last()
  await composer.waitFor({ timeout: timeoutMs })
  await composer.fill(text)
  await composer.press('Enter')
  await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: text }).last()
    .waitFor({ timeout: timeoutMs })
}

async function waitForTurns(page, sessionId, inputs, timeoutMs, signal) {
  let archive
  const cookies = await page.context().cookies(page.url())
  try {
    await waitForSessionTree({ baseUrl: new URL(page.url()), cookie: cookies.map(row => `${row.name}=${row.value}`).join('; ') }, sessionId, timeoutMs, signal, async () => {
      try { archive = await exportSession(page, sessionId) }
      catch (error) { if (SAFETY_STOP_REASONS.has(error?.message) || signal?.aborted) throw error }
    })
    const turns = await poll(async () => {
      archive = await exportSession(page, sessionId)
      return turnsFromTrace(archive, inputs)
    }, value => value !== null, timeoutMs, signal)
    return { archive, turns }
  } catch (error) { error.archive = archive; throw error }
}

async function waitForDisplayedTurn(page, sessionId, turn, timeoutMs, signal) {
  if (turn.turn === null) throw new Error('turn-render-key-missing')
  await page.locator(`[data-row-key="session:${sessionId}"]`).click({ timeout: timeoutMs })
  const assistantPrefix = `${'assistant-step'.length}:assistant-step${turn.turn}:`
  return await poll(() => page.locator(`[data-chat-anchor-key^="${assistantPrefix}"]`).last()
    .isVisible().catch(() => false), visible => visible, timeoutMs, signal)
}

async function runCase(page, payload, item, uiStartup, signal) {
  const existingSessions = new Map((await listSessions(page))
    .map(session => [session.sessionId, session.updatedAt]))
  const newSession = page.getByRole('button', { name: /^(New session|新会话|新建会话)$/ }).last()
  uiStartup.testing_notice_dismissed =
    await clickAfterNotice(page, newSession, payload.timeout_ms) || uiStartup.testing_notice_dismissed
  let session = null
  let completed
  for (let index = 0; index < item.inputs.length; index += 1) {
    await send(page, item.inputs[index], payload.timeout_ms)
    if (session === null) {
      session = await resolveNewSession(
        page, existingSessions, item.inputs[index], payload.preset_id, payload.workspace, payload.timeout_ms, signal,
      )
    }
    completed = await waitForTurns(
      page, session.session_id, item.inputs.slice(0, index + 1), payload.timeout_ms, signal,
    )
    try {
      await waitForDisplayedTurn(page, session.session_id, completed.turns.at(-1), payload.timeout_ms, signal)
    } catch (error) {
      error.archive = completed.archive
      throw error
    }
  }
  const { archive, turns } = completed
  if (signal?.aborted) throw new Error('case-hard-timeout')
  const response = {
    inputs: item.inputs,
    assistant_texts: turns.map(turn => turn.assistant_text),
    session_id: session.session_id,
    turns,
  }
  const checks = {
    schema_version: '1.0',
    case_id: item.case_id,
    transport: 'browser',
    expected_behavior: item.expected_behavior,
    ...session,
    ui_startup: uiStartup,
    trace_format: 'dsh-session-export-envelope-v1',
    root_session_log: archive.rootName,
    completed: turns.every(turn => turn.turn_reason === 'completed'),
  }
  checks.ui_smoke_passed = checks.completed && turns.every(turn => turn.assistant_text.trim() !== '')
  if (!checks.ui_smoke_passed) {
    await saveEvidence(payload.evidence_root, item, response, archive, checks)
    return result(item, 'error', 'inconclusive',
      checks.completed ? '页面回答为空。' : 'DSH Turn 未正常完成。',
      checks.completed ? 'empty-assistant-reply' : 'turn-not-completed')
  }
  await saveEvidence(payload.evidence_root, item, response, archive, checks)
  return result(item, 'completed', 'inconclusive', '浏览器冒烟通过：目标会话完成且页面显示回答；业务语义需由 API Run 判定。')
}

async function main() {
  const payload = await readInput()
  evidenceRoot = payload.evidence_root
  startupStage = 'browser-launch'
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const rows = []
  let stopReason
  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const page = await context.newPage()
    startupStage = 'page-open'
    await page.goto(payload.auth_url, { waitUntil: 'domcontentloaded', timeout: payload.timeout_ms })
    startupStage = 'workspace-connect'
    await page.locator('[class*="frame"]').waitFor({ timeout: payload.timeout_ms })
    const uiStartup = await connectWorkspace(page, payload.workspace, payload.timeout_ms)
    startupStage = 'case-run'
    for (const item of payload.cases) {
      try {
        rows.push(await withCaseTimeout(
          signal => runCase(page, payload, item, uiStartup, signal),
          payload.timeout_ms * (item.inputs.length + 2),
        ))
      } catch (error) {
        const reason = SAFETY_STOP_REASONS.has(error?.message) ? error.message : 'browser-case-error'
        const directory = join(payload.evidence_root, item.case_id)
        await mkdir(directory, { recursive: true })
        try { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }) } catch {}
        await saveEvidence(payload.evidence_root, item,
          { inputs: item.inputs, assistant_texts: [] }, error?.archive ?? null,
          {
            schema_version: '1.0', case_id: item.case_id, transport: 'browser',
            completed: false, failure_reason: reason, failure_detail: diagnostic(error),
          })
        rows.push(result(item, 'error', 'inconclusive',
          reason === 'browser-case-error' ? '浏览器用例未完成，未产生语义结论。' : '评测身份或证据失配，已停止。',
          reason))
        if (SAFETY_STOP_REASONS.has(reason)) {
          stopReason = reason
          await saveCaseResult(payload.evidence_root, rows.at(-1))
          break
        }
      }
      await saveCaseResult(payload.evidence_root, rows.at(-1))
    }
    await context.close()
  } finally {
    await browser.close()
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: '1.0',
    executor: 'browser',
    rows,
    ...(stopReason ? { stop_reason: stopReason } : {}),
  })}\n`)
}

main().catch(async error => {
  const detail = diagnostic(error)
  if (evidenceRoot) {
    try {
      await mkdir(evidenceRoot, { recursive: true })
      await writeFile(join(evidenceRoot, 'browser-startup-error.json'),
        `${JSON.stringify({ stage: startupStage, failure_detail: detail })}\n`)
    } catch {}
  }
  process.stderr.write(`dsh-eval-browser failed: ${startupStage}: ${detail}\n`)
  process.exitCode = 2
})

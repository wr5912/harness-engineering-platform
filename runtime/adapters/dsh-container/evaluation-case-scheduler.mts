type Case = { case_id: string }

export function validateCaseSchedule(cases: Case[], concurrency = 1, parallelCases: string[] = []) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Array.isArray(parallelCases) || new Set(parallelCases).size !== parallelCases.length
    || new Set(cases.map(item => item.case_id)).size !== cases.length
    || parallelCases.some(id => typeof id !== 'string' || !cases.some(item => item.case_id === id))) {
    throw new Error('invalid-case-schedule')
  }
}

/** 只有调用者明确确认互不影响的 Case 可并行；其余 Case 是独占屏障。 */
export async function scheduleCases<T extends Case, R>(cases: T[], concurrency: number, parallelCases: string[],
  execute: (item: T) => Promise<{ row: R; stop_reason?: string }>) {
  validateCaseSchedule(cases, concurrency, parallelCases)
  const parallel = new Set(parallelCases), rows = new Map<number, R>()
  let stopReason: string | undefined
  let failure: unknown
  async function run(index: number) {
    try {
      const result = await execute(cases[index])
      rows.set(index, result.row)
      if (result.stop_reason && !stopReason) stopReason = result.stop_reason
    } catch (error) { failure ??= error }
  }
  let next = 0
  while (next < cases.length && !stopReason && !failure) {
    if (!parallel.has(cases[next].case_id)) { await run(next++); continue }
    const start = next
    while (next < cases.length && parallel.has(cases[next].case_id)) next++
    const end = next
    let cursor = start
    await Promise.all(Array.from({ length: Math.min(concurrency, end - start) }, async () => {
      while (cursor < end && !stopReason && !failure) await run(cursor++)
    }))
  }
  // 已发出的请求收尾后再报告；不取消后重放状态未知的外部动作。
  if (failure) throw failure
  return { rows: [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row),
    ...(stopReason ? { stop_reason: stopReason } : {}) }
}

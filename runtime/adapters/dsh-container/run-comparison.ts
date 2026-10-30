#!/usr/bin/env node
/** Compare two frozen Run views without changing either Run. */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

type Trial = { execution_status: string; verdict: string; observation: string };
type ActualRoute = { provider?: string | null; model?: string | null; reasoningEffort?: string | null };
type Case = {
  case_id: string; frozen: unknown; trials: Trial[]; output: unknown;
  actual_routes: Array<ActualRoute | null> | null;
  registered_tools?: Array<string[] | null> | null;
  tool_calls?: Array<{ name: string | null; status: string; error_code?: string | null }>;
  review: { reviewed_verdict?: string; reason?: string } | null;
  load_observation: { preset_matches?: boolean; workspace_matches?: boolean; guard?: { status?: string } } | null;
  evidence: Array<{ path: string; present: boolean }>;
};
type View = {
  run_id: string; run_path: string; manifest: { agent_id: string; status: string };
  source: Record<string, any>; image: Record<string, any> | null;
  cases: Case[]; missing: string[];
};

const { left, right } = JSON.parse(readFileSync(0, 'utf8')) as { left: View; right: View };
if (left.manifest.agent_id !== right.manifest.agent_id) throw new Error('只能比较同一 Agent 的 Run');

const limits: string[] = [];
const limit = (value: string) => { if (!limits.includes(value)) limits.push(value); };
const value = (item: unknown) => item === null || item === undefined || item === '' ? '未记录' : String(item);
const cell = (item: unknown) => value(item).replaceAll('|', '\\|').replaceAll('\n', '<br>');
const link = (path: string, label: string) => `[${label}](${posix.relative(right.run_path, path)})`;
const trialVerdicts = (item: Case) => item.trials.map(row => `${row.execution_status}/${row.verdict}`).join('、') || '未记录';
const observation = (item: Case) => item.review?.reason || item.trials.map(row => row.observation).join('；') || '未记录';
const routeFields = ['provider', 'model', 'reasoningEffort'] as const;
const routes = (item: Case) => item.actual_routes?.map(route =>
  routeFields.map(field => route?.[field] ?? null)) ?? null;
const routeLabels = (item: Case) => item.actual_routes?.map(route =>
  `${value(route?.provider)} / ${value(route?.model)} / reasoningEffort=${value(route?.reasoningEffort)}`) || [];

for (const field of ['executor', 'model'] as const) {
  const a = left.source[field], b = right.source[field];
  if (!a || !b) limit(`${field}: 未记录`);
  else if (a !== b) limit(`${field}: 不同`);
}
for (const field of ['review_mode', 'configured_capabilities', 'dependency_env', 'evaluation_implementation']) {
  const a = left.source[field], b = right.source[field];
  if (!a || !b) limit(`${field}: 未记录`);
  else if (!isDeepStrictEqual(a, b)) limit(`${field}: 不同`);
}
if (!isDeepStrictEqual(left.source.mcp_fixture ?? null, right.source.mcp_fixture ?? null)) limit('mcp_fixture: Mock 环境或冻结连接映射不同');
for (const [side, run] of [['left', left], ['right', right]] as const) {
  if (!run.source.source_ref && run.source.git_version?.dirty !== false) limit(`${side}: Git 来源不干净或未记录`);
  if (!run.source.program_origin?.commit) limit(`${side}: 平台程序来源未记录`);
  if (run.source.program_origin?.dirty !== false) limit(`${side}: 平台程序来源不干净或未记录`);
  if (run.missing.length) limit(`${side}: 缺少证据或记录（${run.missing.join('；')}）`);
}
if (left.source.program_origin?.commit !== right.source.program_origin?.commit)
  limit('program_origin: 平台程序提交不同');
for (const field of ['image_build_fingerprint', 'local_image_id']) {
  const a = left.image?.[field], b = right.image?.[field];
  if (!a || !b) limit(`${field}: 缺少实际镜像证据`);
  else if (a !== b) limit(`${field}: 不同`);
}

const leftCases = new Map(left.cases.map(item => [item.case_id, item]));
const rightCases = new Map(right.cases.map(item => [item.case_id, item]));
const shared = [...leftCases.keys()].filter(id => rightCases.has(id)).sort();
const leftOnly = [...leftCases.keys()].filter(id => !rightCases.has(id)).sort();
const rightOnly = [...rightCases.keys()].filter(id => !leftCases.has(id)).sort();
if (!shared.length) limit('没有共同 Case');
if (leftOnly.length || rightOnly.length) limit('选择的 Case 集合不同');
const cases = shared.map(case_id => {
  const a = leftCases.get(case_id)!, b = rightCases.get(case_id)!;
  const frozen_contract_same = isDeepStrictEqual(a.frozen, b.frozen);
  if (!frozen_contract_same) limit(`${case_id}: 冻结 Case 口径不同`);
  for (const [side, item] of [['left', a], ['right', b]] as const) {
    if (!item.load_observation?.preset_matches || !item.load_observation?.workspace_matches)
      limit(`${case_id}: ${side} 缺少正确装载观察`);
    const source = side === 'left' ? left.source : right.source;
    if (source.declared_guard && item.load_observation?.guard?.status !== 'verified')
      limit(`${case_id}: ${side} 来源声明的 Guard 实际激活未验证`);
  }
  for (const [side, item] of [['left', a], ['right', b]] as const) {
    if (!item.actual_routes?.length) limit(`${case_id}: ${side} 缺少实际模型路由记录`);
    item.actual_routes?.forEach((route, index) => {
      const missing = routeFields.filter(field => typeof route?.[field] !== 'string' || !route[field]?.trim());
      if (missing.length) limit(`${case_id}: ${side} 第 ${index + 1} 轮实际模型路由未记录 ${missing.join(' / ')}`);
    });
  }
  if (!isDeepStrictEqual(routes(a), routes(b)))
    limit(`${case_id}: 实际模型路由不同（provider / model / reasoningEffort）`);
  if (!a.trials.length || !b.trials.length) limit(`${case_id}: 缺少 Trial 结果`);
  for (const [side, item] of [['left', a], ['right', b]] as const) {
    if (item.tool_calls?.some(call => call.status !== 'ok')) limit(`${case_id}: ${side} 工具调用失败或结果未知`);
    if (case_id.startsWith('U-INS-') && !item.tool_calls?.some(call =>
      call.name?.startsWith('mcp__inspection__') && call.status === 'ok'))
      limit(`${case_id}: ${side} 巡检服务依赖未确认可用`);
  }
  return {
    case_id, frozen_contract_same,
    left_trials: a.trials, right_trials: b.trials,
    left_output: a.output, right_output: b.output,
    left_actual_routes: a.actual_routes, right_actual_routes: b.actual_routes,
    left_review: a.review, right_review: b.review,
    left_registered_tools: a.registered_tools, right_registered_tools: b.registered_tools,
    left_tool_calls: a.tool_calls, right_tool_calls: b.tool_calls,
    left_evidence: a.evidence, right_evidence: b.evidence,
    observed_change: isDeepStrictEqual(
      [trialVerdicts(a), a.review?.reviewed_verdict, observation(a), a.output],
      [trialVerdicts(b), b.review?.reviewed_verdict, observation(b), b.output],
    ) ? '记录相同' : '记录有差异',
  };
});
const comparable = cases.some(item => item.left_trials.length && item.right_trials.length);
const causal_comparable = comparable && limits.length === 0;

const sourceFacts = (run: View) => {
  const trees = Object.entries(run.source.candidate_trees || {})
    .map(([name, tree]: [string, any]) => `${name}: ${value(tree.tree_sha256)}`).join('<br>') || '未记录';
  const actualModels = [...new Set(run.cases.flatMap(routeLabels))].join('、') || '未记录';
  return {
    'Run': link(`${run.run_path}/report.md`, run.run_id),
    'Git': `${cell(run.source.git_version?.commit)}；dirty=${cell(run.source.git_version?.dirty)}`,
    '固定运行来源': cell(run.source.source_ref ?? '当前工作树'),
    '接口环境': run.source.mcp_fixture ? `mock；冻结连接映射 ${cell(run.source.mcp_fixture.sha256)}，不代表真实业务系统` : '未声明 Mock 连接映射',
    '平台程序': `${cell(run.source.program_origin?.commit)}；dirty=${cell(run.source.program_origin?.dirty)}`,
    '执行与评审实现': run.source.evaluation_implementation
      ? link(`${run.run_path}/inputs.lock.json`, `已冻结 ${Object.keys(run.source.evaluation_implementation).length} 项文件`)
      : '未记录',
    'Candidate': trees,
    '执行器 / 预期模型': `${cell(run.source.executor)} / ${cell(run.source.model)}`,
    '实际模型路由': cell(actualModels),
    '实际镜像': `${cell(run.image?.image_build_fingerprint)}；${cell(run.image?.local_image_id)}`,
    '插件配置 / 依赖变量': `${cell(run.source.candidate_trees?.managed?.tree_sha256)}；${cell(JSON.stringify(run.source.dependency_env || {}))}`,
    '硬件 / 资源消耗': '未记录',
  };
};
const evidenceLinks = (items: Case['evidence']) => items.length
  ? items.map(item => item.present ? link(item.path, posix.basename(item.path)) : `${cell(item.path)}（缺失）`).join('、')
  : '未记录';
const leftFacts = sourceFacts(left), rightFacts = sourceFacts(right);
const markdown = [
  '## 与之前版本的对比', '',
  '这是两次 Run 的观察性对照；模型、执行器、镜像、输入口径或环境有差异时，不能单独归因于 Harness。', '',
  '| 来源 | 旧版 | 新版 |', '| --- | --- | --- |',
  ...Object.entries(leftFacts).map(([name, oldValue]) =>
    `| ${name} | ${oldValue} | ${rightFacts[name as keyof typeof rightFacts]} |`),
  '',
  `- 共同 Case：${shared.join('、') || '无'}；仅旧版：${leftOnly.join('、') || '无'}；仅新版：${rightOnly.join('、') || '无'}。`,
  `- 可观察对照：${comparable ? '有共同 Case 结果' : '缺少共同 Case 结果'}；因果归因：${causal_comparable ? '条件一致，但仍需结合实验设计判断' : '受下列限制，不能认定 Harness 单独导致差异'}。`,
  ...limits.map(item => `- 限制：${cell(item)}`),
  '',
  '| Case | 冻结口径 | 旧 Trial / 复核 | 新 Trial / 复核 | 实际工具调用 | 观察 | 旧证据 | 新证据 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...shared.map(id => {
    const a = leftCases.get(id)!, b = rightCases.get(id)!;
    const decision = (item: Case) => `${trialVerdicts(item)} / ${value(item.review?.reviewed_verdict)}`;
    const change = cases.find(item => item.case_id === id)!.observed_change;
    const calls = (item: Case) => item.tool_calls?.map(call => `${call.name}: ${call.status}${call.error_code ? `(${call.error_code})` : ''}`).join('、') || '未调用';
    return `| ${cell(id)} | ${isDeepStrictEqual(a.frozen, b.frozen) ? '相同' : '不同'} | ${cell(decision(a))} | ${cell(decision(b))} | 旧：${cell(calls(a))}；新：${cell(calls(b))} | ${change}；旧：${cell(observation(a))}；新：${cell(observation(b))} | ${evidenceLinks(a.evidence)} | ${evidenceLinks(b.evidence)} |`;
  }),
  ...(shared.length ? [] : ['| - | - | - | - | - | 无共同 Case | - | - |']),
  '',
].join('\n');

process.stdout.write(JSON.stringify({
  left_run: left.run_id, right_run: right.run_id,
  left_source: left.source, right_source: right.source,
  left_image: left.image, right_image: right.image,
  comparable, causal_comparable, limits, cases, left_only: leftOnly, right_only: rightOnly,
  left_missing: left.missing, right_missing: right.missing, markdown,
}));

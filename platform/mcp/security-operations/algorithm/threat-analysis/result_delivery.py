"""将研判结果及独立校验状态投影为摘要和阅读视图；不推理、不改写原始结论、不调用保存接口。"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
from pathlib import Path

SOURCES = {'alert_whitelist': '告警白名单', 'intel_whitelist': '情报白名单', 'intel_blacklist': '情报黑名单'}
FULL_FIELDS = ('primary_claim', 'secondary_findings', 'confidence_score', 'attack_stage',
               'technique', 'technique_name', 'counter_evidence', 'uncertainty_notes',
               'attack_chain_speculation', 'rule_optimization_suggestions',
               'recommended_actions', 'reasoning_summary')
EMPTY = '本次结果未列出'


def text(value):
    if value is None:
        return '未提供'
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def md(value):
    # 所有外部值作为文字展示，不能注入链接、HTML 或表格结构。
    value = html.escape(text(value), quote=False)
    return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])', r'\\\1', value).replace('\n', '<br>').replace('\r', '')


class ReadingView:
    """同一排版内容同时输出 Markdown 和 HTML，避免两份模板的字段漂移。"""
    def __init__(self):
        self.markdown = []
        self.html = []

    def heading(self, title, level=4):
        self.markdown.append('#' * level + ' ' + title)
        self.html.append(f'<h{level-2}>{html.escape(title)}</h{level-2}>')

    def paragraph(self, value):
        self.markdown.append(md(value))
        self.html.append('<p>' + html.escape(text(value)).replace('\n', '<br>') + '</p>')

    def field(self, label, value):
        self.markdown.append(f'**{label}：** {md(value)}')
        self.html.append(f'<p><strong>{label}：</strong> {html.escape(text(value))}</p>')

    def table(self, headers, rows):
        rows = list(rows)
        if not rows:
            self.paragraph(EMPTY)
            return
        self.markdown.append('\n'.join(['| ' + ' | '.join(headers) + ' |',
                                        '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                                       ['| ' + ' | '.join(md(v) for v in row) + ' |' for row in rows]))
        self.html.append('<div class="table-wrap"><table><thead><tr>' +
                         ''.join('<th>' + html.escape(h) + '</th>' for h in headers) +
                         '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(
                             '<td>' + html.escape(text(v)).replace('\n', '<br>') + '</td>' for v in row
                         ) + '</tr>' for row in rows) + '</tbody></table></div>')


def full_view(view, raw, report):
    view.heading('核心判断')
    primary = raw.get('primary_claim') or {}
    view.field('原始主张', primary.get('type') if isinstance(primary, dict) else primary)
    view.field('主张判断', primary.get('result') if isinstance(primary, dict) else None)
    secondary = raw.get('secondary_findings')
    view.field('其他攻击发现', '无' if secondary is None else
               (' · '.join(text(secondary.get(k)) for k in ('type', 'description'))
                if isinstance(secondary, dict) else secondary))
    for label, key in [('攻击阶段', 'attack_stage'), ('攻击技术', 'technique'), ('技术名称', 'technique_name')]:
        view.field(label, raw.get(key))
    claims = raw.get('key_claims', [])
    if report:
        view.heading('已观察事实')
        view.table(['事实 ID', '事实描述', '来源'], ((r.get('id'), r.get('fact'), r.get('source')) for r in raw.get('verified_facts', [])))
        view.heading('研判依据与缺口')
        view.table(['主张', '判断', '权重'],
                   ([c.get('claim'), c.get('result'), c.get('weight')] for c in claims))
        view.field('反向证据', EMPTY if not raw.get('counter_evidence') else '见下表')
        if raw.get('counter_evidence'):
            keys = ['claim', 'fact', 'source', 'field', 'value']
            view.table(['受影响主张', '反向事实', '来源', '字段路径', '证据值'],
                       ([c.get(k) for k in keys] for c in raw['counter_evidence']))
        view.field('不确定性', raw.get('uncertainty_notes'))
        view.heading('攻击链分析')
        chain = raw.get('attack_chain_speculation') or {}
        view.field('当前阶段', chain.get('current_stage'))
        view.field('已观察路径', EMPTY if not chain.get('observed_path') else '见下表')
        if chain.get('observed_path'):
            view.table(['已观察行为', '事实引用'], ((r.get('description'), '、'.join(r.get('fact_refs', []))) for r in chain['observed_path']))
        view.field('可能的下一步（推测，尚未观察到）', EMPTY if not chain.get('possible_next_steps') else '见下表')
        if chain.get('possible_next_steps'):
            view.table(['技术', '技术名称', '推测内容'], ((r.get('technique'), r.get('technique_name'), r.get('description')) for r in chain['possible_next_steps']))
        view.field('支撑事实', '、'.join(chain.get('supporting_evidence', [])) or EMPTY)
        view.heading('处置建议')
        view.table(['优先级', '操作', '目标', '原因'],
                   ((r.get('priority'), r.get('action'), r.get('target'), r.get('reason')) for r in raw.get('recommended_actions', [])))
        view.heading('规则优化建议')
        view.table(['规则层级', '规则 ID', '规则名称', '优化建议'],
                   ((r.get('rule', {}).get('level'), r.get('rule', {}).get('id'), r.get('rule', {}).get('name'), r.get('suggestion')) for r in raw.get('rule_optimization_suggestions', [])))
    view.heading('推理摘要')
    view.paragraph(raw.get('reasoning_summary'))
    view.paragraph('置信度表示当前结论的可信程度，不是恶意概率。')
    if report:
        view.heading('证据引用明细')
        view.table(['关联主张序号', '来源', '字段路径 / field', '证据值 / value'],
                   ((i, e.get('source'), e.get('field'), e.get('value'))
                    for i, claim in enumerate(claims, 1) for e in claim.get('evidence', [])))
        view.paragraph('历史研判查询当前尚未接入；五源结构不表示每个来源都有实际证据。')


def build_delivery(run, storage=None):
    if run['status'] != 'completed':
        raise ValueError('formal delivery requires completed analysis')
    raw = run['result']
    fast = run['route'] == 'fast_classification'
    summary = {'unified_event_id': run['incident_id'], 'run_id': run['run_id'],
               'verdict': raw.get('verdict'), 'is_fast': fast, 'validation': run.get('validation', {})}
    if fast:
        summary['matches'] = [{'source': m['source'], 'entity_value': m['entity_value'],
                               'evidence_refs_nums': len(m['evidence_refs']), 'queried_at': m['queried_at']}
                              for m in raw.get('matches', [])]
    else:
        summary.update({k: raw.get(k) for k in FULL_FIELDS})
        claims = raw.get('key_claims', [])
        summary['key_claims'] = ([{k: c.get(k) for k in ('claim', 'result')} for c in claims]
                                 if isinstance(claims, list) and all(isinstance(c, dict) for c in claims)
                                 else claims)
    views = []
    for report in (False, True):
        view = ReadingView()
        view.heading(('威胁事件快速研判报告' if fast else '威胁事件完整研判报告') if report else '威胁事件研判摘要', 3)
        view.field('结论', raw.get('verdict'))
        view.field('快速研判', '是' if fast else '否')
        view.field('事件 ID', run['incident_id'])
        if not fast:
            view.field('结论置信度', raw.get('confidence_score'))
            detail = ReadingView()
            try:
                full_view(detail, raw, report)
            except (TypeError, AttributeError, KeyError):
                # 字段结构错误时保留原文，避免阅读模板再次阻断交付。
                detail = ReadingView()
                detail.heading('字段原文（结构不符合报告模板）')
                detail.paragraph('以下逐字段展示模型原文，不补造缺失字段。')
                for key, value in raw.items():
                    detail.table(['字段', '内容'], [(key, value)])
            view.markdown.extend(detail.markdown)
            view.html.extend(detail.html)
        else:
            view.heading('名单命中依据')
            view.table(['名单来源', '命中实体', '引用条数', '查询时间'],
                       ((SOURCES.get(m['source'], m['source']), m['entity_value'], m['evidence_refs_nums'], m['queried_at']) for m in summary['matches']))
            view.paragraph('引用条数按每条命中分别统计，不代表独立告警数。该结论由名单规则生成，未进行完整行为研判。')
            if report:
                view.heading('名单及证据明细')
                for i, match in enumerate(raw.get('matches', []), 1):
                    view.field('命中序号', i)
                    for label, key in [('来源', 'source'), ('名单条目 ID', 'entry_id'), ('命中实体', 'entity_value'), ('名单版本', 'list_version'), ('查询时间', 'queried_at')]:
                        view.field(label, match.get(key))
                    view.table(['引用序号', '证据引用'], enumerate(match.get('evidence_refs', []), 1))
        if not report:
            view.heading('保存与下载')
            for key, label in [('summary', '摘要存储'), ('report', '报告存储')]:
                state = (storage or {}).get(key, {})
                view.field(label, {'saved': '已保存', 'failed': '保存失败'}.get(state.get('status'), '待接入'))
                if state.get('status') == 'failed':
                    view.field(label + '错误', state.get('error') or state.get('error_type'))
            report_state = (storage or {}).get('report', {})
            url = report_state.get('download_url')
            if url:
                safe_url = urllib.parse.quote(url, safe=':/?=&%#@+,$;~')
                view.markdown.append('**报告下载：** [下载 HTML 报告](<' + safe_url + '>)')
            else:
                view.field('报告下载', '已保存，未返回有效下载链接' if report_state.get('status') == 'saved' else '暂无下载链接')
        view.field('运行 ID', run['run_id'])
        views.append(view)
    css = (Path(__file__).parent / 'report.css').read_text(encoding='utf-8')
    color = {'误报': 'benign', '真实告警': 'danger'}.get(text(raw.get('verdict')), 'uncertain')
    report_html = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                   '<meta name="viewport" content="width=device-width,initial-scale=1">'
                   '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
                   '<title>威胁事件研判报告</title><style>' + css + '</style></head><body><main class="paper ' + color + '">' +
                   ''.join(views[1].html) + '</main></body></html>')
    return {'summary': summary, 'markdown': '\n\n'.join(views[0].markdown) + '\n', 'report_html': report_html,
            'storage': storage if storage is not None else {'summary': 'not_configured', 'report': 'not_configured'}}


def failure_markdown(run):
    status = {'claim_failed': 'SOC 事件认领失败，未开始取证', 'evidence_failed': '取证失败', 'model_failed': '模型调用失败', 'contract_failed': '模型输出无法解析为研判 JSON 对象'}.get(run['status'], '研判未完成')
    if run['status'] == 'claim_failed' and run.get('error_code') == 409:
        status = '该事件已被认领且锁未过期，未重复开始研判'
    return f'### 研判未完成\n\n{status}。当前没有可发布的正式结论，未生成正式摘要与报告。\n\n运行 ID：{md(run["run_id"])}\n'

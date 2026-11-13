"""经本轮 MCP bridge 完成 SOC 状态写回与报告保存。"""
from __future__ import annotations

import base64
import copy
import json
import urllib.parse
from pathlib import Path

from mcp_gateway import McpGateway, classify_response, extract_result_data
from fusion_contract import CallOutcome

LIMIT = 1048576
VALIDATION_STATUSES = {'passed', 'passed_with_warnings', 'failed', 'not_applicable_fast_classification'}


def build_writeback(run, report_html):
    raw = run['result']
    verdict = raw.get('verdict')
    if verdict not in ('误报', '真实告警', '可疑'):
        raise ValueError('verdict cannot be mapped to SOC')
    validation = run.get('validation', {}).get('status')
    if validation not in VALIDATION_STATUSES:
        raise ValueError('validationStatus cannot be mapped to SOC')
    if run['status'] != 'completed':
        raise ValueError('incomplete judgement requires SOC fail interface')
    if len(report_html.encode('utf-8')) > LIMIT:
        raise ValueError('reportHtml exceeds 1048576 UTF-8 bytes')
    fast = run['route'] == 'fast_classification'
    summary = f"事件 {run['incident_id']}，{'快速' if fast else '完整'}研判结论：{verdict}。"
    if fast:
        summary += f"命中 {len(raw.get('matches', []))} 条名单记录；依据名单规则生成，未进行完整行为研判。"
    else:
        reasoning = raw.get('reasoning_summary')
        detail = reasoning if isinstance(reasoning, str) else ''
        suffix = '模型输出校验未通过，需人工复核。' if validation == 'failed' else ''
        # 生成独立短摘要，超出时使用固定概述；原文全部保留在 resultJson 和报告。
        summary += (detail if len(summary + detail + suffix) <= 500 else '完整研判依据与建议见报告。') + suffix
    if len(summary) > 500:
        raise ValueError('summary exceeds 500 Unicode code points')
    confidence = None if fast else raw.get('confidence_score')
    if confidence is not None and (isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1):
        raise ValueError('confidence cannot be mapped to SOC')
    result_json = copy.deepcopy({k: v for k, v in run.items() if k != 'delivery'})
    result_json['schema_version'] = '1.0'
    if len(json.dumps(result_json, ensure_ascii=False).encode('utf-8')) > LIMIT:
        raise ValueError('resultJson exceeds 1048576 UTF-8 bytes')
    body = {'runId': run['run_id'], 'route': run['route'], 'llmInvoked': run['llm_invoked'],
            'verdict': verdict, 'validationStatus': validation,
            'summary': summary, 'reportHtml': report_html, 'resultJson': result_json,
            'schemaVersion': '1.0', 'agentName': 'threat-analysis'}
    if confidence is not None:
        body['confidence'] = confidence
    if run.get('model'):
        body['model'] = run['model']
    return body


class SocWriteError(RuntimeError):
    def __init__(self, code=None):
        super().__init__('SOC judgement MCP request failed')
        self.code = code


class SocJudgementClient:
    # 与只读取证入口分开，只能读取待研判列表并执行三个已确认的写入工具。
    TOOLS = {
        'pending': 'ai_soc_correlate__get_correlate_incident_judge_pending',
        'claim': 'ai_soc_correlate__create_incident_judgement_claim',
        'result': 'ai_soc_correlate__update_incident_judgement_result',
        'fail': 'ai_soc_correlate__create_correlate_incident_judgement_fail',
    }

    def __init__(self, gateway, output):
        self.gateway = gateway
        self.output = Path(output)

    def invoke(self, operation, arguments):
        name = self.TOOLS[operation]
        # 请求在网络调用前保存；同一 judgementId/runId 可用原请求重试，不重跑研判。
        self.output.mkdir(parents=True, exist_ok=True)
        (self.output / f'soc-{operation}-request.json').write_text(
            json.dumps(arguments, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        response = self.gateway.invoke_trusted(
            resource='ai_soc_correlate', tool_name=name, arguments=arguments)
        (self.output / f'soc-{operation}-response.json').write_text(
            json.dumps(response, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if not isinstance(response, dict):
            raise SocWriteError()
        if classify_response(response) not in (CallOutcome.SUCCESS_WITH_DATA, CallOutcome.SUCCESS_EMPTY):
            inner = response.get('result')
            raise SocWriteError(inner.get('code', response.get('status_code')) if isinstance(inner, dict) else response.get('status_code'))
        return extract_result_data(response)

    def claim(self, incident_id):
        data = self.invoke('claim', {'incidentId': incident_id})
        if not isinstance(data, dict) or not isinstance(data.get('judgementId'), str) or not data['judgementId']:
            raise ValueError('SOC claim missing judgementId')
        return data

    def pending(self, page_size=100):
        if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
            raise ValueError('pending page size must be between 1 and 100')
        return self.invoke('pending', {'pageNum': 1, 'pageSize': page_size,
                                       'previewPriority': False})

    def write(self, operation, judgement_id, body):
        error = None
        for attempt in range(1, 3):
            try:
                data = self.invoke(operation, {'judgementId': judgement_id, 'body': body})
                # judgementId/runId 保持不变，响应丢失时可由 SOC 幂等重放。
                return {'status': 'saved', 'judgement_id': judgement_id, 'attempts': attempt,
                        'replayed': isinstance(data, dict) and data.get('replayed') is True}
            except Exception as caught:
                error = caught
        state = {'status': 'failed', 'error_type': type(error).__name__, 'attempts': 2}
        if isinstance(error, SocWriteError):
            state['code'] = error.code
        return state


def build_failure_writeback(run):
    # 只传阶段与错误类别，避免异常文本带出连接凭据；详细证据留在本地运行目录。
    body = {'runId': run['run_id'], 'errorType': run.get('error_type', run['status']),
            'error': f"{run['status']}: {run.get('error_type', 'no deliverable result')}",
            'resultJson': copy.deepcopy({k: v for k, v in run.items() if k != 'delivery'}),
            'agentName': 'threat-analysis'}
    if run.get('model'):
        body['model'] = run['model']
    return body


def _persistence_data(response):
    if classify_response(response) not in (CallOutcome.SUCCESS_WITH_DATA, CallOutcome.SUCCESS_EMPTY):
        raise ValueError('persistence MCP tool error')
    data = extract_result_data(response)
    # bridge 的规范结果应直接给出 data；兼容报告 MCP 原有的 code/data 业务包络。
    if isinstance(data, dict) and str(data.get('code')) == '200' and isinstance(data.get('data'), dict):
        data = data['data']
    if not isinstance(data, dict):
        raise ValueError('persistence MCP invalid result')
    return data


def persist(run, report_html, gateway: McpGateway):
    common = {'businessId': run['run_id'], 'sourceModule': 'threat-analysis', 'revision': 1}
    states = {'summary': {'status': 'not_configured'}}
    try:
        if len(report_html.encode('utf-8')) > LIMIT:
            raise ValueError('reportHtml exceeds 1048576 UTF-8 bytes')
        args = dict(common, resultType='report', contentType='text/html',
                    fileName=run['incident_id'] + '-' + run['run_id'] + '.html',
                    fileContentBase64=base64.b64encode(report_html.encode('utf-8')).decode('ascii'))
        response = gateway.invoke_trusted(
            resource='report-write', tool_name='save_persistence_result', arguments=args)
        data = _persistence_data(response)
        if not isinstance(data.get('id'), str) or not data['id']:
            raise ValueError('persistence MCP missing storage id')
        state = {'status': 'saved', 'id': data['id']}
        url_value = data.get('downloadUrl')
        if isinstance(url_value, str):
            parsed = urllib.parse.urlsplit(url_value)
            if parsed.scheme in ('http', 'https') and parsed.netloc:
                state['download_url'] = url_value
        states['report'] = state
    except Exception as error:
        # 不回显网络异常中的地址或认证信息；保存失败不改变研判结论。
        states['report'] = {'status': 'failed', 'error_type': type(error).__name__}
        if isinstance(error, ValueError):
            states['report']['error'] = str(error)
    return states

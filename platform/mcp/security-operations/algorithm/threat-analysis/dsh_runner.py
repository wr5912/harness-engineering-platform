"""DSH 工具入口；固定取证链和研判模型之间只传冻结五源输入。"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import signal
import sys
import uuid
from pathlib import Path

import evidence_collection
from mcp_gateway import McpGateway, extract_result_data
from model_inference import run_inference
from result_delivery import build_delivery, failure_markdown
from result_storage import persist, build_writeback, build_failure_writeback, SocJudgementClient, SocWriteError

ROOT = Path(__file__).resolve().parent
ANALYSIS_TIMEOUT_SECONDS = 30 * 60


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def checkpoint(output, result):
    temporary = output / 'result.json.tmp'
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(output / 'result.json')


def build_gateway(config, raw_directory):
    runtime = config['connections']['runtime']
    return McpGateway(
        bridge_url=runtime['bridgeUrl'], bridge_key=runtime['bridgeKey'],
        raw_directory=Path(raw_directory),
    )


def _analyze(incident_id, output_root, config, cancel_analysis_deadline=None, run_id=None):
    if not re.fullmatch(r'INC-\d{8}-\d{6}', incident_id):
        raise ValueError('invalid incident ID')
    run_id = run_id or 'run-' + str(uuid.uuid4())
    if not re.fullmatch(r'run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id):
        raise ValueError('invalid run ID')
    output = Path(output_root) / run_id
    output.mkdir(parents=True)
    result = {'schema_version': '1.0', 'model': None, 'incident_id': incident_id, 'run_id': run_id, 'status': 'claim_failed', 'llm_invoked': False}
    client = None
    try:
        gateway = build_gateway(config, output / 'fusion' / 'raw')
        client = SocJudgementClient(gateway, output)
        claim = client.claim(incident_id)
        result['judgement_id'] = claim['judgementId']
        result['status'] = 'evidence_failed'
        checkpoint(output, result)
        args = evidence_collection.parse_args([
            '--incident-id', incident_id,
            '--output-dir', str(output / 'fusion'),
            '--list-timezone', 'Asia/Shanghai',
        ], require_bridge=False)
        # 原入口的路径输出不是模型输入，也不混入工具 JSON。
        with contextlib.redirect_stdout(io.StringIO()):
            fusion = evidence_collection.run(args, gateway=gateway)
        manifest = read_json(fusion / 'manifest.json')
        result['route'] = manifest['route']
        ledger = fusion / 'call-ledger.audit.json'
        if ledger.exists():
            calls = read_json(ledger)
            result['mcp_calls'] = len(calls)
            result['mcp_failures'] = sum(row['status'] == 'failed' for row in calls)
        if manifest['route'] == 'fast_classification':
            result.update(status='completed', validation={'status': 'not_applicable_fast_classification'},
                          result=read_json(fusion / 'fast-classification-output.json'))
        else:
            frozen = fusion / 'five-source-output.json'
            result['input_sha256'] = hashlib.sha256(frozen.read_bytes()).hexdigest()
            try:
                model_config = config['analysisModel']
                model_base_url = model_config['baseURL']
                model_name = model_config['model']
                if not model_base_url or not model_name:
                    raise ValueError('missing analysis model configuration')
                result['llm_invoked'] = True
                result['model'] = model_name
                verdict = run_inference(
                    five_source=read_json(frozen),
                    system_prompt=(ROOT / 'prompts/threat-analysis-system.txt').read_text(encoding='utf-8'),
                    base_url=model_base_url, model=model_name,
                    api_key=os.environ.get(model_config.get('apiKeyEnv', '')) or None,
                    output_dir=output / 'model', timeout=300, temperature=0.1,
                )
                result.update(status='completed', result=verdict)
            except Exception as error:
                result.update(status='model_failed', error_type=type(error).__name__)
            metadata_path = output / 'model/request-metadata.json'
            if metadata_path.exists():
                metadata = read_json(metadata_path)
                result['model'] = metadata.get('response_model') or metadata.get('model')
            validation_path = output / 'model/validation.json'
            if validation_path.exists():
                validation = read_json(validation_path)
                # 校验结果由代码提供，与模型原文分开交付。
                result['validation'] = {k: validation[k] for k in ('status', 'warnings', 'error_type') if k in validation}
                if validation['status'] == 'failed':
                    result['status'] = 'contract_failed'
                    result['validation']['error'] = validation.get('error')
                    parsed_path = output / 'model/model-analysis-output.json'
                    if parsed_path.exists():
                        # 严格校验仍失败；可解析的模型内容可展示，但不是已核实结论。
                        parsed = read_json(parsed_path)
                        if isinstance(parsed, dict):
                            result.update(status='completed', result=parsed)
                            result.pop('error_type', None)
    except Exception as error:
        result['error_type'] = type(error).__name__
        if isinstance(error, SocWriteError):
            result['error_code'] = error.code
    # 后续只做 SOC 状态回写和本地交付，不再计入分析预算。
    if cancel_analysis_deadline is not None:
        cancel_analysis_deadline()
    if result['status'] == 'completed':
        try:
            delivery = build_delivery(result)
            # 先保留报告与回写请求，即使远端保存失败也可独立检查与再次交付。
            (output / 'report.html').write_text(delivery['report_html'], encoding='utf-8')
            storage = {}
            try:
                writeback = build_writeback(result, delivery['report_html'])
                (output / 'writeback.json').write_text(json.dumps(writeback, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                storage['summary'] = client.write('result', result['judgement_id'], writeback)
            except Exception as error:
                state = {'status': 'failed', 'error_type': type(error).__name__}
                if isinstance(error, ValueError):
                    state['error'] = str(error)
                (output / 'writeback-error.json').write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
                storage['summary'] = state
            storage['report'] = persist(result, delivery['report_html'], gateway)['report']
            delivery = build_delivery(result, storage=storage)
            (output / 'summary.json').write_text(json.dumps(delivery['summary'], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            (output / 'summary.md').write_text(delivery['markdown'], encoding='utf-8')
            (output / 'report.html').write_text(delivery.pop('report_html'), encoding='utf-8')
            result['delivery'] = delivery
        except Exception as error:
            # 阅读视图生成失败与研判结论分开记录；原始结果仍保存。
            result['delivery'] = {'status': 'failed', 'error_type': type(error).__name__,
                                  'markdown': '研判已完成，但阅读内容生成失败。\n\n运行 ID：' + run_id}
    else:
        result['delivery'] = {'status': 'not_generated', 'markdown': failure_markdown(result)}
        if result.get('judgement_id'):
            state = client.write('fail', result['judgement_id'], build_failure_writeback(result))
            result['delivery']['storage'] = {'summary': state}
            result['delivery']['markdown'] += '\nSOC 失败状态回写：' + ('已保存' if state['status'] == 'saved' else '保存失败') + '\n'
    checkpoint(output, result)
    return result


def analyze(incident_id, output_root, config, run_id=None):
    """Give analysis 30 minutes, then leave the outer tool budget for writeback."""

    if not hasattr(signal, 'SIGALRM'):
        return _analyze(incident_id, output_root, config, run_id=run_id)

    def deadline_exceeded(_signum, _frame):
        raise TimeoutError('threat analysis exceeded 30 minute deadline')

    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, deadline_exceeded)
    previous_timer = signal.alarm(ANALYSIS_TIMEOUT_SECONDS)

    def cancel_analysis_deadline():
        signal.alarm(0)

    try:
        return _analyze(incident_id, output_root, config, cancel_analysis_deadline, run_id)
    finally:
        cancel_analysis_deadline()
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer > 0:
            signal.alarm(previous_timer)


def pending(output_root, config, page_size=100):
    output = Path(output_root) / 'automation'
    gateway = build_gateway(config, output / 'mcp-raw')
    client = SocJudgementClient(gateway, output)
    return {'schema_version': '1.0', 'data': client.pending(page_size)}


def cleanup(run_id, output_root, config):
    """只清理已认领、尚未开始终态写回的同一次运行；不重新认领或研判。"""
    if not re.fullmatch(r'run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id):
        raise ValueError('invalid run ID')
    output = Path(output_root) / run_id
    try:
        result = read_json(output / 'result.json')
    except FileNotFoundError:
        claim = extract_result_data(read_json(output / 'soc-claim-response.json'))
        incident = read_json(output / 'soc-claim-request.json')['incidentId']
        result = {'schema_version': '1.0', 'run_id': run_id, 'incident_id': incident,
                  'judgement_id': claim['judgementId'], 'status': 'evidence_failed', 'llm_invoked': False, 'model': None}
    if result.get('run_id') != run_id or not result.get('judgement_id'):
        raise ValueError('missing bound claim identity')
    if result.get('cleanup_attempted'):
        return result
    # 已发出的 result/fail 可能被远端接受，不再提交相反的终态。
    if any((output / f'soc-{operation}-request.json').exists() for operation in ('result', 'fail')):
        result.setdefault('delivery', {'status': 'unknown', 'markdown': '研判已中止；SOC 终态请求已发出，请按原运行核验结果。\n\n运行 ID：' + run_id})
        checkpoint(output, result)
        return result
    lock = output / '.cleanup-lock'
    try:
        lock.mkdir()
    except FileExistsError:
        return read_json(output / 'result.json')
    try:
        # 先落标记，即使响应丢失或清理进程再次被取消，也不会重复发起清理。
        result.update(status='evidence_failed', error_type='AbortError', cleanup_attempted=True)
        checkpoint(output, result)
        client = SocJudgementClient(build_gateway(config, output / 'fusion/raw'), output)
        state = client.write('fail', result['judgement_id'], build_failure_writeback(result))
        result['delivery'] = {'status': 'not_generated', 'storage': {'summary': state},
                              'markdown': failure_markdown(result) + '\nSOC 失败状态回写：' + ('已保存' if state['status'] == 'saved' else '保存失败') + '\n'}
        checkpoint(output, result)
        return result
    finally:
        lock.rmdir()


if __name__ == '__main__':
    root = Path(os.environ['DSH_HOME']) / 'threat-analysis'
    configuration = json.loads(os.environ['THREAT_ANALYSIS_CONFIG'])
    if sys.argv[1:] == ['--pending']:
        result = pending(root, configuration)
    elif sys.argv[1:2] == ['--cleanup'] and len(sys.argv) == 3:
        result = cleanup(sys.argv[2], root, configuration)
    else:
        run_id = sys.argv[3] if len(sys.argv) == 4 and sys.argv[2] == '--run-id' else None
        result = analyze(sys.argv[1], root, configuration, run_id)
    print(json.dumps(result, ensure_ascii=False))

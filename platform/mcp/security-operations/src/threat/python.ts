// 仅阶段协调和 JSON 边界；算法、提示词、catalog 与 CSS 始终 import 固定 Git 制品。
export const threatPython = String.raw`
import contextlib, hashlib, io, json, math, os, signal, sys, time
from pathlib import Path
p = json.load(sys.stdin)
sys.path.insert(0, p['source'])
import evidence_collection
from model_inference import run_inference
from dsh_runner import build_gateway
from result_delivery import build_delivery, failure_markdown
from result_storage import SocJudgementClient, SocWriteError, build_writeback, build_failure_writeback, persist

out = Path(p['output'])
run = p['run']
stage = p['stage']
config = p['config']
phase_status = 'completed'
gateway = build_gateway(config, out / 'fusion' / 'raw')
client = SocJudgementClient(gateway, out)

def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def dump(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)

def checkpoint():
    dump(out / 'result.json', run)

def deadline(_signum, _frame):
    raise TimeoutError('analysis_deadline_exceeded')

try:
    if stage in ('collect', 'infer'):
        remaining = p['analysis_deadline'] - time.time()
        if remaining <= 0:
            raise TimeoutError('analysis_deadline_exceeded')
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(max(1, math.ceil(remaining)))
    if stage == 'collect':
        claim = client.claim(run['incident_id'])
        run['judgement_id'] = claim['judgementId']
        run['status'] = 'evidence_failed'
        checkpoint()
        args = evidence_collection.parse_args([
            '--incident-id', run['incident_id'], '--output-dir', str(out / 'fusion'),
            '--list-timezone', 'Asia/Shanghai'], require_bridge=False)
        with contextlib.redirect_stdout(io.StringIO()):
            fusion = evidence_collection.run(args, gateway=gateway)
        manifest = read(fusion / 'manifest.json')
        run['route'] = manifest['route']
        ledger = read(fusion / 'call-ledger.audit.json')
        run['mcp_calls'] = len(ledger)
        run['mcp_failures'] = sum(row['status'] == 'failed' for row in ledger)
        if run['route'] == 'fast_classification':
            run.update(status='completed', validation={'status':'not_applicable_fast_classification'},
                       result=read(fusion / 'fast-classification-output.json'))
        else:
            frozen = fusion / 'five-source-output.json'
            run['input_sha256'] = hashlib.sha256(frozen.read_bytes()).hexdigest()
            run['status'] = 'evidence_ready'
    elif stage == 'infer':
        if run.get('route') != 'five_source' or run['status'] != 'evidence_ready':
            phase_status = 'skipped'
        else:
            model = config['analysisModel']
            run.update(llm_invoked=True, model=model['model'], status='model_failed')
            checkpoint()
            try:
                verdict = run_inference(five_source=read(out / 'fusion/five-source-output.json'),
                    system_prompt=(Path(p['source']) / 'prompts/threat-analysis-system.txt').read_text(encoding='utf-8'),
                    base_url=model['baseURL'], model=model['model'], api_key=os.environ['THREAT_MODEL_BRIDGE_KEY'],
                    output_dir=out / 'model', timeout=300, temperature=0.1)
                run.update(status='completed', result=verdict)
            except Exception as error:
                run.update(status='model_failed', error_type=type(error).__name__)
                phase_status = 'failed'
            metadata_path = out / 'model/request-metadata.json'
            if metadata_path.exists():
                metadata = read(metadata_path)
                run['model'] = metadata.get('response_model') or metadata.get('model')
            validation_path = out / 'model/validation.json'
            if validation_path.exists():
                validation = read(validation_path)
                run['validation'] = {k:validation[k] for k in ('status','warnings','error_type') if k in validation}
                if validation['status'] == 'failed':
                    run['status'] = 'contract_failed'
                    run['validation']['error'] = validation.get('error')
                    parsed_path = out / 'model/model-analysis-output.json'
                    if parsed_path.exists() and isinstance(read(parsed_path), dict):
                        run.update(status='completed', result=read(parsed_path))
                        run.pop('error_type', None)
                        # 已完成原样交付；独立 validation 仍保留 failed。
                        phase_status = 'completed'
    elif stage == 'writeback':
        if not run.get('judgement_id'):
            run['delivery'] = {'status':'not_generated', 'markdown':failure_markdown(run)}
            phase_status = 'skipped'
        elif run['status'] == 'completed':
            delivery = build_delivery(run)
            (out / 'report.html').write_text(delivery['report_html'], encoding='utf-8')
            storage = {}
            try:
                body = build_writeback(run, delivery['report_html'])
                dump(out / 'writeback.json', body)
                storage['summary'] = client.write('result', run['judgement_id'], body)
            except Exception as error:
                storage['summary'] = {'status':'failed', 'error_type':type(error).__name__}
                if isinstance(error, ValueError):
                    storage['summary']['error'] = str(error)
                dump(out / 'writeback-error.json', storage['summary'])
            dump(out / 'storage.json', storage)
            delivery.pop('report_html', None)
            delivery['storage'] = storage
            run['delivery'] = delivery
            if storage['summary']['status'] != 'saved': phase_status = 'failed'
        else:
            state = client.write('fail', run['judgement_id'], build_failure_writeback(run))
            run['delivery'] = {'status':'not_generated', 'storage':{'summary':state},
                'markdown':failure_markdown(run) + '\nSOC 失败状态回写：' + ('已保存' if state['status']=='saved' else '保存失败') + '\n'}
            if state['status'] != 'saved': phase_status = 'failed'
    elif stage == 'report':
        if run['status'] != 'completed' or not (out / 'report.html').exists():
            phase_status = 'skipped'
        else:
            storage = read(out / 'storage.json')
            html = (out / 'report.html').read_text(encoding='utf-8')
            storage['report'] = persist(run, html, gateway)['report']
            dump(out / 'storage.json', storage)
            delivery = build_delivery(run, storage=storage)
            dump(out / 'summary.json', delivery['summary'])
            (out / 'summary.md').write_text(delivery['markdown'], encoding='utf-8')
            (out / 'report.html').write_text(delivery.pop('report_html'), encoding='utf-8')
            run['delivery'] = delivery
            if storage['report']['status'] != 'saved': phase_status = 'failed'
    else:
        raise ValueError('unknown_stage')
except Exception as error:
    phase_status = 'failed'
    run['error_type'] = type(error).__name__
    if stage == 'infer' and run['status'] == 'evidence_ready': run['status'] = 'model_failed'
    if isinstance(error, SocWriteError): run['error_code'] = error.code
    if stage in ('writeback','report'):
        run['delivery'] = {'status':'failed', 'error_type':type(error).__name__, 'markdown':'阅读内容或保存失败，原始研判结果已保留。'}
finally:
    signal.alarm(0)
    checkpoint()
print(json.dumps({'result':run, 'phase_status':phase_status}, ensure_ascii=False))
`

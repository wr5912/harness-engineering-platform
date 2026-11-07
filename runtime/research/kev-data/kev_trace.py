#!/usr/bin/env python3
"""Local trace-to-Kev data utilities. Python standard library; no tool execution."""
from __future__ import annotations
import argparse
import copy
import json
import sys
from pathlib import Path
from collections import Counter
from trace_adapter import parse_trace, audit_summary, extract, strict_loads, stable, VERSION
from dataset import compile_records, split_records, audit_partitions, label_key
from human_report import emit_result, print_summary, write_report, reason_text


class InputError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's usage remains useful for precise flags; the result is Chinese.
        self.print_usage(sys.stderr)
        payload = {'status': 'blocked', 'reason_codes': ['invalid_arguments'], 'error': message}
        if '--json' in sys.argv[1:]:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print('当前不能继续：命令参数有误（invalid_arguments）。', file=sys.stderr)
            print('参数诊断：' + message, file=sys.stderr)
        raise SystemExit(2)


def label_summary(counts):
    names = {'verified':'标为已复核', 'unlabeled':'未标注', 'weak':'弱标签',
             'ambiguous':'有歧义', 'invalid':'无效'}
    return '、'.join(f'{names.get(key, "未知状态（"+str(key)+"）")} {number} 条'
                    for key, number in counts.items()) or '没有样本'


def partition_summary(counts):
    names = {'train':'训练', 'development':'开发验证', 'calibration':'校准', 'test':'独立测试'}
    return '；'.join(f'{names.get(key,key)} {value} 条' for key, value in counts.items())


def finish(args, out, status, result, summary, reason_codes=(), next_allowed_stage=None,
           *, next_step=None, artifacts=(), details=(), limitations=(), diagnostics=(), notices=()):
    exit_code = stage_status(out, args.command, status, reason_codes, next_allowed_stage)
    emit_result(out, args.command, status, summary, [*reason_codes, *notices], next_step,
        [*artifacts, ('阶段状态', 'stage-status.json')],
        json_output=getattr(args,'json',False), machine_result={'out':str(out), **result},
        details=details, limitations=limitations, diagnostics=diagnostics)
    return exit_code

def read_jsonl(path):
    result=[]
    for line,s in enumerate(Path(path).read_text(encoding='utf-8-sig').splitlines(),1):
        if s.strip():
            try: result.append(strict_loads(s))
            except ValueError as exc: raise ValueError(f'{path}:{line}: {exc}') from exc
    return result

def write_json(path,value):
    Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')

def write_jsonl(path,values):
    # Native Kev renders object fields and options in insertion order. Canonical
    # sorting belongs in identity hashes, never in model-input serialization.
    Path(path).write_text(''.join(json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n' for v in values),encoding='utf-8')

def stage_status(out,stage,status,reason_codes=(),next_allowed_stage=None):
    """Report this stage's gate, separately from the existing evidence schemas.

    A completed stage is not a training or deployment approval. Review stages
    name the next safe check; a blocked stage never authorizes a later stage.
    """
    write_json(out/'stage-status.json',{
        'stage':stage,'status':status,'reason_codes':sorted(set(reason_codes)),
        'next_allowed_stage':None if status=='blocked' else next_allowed_stage,
    })
    return 2 if status=='blocked' else 0

def new_dir(path,inputs=()):
    out=Path(path).resolve()
    for p in inputs:
        if out==Path(p).resolve(): raise InputError('output_conflicts_with_input','输出目录不得替代输入：'+str(out))
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise InputError('output_not_empty','请使用新的空输出目录：'+str(out))
    out.mkdir(parents=True,exist_ok=True)
    return out

def usage_report(audits):
    totals=Counter();observed=[]
    for a in audits:
        for s in a['snapshots']:
            u=s['usage']
            for k in ['inputTokens','outputTokens','cacheReadTokens','totalTokens']:
                if type(u.get(k)) is int: totals[k]+=u[k]
            observed.append({'session_id':s['session_id'],'line':s['decision_line'],'step':s['step'],'usage':u})
    return {'sum_of_recorded_fields':dict(totals),'per_model_response':observed,
        'interpretation':'Canonical assistant.data.usage only; stream copies excluded. Provider-specific semantics, not an invoice or estimated savings.'}

def discover(audit,profile):
    records,blocked=extract(audit,profile)
    return [{'sample_id':r['sample_id'],'decision_site_id':r['decision_site_id'],
        'line':r['provenance']['decision_line'],'seq':r['provenance']['decision_seq'],
        'turn':r['provenance']['turn'],'step':r['provenance']['step'],
        'implementation_recommendation':r['implementation'],
        'candidate_count':len(r['question']['criteria']),
        'observed_candidate':r['observed_candidate'],
        'label_status':r['label']['status'],
        'question':r['question']['instructions'],
        'next_evidence_needed':['Confirm runtime trigger and business contract',
            'Pin target Skill version and decision-time loaded context; compare normative branches with observed coverage',
            'Verify target independently of observed action','Measure actual avoidable full-path cost'],
        'rule_suggestion_for_review':r['review']['rule_suggestion']} for r in records],blocked

def main(argv=None):
    ap=ArgumentParser(description='离线检查轨迹、整理决策样本并导出 KEV 数据；不会执行训练或调用平台。')
    ap.add_argument('--json',action='store_true',help='向标准输出返回机器 JSON；仍保存 report.md')
    sub=ap.add_subparsers(dest='command',required=True)
    for name in ['audit','discover','extract']:
        p=sub.add_parser(name)
        p.add_argument('traces',nargs='+')
        p.add_argument('--out',required=True)
        if name!='audit': p.add_argument('--profile',choices=['next-operation','inspection-v1','cybersecurity-routing-v1'],default='next-operation')
    p=sub.add_parser('annotate')
    p.add_argument('--samples',required=True);p.add_argument('--annotations',required=True);p.add_argument('--out',required=True)
    p=sub.add_parser('compile')
    p.add_argument('--input',nargs='+',required=True);p.add_argument('--out',required=True)
    p.add_argument('--allow-weak-train',action='store_true');p.add_argument('--include-code',action='store_true')
    p=sub.add_parser('split')
    p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.add_argument('--seed',type=int,default=20261026)
    p.add_argument('--fractions',default='0.7,0.1,0.1,0.1',help='训练、开发验证、校准、独立测试的比例；规模和覆盖仍需复核')
    p=sub.add_parser('audit-dataset');p.add_argument('--dataset-dir',required=True);p.add_argument('--out',required=True)
    for parser in sub.choices.values():
        parser.add_argument('--json',action='store_true',default=argparse.SUPPRESS,
                            help='向标准输出返回机器 JSON；仍保存 report.md')
    args=ap.parse_args(argv)
    if args.command in ['audit','discover','extract']: inputs=args.traces
    elif args.command=='annotate': inputs=[args.samples,args.annotations]
    elif args.command=='compile': inputs=args.input
    elif args.command=='split': inputs=[args.input]
    else: inputs=[args.dataset_dir]
    out=None
    try:
        out=new_dir(args.out,inputs)
        return execute_command(args,out)
    except (ValueError,KeyError,TypeError,OSError,AttributeError,IndexError,OverflowError,RecursionError) as exc:
        # Preserve any partial evidence; never replace an existing output dir.
        # An unwritable destination cannot itself receive a status artifact.
        code=getattr(exc,'code','io_error' if isinstance(exc,OSError) else 'invalid_input')
        error={'code':code,'type':type(exc).__name__,'message':str(exc)}
        payload={'out':str(Path(args.out).resolve()),'stage':args.command,'status':'blocked',
                 'reason_codes':[code],'error':error}
        summary='本次操作未完成。'+reason_text(code)
        next_step='按原始诊断修正输入或文件路径，再使用新的空目录重试。'
        report_path=None
        diagnostics=[f'{type(exc).__name__}: {exc}']
        if out is not None:
            try:
                stage_status(out,args.command,'blocked',[code])
                write_json(out/'error-report.json',payload)
                report_path=write_report(out,args.command,'blocked',summary,[code],next_step,
                    [('失败诊断','error-report.json'),('阶段状态','stage-status.json')],
                    details='目录内已经写出的中间文件仅供排查，不能作为本阶段通过的凭据。',
                    diagnostics=diagnostics)
            except OSError as save_error:
                diagnostics.append(f'报告保存失败：{save_error}')
                payload['report_save_error']=str(save_error)
        if args.json:
            print(json.dumps(payload,ensure_ascii=False,allow_nan=False))
        else:
            if report_path is None:
                summary+=' 未保存新的可读报告。'
            print_summary(args.command,'blocked',summary,[code],next_step,report_path,diagnostics=diagnostics)
        return 1

def execute_command(args,out):
    if args.command in ['audit','discover','extract']:
        audits=[parse_trace(p) for p in args.traces]
        audit_errors=[i['code'] for a in audits for i in a['issues'] if i['severity']=='error']
        audit_notices=[i['code'] for a in audits for i in a['issues'] if i['severity']!='error']
        write_json(out/'trace-audit.json',{'adapter_version':VERSION,'traces':[audit_summary(a) for a in audits]})
        write_json(out/'usage.json',usage_report(audits))
        artifacts=[('轨迹检查明细','trace-audit.json'),('已记录用量','usage.json')]
        boundaries=sum(len(a['snapshots']) for a in audits)
        missing_usage=sum(type(s['usage'].get('totalTokens')) is not int for a in audits for s in a['snapshots'])
        usage_note=f'用量仅汇总轨迹已有字段；{boundaries} 个模型回复中有 {missing_usage} 个未记录总 token 数。供应商字段含义未校准，不能据此认定账单或节省。'
        if args.command=='audit':
            write_json(out/'timing.json',{'traces':[{'source':a['source'],**a['timing']} for a in audits]})
            artifacts.append(('原生会话耗时分解','timing.json'))
            write_jsonl(out/'request-snapshots.jsonl',[s for a in audits for s in a['snapshots']])
            result={'traces':len(audits),'boundaries':sum(len(a['snapshots']) for a in audits),
                'errors':sum(i['severity']=='error' for a in audits for i in a['issues'])}
            artifacts.append(('决策前请求快照','request-snapshots.jsonl'))
            summary=f'已检查 {len(audits)} 份轨迹，识别 {boundaries} 个模型决策时点；发现 {len(audit_errors)} 个结构错误、{len(audit_notices)} 项提示。'
            limitations=[usage_note,'本次只检查轨迹结构与请求重建，没有验证标签、训练效果或业务收益。']
            next_step='核对轨迹提示及来源关联后，继续发现可替换的决策点。'
        elif args.command=='discover':
            found=[];blocked=[]
            for a in audits:
                r,b=discover(a,args.profile);found.extend(r);blocked.extend(b)
            skipped=[item for item in blocked if item.get('disposition')=='skip']
            blocked=[item for item in blocked if item.get('disposition')!='skip']
            inventory={'profile':args.profile,'candidates':found,'blocked':blocked,
                'status':'proposals_not_validated_runtime_contracts'}
            if skipped: inventory['skipped']=skipped
            write_json(out/'decision-inventory.json',inventory)
            result={'decision_candidates':len(found),'blocked':len(blocked),'status':'requires_contract_review'}
            if skipped: result['skipped']=len(skipped)
            artifacts.append(('决策候选与未抽取原因','decision-inventory.json'))
            summary=f'发现 {len(found)} 个决策候选，另有 {len(blocked)} 个决策时点未满足抽取条件。轨迹检查发现 {len(audit_errors)} 个结构错误、{len(audit_notices)} 项提示。'
            if skipped: summary+=f'按当前抽取范围跳过 {len(skipped)} 个后续处理时点。'
            limitations=['候选尚未验证实际运行时合同，也未测量可避免的完整路径成本。',usage_note]
            next_step='逐项确认触发条件、当时可见的输入和候选范围，并为目标标签寻找独立依据。'
        else:
            records=[];blocked=[]
            for a in audits:
                r,b=extract(a,args.profile);records.extend(r);blocked.extend(b)
            skipped=[item for item in blocked if item.get('disposition')=='skip']
            blocked=[item for item in blocked if item.get('disposition')!='skip']
            ids=[r['sample_id'] for r in records]
            if len(ids)!=len(set(ids)): raise ValueError('Duplicate decision sample IDs across inputs; deduplicate source exports first')
            write_jsonl(out/'samples.jsonl',records)
            write_jsonl(out/'annotations.todo.jsonl',[{'sample_id':r['sample_id'],'label':copy.deepcopy(r['label'])} for r in records])
            result={'profile':args.profile,'samples':len(records),'blocked':blocked,
                'source_groups':len({r['provenance']['source_group_id'] for r in records}),
                'implementation_counts':dict(Counter(r['implementation'] for r in records)),
                'label_counts':dict(Counter(r['label']['status'] for r in records)),
                'token_budget':'not_checked','ready_for_training':False,
                'note':'Observed actions and rule suggestions are evidence, not automatically verified labels.'}
            if skipped: result['skipped']=skipped
            write_json(out/'extraction-report.json',result)
            artifacts.extend([('候选样本','samples.jsonl'),('待复核标注','annotations.todo.jsonl'),('抽取明细','extraction-report.json')])
            summary=[f'已保存 {len(records)} 条候选样本，来自 {result["source_groups"]} 个来源组；{len(blocked)} 个决策时点未能抽取。',
                     '标签状态：'+label_summary(result['label_counts'])+'。']
            if skipped: summary.append(f'另按当前抽取范围跳过 {len(skipped)} 个后续处理时点，具体原因已保留。')
            limitations=['来源组数量不等于独立任务数量，后续仍需核对来源关联。',
                         '历史动作和规则建议不能自动当作正确标签；目标分词器长度、训练效果和业务收益尚未检查。',usage_note]
            next_step='在 annotations.todo.jsonl 中补充标签、来源和独立证据，复核后通过 annotate 更新样本。'
        if audit_errors:
            return finish(args,out,'blocked',result,summary,['trace_audit_errors',*audit_errors],
                next_step='先按 trace-audit.json 的行号修正轨迹问题，再重新执行当前阶段；已保存的中间文件仅供排查。',
                artifacts=artifacts,limitations=limitations,notices=audit_notices)
        if args.command=='audit':
            if not result['boundaries']:
                return finish(args,out,'requires_review',result,summary,['no_decision_boundaries'],
                    next_step='核对输入是否为完整的 DSH v4 轨迹，以及其中是否含模型生成的回复。',
                    artifacts=artifacts,limitations=limitations,notices=audit_notices)
            return finish(args,out,'completed',result,summary,next_allowed_stage='discover',
                next_step=next_step,artifacts=artifacts,limitations=limitations,notices=audit_notices)
        if args.command=='discover':
            reasons=['decision_contract_review_required',*[b['reason'] for b in blocked]]
            if not found: reasons.append('no_decision_candidates')
            return finish(args,out,'requires_review',result,summary,reasons,'contract-review',
                next_step=next_step,artifacts=artifacts,limitations=limitations,notices=audit_notices)
        if not records or blocked:
            reasons=[b['reason'] for b in blocked]
            if blocked: reasons.append('blocked_decision_prefixes')
            if not records: reasons.append('no_usable_samples')
            return finish(args,out,'blocked',result,summary,reasons,
                next_step='按 extraction-report.json 的未抽取原因补齐决策前证据或修正抽取规则，再重新抽取。',
                artifacts=artifacts,limitations=limitations,notices=audit_notices)
        return finish(args,out,'requires_review',result,summary,
            ['label_review_required','runtime_contract_review_required'],'annotate',
            next_step=next_step,artifacts=artifacts,limitations=limitations,notices=audit_notices)
    if args.command=='annotate':
        records=read_jsonl(args.samples);annotations=read_jsonl(args.annotations)
        ids={r['sample_id'] for r in records};by_id={}
        if len(ids)!=len(records): raise ValueError('Duplicate sample IDs')
        for a in annotations:
            if set(a)!={'sample_id','label'}: raise ValueError('Annotation may only contain sample_id and label')
            sid=a['sample_id']
            if sid not in ids or sid in by_id: raise ValueError('Unknown or duplicate annotation ID: '+sid)
            label=a['label']
            if not isinstance(label,dict) or label.get('status') not in ['unlabeled','weak','verified','ambiguous','invalid']:
                raise ValueError('Explicit supported label.status required')
            if label.get('status') in ['weak','verified'] and (not label.get('source') or not label.get('evidence_refs')):
                raise ValueError('Label source and evidence references required')
            by_id[sid]=label
        for r in records:
            if r['sample_id'] in by_id:
                label=by_id[r['sample_id']]
                if label.get('value') is not None:
                    try:
                        label_key(r['question'], label['value'])
                    except ValueError:
                        raise ValueError('Annotation target does not match current question: '+r['sample_id']) from None
                r['label']=copy.deepcopy(label)
        write_jsonl(out/'samples.labeled.jsonl',records)
        report={'updates':len(by_id),'labels':dict(Counter(r['label']['status'] for r in records)),
            'semantic_validation':'Source/evidence structure checked; reviewer remains responsible for target correctness.'}
        write_json(out/'annotation-report.json',report)
        eligible,unready,eligibility_report=compile_records(records)
        reasons=['label_semantics_not_verified']
        if not eligible: reasons.append('no_default_export_eligible_labels')
        return finish(args,out,'requires_review',{'updates':len(by_id)},
            [f'已更新 {len(by_id)} 条标注，共保存 {len(records)} 条样本；其中 {len(eligible)} 条满足默认编译的结构与标签要求。',
             '标签状态：'+label_summary(report['labels'])+'。'],reasons,'compile' if eligible else 'annotate',
            next_step='核对标签的业务含义和证据后，用 samples.labeled.jsonl 编译数据。' if eligible else '按报告补齐或修正标签、来源证据及样本结构，再更新样本并重新检查。',
            artifacts=[('更新后的样本','samples.labeled.jsonl'),('标注更新明细','annotation-report.json')],
            details=[f'默认编译检查暂不接受 {len(unready)} 条样本；尚未执行正式编译。'] if unready else (),
            notices=list(eligibility_report['quarantine_by_reason']),
            limitations=['已复核状态来自输入声明；本命令没有判定标签在业务上正确，也没有执行训练。'])
    if args.command=='compile':
        records=[r for p in args.input for r in read_jsonl(p)]
        compiled,quarantine,report=compile_records(records,args.allow_weak_train,include_code=args.include_code)
        write_jsonl(out/'compiled.jsonl',compiled);write_jsonl(out/'quarantine.jsonl',quarantine);write_json(out/'compile-report.json',report)
        reasons=list(report['quarantine_by_reason'])
        blocked=not compiled or report['status']=='blocked'
        summary=[f'共检查 {len(records)} 条样本，编译通过 {len(compiled)} 条，隔离 {len(quarantine)} 条。',
                 f'导出中 {report["verified_records"]} 条标为已复核，{report["weak_train_only_records"]} 条为仅限训练的弱标签；尚未检查编码长度，也未运行训练。']
        details=[]
        if report['soft_target_records']:
            details.append(f'{report["soft_target_records"]} 条导出记录含软标签；保留其监督来源和含义。')
        if report['quarantine_by_reason']:
            details.append('隔离原因按记录计数（同一条记录可有多项原因）：'+
                '；'.join(f'{reason_text(code)} {number} 条（{code}）' for code,number in report['quarantine_by_reason'].items()))
        if report['warnings']:
            details.append(f'另有 {len(report["warnings"])} 项提示需要核对，具体记录见 compile-report.json。')
        return finish(args,out,'blocked' if blocked else 'requires_review' if quarantine else 'completed',
            {'compiled':len(compiled),'quarantine':len(quarantine),'report':report},summary,
            ['no_compiled_records',*reasons] if blocked else reasons,None if blocked else 'split',
            next_step='根据 quarantine.jsonl 的原因修正样本后重新编译。' if blocked else
                '核对隔离记录；继续分区时仅使用 compiled.jsonl 中已通过的记录。' if quarantine else
                '使用 compiled.jsonl 按独立来源分区，再检查分区之间是否重叠。',
            artifacts=[('编译通过的数据','compiled.jsonl'),('隔离样本及原因','quarantine.jsonl'),('编译明细','compile-report.json')],
            details=details,notices=[w['code'] for w in report['warnings']],
            limitations=['已复核标签是外部复核声明，编译不证明标签正确或所有输入都只来自决策之前。',
                         '目标分词器长度、类别覆盖、模型效果、校准效果和完整业务等效性尚未验证。'])
    if args.command=='split':
        values=[float(x) for x in args.fractions.split(',')]
        if len(values)!=4: raise ValueError('Four fractions required')
        fractions=dict(zip(['train','development','calibration','test'],values))
        partitions,manifest=split_records(read_jsonl(args.input),fractions,seed=args.seed)
        write_json(out/'split-manifest.json',manifest)
        ready=manifest.get('status')=='ready' and manifest.get('audit',{}).get('ok') is True
        if ready:
            for name,records in partitions.items(): write_jsonl(out/(name+'.jsonl'),records)
            write_json(out/'partition-audit.json',audit_partitions(partitions))
        known_groups=manifest.get('independent_groups')
        group_text=f'{known_groups} 个独立来源组' if known_groups is not None else '独立来源组数量尚未确定'
        summary=f'本次输入 {manifest["input_records"]} 条记录，{group_text}。'
        artifacts=[('分区清单与原因','split-manifest.json')]
        details=[]
        if not ready:
            return finish(args,out,'blocked',{'manifest':manifest},[summary,'未输出训练、开发验证、校准和独立测试文件，原编译数据保持原样。'],
                manifest.get('blocked_reasons') or ['partition_audit_failed'],
                next_step='按分区清单补充独立来源、修正数据或分区比例，再重新分区；复制同源记录不会增加独立来源组。',
                artifacts=artifacts,limitations=['分区未通过，当前没有四份可独立使用的数据。'],
                notices=[item['code'] for item in manifest.get('validation',{}).get('errors',[])])
        summary=[summary,'已保存四份用途数据：'+partition_summary(manifest['partition_records'])+'。']
        artifacts.extend([(name+'.jsonl',name+'.jsonl') for name in partitions])
        artifacts.append(('分区结构检查','partition-audit.json'))
        reasons=['missing_label_coverage'] if manifest.get('missing_label_coverage') else []
        if manifest.get('missing_label_coverage'):
            names={'train':'训练','development':'开发验证','calibration':'校准','test':'独立测试'}
            details.append('类别覆盖缺口：'+'；'.join(f'{names.get(name,name)}缺少 {sum(len(values) for values in labels.values())} 个问题类别' for name,labels in manifest['missing_label_coverage'].items())+'。具体问题与类别见 split-manifest.json。')
        return finish(args,out,'requires_review' if reasons else 'completed',{'manifest':manifest},summary,reasons,'audit-dataset',
            next_step='对四份文件运行 audit-dataset，并复核来源多样性和业务类别覆盖。',
            artifacts=artifacts,details=details,
            limitations=['分区数量与比例不证明统计效力或业务代表性；编码长度、模型效果和训练仍未验证。'])
    if args.command=='audit-dataset':
        source=Path(args.dataset_dir)
        expected=['train','development','calibration','test']
        missing=[name for name in expected if not (source/(name+'.jsonl')).is_file()]
        if missing: raise ValueError('Missing independent dataset partitions: '+','.join(missing))
        parts={name:read_jsonl(source/(name+'.jsonl')) for name in expected}
        report=audit_partitions(parts, required_partitions=expected)
        report['training_handoff']={'token_budget':'not_checked','runtime_equivalence':'not_evaluated',
            'required_next':['Prepare a pinned plan with kev-training, then run the selected Kev renderer/tokenizer and length checks','Check source diversity and business slice coverage','Compare cheap baseline, original Harness and Kev Variant on independent tasks'],
            'augmentation_first_run':{'keep_choice_shuffle':True,'p_none':0,'p_none_distract':0,'p_distract':0,'p_none_pair':0},
            'augmentation_scope':'Fixed closed-set baseline recommendation; ablate for dynamic candidates, not a universal Kev default.'}
        write_json(out/'dataset-audit.json',report)
        summary=[f'已检查四个用途共 {report["records"]} 条记录，发现 {len(report["errors"])} 个错误、{len(report["warnings"])} 项提示。',
                 partition_summary(report['partition_counts'])+'。']
        artifacts=[('数据集检查明细','dataset-audit.json')]
        if report.get('ok') is not True:
            return finish(args,out,'blocked',{'report':report},summary,
                [e['code'] for e in report['errors']] or ['no_dataset_records'],
                next_step='按 dataset-audit.json 修正错误；若来源跨分区，需按关联来源重新分区后再检查。',
                artifacts=artifacts,notices=[w['code'] for w in report['warnings']],
                limitations=['本次数据检查未通过，不能据此交接训练。'])
        return finish(args,out,'requires_review',{'report':report},summary,
            ['token_budget_not_checked','runtime_equivalence_not_evaluated'],'encoding-review',
            next_step='复核来源多样性与类别覆盖后，交接 kev-training：先生成训练方案，再按方案检查实际编码长度。',
            artifacts=artifacts,notices=[w['code'] for w in report['warnings']],
            limitations=['结构检查不能发现所有自然语言信息泄漏；输入是否可答、标签是否正确仍需业务复核。',
                         '训练、校准、独立测试和完整业务流程对照尚未执行；当前通过只覆盖数据结构与来源分区检查。'])

if __name__=='__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Read-only DSH v4 adapter. No commands, URLs, plugins or tools are executed."""
from __future__ import annotations
import copy
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

VERSION = 'dsh-v4-subset/1.0.0'
MESSAGE_TYPES = {'system/message','developer/message','user/message','assistant/message','tool/result'}
NON_MESSAGE_TYPES = {'permission/preset','sandbox/mode','approval/policy','session/title',
    'agent/inbox/spliced','turn/start','turn/end','step/start','step/end',
    'request/header','request/context','tool/call'}
BLOCK_TYPES = {'text','tool-call','tool-removal','tool-addition'}

def stable(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)

def digest(value):
    return hashlib.sha256(stable(value).encode()).hexdigest()

def text_of(message):
    content=message.get('content',[])
    if isinstance(content,str): return content
    return '\n'.join(b.get('text','') for b in content if isinstance(b,dict) and b.get('type')=='text')

def strict_loads(value):
    def pairs(items):
        out={}
        for k,v in items:
            if k in out: raise ValueError('duplicate JSON key: '+k)
            out[k]=v
        return out
    def constant(v): raise ValueError('non-finite JSON number: '+v)
    return json.loads(value,object_pairs_hook=pairs,parse_constant=constant)

def ref(event, pointer=None):
    value={'kind':'event','line':event['line'],'seq':event['event']['seq']}
    if pointer: value['pointer']=pointer
    return value

def _message(event):
    data=event.get('data',{})
    return data if event['type']=='user/message' else data.get('message')

def parse_trace(path):
    raw=Path(path).read_bytes()
    rows=[]
    for line,s in enumerate(raw.decode('utf-8-sig').splitlines(),1):
        if not s.strip(): continue
        try: value=strict_loads(s)
        except ValueError as exc: raise ValueError(f'{Path(path)}:{line}: {exc}') from exc
        if not isinstance(value,dict): raise ValueError(f'{Path(path)}:{line}: JSON object required')
        event=value.get('event',value)
        if not isinstance(event,dict): raise ValueError(f'{Path(path)}:{line}: event object required')
        rows.append({'line':line,'session_log':value.get('session_log'),'event':event})
    result=audit_rows(rows)
    result['source']={'filename':Path(path).name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
    for snap in result['snapshots']:
        snap['trace_sha256']=result['source']['sha256']
    return result

def timing_summary(rows):
    """只统计原生事件时间；不同类别的重叠区间不能相加。"""
    sessions={}; current={}; turns={}; starts={}; intervals={}; steps={}; calls={}; retries={}
    def timestamp(value):
        return value if type(value) in (int,float) and value>=0 else None
    def bucket(sid,turn):
        key=(sid,turn)
        if key not in turns:
            turns[key]={'session_id':sid,'turn':turn,'user_event_seqs':[], 'user_time':None,
                'end_time':None,'reason':None,'missing_timestamps':0,'model_steps':[],
                'tool_calls':0,'retry_count':0,'incomplete_intervals':0}
            intervals[key]={kind:[] for kind in ('model_step','tool','compaction','retry_wait')}
        return key,turns[key]
    def finish(key,kind,start,end):
        if start is None or end is None or end<start:
            turns[key]['incomplete_intervals']+=1
        else: intervals[key][kind].append((start,end))
    def union(spans):
        total=0; end=None
        for a,b in sorted(spans):
            total+=b-max(a,end if end is not None else a) if end is None or b>end else 0
            end=max(end,b) if end is not None else b
        return round(total,3)
    for row in rows:
        ev=row['event']; typ=ev.get('type'); log=row.get('session_log') or '<unwrapped>'
        if typ=='session':
            sid=ev['id'];current[log]=sid
            parent=ev.get('parentSession')
            sessions[sid]={'session_id':sid,'parent_session':parent,'is_seeded':ev.get('isSeeded',False)}
            continue
        sid=current.get(log)
        if sid is None: continue
        data=ev.get('data',{});time=timestamp(ev.get('time'))
        if typ=='turn/start': starts[sid]=data.get('turn')
        turn=data.get('turn',starts.get(sid))
        if turn is None: continue
        key,item=bucket(sid,turn)
        if time is None: item['missing_timestamps']+=1
        if typ=='user/message' and data.get('source',{}).get('kind')=='user' and not ev.get('sourceEventSeqs'):
            item['user_event_seqs'].append(ev.get('seq'))
            if len(item['user_event_seqs'])==1: item['user_time']=time
        elif typ=='turn/end':
            item['end_time']=time;item['reason']=data.get('reason')
        elif typ=='step/start': steps[(sid,turn,data.get('step'))]=time
        elif typ in ('assistant/message','assistant/attempt'):
            step=data.get('step');start=steps.pop((sid,turn,step),None)
            # 尝试和重试属于同一原生步骤，只记录一次外层区间。
            if typ=='assistant/attempt':
                steps[(sid,turn,step)]=start
                continue
            finish(key,'model_step',start,time)
            blocks=data.get('message',{}).get('content',[])
            chars=sum(len(b.get('text',''))+len(b.get('arguments','')) for b in blocks
                if isinstance(b,dict) and isinstance(b.get('arguments',''),str)) if isinstance(blocks,list) else len(blocks)
            item['model_steps'].append({'step':step,'duration_ms':time-start if start is not None and time is not None and time>=start else None,
                'output_chars':chars})
        elif typ=='tool/call':
            cid=(sid,turn,data.get('step'),data.get('callId'))
            if cid not in calls: calls[cid]=(key,time);item['tool_calls']+=1
        elif typ=='tool/result':
            msg=data.get('message',{});cid=(sid,turn,data.get('step'),msg.get('toolCallId'))
            found=calls.pop(cid,None)
            if found: finish(found[0],'tool',found[1],time)
        elif typ=='compaction/start': retries[(sid,'compaction',data.get('compactionId'))]=(key,time)
        elif typ=='llm/retry':
            retries[(sid,'retry_wait',data.get('retryId'))]=(key,time);item['retry_count']+=1
        elif typ in ('compaction/end','llm/retry-started'):
            kind='compaction' if typ=='compaction/end' else 'retry_wait'
            found=retries.pop((sid,kind,data.get('compactionId') if kind=='compaction' else data.get('retryId')),None)
            if found: finish(found[0],kind,found[1],time)
    for key,time in steps.items():
        if key[:2] in turns: turns[key[:2]]['incomplete_intervals']+=1
    for key,time in [*calls.values(),*retries.values()]: turns[key]['incomplete_intervals']+=1
    for key,item in turns.items():
        start=item.pop('user_time');end=item.pop('end_time')
        item['wall_ms']=end-start if start is not None and end is not None and end>=start else None
        item['completed']=item['reason'] is not None
        item['interval_union_ms']={kind:union(spans) for kind,spans in intervals[key].items()}
    return {'sessions':list(sessions.values()),'turns':list(turns.values()),'limitations':[
        'Wall time starts at the actual user event and ends at native turn/end; missing boundaries remain unknown.',
        'Model step spans include provider latency, streaming and native retries; they do not measure pure thinking.',
        'Each category uses interval union; categories may overlap and must not be added. Child sessions remain separate.',
        'Timing does not imply successful request reconstruction or business acceptance.']}

def audit_rows(rows):
    sessions={}; current={}; issues=[]; snapshots=[]; timeline=[]; counts=Counter()
    def issue(code,line,detail,severity='error',session=None):
        v={'code':code,'line':line,'detail':detail,'severity':severity,'session_id':session}
        issues.append(v)
        if session in sessions and severity=='error': sessions[session]['blocking_issues'].append(v)
    for row in rows:
        ev=row['event']; line=row['line']; typ=ev.get('type'); log=row.get('session_log') or '<unwrapped>'
        counts[typ]+=1
        if typ=='session':
            sid=ev.get('id')
            if not isinstance(sid,str) or not sid: raise ValueError(f'line {line}: session id required')
            if sid in sessions: raise ValueError(f'line {line}: duplicate session header {sid}')
            current[log]=sid
            sessions[sid]={'header':copy.deepcopy(ev),'session_log':log,'header_line':line,'surface':[],
                'last_seq':-1,'header_event':None,'request_header':None,
                'blocking_issues':[],'calls':{},'emitted':{},'results':{},'tool_headers':[],
                'message_count':0,'turn':None,'step':None,'finished_turns':[], 'known_turns':set(),'seen_seqs':set(),
                'prior_model_response_count':0,'prior_assistant_message_count':0,
                'prior_tool_activity_count':0,'latest_actual_user_seq':None}
            if ev.get('version')!=4: issue('unsupported_session_version',line,ev.get('version'),session=sid)
            if ev.get('isSeeded') or ev.get('parentSession'):
                issue('lineage_requires_group_review',line,'Seeded/parent session: link all descendants to the same source family.','warning',sid)
            continue
        sid=current.get(log)
        if sid is None: raise ValueError(f'line {line}: no session header for this session_log')
        s=sessions[sid]; seq=ev.get('seq'); data=ev.get('data',{})
        if type(seq) is not int:
            issue('invalid_seq',line,'Integer event seq required',session=sid);continue
        if seq!=s['last_seq']+1: issue('seq_gap_or_reorder',line,{'expected':s['last_seq']+1,'actual':seq},session=sid)
        s['last_seq']=seq
        if 'sourceEventSeqs' in ev:
            sources=ev['sourceEventSeqs']
            if (not isinstance(sources,list) or not sources or
                any(type(n) is not int or n>=seq or n not in s['seen_seqs'] for n in sources) or
                len(set(sources))!=len(sources)):
                issue('invalid_source_event_seqs',line,sources,session=sid)
            if typ=='assistant/message': issue('assistant_source_refs_forbidden',line,'Assistant response embeds its provider stream',session=sid)
        if typ in NON_MESSAGE_TYPES and ('surfaceOp' in ev or 'sourceEventSeqs' in ev):
            issue('log_only_surface_metadata',line,typ,session=sid)
        s['seen_seqs'].add(seq)
        timeline.append({'line':line,'session_id':sid,'seq':seq,'type':typ,'turn':data.get('turn'),'step':data.get('step')})
        if typ=='turn/start': s['turn']=data.get('turn');s['known_turns'].add(data.get('turn'))
        if typ=='step/start': s['turn']=data.get('turn');s['step']=data.get('step')
        if typ=='turn/end': s['finished_turns'].append(data.get('turn'))
        if typ=='request/header':
            h=data.get('header')
            if not isinstance(h,dict) or not isinstance(h.get('tools'),list):
                issue('invalid_request_header',line,'Expected header.config/tools',session=sid)
            else:
                tools=h['tools'];names=[t.get('name') for t in tools if isinstance(t,dict)]
                if len(names)!=len(tools) or len(set(names))!=len(names) or any(not n for n in names):
                    issue('duplicate_or_invalid_tools',line,names,session=sid)
                s['request_header']=copy.deepcopy(h);s['header_event']=copy.deepcopy(row)
                s['tool_headers'].append({'line':line,'seq':seq,'tool_count':len(tools),'tool_names':names,'sha256':digest(tools)})
        if typ=='tool/call':
            cid=data.get('callId');key=(data.get('turn'),data.get('step'),cid)
            if not cid or key in s['calls']:
                issue('invalid_or_duplicate_call',line,cid,session=sid)
            emitted=s['emitted'].get(key)
            if emitted is None: issue('call_without_model_selection',line,cid,session=sid)
            else:
                block=emitted['block']
                try:
                    a=strict_loads(block['arguments']) if isinstance(block.get('arguments'),str) else block.get('arguments')
                    b=strict_loads(data['arguments']) if isinstance(data.get('arguments'),str) else data.get('arguments')
                    if block.get('name')!=data.get('name') or a!=b: issue('call_differs_from_selection',line,cid,session=sid)
                except (ValueError,TypeError,KeyError) as exc: issue('invalid_tool_arguments',line,str(exc),session=sid)
            s['calls'][key]={'line':line,'seq':seq,'name':data.get('name'),'call_id':cid,'arguments':data.get('arguments')}
        if typ=='tool/result':
            message=_message(ev) or {};cid=message.get('toolCallId');key=(data.get('turn'),data.get('step'),cid)
            call=s['calls'].get(key)
            if not call: issue('orphan_tool_result',line,cid,session=sid)
            else:
                if call['seq'] not in ev.get('sourceEventSeqs',[]): issue('result_source_mismatch',line,cid,session=sid)
                if message.get('source',{}).get('callId')!=cid: issue('result_call_id_mismatch',line,cid,session=sid)
            if key in s['results']: issue('duplicate_tool_result',line,cid,session=sid)
            s['results'][key]={'line':line,'seq':seq,'call_id':cid,'is_error':message.get('isError'),'message':copy.deepcopy(message)}
        if typ=='assistant/message':
            message=_message(ev) or {}
            if message.get('source',{}).get('kind')!='model':
                issue('assistant_source_not_model',line,'Not emitted as a training decision boundary','warning',sid)
            else:
                if s['request_header'] is None: issue('missing_request_header',line,'Cannot recover current candidate tool set',session=sid)
                surface=copy.deepcopy([n for n in s['surface'] if n['message'].get('content')]);header=copy.deepcopy(s['request_header'])
                content=message.get('content',[])
                observed_calls=[b for b in content if isinstance(b,dict) and b.get('type')=='tool-call'] if isinstance(content,list) else []
                for block in observed_calls:
                    key=(data.get('turn'),data.get('step'),block.get('id'))
                    if not isinstance(block.get('id'),str) or not block['id']:
                        issue('invalid_selection_call_id',line,block.get('id'),session=sid)
                    try:
                        chosen_args=strict_loads(block['arguments']) if isinstance(block.get('arguments'),str) else block.get('arguments')
                        if not isinstance(chosen_args,dict): raise ValueError('Tool arguments must be an object')
                    except (ValueError,KeyError,TypeError) as exc:
                        issue('invalid_tool_arguments',line,str(exc),session=sid)
                    if key in s['emitted']: issue('duplicate_selection_call_id',line,block.get('id'),session=sid)
                    s['emitted'][key]={'block':copy.deepcopy(block),'line':line}
                    if header and block.get('name') not in [t.get('name') for t in header['tools']]:
                        issue('selected_tool_not_in_header',line,block.get('name'),session=sid)
                snapshots.append({'session_id':sid,'session_log':log,'turn':data.get('turn'),'step':data.get('step'),
                    'decision_line':line,'decision_seq':seq,'visible_event_seqs':[x['seq'] for x in surface],
                    'surface':surface,'request_header':header,'request_header_ref':ref(s['header_event']) if s['header_event'] else None,
                    'prefix_context':{
                        'prior_model_response_count':s['prior_model_response_count'],
                        'prior_assistant_message_count':s['prior_assistant_message_count'],
                        'prior_tool_activity_count':s['prior_tool_activity_count'],
                        'latest_actual_user_seq':s['latest_actual_user_seq'],
                        'session_has_inherited_context':bool(s['header'].get('isSeeded') or s['header'].get('parentSession'))},
                    'prefix_digest':digest({'surface':surface,'header':header}),
                    'visibility':'reconstructed_provider_neutral_input','adapter_version':VERSION,
                    'blocking_issues':copy.deepcopy(s['blocking_issues']),
                    'observed_action':{'tool_calls':copy.deepcopy(observed_calls),'text':text_of(message)},
                    'usage':copy.deepcopy(data.get('usage',{}))})
                s['prior_model_response_count']+=1
            s['prior_assistant_message_count']+=1
        if typ in {'tool/call','tool/result'}: s['prior_tool_activity_count']+=1
        if typ=='user/message' and isinstance(data,dict) and isinstance(data.get('source'),dict) and data['source'].get('kind')=='user':
            s['latest_actual_user_seq']=seq
        if typ in MESSAGE_TYPES:
            message=_message(ev)
            if not isinstance(message,dict): issue('missing_message',line,typ,session=sid);continue
            blocks=message.get('content',[])
            if not isinstance(blocks,(list,str)): issue('unsupported_content_shape',line,type(blocks).__name__,session=sid);continue
            for block in blocks if isinstance(blocks,list) else []:
                if not isinstance(block,dict) or block.get('type') not in BLOCK_TYPES:
                    issue('unsupported_content_block',line,block.get('type') if isinstance(block,dict) else type(block).__name__,session=sid)
            op=ev.get('surfaceOp')
            node={'seq':seq,'line':line,'event_type':typ,'message':copy.deepcopy(message)}
            if op=='append': s['surface'].append(node)
            elif isinstance(op,dict) and op.get('op')=='replace':
                oldseq=[x['seq'] for x in s['surface']]
                try:
                    if set(op)!={'op','startSeq','endSeq'}: raise ValueError('Unknown surface replace keys')
                    a=oldseq.index(op['startSeq']);b=oldseq.index(op['endSeq'])
                    if a>b: raise ValueError('reversed surface endpoints')
                    if a==0 and s['surface'][0]['event_type']=='system/message' and not (typ=='system/message' and b==0):
                        raise ValueError('Leading system node may only be replaced by a single system node')
                    replaced=oldseq[a:b+1]
                    if not set(replaced).issubset(set(ev.get('sourceEventSeqs',[]))): raise ValueError('sourceEventSeqs missing replaced surface nodes')
                    s['surface'][a:b+1]=[node]
                except (ValueError,KeyError) as exc: issue('invalid_surface_replace',line,str(exc),session=sid)
            else: issue('unsupported_surface_operation',line,op,session=sid)
            s['message_count']+=1
        elif typ not in NON_MESSAGE_TYPES:
            if ev.get('ignorable') is True:
                issue('ignored_extension_event',line,typ,'warning',sid)
            else:
                issue('unsupported_event',line,typ,session=sid)
    summary=[]
    for sid,s in sessions.items():
        for key,call in s['calls'].items():
            if key not in s['results']: issue('missing_tool_result',call['line'],call['call_id'],'warning',sid)
        for key,chosen in s['emitted'].items():
            if key not in s['calls']: issue('selection_not_executed',chosen['line'],key[2],'warning',sid)
        if set(s['known_turns'])-set(s['finished_turns']): issue('unfinished_turn',s['header_line'],'Turn end absent','warning',sid)
        summary.append({'session_id':sid,'session_log':s['session_log'],'header':s['header'],
            'message_count':s['message_count'],'tool_call_count':len(s['calls']),'tool_result_count':len(s['results']),
            'tool_error_count':sum(r['is_error'] is True for r in s['results'].values()),
            'tool_headers':s['tool_headers'],'turn_count':len(s['known_turns']),
            'calls':[dict(v,result_line=s['results'].get(k,{}).get('line')) for k,v in s['calls'].items()]})
    return {'adapter_version':VERSION,'records':len(rows),'event_counts':dict(counts),'sessions':summary,
        'snapshots':snapshots,'timeline':timeline,'issues':issues,'timing':timing_summary(rows),
        'limitations':['Harness-neutral reconstruction; no claim of exact provider HTTP serialization.',
            'Unsupported mandatory events/projections block affected later snapshots; no plugin code is executed.',
            'Tool success, business result, and task success are separate signals.']}

def _event_ref(node): return {'kind':'event','line':node['line'],'seq':node['seq']}

def _latest_user(snap):
    found=[n for n in snap['surface'] if n['event_type']=='user/message' and n['message'].get('source',{}).get('kind')=='user']
    return found[-1] if found else None

def _tool_history(snap):
    calls={}
    for n in snap['surface']:
        if n['event_type']=='assistant/message':
            for b in n['message'].get('content',[]):
                if b.get('type')=='tool-call': calls[b.get('id')]=b
    results=[]
    for n in snap['surface']:
        if n['event_type']=='tool/result':
            c=calls.get(n['message'].get('toolCallId'),{})
            try: payload=strict_loads(text_of(n['message']))
            except (ValueError,TypeError): payload=None
            results.append((n,c,payload))
    return results

def _observed(snap):
    calls=snap['observed_action']['tool_calls']
    if len(calls)!=1: return None,{}
    c=calls[0]
    try: args=strict_loads(c['arguments']) if isinstance(c.get('arguments'),str) else c.get('arguments')
    except (ValueError,TypeError): args={}
    return c.get('name'),args if isinstance(args,dict) else {}

def build_sample(snap,profile='next-operation'):
    """Construct input from prefix only; attach observed output only afterwards."""
    if profile=='cybersecurity-routing-v1':
        from security_routing import build_sample as build_security_routing_sample
        return build_security_routing_sample(snap)
    if snap['blocking_issues']: return None,{'decision_line':snap['decision_line'],'reason':'trace_integrity','issues':snap['blocking_issues']}
    user=_latest_user(snap)
    if user is None: return None,{'decision_line':snap['decision_line'],'reason':'missing_actual_user_message'}
    request=text_of(user['message']);state_refs=[_event_ref(user)];candidate_refs=[];bindings={};implementation='hybrid'
    q={'type':'choice'};site='next-operation.v1';state={};suggestion=None;observed_value=None
    history=_tool_history(snap)
    last=history[-1] if history else None
    header=snap['request_header'] or {'tools':[]}
    toolnames={t['name'] for t in header['tools']}
    if profile=='next-operation':
        state={'context':stable([n['message'] for n in snap['surface']])}
        state_refs=[_event_ref(n) for n in snap['surface']]
        q['instructions']='根据当前可见上下文选择下一项操作；选择工具只表示工具类别，参数需另行构造。respond 表示输出面向用户的文本。'
        q['criteria']={t['name']:t.get('description','') for t in header['tools']}
        if 'respond' in q['criteria']: return None,{'reason':'reserved_action_collision','decision_line':snap['decision_line']}
        q['criteria']['respond']='输出面向用户的文本（包括必要的澄清），不在本题生成正文。'
        candidate_refs=[snap['request_header_ref']]
    elif profile=='inspection-v1':
        contract={'kind':'contract','contract_version':'inspection-reference/v1'}
        if last is None:
            if 'skill' not in toolnames:
                return None,{'reason':'skill_tool_unavailable','decision_line':snap['decision_line']}
            catalogs=[n for n in snap['surface'] if n['message'].get('source',{}).get('kind')=='skill-catalog']
            if not catalogs: return None,{'reason':'missing_skill_catalog','decision_line':snap['decision_line']}
            catalog=catalogs[-1]
            skills=dict(re.findall(r'^-\s+`([^`]+)`:\s*(.+)$',text_of(catalog['message']),re.M))
            if not skills: return None,{'reason':'unparsed_skill_catalog','decision_line':snap['decision_line']}
            site='skill-route.v1';implementation='model';state={'request':request}
            q['instructions']='根据本次用户需求和可用技能职责，选择最适用的一个技能；信息不足选 clarify，无适用技能选 no_match。'
            if {'clarify','no_match'}&set(skills): return None,{'reason':'reserved_skill_collision','decision_line':snap['decision_line']}
            q['criteria']={**skills,'clarify':'需要补充信息才能路由','no_match':'没有适用的技能'}
            candidate_refs=[_event_ref(catalog),contract]
        elif last[1].get('name')=='skill' and '<skill_content name="security-inspection">' in text_of(last[0]['message']):
            if 'mcp__inspection__list_executable_inspections' not in toolnames:
                return None,{'reason':'inspection_catalog_tool_unavailable','decision_line':snap['decision_line']}
            site='inspection-discovery.v1';implementation='code';state={'request':request,'inspection_skill_loaded':True,'catalog_available':False}
            q['instructions']='在已进入巡检流程的前提下，决定下一步：执行前先取得当前可执行目录；仅凭历史名称不能猜测任务标识。'
            q['criteria']={'list_catalog':'查询当前可执行巡检目录','clarify':'用户需求需要澄清','respond':'当前无需执行，仅向用户说明'}
            state_refs.append(_event_ref(last[0]));candidate_refs=[snap['request_header_ref'],contract]
            suggestion={'value':'list_catalog','basis':'Loaded skill requires discovery first; inspect user intent before confirming.'}
        elif last[1].get('name')=='mcp__inspection__list_executable_inspections':
            if 'mcp__inspection__start_inspection' not in toolnames:
                return None,{'reason':'inspection_start_tool_unavailable','decision_line':snap['decision_line']}
            if last[0]['message'].get('isError') is True or not isinstance(last[2],list):
                return None,{'reason':'invalid_catalog_response','decision_line':snap['decision_line']}
            catalog=last[2];site='inspection-template.v1';state={'request':request};implementation='hybrid'
            q['instructions']='选择符合用户需求的本轮可执行模板。唯一匹配后仍需检查必填运行参数；无唯一匹配选 clarify；空目录选 unavailable。不使用后续运行结果选择模板。'
            q['criteria']={}
            matches=[]
            seen_bindings=set()
            for i,t in enumerate(catalog):
                if not isinstance(t,dict) or not all(isinstance(t.get(k),str) and t[k] for k in ['taskId','definitionVersion','name']):
                    return None,{'reason':'invalid_template_record','decision_line':snap['decision_line']}
                key=f'template_{i+1}'
                identity=(t['taskId'],t['definitionVersion'])
                if identity in seen_bindings:
                    return None,{'reason':'duplicate_template_binding','decision_line':snap['decision_line']}
                seen_bindings.add(identity)
                q['criteria'][key]=stable({k:t.get(k) for k in ['name','description','inspectionItems','matchPhrases','defaultForChat','runtimeInputSchema']})
                bindings[key]={'tool':'mcp__inspection__start_inspection','taskId':t['taskId'],'definitionVersion':t['definitionVersion']}
                normalized=re.sub(r'[。！？!?\s]+$','',request)
                if normalized in t.get('matchPhrases',[]): matches.append(key)
            q['criteria'].update({'clarify':'没有唯一匹配或需求需要澄清','unavailable':'目录为空，没有可执行模板'})
            candidate_refs=[_event_ref(last[0]),contract]
            if len(matches)==1:
                implementation='code';suggestion={'value':matches[0],'basis':'Unique exact phrase match; reference matching contract, not an inferred hidden policy.'}
            elif not catalog: suggestion={'value':'unavailable','basis':'Observed empty catalog.'}
        elif last[1].get('name')=='mcp__inspection__start_inspection':
            if 'mcp__inspection__get_inspection_result' not in toolnames:
                return None,{'reason':'inspection_query_tool_unavailable','decision_line':snap['decision_line']}
            receipt=last[2]
            if not isinstance(receipt,dict) or last[0]['message'].get('isError') is True:
                return None,{'reason':'invalid_start_response','decision_line':snap['decision_line']}
            site='inspection-followup.v1';implementation='code'
            state={'request':request,'run_status':receipt.get('status'),'run_id_available':bool(receipt.get('runId')),
                'report_available':bool(receipt.get('reportMarkdown')),'download_available':bool(receipt.get('reportDownloadUrl')),
                'poll_budget':'not_recorded'}
            q['instructions']='继续跟踪已创建的同一个运行。运行中可按预算查询或告知待完成；不得因未知状态重新发起。没有运行标识时说明需要恢复关联信息。'
            q['criteria']={'query_existing':'使用已有 runId 查询当前运行','report_pending':'告知当前运行中，保留 runId 供续查','recover_reference':'缺少 runId，先恢复关联信息','present_result':'结果已就绪，转入结果表达'}
            if receipt.get('runId'):
                bindings['query_existing']={'tool':'mcp__inspection__get_inspection_result','runId':receipt['runId']}
            else:
                del q['criteria']['query_existing']
            state_refs.append(_event_ref(last[0]));candidate_refs=[_event_ref(last[0]),contract]
        elif last[1].get('name')=='mcp__inspection__get_inspection_result':
            receipt=last[2]
            if not isinstance(receipt,dict) or last[0]['message'].get('isError') is True:
                return None,{'reason':'invalid_result_response','decision_line':snap['decision_line']}
            site='inspection-disposition.v1';implementation='hybrid'
            state={'request':request,'run_status':receipt.get('status'),'result_status':receipt.get('resultStatus'),
                'conclusion_status':receipt.get('conclusionStatus'),'error_message':receipt.get('errorMessage'),
                'report_available':bool(receipt.get('reportMarkdown')),'download_available':bool(receipt.get('reportDownloadUrl'))}
            q['instructions']='只选择结果表达方式，不生成报告。区分运行结束、证据完整与是否异常；PARTIAL 不能被当作全部正常。正文数字和链接由证据绑定与模板另行处理。'
            q['criteria']={'present_with_gaps':'报告已有结论并明确证据缺口','present_complete':'报告完整检查结论，仍保留正常或异常状态','continue_wait':'继续等待或查询运行状态','report_failure':'说明实际失败及可行下一步','need_review':'字段矛盾或不足，需复核'}
            state_refs.append(_event_ref(last[0]));candidate_refs=[_event_ref(last[0]),contract]
            if receipt.get('status')=='PARTIAL':
                suggestion={'value':'present_with_gaps','basis':'Observed PARTIAL under the reference result contract; business truth remains upstream evidence.'}
        else:
            return None,{'reason':'profile_not_applicable_to_prefix','decision_line':snap['decision_line']}
    else: raise ValueError('Unknown extraction profile: '+profile)
    name,args=_observed(snap)
    if profile=='next-operation': observed_value=name if name else ('respond' if not snap['observed_action']['tool_calls'] else None)
    elif site=='skill-route.v1' and name=='skill': observed_value=args.get('name')
    elif site=='inspection-discovery.v1' and name=='mcp__inspection__list_executable_inspections': observed_value='list_catalog'
    elif site=='inspection-template.v1' and name=='mcp__inspection__start_inspection':
        found=[k for k,b in bindings.items() if args.get('taskId')==b['taskId'] and args.get('definitionVersion')==b['definitionVersion']]
        if len(found)==1: observed_value=found[0]
    elif site=='inspection-followup.v1' and name=='mcp__inspection__get_inspection_result':
        if 'query_existing' in bindings and args.get('runId')==bindings['query_existing']['runId']: observed_value='query_existing'
    sample_id='dsh-'+digest({'session':snap['session_id'],'turn':snap['turn'],'step':snap['step'],'seq':snap['decision_seq'],'site':site})[:24]
    sample={'schema_version':'kev-decision-ir/v1','sample_id':sample_id,'decision_site_id':site,
        'contract_version':'inspection-reference/v1' if profile=='inspection-v1' else 'next-operation/v1',
        'implementation':implementation,'state':state,'question':q,
        'candidate_bindings':bindings,'observed_action':copy.deepcopy(snap['observed_action']),
        'observed_candidate':observed_value,'label':{'status':'unlabeled','value':None,'source':'','evidence_refs':[]},
        'provenance':{'trace_sha256':snap.get('trace_sha256'),'session_id':snap['session_id'],'session_log':snap['session_log'],
            'source_group_id':snap['session_id'],'turn':snap['turn'],'step':snap['step'],'decision_seq':snap['decision_seq'],
            'decision_line':snap['decision_line'],'visible_event_seqs':snap['visible_event_seqs'],
            'state_evidence_refs':state_refs,'candidate_evidence_refs':[r for r in candidate_refs if r is not None],
            'state_builder_version':VERSION+'/'+profile,'candidate_builder_version':VERSION+'/'+profile,
            'prefix_digest':snap['prefix_digest'],'visibility':snap['visibility']},
        'review':{'rule_suggestion':suggestion,'observed_candidate_in_options':observed_value in q['criteria'] if observed_value is not None else None,
            'parameter_generation_replaced':False,'needs_runtime_contract_validation':True}}
    return sample,None

def extract(audit,profile):
    records=[];blocked=[]
    for snap in audit['snapshots']:
        r,b=build_sample(snap,profile)
        if r is not None: records.append(r)
        if b is not None: blocked.append(b)
    return records,blocked

def audit_summary(audit):
    return {k:v for k,v in audit.items() if k!='snapshots'} | {
        'decision_boundary_count':len(audit['snapshots']),
        'decisions':[{'line':s['decision_line'],'seq':s['decision_seq'],'session_id':s['session_id'],
            'turn':s['turn'],'step':s['step'],'visible_message_count':len(s['surface']),
            'current_tool_count':len((s['request_header'] or {}).get('tools',[])),
            'observed_tool_names':[c['name'] for c in s['observed_action']['tool_calls']],
            'blocking_issue_count':len(s['blocking_issues'])} for s in audit['snapshots']]}

"""Synthetic invariants for the DSH adapter; no user trace is stored here."""
import copy
import json
import unittest
from trace_adapter import audit_rows, build_sample, strict_loads, timing_summary

def fixture():
    header={'type':'session','version':4,'id':'synthetic-session','isSeeded':False}
    messages=[
        {'type':'user/message','data':{'id':'u1','role':'user','source':{'kind':'user'},'content':[{'type':'text','text':'Inspect a synthetic resource.'}]},'surfaceOp':'append'},
        {'type':'request/header','data':{'header':{'config':{'model':'synthetic'},'tools':[{'name':'lookup','description':'Look up current facts','parameters':{'type':'object'}},{'name':'inspect','description':'Inspect a known target','parameters':{'type':'object'}}]}}},
        {'type':'assistant/message','data':{'turn':1,'step':1,'message':{'id':'a1','role':'assistant','source':{'kind':'model'},'content':[{'type':'tool-call','id':'c1','name':'lookup','arguments':'{}'}]},'usage':{'inputTokens':10,'outputTokens':2},'stream':[{'type':'usage','usage':{'inputTokens':10,'outputTokens':2}}]},'surfaceOp':'append'},
        {'type':'tool/call','data':{'turn':1,'step':1,'callId':'c1','name':'lookup','arguments':'{}'}},
        {'type':'tool/result','data':{'turn':1,'step':1,'message':{'role':'tool','source':{'kind':'tool','callId':'c1'},'toolCallId':'c1','content':[{'type':'text','text':'{"available":true}'}],'isError':False}},'sourceEventSeqs':[3],'surfaceOp':'append'},
        {'type':'assistant/message','data':{'turn':1,'step':2,'message':{'id':'a2','role':'assistant','source':{'kind':'model'},'content':[{'type':'text','text':'Synthetic result.'}]}},'surfaceOp':'append'},
        {'type':'turn/end','data':{'turn':1,'reason':{'kind':'completed'}}},
    ]
    return wrap(header,messages)

def wrap(header,events):
    return [{'line':1,'session_log':'session.v4.jsonl','event':header}]+[{'line':i+2,'session_log':'session.v4.jsonl','event':dict(e,seq=i)} for i,e in enumerate(events)]

class AdapterTests(unittest.TestCase):
    def test_native_timing_unions_retries_and_real_user_boundaries(self):
        events=[
            ('turn/start',0,{'turn':1}),
            ('user/message',10,{'source':{'kind':'user'}}),
            ('step/start',20,{'turn':1,'step':1}),
            ('assistant/attempt',40,{'turn':1,'step':1}),
            ('llm/retry',40,{'turn':1,'step':1,'retryId':'r'}),
            ('llm/retry-started',50,{'turn':1,'step':1,'retryId':'r'}),
            ('assistant/message',100,{'turn':1,'step':1,'message':{'content':[{'text':'done'}]}}),
            ('tool/call',100,{'turn':1,'step':1,'callId':'a'}),
            ('tool/call',110,{'turn':1,'step':1,'callId':'b'}),
            ('tool/result',150,{'turn':1,'step':1,'message':{'toolCallId':'a'}}),
            ('tool/result',160,{'turn':1,'step':1,'message':{'toolCallId':'b'}}),
            ('tool/result',190,{'turn':1,'step':1,'message':{'toolCallId':'a'}}),
            ('compaction/start',120,{'turn':1,'compactionId':'c'}),
            ('compaction/end',180,{'turn':1,'compactionId':'c'}),
            ('user/message',190,{'source':{'kind':'user'}}),
            ('turn/end',210,{'turn':1,'reason':{'kind':'completed'}}),
        ]
        rows=wrap({'type':'session','version':4,'id':'s'},[dict(type=t,time=ms,data=d) for t,ms,d in events])
        rows[-2]['event']['sourceEventSeqs']=[1]
        out=timing_summary(rows)['turns'][0]
        self.assertEqual(out['user_event_seqs'],[1])
        self.assertEqual(out['wall_ms'],200)
        self.assertEqual(out['interval_union_ms'],{'model_step':80,'tool':60,'compaction':60,'retry_wait':10})
        self.assertEqual((out['tool_calls'],out['retry_count'],out['incomplete_intervals']),(2,1,0))
        self.assertEqual(out['model_steps'],[{'step':1,'duration_ms':80,'output_chars':4}])

    def test_timing_missing_end_and_child_are_not_parent_wall_time(self):
        parent=wrap({'type':'session','version':4,'id':'p'},[
            {'type':'turn/start','time':0,'data':{'turn':1}},
            {'type':'user/message','time':1,'data':{'source':{'kind':'user'}}},
            {'type':'tool/call','time':2,'data':{'turn':1,'step':1,'callId':'same'}},
        ])
        child=wrap({'type':'session','version':4,'id':'c','parentSession':{'id':'p'},'isSeeded':False},[
            {'type':'turn/start','time':0,'data':{'turn':1}},
            {'type':'user/message','data':{'source':{'kind':'user'}}},
            {'type':'tool/result','time':3,'data':{'turn':1,'step':1,'message':{'toolCallId':'same'}}},
            {'type':'turn/end','time':4,'data':{'turn':1,'reason':{'kind':'completed'}}},
        ])
        out=timing_summary(parent+child)
        self.assertEqual(out['sessions'][1]['parent_session'],{'id':'p'})
        self.assertEqual([t['wall_ms'] for t in out['turns']],[None,None])
        self.assertEqual(out['turns'][0]['incomplete_intervals'],1)
        self.assertEqual(out['turns'][1]['interval_union_ms']['tool'],0)
        self.assertEqual(out['turns'][1]['missing_timestamps'],1)

    def test_first_missing_user_time_cannot_be_replaced_by_a_later_message(self):
        rows=wrap({'type':'session','version':4,'id':'s'},[
            {'type':'turn/start','time':0,'data':{'turn':1}},
            {'type':'user/message','data':{'source':{'kind':'user'}}},
            {'type':'user/message','time':2,'data':{'source':{'kind':'user'}}},
            {'type':'turn/end','time':4,'data':{'turn':1,'reason':{'kind':'completed'}}},
        ])
        self.assertIsNone(timing_summary(rows)['turns'][0]['wall_ms'])

    def test_counts_and_call_pair(self):
        a=audit_rows(fixture())
        self.assertEqual(len(a['snapshots']),2)
        self.assertEqual(a['sessions'][0]['tool_call_count'],1)
        self.assertEqual(a['sessions'][0]['tool_result_count'],1)
        self.assertEqual([i for i in a['issues'] if i['severity']=='error'],[])
        self.assertEqual(len(a['snapshots'][0]['surface']),1)

    def test_future_invariance(self):
        before=fixture();after=copy.deepcopy(before)
        after[5]['event']['data']['message']['content'][0]['text']='{"available":false,"secret_future":"different"}'
        after[6]['event']['data']['message']['content'][0]['text']='Entirely different future answer'
        a=build_sample(audit_rows(before)['snapshots'][0])[0]
        b=build_sample(audit_rows(after)['snapshots'][0])[0]
        self.assertEqual((a['state'],a['question']),(b['state'],b['question']))

    def test_current_answer_not_input(self):
        a=fixture();b=copy.deepcopy(a)
        b[3]['event']['data']['message']['content'][0]['name']='inspect'
        b[4]['event']['data']['name']='inspect'
        x=build_sample(audit_rows(a)['snapshots'][0])[0]
        y=build_sample(audit_rows(b)['snapshots'][0])[0]
        self.assertEqual((x['state'],x['question']),(y['state'],y['question']))
        self.assertNotEqual(x['observed_candidate'],y['observed_candidate'])

    def test_progressive_skill_context_stays_at_its_visible_boundary(self):
        rows=fixture();events=[r['event'] for r in rows[1:]]
        events[4]['data']['message']['content'][0]['text']='<skill_content>SKILL_BODY_V1</skill_content>'
        events[4]['sourceEventSeqs']=[4]
        events.insert(1,{'type':'user/message','data':{'role':'user','source':{'kind':'skill-catalog','form':'catalog'},
            'content':[{'type':'text','text':'Synthetic inspection skill catalog'}]},'surfaceOp':'append'})
        events.insert(6,{'type':'user/message','data':{'role':'user','source':{'kind':'context','form':'notice'},
            'content':[{'type':'text','text':'SKILL_SUMMARY'}]},'surfaceOp':{'op':'replace','startSeq':5,'endSeq':5},'sourceEventSeqs':[5]})
        snapshots=audit_rows(wrap(rows[0]['event'],events))['snapshots']
        initial=build_sample(snapshots[0])[0]
        compacted=build_sample(snapshots[1])[0]
        self.assertEqual(json.loads(initial['state']['context'])[1]['source']['kind'],'skill-catalog')
        self.assertNotIn('SKILL_BODY',json.dumps(initial['state']))
        self.assertNotIn('SKILL_BODY',json.dumps(compacted['state']))
        self.assertIn('SKILL_SUMMARY',json.dumps(compacted['state']))
        loaded_events=events[:6]+events[7:]
        loaded=build_sample(audit_rows(wrap(rows[0]['event'],loaded_events))['snapshots'][1])[0]
        self.assertIn('SKILL_BODY_V1',json.dumps(loaded['state']))
        changed=copy.deepcopy(events)
        changed[5]['data']['message']['content'][0]['text']='SKILL_BODY_V2'
        again=audit_rows(wrap(rows[0]['event'],changed))['snapshots']
        for index, sample in enumerate((initial,compacted)):
            revised=build_sample(again[index])[0]
            self.assertEqual((sample['state'],sample['question']),(revised['state'],revised['question']))

    def test_tool_headers_persist_and_change(self):
        rows=fixture();h=copy.deepcopy(rows[2]['event']);h['data']['header']['tools']=h['data']['header']['tools'][:1]
        ev=[r['event'] for r in rows[1:]];ev.insert(5,h)
        a=audit_rows(wrap(rows[0]['event'],ev))
        self.assertEqual([len(s['request_header']['tools']) for s in a['snapshots']],[2,1])

    def test_nontext_removal_preserved(self):
        rows=fixture();ev=[r['event'] for r in rows[1:]]
        ev.insert(5,{'type':'developer/message','data':{'message':{'role':'developer','content':[{'type':'tool-removal','toolName':'inspect'}]}},'surfaceOp':'append'})
        a=audit_rows(wrap(rows[0]['event'],ev))
        self.assertEqual(a['snapshots'][1]['surface'][-1]['message']['content'][0]['type'],'tool-removal')

    def test_unknown_event_blocks_later_only(self):
        rows=fixture();ev=[r['event'] for r in rows[1:]];ev.insert(5,{'type':'plugin/unknown','data':{}})
        a=audit_rows(wrap(rows[0]['event'],ev))
        self.assertFalse(a['snapshots'][0]['blocking_issues'])
        self.assertTrue(a['snapshots'][1]['blocking_issues'])
        self.assertIsNone(build_sample(a['snapshots'][1])[0])

    def test_ignorable_extension_is_warning(self):
        rows=fixture();ev=[r['event'] for r in rows[1:]];ev.insert(5,{'type':'plugin/telemetry','data':{},'ignorable':True})
        a=audit_rows(wrap(rows[0]['event'],ev))
        self.assertFalse(a['snapshots'][1]['blocking_issues'])

    def test_malformed_selected_arguments_block_current(self):
        rows=fixture();rows[3]['event']['data']['message']['content'][0]['arguments']='{broken'
        a=audit_rows(rows)
        self.assertTrue(a['snapshots'][0]['blocking_issues'])

    def test_orphan_tool_result(self):
        rows=fixture();rows[5]['event']['data']['message']['toolCallId']='not-c1'
        a=audit_rows(rows)
        self.assertIn('orphan_tool_result',[i['code'] for i in a['issues']])

    def test_replace_uses_current_surface(self):
        rows=fixture();ev=[r['event'] for r in rows[1:]]
        ev.insert(5,{'type':'user/message','data':{'role':'user','source':{'kind':'user'},'content':[{'type':'text','text':'New scoped request.'}]},'surfaceOp':{'op':'replace','startSeq':0,'endSeq':4},'sourceEventSeqs':[0,2,4]})
        a=audit_rows(wrap(rows[0]['event'],ev))
        self.assertEqual(len(a['snapshots'][1]['surface']),1)
        self.assertEqual(a['snapshots'][1]['surface'][0]['seq'],5)

    def test_source_guidance_not_new_user(self):
        rows=fixture();ev=[r['event'] for r in rows[1:]]
        ev.insert(5,{'type':'user/message','data':{'role':'user','source':{'kind':'runtime-context'},'content':[{'type':'text','text':'Injected context, not an actual user task.'}]},'surfaceOp':'append'})
        a=audit_rows(wrap(rows[0]['event'],ev))
        sample=build_sample(a['snapshots'][1])[0]
        self.assertEqual(sample['provenance']['state_evidence_refs'][0]['seq'],0)

    def test_strict_json(self):
        with self.assertRaises(ValueError): strict_loads('{"a":1,"a":2}')
        with self.assertRaises(ValueError): strict_loads('{"a":NaN}')

    def test_inspection_route_requires_current_skill_tool(self):
        snap=audit_rows(fixture())['snapshots'][0]
        record,reason=build_sample(snap,'inspection-v1')
        self.assertIsNone(record)
        self.assertEqual(reason['reason'],'skill_tool_unavailable')

    def test_template_selection_requires_current_start_tool(self):
        snap=audit_rows(fixture())['snapshots'][1]
        snap['surface'][1]['message']['content'][0]['name']='mcp__inspection__list_executable_inspections'
        snap['surface'][2]['message']['content'][0]['text']='[]'
        record,reason=build_sample(snap,'inspection-v1')
        self.assertIsNone(record)
        self.assertEqual(reason['reason'],'inspection_start_tool_unavailable')

    def test_future_source_reference_rejected(self):
        rows=fixture();rows[5]['event']['sourceEventSeqs']=[99]
        a=audit_rows(rows)
        self.assertIn('invalid_source_event_seqs',[i['code'] for i in a['issues']])
        self.assertTrue(a['snapshots'][1]['blocking_issues'])

    def test_leading_system_cannot_be_replaced_by_user(self):
        rows=fixture();events=[r['event'] for r in rows[1:]]
        events[0]={'type':'system/message','data':{'message':{'role':'system','content':[{'type':'text','text':'System contract'}]}},'surfaceOp':'append'}
        events.insert(5,{'type':'user/message','data':{'role':'user','source':{'kind':'user'},'content':[{'type':'text','text':'Override'}]},'surfaceOp':{'op':'replace','startSeq':0,'endSeq':4},'sourceEventSeqs':[0,2,4]})
        a=audit_rows(wrap(rows[0]['event'],events))
        self.assertIn('invalid_surface_replace',[i['code'] for i in a['issues']])

    def test_empty_replacement_shadows_old_nodes(self):
        rows=fixture();events=[r['event'] for r in rows[1:]]
        events.insert(5,{'type':'developer/message','data':{'message':{'role':'developer','content':[]}},'surfaceOp':{'op':'replace','startSeq':2,'endSeq':4},'sourceEventSeqs':[2,4]})
        a=audit_rows(wrap(rows[0]['event'],events))
        self.assertEqual(len(a['snapshots'][1]['surface']),1)
        self.assertEqual(a['snapshots'][1]['surface'][0]['seq'],0)

if __name__=='__main__': unittest.main()

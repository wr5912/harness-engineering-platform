"""Subprocess checks for stage gates, using only synthetic local evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / 'kev_trace.py'


def trace_rows(number, *, actual_user=True, corrupt=False):
    header = {'type': 'session', 'version': 4, 'id': f'synthetic-session-{number}'}
    events = [
        {'type': 'user/message', 'surfaceOp': 'append', 'data': {
            'role': 'user', 'source': {'kind': 'user' if actual_user else 'runtime-context'},
            'content': [{'type': 'text', 'text': f'Synthetic request {number}.'}],
        }},
        {'type': 'request/header', 'data': {'header': {
            'config': {'model': 'synthetic'},
            'tools': [{'name': 'lookup', 'description': 'Look up a fact',
                       'parameters': {'type': 'object'}}],
        }}},
        {'type': 'assistant/message', 'surfaceOp': 'append', 'data': {
            'turn': 1, 'step': 1, 'message': {
                'role': 'assistant', 'source': {'kind': 'model'},
                'content': [{'type': 'text', 'text': 'Synthetic response.'}],
            },
        }},
    ]
    if corrupt:
        events.insert(2, {'type': 'plugin/unknown-required-event', 'data': {}})
    return [header, *[dict(event, seq=index) for index, event in enumerate(events)]]


def ir_record(number, *, session=None, status='verified'):
    return {
        'schema_version': 'kev-decision-ir/v1', 'sample_id': f'synthetic-{number}',
        'decision_site_id': 'synthetic-choice', 'contract_version': 'synthetic/v1',
        'implementation': 'model', 'state': {'request': f'Synthetic request {number}'},
        'question': {'type': 'choice', 'instructions': 'Synthetic policy: choose respond.',
                     'criteria': {'respond': 'Respond', 'clarify': 'Ask for context'}},
        'label': {'status': status, 'value': 'respond' if status == 'verified' else None,
                  'source': 'synthetic-test-policy' if status == 'verified' else '',
                  'evidence_refs': ['synthetic-test-rule/v1'] if status == 'verified' else []},
        'provenance': {
            'trace_sha256': 'a' * 64, 'session_id': session or f'session-{number}',
            'source_group_id': f'source-{number}', 'decision_seq': 3, 'decision_line': 5,
            'state_builder_version': 'synthetic-state/v1',
            'candidate_builder_version': 'synthetic-candidates/v1',
            'state_evidence_refs': [{'kind': 'event', 'seq': 0, 'line': 2}],
            'candidate_evidence_refs': [{'kind': 'contract', 'contract_version': 'synthetic/v1'}],
        },
    }


class CliGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write_rows(self, name, rows):
        path = self.root / name
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        return path

    def read_json(self, path):
        return json.loads(path.read_text(encoding='utf-8'))

    def read_rows(self, path):
        return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line]

    def run_stage(self, stage, *arguments, out_name=None, code=0):
        out = self.root / (out_name or stage)
        result = subprocess.run(
            [sys.executable, str(CLI), stage, *map(str, arguments), '--out', str(out)],
            cwd=self.root, capture_output=True, text=True, timeout=15,
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
        )
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.last_result = result
        gate = self.read_json(out / 'stage-status.json')
        self.assertEqual(set(gate), {'stage', 'status', 'reason_codes', 'next_allowed_stage'})
        self.assertEqual(gate['stage'], stage)
        if code:
            self.assertEqual(gate['status'], 'blocked')
            self.assertIsNone(gate['next_allowed_stage'])
        self.assertTrue((out / 'report.md').is_file())
        if '--json' not in arguments:
            expected = {'completed':'完成当前检查', 'requires_review':'还需复核', 'blocked':'当前不能继续'}
            self.assertIn(expected[gate['status']], result.stdout)
            self.assertIn(str(out / 'report.md'), result.stdout)
            self.assertFalse(result.stdout.lstrip().startswith('{'), result.stdout)
            self.assertNotIn('Traceback', result.stdout + result.stderr)
        return out, gate

    def test_single_source_split_is_blocked_and_retains_compile(self):
        source = self.write_rows('single-source.jsonl', [
            ir_record(number, session='one-source-session') for number in range(6)
        ])
        compiled, _ = self.run_stage('compile', '--input', source)
        before = (compiled / 'compiled.jsonl').read_bytes()
        split, gate = self.run_stage('split', '--input', compiled / 'compiled.jsonl', code=2)
        manifest = self.read_json(split / 'split-manifest.json')
        self.assertEqual(manifest['status'], 'blocked')
        self.assertEqual(manifest['independent_groups'], 1)
        self.assertIn('insufficient_independent_groups', gate['reason_codes'])
        self.assertFalse((split / 'train.jsonl').exists())
        self.assertEqual((compiled / 'compiled.jsonl').read_bytes(), before)

    def test_compile_split_audit_preserve_physical_input_order(self):
        rows = [ir_record(index) for index in range(8)]
        for row in rows:
            row['state'] = {'z_request': row['state']['request'], 'a_background': {'z': 'first', 'a': 'second'}}
            row['question']['criteria'] = {'respond': 'Respond', 'clarify': 'Ask for context'}
        source = self.write_rows('ordered-source.jsonl', rows)
        compiled, _ = self.run_stage('compile', '--input', source)
        compiled_rows = self.read_rows(compiled / 'compiled.jsonl')
        self.assertEqual(list(compiled_rows[0]['state']), ['z_request', 'a_background'])
        self.assertEqual(list(compiled_rows[0]['questions']['synthetic-choice']['criteria']), ['respond', 'clarify'])
        split, _ = self.run_stage('split', '--input', compiled / 'compiled.jsonl')
        self.run_stage('audit-dataset', '--dataset-dir', split)

    def test_zero_compile_preserves_unlabeled_quarantine(self):
        source = self.write_rows('unlabeled.jsonl', [ir_record(1, status='unlabeled')])
        out, gate = self.run_stage('compile', '--input', source, code=2)
        report = self.read_json(out / 'compile-report.json')
        self.assertEqual(report['status'], 'blocked')
        self.assertEqual(report['compiled_records'], 0)
        self.assertEqual(self.read_rows(out / 'compiled.jsonl'), [])
        self.assertEqual(len(self.read_rows(out / 'quarantine.jsonl')), 1)
        self.assertIn('label_unlabeled', gate['reason_codes'])

    def test_audit_structural_error_is_fatal_with_evidence(self):
        source = self.write_rows('corrupt-trace.jsonl', trace_rows(1, corrupt=True))
        out, gate = self.run_stage('audit', source, code=2)
        audit = self.read_json(out / 'trace-audit.json')
        self.assertIn('unsupported_event', gate['reason_codes'])
        self.assertTrue(any(issue['severity'] == 'error' for issue in audit['traces'][0]['issues']))
        self.assertTrue((out / 'request-snapshots.jsonl').exists())

    def test_extract_missing_user_is_blocked_without_inventing_samples(self):
        source = self.write_rows('context-only.jsonl', trace_rows(1, actual_user=False))
        out, gate = self.run_stage('extract', source, code=2)
        self.assertIn('no_usable_samples', gate['reason_codes'])
        self.assertIn('missing_actual_user_message', gate['reason_codes'])
        self.assertEqual(self.read_json(out / 'extraction-report.json')['samples'], 0)
        self.assertEqual(self.read_rows(out / 'annotations.todo.jsonl'), [])

    def test_extract_partial_structural_failure_retains_unaffected_sample(self):
        good = self.write_rows('good.jsonl', trace_rows(1))
        bad = self.write_rows('bad.jsonl', trace_rows(2, corrupt=True))
        out, gate = self.run_stage('extract', good, bad, code=2)
        report = self.read_json(out / 'extraction-report.json')
        self.assertEqual(report['samples'], 1)
        self.assertEqual(report['blocked'][0]['reason'], 'trace_integrity')
        self.assertEqual(len(self.read_rows(out / 'samples.jsonl')), 1)
        self.assertIn('trace_audit_errors', gate['reason_codes'])

    def test_routing_profile_reports_later_responses_as_skipped_without_blocking(self):
        rows = trace_rows(1)
        rows.append({'type':'assistant/message', 'surfaceOp':'append', 'seq':3, 'data':{
            'turn':1, 'step':2, 'message':{'role':'assistant', 'source':{'kind':'model'},
                'content':[{'type':'text', 'text':'Synthetic follow-up, outside initial routing.'}]},
        }})
        source = self.write_rows('routing-with-follow-up.jsonl', rows)
        out, gate = self.run_stage('extract', source, '--profile', 'cybersecurity-routing-v1')
        report = self.read_json(out / 'extraction-report.json')
        self.assertEqual(report['samples'], 1)
        self.assertEqual(report['blocked'], [])
        self.assertEqual([item['reason'] for item in report['skipped']], ['not_initial_routing_boundary'])
        self.assertEqual((gate['status'], gate['next_allowed_stage']), ('requires_review', 'annotate'))
        self.assertEqual(self.read_rows(out / 'samples.jsonl')[0]['label']['status'], 'unlabeled')
        self.assertIn('跳过 1 个后续处理时点', self.last_result.stdout)
        discovery, _ = self.run_stage('discover', source, '--profile', 'cybersecurity-routing-v1')
        inventory = self.read_json(discovery / 'decision-inventory.json')
        self.assertEqual(len(inventory['candidates']), 1)
        self.assertIn('Pin target Skill version and decision-time loaded context; compare normative branches with observed coverage',
                      inventory['candidates'][0]['next_evidence_needed'])
        self.assertEqual(inventory['blocked'], [])
        self.assertEqual(len(inventory['skipped']), 1)

    def test_annotate_unlabeled_is_nonfatal_and_requires_review(self):
        source = self.write_rows('unlabeled.jsonl', [ir_record(1, status='unlabeled')])
        annotations = self.write_rows('no-new-labels.jsonl', [])
        out, gate = self.run_stage('annotate', '--samples', source, '--annotations', annotations)
        self.assertEqual(gate['status'], 'requires_review')
        self.assertEqual(gate['next_allowed_stage'], 'annotate')
        self.assertIn('no_default_export_eligible_labels', gate['reason_codes'])
        self.assertEqual(self.read_json(out / 'annotation-report.json')['labels'], {'unlabeled': 1})

    def test_mixed_types_annotate_compile_split_and_audit_preserve_native_labels(self):
        rows, annotations = [], []
        definitions = (("choice", {"false": "字面否", "0": "字面零"}, "false"),
                       ("noul", {"false": "不成立", "true": "成立"}, False),
                       ("score", ["low", "high"], 0))
        for group in range(5):
            for kind, criteria, value in definitions:
                row = ir_record(f'{group}-{kind}', session=f'session-{group}', status='unlabeled')
                row['provenance']['source_group_id'] = f'source-{group}'
                row['state'] = {'request': f'Synthetic independent task {group}'}
                row['decision_site_id'] = f'synthetic-{kind}'
                row['question'] = {'type': kind, 'instructions': 'Synthetic typed question', 'criteria': criteria}
                rows.append(row)
                annotations.append({'sample_id': row['sample_id'], 'label': {
                    'status': 'verified', 'value': value, 'source': 'synthetic-ai-functional-review',
                    'evidence_refs': ['synthetic-review-only'],
                }})
        source = self.write_rows('typed-unlabeled.jsonl', rows)
        reviews = self.write_rows('typed-annotations.jsonl', annotations)
        annotated, _ = self.run_stage('annotate', '--samples', source, '--annotations', reviews)
        compiled, _ = self.run_stage('compile', '--input', annotated / 'samples.labeled.jsonl')
        exported = self.read_rows(compiled / 'compiled.jsonl')
        labels = {next(iter(row['questions'].values()))['type']: next(iter(row['questions'].values()))['label'] for row in exported}
        self.assertEqual(labels['choice'], 'false')
        self.assertIs(labels['noul'], False)
        self.assertIs(type(labels['score']), int)
        self.assertEqual(labels['score'], 0)
        split, _ = self.run_stage('split', '--input', compiled / 'compiled.jsonl', '--fractions', '0.2,0.2,0.4,0.2')
        manifest = self.read_json(split / 'split-manifest.json')
        self.assertEqual(manifest['partition_groups']['calibration'], 2)
        audited, gate = self.run_stage('audit-dataset', '--dataset-dir', split)
        self.assertEqual(gate['status'], 'requires_review')
        self.assertEqual(gate['next_allowed_stage'], 'encoding-review')
        self.assertTrue(self.read_json(audited / 'dataset-audit.json')['ok'])
        self.assertEqual(self.read_rows(source), rows)

    def test_annotate_rejects_integer_for_boolean_and_boolean_for_score(self):
        for kind, value in (('noul', 0), ('score', False)):
            row = ir_record(kind, status='unlabeled')
            row['question'] = {'type': kind, 'instructions': 'Synthetic typed question'}
            if kind == 'score':
                row['question']['criteria'] = ['low', 'high']
            source = self.write_rows(f'{kind}.jsonl', [row])
            reviews = self.write_rows(f'{kind}-review.jsonl', [{'sample_id': row['sample_id'], 'label': {
                'status': 'verified', 'value': value, 'source': 'synthetic-review', 'evidence_refs': ['synthetic'],
            }}])
            _, gate = self.run_stage('annotate', '--samples', source, '--annotations', reviews, out_name=f'{kind}-invalid', code=1)
            self.assertEqual(gate['reason_codes'], ['invalid_input'])

    def test_partial_compile_is_nonfatal_but_requires_review(self):
        source = self.write_rows('mixed-labels.jsonl', [ir_record(1), ir_record(2, status='unlabeled')])
        out, gate = self.run_stage('compile', '--input', source)
        self.assertEqual(gate['status'], 'requires_review')
        self.assertEqual(gate['next_allowed_stage'], 'split')
        self.assertEqual(self.read_json(out / 'compile-report.json')['status'], 'partial')
        self.assertEqual(len(self.read_rows(out / 'compiled.jsonl')), 1)
        self.assertEqual(len(self.read_rows(out / 'quarantine.jsonl')), 1)

    def test_malformed_input_gets_blocked_status_without_overwriting_input(self):
        source = self.root / 'malformed.jsonl'
        source.write_text('{broken json}\n', encoding='utf-8')
        before = source.read_bytes()
        out, gate = self.run_stage('audit', source, code=1)
        self.assertIn('invalid_input', gate['reason_codes'])
        self.assertEqual(source.read_bytes(), before)
        diagnostic = self.read_json(out / 'error-report.json')
        self.assertEqual(diagnostic['error']['code'], 'invalid_input')
        self.assertIn(str(source), diagnostic['error']['message'])
        report = (out / 'report.md').read_text()
        self.assertIn('排查明细', report)
        self.assertIn(diagnostic['error']['message'], report)

    def test_missing_input_and_invalid_shape_have_human_and_machine_diagnostics(self):
        missing, gate = self.run_stage('audit', self.root / 'missing.jsonl', code=1, out_name='missing')
        self.assertEqual(gate['reason_codes'], ['io_error'])
        self.assertEqual(self.read_json(missing / 'error-report.json')['error']['type'], 'FileNotFoundError')
        invalid = self.write_rows('scalar.jsonl', [None])
        shaped, gate = self.run_stage('audit', invalid, code=1, out_name='bad-shape')
        self.assertEqual(gate['reason_codes'], ['invalid_input'])
        self.assertTrue(self.read_json(shaped / 'error-report.json')['error']['message'])

    def test_existing_output_is_not_overwritten_and_failure_json_is_explicit(self):
        source = self.write_rows('trace.jsonl', trace_rows(1))
        out = self.root / 'existing'
        out.mkdir()
        marker = out / 'keep.txt'
        marker.write_text('keep this existing result', encoding='utf-8')
        command = [sys.executable, str(CLI), 'audit', str(source), '--out', str(out)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn('当前不能继续', result.stdout)
        self.assertIn('output_not_empty', result.stdout)
        self.assertIn('未保存新的可读报告', result.stdout)
        self.assertEqual([path.name for path in out.iterdir()], ['keep.txt'])
        machine = subprocess.run(command + ['--json'], capture_output=True, text=True, timeout=15)
        payload = json.loads(machine.stdout)
        self.assertEqual(machine.returncode, 1)
        self.assertEqual(payload['error']['code'], 'output_not_empty')
        self.assertEqual(marker.read_text(), 'keep this existing result')

    def test_unwritable_destination_reports_io_failure_without_claiming_a_report(self):
        source = self.write_rows('trace.jsonl', trace_rows(1))
        parent = self.root / 'parent-is-a-file'
        parent.write_text('keep', encoding='utf-8')
        destination = parent / 'output'
        result = subprocess.run([sys.executable, str(CLI), 'audit', str(source), '--out', str(destination)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn('io_error', result.stdout)
        self.assertIn('未保存新的可读报告', result.stdout)
        self.assertIn('原始诊断', result.stdout)
        self.assertNotIn('Traceback', result.stdout + result.stderr)
        self.assertFalse(destination.exists())
        self.assertEqual(parent.read_text(), 'keep')

    def test_json_mode_preserves_data_and_existing_machine_reports(self):
        source = self.write_rows('reviewed.jsonl', [ir_record(1), ir_record(2, status='unlabeled')])
        human, human_gate = self.run_stage('compile', '--input', source, out_name='human-compile')
        human_stdout = self.last_result.stdout
        machine, machine_gate = self.run_stage('compile', '--input', source, '--json', out_name='machine-compile')
        payload = json.loads(self.last_result.stdout)
        self.assertEqual(payload['compiled'], 1)
        self.assertEqual(payload['quarantine'], 1)
        self.assertEqual(payload['report'], self.read_json(machine / 'compile-report.json'))
        self.assertEqual(human_gate, machine_gate)
        for name in ['compiled.jsonl', 'quarantine.jsonl', 'compile-report.json', 'stage-status.json', 'report.md']:
            self.assertEqual((human / name).read_bytes(), (machine / name).read_bytes(), name)
        self.assertIn('共检查 2 条样本，编译通过 1 条，隔离 1 条', human_stdout)
        self.assertIn('尚未检查编码长度，也未运行训练', human_stdout)
        self.assertNotIn('a' * 64, human_stdout)
        self.assertEqual(self.read_rows(human / 'compiled.jsonl')[0]['_meta']['label_status'], 'verified')
        self.assertEqual(self.read_rows(human / 'quarantine.jsonl')[0]['record']['label']['status'], 'unlabeled')

    def test_global_json_flag_and_failure_payload_are_parseable(self):
        invalid = self.root / 'invalid.jsonl'
        invalid.write_text('{bad}\n', encoding='utf-8')
        out = self.root / 'global-json'
        result = subprocess.run([sys.executable, str(CLI), '--json', 'audit', str(invalid), '--out', str(out)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload['reason_codes'], ['invalid_input'])
        self.assertEqual(payload, self.read_json(out / 'error-report.json'))
        self.assertTrue((out / 'report.md').is_file())

    def test_dataset_audit_rejects_cross_partition_overlap(self):
        source = self.write_rows('independent.jsonl', [ir_record(number) for number in range(4)])
        compiled, _ = self.run_stage('compile', '--input', source)
        split, _ = self.run_stage('split', '--input', compiled / 'compiled.jsonl')
        with (split / 'test.jsonl').open('a', encoding='utf-8') as handle:
            handle.write((split / 'train.jsonl').read_text(encoding='utf-8'))
        out, gate = self.run_stage('audit-dataset', '--dataset-dir', split, code=2)
        self.assertFalse(self.read_json(out / 'dataset-audit.json')['ok'])
        self.assertIn('cross_partition_overlap', gate['reason_codes'])

    def test_dataset_audit_rejects_an_empty_partition(self):
        source = self.write_rows('independent.jsonl', [ir_record(number) for number in range(4)])
        compiled, _ = self.run_stage('compile', '--input', source)
        split, _ = self.run_stage('split', '--input', compiled / 'compiled.jsonl')
        (split / 'test.jsonl').write_text('', encoding='utf-8')
        out, gate = self.run_stage('audit-dataset', '--dataset-dir', split, code=2)
        audit = self.read_json(out / 'dataset-audit.json')
        self.assertFalse(audit['ok'])
        self.assertEqual(audit['partition_counts']['test'], 0)
        self.assertEqual(audit['records'], 3)
        self.assertIn('empty_partition', gate['reason_codes'])
        self.assertIn('独立测试 0 条', self.last_result.stdout)

    def test_valid_flow_stops_before_encoding_or_training_claims(self):
        traces = [self.write_rows(f'trace-{number}.jsonl', trace_rows(number)) for number in range(4)]
        _, audit = self.run_stage('audit', *traces)
        self.assertEqual((audit['status'], audit['next_allowed_stage']), ('completed', 'discover'))
        _, discovery = self.run_stage('discover', *traces)
        self.assertEqual((discovery['status'], discovery['next_allowed_stage']),
                         ('requires_review', 'contract-review'))
        extracted, extraction = self.run_stage('extract', *traces)
        self.assertEqual((extraction['status'], extraction['next_allowed_stage']),
                         ('requires_review', 'annotate'))
        report = self.read_json(extracted / 'extraction-report.json')
        self.assertFalse(report['ready_for_training'])
        self.assertEqual(report['token_budget'], 'not_checked')
        samples = self.read_rows(extracted / 'samples.jsonl')
        self.assertEqual({row['label']['status'] for row in samples}, {'unlabeled'})
        annotations = self.write_rows('synthetic-reviewed-labels.jsonl', [
            {'sample_id': row['sample_id'], 'label': {
                'status': 'verified', 'value': 'respond', 'source': 'synthetic-test-policy',
                'evidence_refs': ['synthetic-test-rule/v1'],
            }} for row in samples
        ])
        annotated, annotation = self.run_stage('annotate', '--samples', extracted / 'samples.jsonl',
                                                '--annotations', annotations)
        self.assertEqual((annotation['status'], annotation['next_allowed_stage']),
                         ('requires_review', 'compile'))
        compiled, compilation = self.run_stage('compile', '--input', annotated / 'samples.labeled.jsonl')
        self.assertEqual(compilation['next_allowed_stage'], 'split')
        split, splitting = self.run_stage('split', '--input', compiled / 'compiled.jsonl')
        self.assertEqual(splitting['next_allowed_stage'], 'audit-dataset')
        self.assertEqual(self.read_json(split / 'split-manifest.json')['independent_groups'], 4)
        audited, dataset = self.run_stage('audit-dataset', '--dataset-dir', split)
        self.assertEqual((dataset['status'], dataset['next_allowed_stage']),
                         ('requires_review', 'encoding-review'))
        final = self.read_json(audited / 'dataset-audit.json')
        self.assertTrue(final['ok'])
        self.assertEqual(final['training_handoff']['token_budget'], 'not_checked')
        self.assertEqual(final['training_handoff']['runtime_equivalence'], 'not_evaluated')


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""仅从附件可见 DOM 提取离线复现 fixture；不执行 HTML 脚本、不访问网络。
用法：python extract-inspection-html-preview.py SOURCE_HTML OUTPUT_JSON
fixture 不代表原始结构化证据或真实 Run，不创建 run_id/report_id。
"""
import hashlib
import json
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
    def text(self):
        return ''.join(c.text() if isinstance(c, Node) else c for c in self.children)
    def find(self, predicate):
        return ([self] if predicate(self) else []) + [y for c in self.children if isinstance(c, Node) for y in c.find(predicate)]
    def has(self, cls):
        return cls in self.attrs.get('class', '').split()

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {'meta', 'input', 'link', 'br', 'hr', 'img'}:
            self.stack.append(node)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag == tag:
                self.stack = self.stack[:i]
                break
    def handle_data(self, text):
        self.stack[-1].children.append(text)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

def clean(value):
    return re.sub(r'\s+', ' ', value).strip()

def facts(node):
    result = {}
    for dl in node.find(lambda x: x.tag == 'dl' and x.has('facts')):
        keys = dl.find(lambda x: x.tag == 'dt')
        values = dl.find(lambda x: x.tag == 'dd')
        for key, value in zip(keys, values):
            k, v = clean(key.text()), clean(value.text())
            if k not in result:
                result[k] = v
            elif result[k] != v:
                result[k] = [result[k], v]
    return result

def table_rows(node):
    return [[clean(c.text()) for c in row.children if isinstance(c, Node) and c.tag == 'td']
            for row in node.find(lambda x: x.tag == 'tr')
            if any(isinstance(c, Node) and c.tag == 'td' for c in row.children)]

def main():
    source, output = map(Path, sys.argv[1:3])
    raw = source.read_bytes()
    parser = Parser()
    parser.feed(raw.decode('utf-8'))
    doc = parser.root
    index = json.loads(doc.find(lambda n: n.attrs.get('id') == 'device-index')[0].text())
    index_by_id = {r['id']: r for r in index}
    cards = doc.find(lambda n: n.has('device-card'))
    result = {
        'kind': 'deep',
        'scope': {'count': len(cards), 'assetIds': [c.attrs['data-device'] for c in cards],
                  'requested': {'source_kind': 'attachment_visible_content_offline_reproduction',
                                'source_label': '附件可见内容离线复现',
                                'source_filename': source.name,
                                'source_sha256': hashlib.sha256(raw).hexdigest(),
                                'source_data_date': '2026-11-04',
                                'not_original_structured_evidence': True}},
        'checks': {kind: {'kind': kind, 'items': []} for kind in ['status', 'baseline', 'vulnerabilities', 'reachability']},
        'coverageNotes': ['附件未提供原始结构化结果、原报告／运行标识，无法核对真实执行来源。',
                          '附件仅保留102个连接结论；119次路径尝试明细及原始路径／策略证据未取得。',
                          '规则服务、协议、端口及检测／读取时间未提供；软件版本、业务影响与修复复核结果仍待补证。'],
    }
    severity = Counter()
    cves = set()
    device_records = {}
    for card in cards:
        aid = card.attrs['data-device']
        idx = index_by_id[aid]
        name_node = card.find(lambda n: n.has('device-name'))[0]
        name = clean(name_node.find(lambda n: n.tag == 'strong')[0].text())
        address_node = next(c for c in name_node.children if isinstance(c, Node) and c.tag == 'span')
        address = clean(''.join(c for c in address_node.children if isinstance(c, str)))
        if '源值' in address:
            match = re.search(r'源值[：:]?\s*([^；;）)]+)', address)
            address = match.group(1).strip() if match else address
        if aid == '3617505':
            assert 'any' in name_node.text()
            address = 'any'  # 原文明确的占位地址，不推测新地址。
        base = {'assetId': aid, 'hostname': name, 'ip': address}
        status_nodes = card.find(lambda n: n.tag == 'section' and n.has('issue') and '设备离线' in ''.join(c.text() for c in n.children if isinstance(c, Node) and c.tag == 'h4'))
        if not status_nodes:
            status_nodes = card.find(lambda n: n.has('completed-check') and any(x.tag == 'summary' and '已记录在线' in x.text() for x in n.children if isinstance(x, Node)))
        assert len(status_nodes) == 1, (aid, '状态节点不唯一')
        sf = facts(status_nodes[0])
        online = sf['SOC在线标记']
        assert (online == 'offline') == idx['offline']
        result['checks']['status']['items'].append({**base, 'status': 'abnormal' if online == 'offline' else 'normal', 'online': online,
            'message': 'SOC离线标记，原因与业务影响待核实' if online == 'offline' else 'SOC已记录在线',
            'facts': {'online': online, 'visibleEvidence': sf}})
        baseline = card.find(lambda n: (n.tag == 'section' and n.has('issue') and any(x.tag == 'h4' and '基线待补查' in x.text() for x in n.children if isinstance(x, Node))) or
            (n.has('completed-check') and any(x.tag == 'summary' and '基线原报告判通过' in x.text() for x in n.children if isinstance(x, Node))))
        assert len(baseline) == 1, (aid, '基线节点不唯一')
        bn = baseline[0]
        reason = idx['reason']
        bs = 'normal' if reason == 'RESULT_AVAILABLE' else 'unknown'
        result['checks']['baseline']['items'].append({**base, 'status': bs, 'reasonCode': reason,
            'message': {'NO_TEMPLATE': '未分配适用基线模板', 'NO_DATA': '缺少基线采集数据', 'RESULT_AVAILABLE': '原基线报告判通过，非重新核验'}[reason],
            'facts': {'visibleEvidence': facts(bn), 'visibleCheckItems': table_rows(bn)}})
        rows = card.find(lambda n: 'data-vulnerability-record' in n.attrs)
        if rows:
            records = []
            for row in rows:
                cells = [c for c in row.children if isinstance(c, Node) and c.tag == 'td']
                assert len(cells) == 4
                cve = clean(cells[0].find(lambda n: n.tag == 'strong')[0].text())
                level = clean(cells[1].find(lambda n: n.has('badge'))[0].text())
                vf = facts(row)
                advice = row.find(lambda n: n.has('source-advice'))[0].text().strip()
                record = {'cveId': cve, 'severity': level, 'score': clean(cells[2].text()),
                          'lastSeenAt': clean(cells[3].text()), 'recommendation': advice,
                          'source': vf.get('检测来源'), 'observedAt': vf.get('原观测时间'),
                          'evidence': {'id': vf.get('证据编号'), 'observedAt': vf.get('原观测时间'), 'lastSeenAt': vf.get('原最近发现时间')}}
                records.append(record)
                severity[level] += 1
                cves.add(cve)
            device_records[aid] = len(records)
            vulnerability_section = card.find(lambda n: n.tag == 'section' and n.has('issue') and bool(n.find(lambda x: x.has('vuln-records'))))[0]
            section_evidence = next((n for n in vulnerability_section.children if isinstance(n, Node) and n.has('evidence')), None)
            result['checks']['vulnerabilities']['items'].append({**base, 'status': 'abnormal', 'coverage': 'existing_records_only',
                'message': '历史漏洞记录，当前适用性待复核；未执行新扫描', 'records': records,
                'facts': {'visibleEvidence': facts(section_evidence) if section_evidence else {}}})
    rule_cards = doc.find(lambda n: n.has('rule-card'))
    connections = 0
    ip_ids = {}
    for item in result['checks']['status']['items']:
        ip_ids.setdefault(item['ip'], []).append(item['assetId'])
    for card in rule_cards:
        rid = card.attrs['id'].removeprefix('rule-')
        title = clean(next(c for c in card.children if isinstance(c, Node) and c.tag == 'summary').find(lambda n: n.tag == 'strong')[0].text())
        rname = title.split('·', 1)[-1].strip()
        summary = clean(next(c for c in card.children if isinstance(c, Node) and c.tag == 'summary').text())
        status = 'abnormal' if '发现异常' in summary else 'unknown' if '待补查' in summary else 'normal'
        paragraphs = [clean(n.text()) for n in card.find(lambda n: n.tag == 'p')]
        rows = table_rows(card)
        base = {'ruleId': rid, 'ruleName': rname, 'facts': {'visibleRuleSummary': summary, 'visibleRuleNotes': paragraphs}}
        if '禁止' in rname or '不得' in rname:
            base['ruleType'] = 'FORBIDDEN'
        elif '允许' in rname:
            base['ruleType'] = 'REQUIRED'
        for pair, conclusion, message in rows:
            src, dst = [v.strip() for v in pair.split('→', 1)]
            item = {**base, 'srcIp': src, 'dstIp': dst, 'status': {'正常': 'normal', '异常': 'abnormal', '未完成': 'unknown'}[conclusion],
                    'message': message, 'recordType': 'visible_connection'}
            for field, ip in [('srcAssetId', src), ('dstAssetId', dst)]:
                if len(ip_ids.get(ip, [])) == 1:
                    item[field] = ip_ids[ip][0]
            result['checks']['reachability']['items'].append(item)
            connections += 1
        if not rows or status == 'unknown' and all(conclusion == '正常' for _, conclusion, _ in rows):
            result['checks']['reachability']['items'].append({**base, 'status': status, 'message': '；'.join(paragraphs),
                'recordType': 'visible_rule_summary', 'reasonCode': 'RULE_INCOMPLETE' if status == 'unknown' else ''})
    counts = {'devices': len(cards), 'vulnerabilityRecords': sum(device_records.values()), 'distinctCves': len(cves),
              'rules': len(rule_cards), 'connectionConclusions': connections,
              'offlineDevices': sum(r['offline'] for r in index), 'abnormalDevices': sum(r['abnormal'] for r in index),
              'vulnerabilityDevices': len(device_records), 'baselineReasons': dict(Counter(r['reason'] for r in index)),
              'severity': dict(severity), 'vulnerabilitiesByAssetId': device_records}
    assert counts['devices'] == 91 and len(set(result['scope']['assetIds'])) == 91
    assert counts['vulnerabilityRecords'] == 740 and counts['distinctCves'] == 342
    assert counts['rules'] == 6 and connections == 102
    assert counts['offlineDevices'] == 25 and counts['abnormalDevices'] == 28
    result['fixtureProvenance'] = {'label': '附件可见内容离线复现', 'notOriginalStructuredEvidence': True,
        'sourceSha256': hashlib.sha256(raw).hexdigest(), 'sourceBytes': len(raw), 'extractedCounts': counts,
        'limitations': result['coverageNotes']}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(counts, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()

"""五源富化前，使用事件直接证据进行只读名单快速分类。"""
from __future__ import annotations

import ipaddress
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from fusion_contract import CallOutcome
from fusion_pipeline import normalize_alert

SUCCESS = {CallOutcome.SUCCESS_WITH_DATA, CallOutcome.SUCCESS_EMPTY}


def normalize_ioc(kind: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError('empty IOC')
    value = value.strip()
    if kind == 'IP':
        return str(ipaddress.ip_address(value))
    if kind == 'DOMAIN':
        value = value.rstrip('.').encode('idna').decode('ascii').lower()
        if len(value) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in value.split('.')):
            raise ValueError('invalid domain')
        return value
    if kind == 'URL':
        parts = urlsplit(value)
        if parts.scheme.lower() not in {'http', 'https'} or not parts.hostname or parts.username or parts.password:
            raise ValueError('invalid URL')
        try:
            host = str(ipaddress.ip_address(parts.hostname))
            if ':' in host:
                host = '[' + host + ']'
        except ValueError:
            host = normalize_ioc('DOMAIN', parts.hostname)
        port = parts.port
        authority = host + (f':{port}' if port is not None else '')
        return urlunsplit((parts.scheme.lower(), authority, parts.path, parts.query, parts.fragment))
    if kind == 'HASH':
        if not re.fullmatch(r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|[a-fA-F0-9]{128})', value):
            raise ValueError('invalid hash')
        return value.lower()
    if kind in {'ASSET_ID', 'USERNAME'}:
        return value
    raise ValueError('unsupported IOC type')


def _object(value, default):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return default
    return value if isinstance(value, type(default)) else default


def extract_indicators(incident, alerts, *, errors=None):
    """只读取有类型的直接字段，不从规则名称或自由文本推断 IOC。"""
    output, seen = [], set()
    errors = errors if errors is not None else []

    def add(kind, value, ref, role=None, rule_id=None):
        if value is None or value == "":
            return
        try:
            normalized = normalize_ioc(kind, str(value))
        except ValueError:
            errors.append(ref)
            return
        row = dict(kind=kind, value=normalized, evidence_ref=ref, role=role, rule_id=rule_id)
        key = (kind, normalized, ref, role, str(rule_id))
        if key not in seen:
            seen.add(key)
            output.append(row)

    fields = {'sourceIp': ('IP', 'SRC_IP'), 'source_ip': ('IP', 'SRC_IP'),
              'attackerIp': ('IP', 'SRC_IP'), 'targetIp': ('IP', 'DEST_IP'),
              'destination_ip': ('IP', 'DEST_IP'), 'destinationIp': ('IP', 'DEST_IP'),
              'affectedAssetId': ('ASSET_ID', 'ASSET_ID'), 'affected_asset_id': ('ASSET_ID', 'ASSET_ID'),
              'domain': ('DOMAIN', None), 'url': ('URL', None),
              'file_hash': ('HASH', None), 'sha256': ('HASH', None), 'md5': ('HASH', None)}
    aliases = {'IP_ADDRESS': 'IP', 'IP': 'IP', 'DOMAIN': 'DOMAIN', 'DOMAIN_NAME': 'DOMAIN',
               'URL': 'URL', 'HASH': 'HASH', 'FILE_HASH': 'HASH', 'ASSET': 'ASSET_ID', 'USER': 'USERNAME'}
    for index, record in enumerate([incident, *alerts]):
        ref = 'incident' if index == 0 else f'alerts[{index-1}]({record.get("alert_id", record.get("id", ""))})'
        rule_id = record.get('rule_id', record.get('ruleId')) if index else None
        for field, (kind, role) in fields.items():
            add(kind, record.get(field), f'{ref}.{field}', role, rule_id)
        entities = _object(record.get('entitiesJson', record.get('entities_json', record.get('entities', []))), [])
        observables = _object(record.get('observables', []), [])
        ocsf = _object(record.get('ocsf', {}), {})
        observables = observables + _object(ocsf.get('observables', []), [])
        for item in entities + observables:
            if not isinstance(item, dict):
                continue
            kind = aliases.get(str(item.get('type', item.get('entityType', item.get('iocType', '')))).upper())
            # 对齐仓库 OCSF 1.8 observable.json：2=IP、6=URL、8=Hash；3 是 MAC。
            kind = kind or {2: 'IP', 6: 'URL', 8: 'HASH'}.get(item.get('type_id'))
            field = str(item.get('field', item.get('name', '')))
            kind = kind or ({'ip': 'IP', 'domain': 'DOMAIN', 'url': 'URL', 'url_string': 'URL',
                             'md5': 'HASH', 'sha1': 'HASH', 'sha256': 'HASH', 'sha512': 'HASH'}.get(field.split('.')[-1]))
            if kind:
                add(kind, item.get('value', item.get('iocValue', item.get('ip', item.get('assetId')))), ref, None, rule_id)
        if index:
            normalized = normalize_alert(record)
            for name, kind, role in [('source_ip', 'IP', 'SRC_IP'), ('destination_ip', 'IP', 'DEST_IP'),
                                     ('affected_asset_id', 'ASSET_ID', 'ASSET_ID')]:
                add(kind, normalized.get(name), ref, role, normalized.get('rule_id'))
            asset = normalized.get('asset') or {}
            add('IP', asset.get('ip'), f'{ref}.ocsf.device.ip', None, rule_id)
            user = normalized.get('user') or {}
            add('USERNAME', user.get('name'), ref, 'USERNAME', rule_id)
            raw = _object(_object(record.get('triggering_event'), {}).get('raw'), {})
            embedded = _object(ocsf.get('raw_data'), {})
            for payload in [raw, embedded]:
                data = _object(payload.get('data'), {})
                win = _object(data.get('win', payload.get('win')), {})
                event_data = _object(win.get('eventdata'), {})
                # Sysmon hashes 是明确的 algorithm=digest 字段。
                hashes = event_data.get('hashes')
                if isinstance(hashes, str):
                    for pair in hashes.split(','):
                        algorithm, separator, digest = pair.partition('=')
                        if separator and algorithm.strip().upper() in {'MD5', 'SHA1', 'SHA256', 'SHA512'}:
                            add('HASH', digest.strip(), ref, None, rule_id)
        nodes = [(ocsf, f'{ref}.ocsf')]
        for n, evidence in enumerate(_object(ocsf.get('evidences', []), [])):
            if isinstance(evidence, dict):
                nodes.append((evidence, f'{ref}.ocsf.evidences[{n}]'))
        for node, path in nodes:
            for endpoint, role in [('src_endpoint', 'SRC_IP'), ('dst_endpoint', 'DEST_IP')]:
                obj = node.get(endpoint, {})
                if isinstance(obj, dict):
                    add('IP', obj.get('ip'), f'{path}.{endpoint}.ip', role, rule_id)
                    add('DOMAIN', obj.get('domain'), f'{path}.{endpoint}.domain', None, rule_id)
            def walk_typed(obj, current):
                if not isinstance(obj, dict):
                    return
                for key, value in obj.items():
                    child = f'{current}.{key}'
                    if key in {'hashes', 'hash'}:
                        for n, hash_row in enumerate(value if isinstance(value, list) else [value]):
                            add('HASH', hash_row.get('value') if isinstance(hash_row, dict) else hash_row, f'{child}[{n}]', None, rule_id)
                    elif key == 'url':
                        add('URL', value.get('url_string') if isinstance(value, dict) else value, child, None, rule_id)
                    elif key == 'domain':
                        add('DOMAIN', value, child, None, rule_id)
                    elif key in {'file', 'process', 'actor', 'http_request', 'dns', 'query'}:
                        walk_typed(value, child)
            walk_typed(node, path)
    return output


def _active(entry, expiry_field, now, list_timezone):
    if entry.get('enabled') not in (True, 1):
        if entry.get('enabled') in (False, 0):
            return False
        raise ValueError('missing or invalid enabled flag')
    expiry = entry.get(expiry_field)
    if expiry:
        end = datetime.fromisoformat(str(expiry).replace('Z', '+00:00'))
        if end.tzinfo is None:
            if not list_timezone:
                raise ValueError('naive expiry requires configured list timezone')
            end = end.replace(tzinfo=ZoneInfo(list_timezone))
        if end <= now:
            return False
    return True


def classify(incident, alerts, whitelist, intel, *, complete, queried_at, now=None, list_timezone=None, audit=None):
    """返回最小结果；返回 None 时沿用完整五源流程。"""
    if audit is None:
        audit = {}
    if not complete:
        audit["reason"] = "incomplete_queries_or_alerts"
        return None
    now = now or datetime.now(timezone.utc)
    errors = []
    indicators = extract_indicators(incident, alerts, errors=errors)
    if errors:
        audit.update(reason="invalid_direct_indicator", invalid_evidence_refs=errors)
        return None
    matches = []
    try:
        for source, rows in [('alert_whitelist', whitelist), ('intel', intel)]:
            for entry in rows:
                if not isinstance(entry, dict):
                    raise ValueError('invalid list entry')
                if not _active(entry, 'expiresAt' if source == 'alert_whitelist' else 'validUntil', now, list_timezone):
                    continue
                actual_source = source
                if source == 'intel':
                    disposition = entry.get('disposition')
                    if disposition == 'INDICATOR':
                        continue
                    actual_source = {'WHITELIST': 'intel_whitelist', 'BLACKLIST': 'intel_blacklist'}.get(disposition)
                    if not actual_source:
                        raise ValueError('unknown disposition')
                entry_id = entry.get('whitelistId') or entry.get('id')
                if entry_id is None:
                    raise ValueError('missing entry ID')
                kind = entry.get('type') if source == 'alert_whitelist' else entry.get('iocType')
                value = entry.get('value') if source == 'alert_whitelist' else entry.get('iocValue')
                scope = entry.get('scopeRuleIds') or []
                if not isinstance(scope, list):
                    raise ValueError('invalid rule scope')
                if kind == 'IP_CIDR':
                    target = ipaddress.ip_network(value, strict=False)
                else:
                    target = normalize_ioc('IP' if kind in {'SRC_IP', 'DEST_IP'} else kind, value)
                grouped = {}
                for indicator in indicators:
                    if scope and str(indicator['rule_id']) not in {str(v) for v in scope}:
                        continue
                    if source == 'alert_whitelist' and kind in {'SRC_IP', 'DEST_IP', 'IP_CIDR'}:
                        if indicator['role'] != ('SRC_IP' if kind == 'IP_CIDR' else kind):
                            continue
                    expected = 'IP' if kind in {'SRC_IP', 'DEST_IP', 'IP_CIDR'} else kind
                    if indicator['kind'] != expected:
                        continue
                    hit = ipaddress.ip_address(indicator['value']) in target if kind == 'IP_CIDR' else indicator['value'] == target
                    if hit:
                        grouped.setdefault(indicator['value'], []).append(indicator['evidence_ref'])
                for entity_value, refs in grouped.items():
                    matches.append(dict(source=actual_source, entry_id=str(entry_id), entity_value=entity_value,
                                        evidence_refs=sorted(set(refs)), list_version=None, queried_at=queried_at))
    except (ValueError, TypeError, KeyError):
        audit["reason"] = "invalid_list_entry_or_unconfigured_expiry_timezone"
        audit["matches"] = matches
        return None
    sides = {m['source'] == 'intel_blacklist' for m in matches}
    audit["matches"] = matches
    audit["reason"] = "conflicting_matches" if len(sides) == 2 else "one_sided_match" if sides else "no_match"
    if len(sides) != 1:
        return None
    return {'verdict': '真实告警' if True in sides else '误报', 'matches': matches}


def collect_lists(runner, *, page_size=200, max_pages=100):
    """并发读取两侧名单；分页未完整读取时禁止提前分类。"""
    queried_at = datetime.now(timezone.utc).isoformat()

    def fetch_white():
        result = runner.call(resource='ai_soc_detect', tool='ai_soc_detect__list_detect_whitelist',
                             purpose='快速分类读取告警白名单', arguments={}, argument_sources={}, domain='fast_classification')
        if result.outcome not in SUCCESS or not isinstance(result.data, list):
            raise ValueError('alert whitelist query incomplete')
        return result.data

    def fetch_intel():
        rows, ids, expected = [], set(), None
        for page in range(1, max_pages + 1):
            result = runner.call(resource='ai_soc_correlate', tool='ai_soc_correlate__get_correlate_threat_intel',
                                 purpose='快速分类完整读取情报名单', arguments={'pageNum': page, 'pageSize': page_size},
                                 argument_sources={'pageNum': 'pagination', 'pageSize': 'bounded list query'}, domain='fast_classification')
            data = result.data
            if result.outcome not in SUCCESS or not isinstance(data, dict) or not isinstance(data.get('rows'), list):
                raise ValueError('threat intel query incomplete')
            total = data.get('total')
            if not isinstance(total, int) or isinstance(total, bool) or total < 0 or (expected is not None and total != expected):
                raise ValueError('invalid or changing pagination total')
            expected = total
            for row in data['rows']:
                if not isinstance(row, dict) or row.get('id') is None or str(row['id']) in ids:
                    raise ValueError('missing or repeated pagination ID')
                ids.add(str(row['id']))
                rows.append(row)
            if len(rows) == total:
                return rows
            if len(rows) > total or not data['rows']:
                raise ValueError('inconsistent pagination')
        raise ValueError('threat intel page limit reached')

    values, errors = {}, []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {name: pool.submit(fn) for name, fn in [('whitelist', fetch_white), ('intel', fetch_intel)]}
        for name, future in futures.items():
            try:
                values[name] = future.result()
            except Exception as exc:
                # 异常文本可能携带凭据或远端响应，仅记录类型。
                errors.append({'source': name, 'error_type': type(exc).__name__})
    return values.get('whitelist', []), values.get('intel', []), {'complete': not errors, 'errors': errors, 'queried_at': queried_at}

"""Deterministic projection into entity-local and relationship evidence.

The functions in this module only reshape sourced facts.  They do not classify
behaviour as malicious, choose a verdict, or infer whether an action succeeded.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any, Iterable, Mapping

from fusion_pipeline import parse_datetime_utc


MAX_TEXT_CHARS = 1024


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _nonempty(value: Any) -> bool:
    return value not in (None, "", [], {})


def _text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip() or None


def _bounded(value: Any) -> str | None:
    text = _text(value)
    if text is None or len(text) <= MAX_TEXT_CHARS:
        return text
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    marker = f" ...[TRUNCATED sha256={digest} chars={len(text)}]... "
    return text[: MAX_TEXT_CHARS - len(marker) - 128] + marker + text[-128:]


def _sparse(value: Any) -> Any:
    if isinstance(value, Mapping):
        compact = {str(key): _sparse(item) for key, item in value.items()}
        return {key: item for key, item in compact.items() if _nonempty(item)}
    if isinstance(value, list):
        compact = [_sparse(item) for item in value]
        return [item for item in compact if _nonempty(item)]
    return value


def _first(*values: Any) -> Any:
    for value in values:
        if _nonempty(value):
            return value
    return None


def _stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _sorted_unique(values: Iterable[Any]) -> list[str]:
    return sorted({str(value) for value in values if value not in (None, "")})


def build_judgement_target(
    incident: Mapping[str, Any], reasoning_rule: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Freeze the declared incident claim without interpreting evidence."""

    claim_type = _first(
        incident.get("incidentType"),
        incident.get("incident_type"),
        incident.get("title"),
        incident.get("name"),
    )
    if not claim_type:
        raise ValueError("incident has no declared threat type")
    rule = _mapping(reasoning_rule)
    rule_id = _first(
        rule.get("ruleId"),
        rule.get("rule_id"),
        incident.get("reasoningRuleId"),
        incident.get("reasoning_rule_id"),
        incident.get("ruleId"),
    )
    anchor_rule = _sparse(
        {
            "id": str(rule_id) if rule_id is not None else None,
            "name": rule.get("name"),
            "description": rule.get("description"),
        }
    )
    result: dict[str, Any] = {
        "claim_family": "incident_declared_threat",
        "claim_type": str(claim_type),
        "target_source": (
            "incident.incidentType"
            if incident.get("incidentType") not in (None, "")
            else "incident.metadata"
        ),
    }
    if anchor_rule:
        result["anchor_rule"] = anchor_rule
    return result


def build_anchor_search_targets(
    entities: Iterable[Mapping[str, Any]],
) -> list[dict[str, str]]:
    """Return primary and time-bound alias lookups for every explicit anchor."""

    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for entity in entities:
        if entity.get("role") != "anchor":
            continue
        entity_ref = _text(entity.get("entity_ref"))
        kind = _text(entity.get("entity_type"))
        if not entity_ref or not kind:
            continue
        candidates: list[tuple[str, str]] = []
        if kind == "asset" and _text(entity.get("asset_id")):
            candidates.append(
                ("ocsf.device.asset.uid.keyword", str(entity["asset_id"]))
            )
            for alias in _list(entity.get("aliases")):
                current = _mapping(alias)
                alias_type = _text(current.get("type"))
                alias_value = _text(current.get("value"))
                if alias_type == "ip" and alias_value:
                    candidates.append(("ocsf.device.ip.keyword", alias_value))
                elif alias_type == "hostname" and alias_value:
                    candidates.append(("ocsf.device.hostname.keyword", alias_value))
        elif kind == "ip" and _text(entity.get("value")):
            candidates.append(("ocsf.device.ip.keyword", str(entity["value"])))
        elif kind == "hostname" and _text(entity.get("value")):
            candidates.append(("ocsf.device.hostname.keyword", str(entity["value"])))
        elif kind == "user" and _text(entity.get("value")):
            candidates.append(("ocsf.actor.user.name.keyword", str(entity["value"])))
        for field, value in candidates:
            if (field, value) in seen:
                continue
            seen.add((field, value))
            result.append({"entity_ref": entity_ref, "field": field, "value": value})
    return result


def select_endpoint_pairs(
    records: Iterable[Mapping[str, Any]],
    *,
    anchor_refs: set[str],
    max_pairs: int,
) -> list[dict[str, Any]]:
    """Select distinct observed endpoint pairs connected to an anchor."""

    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for record in records:
        source_ip = _text(record.get("source_ip"))
        destination_ip = _text(record.get("destination_ip"))
        refs = {
            str(value)
            for value in _list(record.get("entity_refs"))
            if value not in (None, "")
        }
        for field in ("source_entity_ref", "destination_entity_ref", "entity_ref"):
            if record.get(field):
                refs.add(str(record[field]))
        if not source_ip or not destination_ip or not refs.intersection(anchor_refs):
            continue
        key = (source_ip, destination_ip)
        group = groups.setdefault(
            key,
            {
                "source_ip": source_ip,
                "destination_ip": destination_ip,
                "destination_ports": set(),
                "protocols": set(),
                "entity_refs": set(),
                "observation_count": 0,
                "event_rows": [],
            },
        )
        if record.get("destination_port") not in (None, ""):
            group["destination_ports"].add(record["destination_port"])
        if protocol := _text(record.get("protocol")):
            group["protocols"].add(protocol)
        group["entity_refs"].update(refs)
        group["observation_count"] += 1
        if record.get("event_time") not in (None, ""):
            group["event_rows"].append({"event_time": record["event_time"]})
    ranked = sorted(
        groups.values(),
        key=lambda row: (
            -len(set(row["entity_refs"]) & anchor_refs),
            -int(row["observation_count"]),
            str(row["source_ip"]),
            str(row["destination_ip"]),
        ),
    )[: max(0, max_pairs)]
    return [
        {
            **{
                key: value
                for key, value in row.items()
                if key
                not in {
                    "destination_ports",
                    "protocols",
                    "entity_refs",
                    "event_rows",
                }
            },
            "destination_ports": sorted(row["destination_ports"], key=str),
            "protocols": sorted(row["protocols"], key=str),
            "entity_refs": sorted(row["entity_refs"]),
            "time_range": _time_bounds(row["event_rows"]),
        }
        for row in ranked
    ]


def _time_bounds(rows: Iterable[Mapping[str, Any]]) -> list[str]:
    values = sorted(
        parsed
        for parsed in (parse_datetime_utc(row.get("event_time")) for row in rows)
        if parsed is not None
    )
    if not values:
        return []
    return [
        values[0].isoformat().replace("+00:00", "Z"),
        values[-1].isoformat().replace("+00:00", "Z"),
    ]


def _provenance(row: Mapping[str, Any]) -> dict[str, Any]:
    return _sparse(
        {
            "sources": _sorted_unique([row.get("source")]),
            "alert_ids": _sorted_unique(_list(row.get("alert_ids"))),
            "rule_ids": _sorted_unique(_list(row.get("rule_ids"))),
            "sample_record_ids": _sorted_unique([row.get("record_key")])[:3],
        }
    )


def _aggregate(rows: Iterable[dict[str, Any]], signature_fields: tuple[str, ...]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        signature = {field: row.get(field) for field in signature_fields}
        key = _stable(signature)
        current = groups.get(key)
        if current is None:
            current = dict(row)
            current["count"] = 1
            current["first_seen"] = row.get("event_time")
            current["last_seen"] = row.get("event_time")
            current.pop("event_time", None)
            groups[key] = current
            continue
        current["count"] += 1
        times = [value for value in (current.get("first_seen"), row.get("event_time")) if value]
        if times:
            current["first_seen"] = min(times)
        times = [value for value in (current.get("last_seen"), row.get("event_time")) if value]
        if times:
            current["last_seen"] = max(times)
        for name in ("sources", "alert_ids", "rule_ids", "sample_record_ids", "process_uids"):
            current[name] = _sorted_unique([*_list(current.get(name)), *_list(row.get(name))])
            if name == "sample_record_ids":
                current[name] = current[name][:3]
            if name == "process_uids":
                current[name] = current[name][:3]
    for current in groups.values():
        alert_ids = _sorted_unique(_list(current.get("alert_ids")))
        rule_ids = _sorted_unique(_list(current.get("rule_ids")))
        current["alert_id_count"] = len(alert_ids)
        current["rule_id_count"] = len(rule_ids)
        current["alert_ids"] = alert_ids[:3]
        current["rule_ids"] = rule_ids[:5]
        current["sources"] = _sorted_unique(_list(current.get("sources")))[:3]
    return sorted(
        (_sparse(row) for row in groups.values()),
        key=lambda row: (str(row.get("first_seen") or ""), _stable(row)),
    )


def _compact_process_activity(row: Mapping[str, Any]) -> dict[str, Any]:
    parent = _mapping(row.get("parent"))
    return _sparse(
        {
            "image": row.get("image"),
            "cmdline": row.get("cmdline"),
            "user": row.get("user"),
            "parent": {
                "image": parent.get("image"),
                "cmdline": parent.get("cmdline"),
                "process_uid": parent.get("process_uid"),
                "pid": parent.get("pid"),
            },
            "process_uids": row.get("process_uids"),
            "pid": row.get("pid"),
            "native_result": row.get("native_result"),
            "action": row.get("action"),
            "count": row.get("count"),
            "first_seen": row.get("first_seen"),
            "last_seen": row.get("last_seen"),
            "sources": row.get("sources"),
            "alert_ids": row.get("alert_ids"),
            "rule_ids": row.get("rule_ids"),
            "sample_record_ids": row.get("sample_record_ids"),
            "alert_id_count": row.get("alert_id_count"),
            "rule_id_count": row.get("rule_id_count"),
        }
    )


def _project_entity_records(records: list[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    process_rows: list[dict[str, Any]] = []
    file_rows: list[dict[str, Any]] = []
    network_rows: list[dict[str, Any]] = []
    auth_rows: list[dict[str, Any]] = []
    other_rows: list[dict[str, Any]] = []
    for record in records:
        provenance = _provenance(record)
        process = _mapping(record.get("process"))
        parent = _mapping(process.get("parent"))
        has_process = any(
            _nonempty(process.get(field))
            for field in ("uid", "pid", "name", "path", "cmdline")
        )
        if has_process:
            process_rows.append(
                _sparse(
                    {
                        "image": _first(process.get("path"), process.get("name")),
                        "cmdline": _bounded(process.get("cmdline")),
                        "user": _mapping(record.get("user")).get("name"),
                        "parent": {
                            "image": _first(parent.get("path"), parent.get("name")),
                            "cmdline": _bounded(parent.get("cmdline")),
                            "process_uid": parent.get("uid"),
                            "pid": parent.get("pid"),
                        },
                        "process_uids": _sorted_unique([process.get("uid")]),
                        "pid": process.get("pid"),
                        "native_result": record.get("native_result"),
                        "action": (
                            record.get("alert_type")
                            if record.get("record_origin") == "anchor_event_search"
                            else record.get("event_type")
                        ),
                        "event_time": record.get("event_time"),
                        **provenance,
                    }
                )
            )
        for operation in _list(record.get("file_operations")):
            current = _mapping(operation)
            if not current:
                continue
            file_rows.append(
                _sparse(
                    {
                        "path": _bounded(current.get("path")),
                        "operation": current.get("operation"),
                        "hashes": _sorted_unique(_list(current.get("hashes"))),
                        "process_uid": process.get("uid"),
                        "process_image": _first(process.get("path"), process.get("name")),
                        "event_time": record.get("event_time"),
                        **provenance,
                    }
                )
            )
        has_network = any(
            _nonempty(record.get(field))
            for field in ("source_ip", "destination_ip", "source_port", "destination_port")
        )
        if has_network:
            network_rows.append(
                _sparse(
                    {
                        "source_ip": record.get("source_ip"),
                        "source_port": record.get("source_port"),
                        "destination_ip": record.get("destination_ip"),
                        "destination_port": record.get("destination_port"),
                        "protocol": record.get("protocol"),
                        "network_session_id": record.get("network_session_id"),
                        "disposition": record.get("disposition"),
                        "process_uid": process.get("uid"),
                        "process_image": _first(process.get("path"), process.get("name")),
                        "event_time": record.get("event_time"),
                        **provenance,
                    }
                )
            )
        has_auth = bool(record.get("authentication_session_id") or record.get("native_result"))
        if has_auth:
            auth_rows.append(
                _sparse(
                    {
                        "user": _mapping(record.get("user")).get("name"),
                        "session_id": record.get("authentication_session_id"),
                        "result": record.get("native_result"),
                        "source_ip": record.get("source_ip"),
                        "destination_ip": record.get("destination_ip"),
                        "event_type": record.get("alert_type") or record.get("event_type"),
                        "event_time": record.get("event_time"),
                        **provenance,
                    }
                )
            )
        if not (has_process or _list(record.get("file_operations")) or has_network or has_auth):
            other_rows.append(
                _sparse(
                    {
                        "event_type": record.get("alert_type") or record.get("event_type"),
                        "request_path": _bounded(record.get("request_path")),
                        "disposition": record.get("disposition"),
                        "event_time": record.get("event_time"),
                        **provenance,
                    }
                )
            )
    return {
        "process_activities": [
            _compact_process_activity(row)
            for row in _aggregate(
                process_rows,
                ("image", "cmdline", "user", "parent", "native_result", "action"),
            )
        ],
        "file_operations": _aggregate(
            file_rows, ("path", "operation", "hashes", "process_image")
        ),
        "network_details": _aggregate(
            network_rows,
            (
                "source_ip",
                "source_port",
                "destination_ip",
                "destination_port",
                "protocol",
                "network_session_id",
                "disposition",
                "process_image",
            ),
        ),
        "authentication_activities": _aggregate(
            auth_rows,
            ("user", "session_id", "result", "source_ip", "destination_ip", "event_type"),
        ),
        "other_activities": _aggregate(
            other_rows, ("event_type", "request_path", "disposition")
        ),
    }


def project_edr_domain(
    entities: Iterable[Mapping[str, Any]], records: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    by_entity: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        if record.get("entity_ref"):
            by_entity[str(record["entity_ref"])].append(record)
    result: list[dict[str, Any]] = []
    for entity in entities:
        entity_ref = str(entity.get("entity_ref"))
        rows = by_entity.get(entity_ref, [])
        segments: list[dict[str, Any]] = []
        if rows:
            segment = {
                "segment_id": f"{entity_ref}-SEG-001",
                "scope": "anchor_entity" if entity.get("role") == "anchor" else "related_entity",
                "time_range": _time_bounds(rows),
                **_project_entity_records(rows),
            }
            segments.append(segment)
        result.append(
            _sparse(
                {
                    "entity_ref": entity_ref,
                    "asset_id": entity.get("asset_id"),
                    "activity_segments": segments,
                }
            )
        )
        result[-1].setdefault("activity_segments", [])
    return {"entities": result}


def _topology_neighbors(topology: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    value = _first(topology.get("neighbors"), topology.get("relatedAssets"), [])
    return [row for row in _list(value) if isinstance(row, Mapping)]


def _endpoint_entity_index(
    entities: Iterable[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in entities:
        entity_ref = _text(entity.get("entity_ref"))
        if not entity_ref:
            continue
        hostname = None
        ips: set[str] = set()
        if entity.get("entity_type") == "ip" and (value := _text(entity.get("value"))):
            ips.add(value)
        for alias in _list(entity.get("aliases")):
            current = _mapping(alias)
            if current.get("type") == "ip" and (value := _text(current.get("value"))):
                ips.add(value)
            elif current.get("type") == "hostname" and not hostname:
                hostname = _text(current.get("value"))
        descriptor = _sparse(
            {
                "ref": entity_ref,
                "asset_id": entity.get("asset_id"),
                "host": hostname,
                "role": entity.get("role"),
                "entity_type": entity.get("entity_type"),
            }
        )
        for ip in ips:
            candidates[ip].append(descriptor)
    result: dict[str, dict[str, Any]] = {}
    for ip, rows in candidates.items():
        result[ip] = sorted(
            rows,
            key=lambda row: (
                row.get("role") != "anchor",
                row.get("entity_type") != "asset",
                str(row.get("ref") or ""),
            ),
        )[0]
    return result


def _path_hints(
    endpoint_pairs: Iterable[Mapping[str, Any]],
    entities: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    endpoint_index = _endpoint_entity_index(entities)
    result: list[dict[str, Any]] = []
    for pair in endpoint_pairs:
        source_ip = _text(pair.get("source_ip"))
        destination_ip = _text(pair.get("destination_ip"))
        if not source_ip or not destination_ip:
            continue
        source = endpoint_index.get(source_ip, {})
        destination = endpoint_index.get(destination_ip, {})
        result.append(
            _sparse(
                {
                    "src_ref": source.get("ref"),
                    "src_asset_id": source.get("asset_id"),
                    "src_host": source.get("host"),
                    "src_ip": source_ip,
                    "dst_ref": destination.get("ref"),
                    "dst_asset_id": destination.get("asset_id"),
                    "dst_host": destination.get("host"),
                    "dst_ip": destination_ip,
                    "protocols": pair.get("protocols"),
                    "dst_ports": pair.get("destination_ports"),
                    "count": pair.get("observation_count"),
                    "time_range": pair.get("time_range"),
                    "basis": "event",
                }
            )
        )
    return result[:100]


def _ids_probe_alerts(records: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for record in records:
        if record.get("record_origin") != "contributing_alert":
            continue
        signature = {
            "source": record.get("source"),
            "event_type": record.get("alert_type") or record.get("event_type"),
            "source_ip": record.get("source_ip"),
            "destination_ip": record.get("destination_ip"),
            "destination_port": record.get("destination_port"),
            "disposition": record.get("disposition"),
        }
        key = _stable(signature)
        current = groups.setdefault(
            key,
            {
                **_sparse(signature),
                "count": 0,
                "first_seen": record.get("event_time"),
                "last_seen": record.get("event_time"),
                "alert_ids": [],
                "rule_ids": [],
                "entity_refs": [],
            },
        )
        current["count"] += 1
        current["first_seen"] = min(
            [value for value in (current.get("first_seen"), record.get("event_time")) if value],
            default=None,
        )
        current["last_seen"] = max(
            [value for value in (current.get("last_seen"), record.get("event_time")) if value],
            default=None,
        )
        current["alert_ids"] = _sorted_unique(
            [*current["alert_ids"], *_list(record.get("alert_ids"))]
        )
        current["rule_ids"] = _sorted_unique(
            [*current["rule_ids"], *_list(record.get("rule_ids"))]
        )
        current["entity_refs"] = _sorted_unique(
            [*current["entity_refs"], *_list(record.get("entity_refs"))]
        )
    for current in groups.values():
        alert_ids = _sorted_unique(_list(current.get("alert_ids")))
        rule_ids = _sorted_unique(_list(current.get("rule_ids")))
        current["alert_id_count"] = len(alert_ids)
        current["rule_id_count"] = len(rule_ids)
        current["alert_ids"] = alert_ids[:3]
        current["rule_ids"] = rule_ids[:5]
    return sorted(
        (_sparse(row) for row in groups.values()),
        key=lambda row: (str(row.get("first_seen") or ""), _stable(row)),
    )[:100]


def project_graph_domain(
    *,
    entities: Iterable[Mapping[str, Any]],
    records: Iterable[Mapping[str, Any]],
    endpoint_pairs: Iterable[Mapping[str, Any]],
    topology_by_entity: Mapping[str, Mapping[str, Any]],
    account_rows: Iterable[Mapping[str, Any]],
    login_sequences: Iterable[Mapping[str, Any]],
    firewall_sessions: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    entity_rows = [dict(row) for row in entities]
    record_rows = [dict(row) for row in records]
    related_hosts: list[dict[str, Any]] = []
    endpoint_pair_rows = [dict(row) for row in endpoint_pairs]
    topology_summary: list[dict[str, Any]] = []
    for entity_ref in sorted(topology_by_entity):
        topology = _mapping(topology_by_entity[entity_ref])
        neighbors = _topology_neighbors(topology)
        for neighbor in neighbors[:100]:
            related_hosts.append(
                _sparse(
                    {
                        "entity_ref": entity_ref,
                        "asset_id": _first(neighbor.get("assetId"), neighbor.get("asset_id")),
                        "hostname": neighbor.get("hostname"),
                        "ip": neighbor.get("ip"),
                        "direction": neighbor.get("direction"),
                    }
                )
            )
        blast = _mapping(topology.get("blastRadius"))
        topology_summary.append(
            _sparse(
                {
                    "entity_ref": entity_ref,
                    "asset_in_graph": topology.get("assetInGraph"),
                    "neighbor_count": _first(topology.get("neighborCount"), len(neighbors)),
                    "neighbors_truncated": topology.get("neighborsTruncated"),
                    "graph_stale": topology.get("graphStale"),
                    "reachable_asset_count": blast.get("reachableAssetCount"),
                    "reachable_truncated": blast.get("reachableTruncated"),
                }
            )
        )

    related_users: list[dict[str, Any]] = []
    for wrapper in account_rows:
        entity_ref = wrapper.get("entity_ref")
        for account in _list(wrapper.get("accounts")):
            if not isinstance(account, Mapping):
                continue
            related_users.append(
                _sparse(
                    {
                        "entity_ref": entity_ref,
                        "name": _first(
                            account.get("name"),
                            account.get("account"),
                            account.get("username"),
                        ),
                        "privilege": account.get("privilege"),
                        "role": account.get("role"),
                    }
                )
            )

    related_hosts = list(
        {
            _stable(row): row
            for row in related_hosts
            if row
        }.values()
    )
    related_users = list(
        {
            _stable(row): row
            for row in related_users
            if row
        }.values()
    )

    return {
        "related_hosts": related_hosts,
        "related_users": related_users[:100],
        "connection_history": [],
        "firewall_sessions": [dict(row) for row in firewall_sessions],
        "ids_probe_alerts": _ids_probe_alerts(record_rows),
        "trust_info": None,
        "path_hints": _path_hints(endpoint_pair_rows, entity_rows),
        "asset_group": [
            _sparse(
                {
                    "entity_ref": entity.get("entity_ref"),
                    "asset_id": entity.get("asset_id"),
                    "business_systems": _mapping(
                        topology_by_entity.get(str(entity.get("entity_ref")), {})
                    ).get("sameBizAssets"),
                }
            )
            for entity in entity_rows
            if entity.get("entity_type") == "asset"
        ],
        "cross_device_corroboration": [],
        "topology_summary": topology_summary,
        "login_sequence": [dict(row) for row in login_sequences],
    }


def project_asset_domain(
    entities: Iterable[Mapping[str, Any]],
    asset_context_by_entity: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    result: list[dict[str, Any]] = []
    for entity in entities:
        entity_ref = str(entity.get("entity_ref"))
        if entity.get("entity_type") != "asset":
            continue
        wrapper = _mapping(asset_context_by_entity.get(entity_ref))
        detail = _mapping(wrapper.get("detail"))
        importance = _mapping(wrapper.get("importance"))
        bindings = [row for row in _list(wrapper.get("bindings")) if isinstance(row, Mapping)]
        tags = []
        raw_tags = detail.get("tagsJson")
        if isinstance(raw_tags, str):
            try:
                raw_tags = json.loads(raw_tags)
            except json.JSONDecodeError:
                raw_tags = [raw_tags]
        tags.extend(_list(raw_tags))
        if detail.get("assetType"):
            tags.append(detail["assetType"])
        tags.extend(
            f"collector:{row['deviceType']}"
            for row in bindings
            if row.get("deviceType")
        )
        criticality = importance.get("importance")
        if criticality in (None, "", "unknown"):
            criticality = None
        result.append(
            _sparse(
                {
                    "entity_ref": entity_ref,
                    "asset_id": entity.get("asset_id"),
                    "hostname": _first(detail.get("hostname"), detail.get("hostName")),
                    "ip": _first(detail.get("ip"), detail.get("ipAddress")),
                    "asset_criticality": criticality,
                    "asset_owner": _first(detail.get("opsOwnerName"), detail.get("ownerName")),
                    "business_system": wrapper.get("business_system"),
                    "exposure": _first(detail.get("exposure"), detail.get("internetExposed")),
                    "tags": _sorted_unique(tags),
                    "maintenance_window": detail.get("maintenanceWindow"),
                    "collectors": bindings,
                }
            )
        )
    return {"entities": result}


def project_threat_intel_domain(
    indicators: Iterable[Mapping[str, Any]],
    intelligence_by_value: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    result: list[dict[str, Any]] = []
    for indicator in indicators:
        value = _text(indicator.get("value"))
        if not value:
            continue
        intelligence = _mapping(intelligence_by_value.get(value))
        matches = _list(intelligence.get("matches"))
        queried = intelligence.get("queried") is True
        row: dict[str, Any] = {
            "indicator_type": indicator.get("indicator_type"),
            "value": value,
            "entity_refs": _sorted_unique(_list(indicator.get("entity_refs"))),
            "intel_hit": bool(matches) if queried else None,
        }
        if matches:
            row["matches"] = matches
        result.append(_sparse(row))
    return {"indicators": result}


def _login_text(value: Any) -> str | None:
    """登录聚合保留原始空白，避免改变已有分组键。"""
    return str(value) if _nonempty(value) else None


def compact_login_sequences(
    account_sequences: Iterable[Mapping[str, Any]],
    *,
    max_rows: int = 100,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Aggregate login observations by account and endpoint relation.

    The graph MCP may return hundreds of timestamp-only repetitions for the
    same account and host pair.  Keeping every repetition adds no relation
    information, so the fusion layer retains the relation, its time boundary,
    and its count.  No login success or attack meaning is inferred here.
    """

    groups: dict[tuple[Any, ...], dict[str, Any]] = {}
    input_count = 0
    for wrapper in account_sequences:
        fallback_account = _login_text(wrapper.get("account"))
        sequence = wrapper.get("sequence")
        if isinstance(sequence, Mapping):
            rows = sequence.get("items") or sequence.get("records") or []
        else:
            rows = sequence or []
        if not isinstance(rows, list):
            continue
        for source in rows:
            if not isinstance(source, Mapping):
                continue
            input_count += 1
            account = _login_text(source.get("account")) or fallback_account
            source_ip = _login_text(source.get("srcIp") or source.get("source_ip"))
            destination_ip = _login_text(source.get("dstIp") or source.get("destination_ip"))
            destination_host = _login_text(
                source.get("dstHost") or source.get("destination_host")
            )
            destination_port = source.get("dstPort")
            if destination_port is None:
                destination_port = source.get("destination_port")
            timestamp = source.get("tsEpochMs")
            if timestamp is None:
                timestamp = source.get("timestamp_epoch_ms")
            signature = (
                account,
                source_ip,
                destination_ip,
                destination_host,
                destination_port,
            )
            current = groups.get(signature)
            if current is None:
                groups[signature] = {
                    "account": account,
                    "source_ip": source_ip,
                    "destination_ip": destination_ip,
                    "destination_host": destination_host,
                    "destination_port": destination_port,
                    "first_seen_epoch_ms": timestamp,
                    "last_seen_epoch_ms": timestamp,
                    "occurrence_count": 1,
                }
                continue
            current["occurrence_count"] += 1
            if timestamp is not None:
                if (
                    current["first_seen_epoch_ms"] is None
                    or timestamp < current["first_seen_epoch_ms"]
                ):
                    current["first_seen_epoch_ms"] = timestamp
                if (
                    current["last_seen_epoch_ms"] is None
                    or timestamp > current["last_seen_epoch_ms"]
                ):
                    current["last_seen_epoch_ms"] = timestamp

    values = sorted(
        groups.values(),
        key=lambda row: (
            row.get("first_seen_epoch_ms") is None,
            row.get("first_seen_epoch_ms") or 0,
            str(row),
        ),
    )
    selected = values[:max_rows]
    return selected, {
        "input_count": input_count,
        "unique_count": len(values),
        "output_count": len(selected),
        "truncated": len(values) > len(selected),
        "retention_policy": "earliest_distinct_account_endpoint_relations",
    }

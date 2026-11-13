#!/usr/bin/env python3
"""Generate the multi-anchor five-source evidence package.

Only read-only data returned by the configured SOC MCP gateway is treated as
fact.  The program freezes the incident-declared claim, resolves every explicit
incident entity, performs deterministic deduplication and bounded relationship
expansion, and writes model-facing evidence plus separate audit artefacts.  It
does not call an LLM. Complete, one-sided list matches produce a fast verdict.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable, Mapping

from domain_projection import compact_login_sequences
from domain_projection import (
    build_anchor_search_targets,
    build_judgement_target,
    project_asset_domain,
    project_edr_domain,
    project_graph_domain,
    project_threat_intel_domain,
    select_endpoint_pairs,
)
from fast_classification import classify, collect_lists
from fusion_contract import CallOutcome, make_ledger_entry
from fusion_contract import validate_five_source_output, validate_model_input
from fusion_pipeline import extract_alert_ids, normalize_alert, normalize_event_hit, parse_datetime_utc
from incident_scope import (
    aggregate_repeated_behaviors,
    attach_entity_refs,
    build_forward_slices,
    build_process_neighborhood,
    canonicalize_entities,
    deduplicate_records,
    derive_effective_time_range,
    expand_related_entities,
    extract_incident_entities,
    select_records,
)
from mcp_gateway import McpCallResult, McpGateway
from model_input_compaction import compact_five_source_output


DOMAIN_WEIGHTS = {
    "graph": 0.25,
    "edr_detail": 0.30,
    "asset": 0.15,
    "threat_intel": 0.15,
    "history": 0.15,
}


def _select(source: Mapping[str, Any], keys: Iterable[str]) -> dict[str, Any]:
    return {key: source.get(key) for key in keys if key in source}


def _nonempty(value: Any) -> bool:
    return value not in (None, "", [], {})


def _intel_positive(value: Any) -> bool:
    """Interpret only an explicit positive lookup result as an intelligence hit."""
    if value is True:
        return True
    if isinstance(value, Mapping):
        for key in ("hit", "matched", "exists", "found"):
            if value.get(key) is True:
                return True
    return False


def _flow_rows(data: Any) -> list[Mapping[str, Any]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, Mapping)]
    if isinstance(data, Mapping):
        for key in ("items", "flows", "records"):
            if isinstance(data.get(key), list):
                return [row for row in data[key] if isinstance(row, Mapping)]
    return []


def _flow_overlaps(row: Mapping[str, Any], start: datetime, end: datetime) -> bool:
    """Return whether a flow aggregate overlaps the frozen evidence window."""

    first = _epoch_iso(row.get("firstSeenEpoch")) or row.get("firstSeen")
    last = _epoch_iso(row.get("lastSeenEpoch")) or row.get("lastSeen")
    if not first and not last:
        return True
    first_time = parse_datetime_utc(first or last)
    last_time = parse_datetime_utc(last or first)
    if first_time is None or last_time is None:
        return False
    return last_time >= start and first_time <= end


def _epoch_iso(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
    return _iso(datetime.fromtimestamp(seconds, tz=timezone.utc))


def _compact_firewall_session(
    row: Mapping[str, Any],
    *,
    query_source_ip: str,
    query_destination_ip: str,
) -> dict[str, Any]:
    """Project one host-pair aggregate without losing its query endpoints."""

    passed = int(row.get("passCount") or row.get("pass_count") or 0)
    blocked = int(row.get("blockCount") or row.get("block_count") or 0)
    action = row.get("action") or row.get("decision")
    if not action:
        action = "mixed" if passed and blocked else "pass" if passed else "block" if blocked else None
    result = {
        "source_ip": row.get("srcIp") or row.get("src_ip") or query_source_ip,
        "destination_ip": (
            row.get("dstIp") or row.get("dst_ip") or query_destination_ip
        ),
        "pass_count": passed,
        "block_count": blocked,
    }
    optional = {
        "source_port": row.get("srcPort") or row.get("src_port"),
        "destination_port": row.get("dstPort") or row.get("dst_port"),
        "protocol": row.get("protocol"),
        "action": action,
        "rule_id": (
            row.get("ruleId")
            or row.get("rule_id")
            or row.get("policyId")
            or row.get("policy_id")
        ),
        "first_seen": _epoch_iso(row.get("firstSeenEpoch")) or row.get("firstSeen"),
        "last_seen": _epoch_iso(row.get("lastSeenEpoch")) or row.get("lastSeen"),
    }
    result.update({key: value for key, value in optional.items() if _nonempty(value)})
    return result


def _extract_event_hits(data: Any) -> list[Mapping[str, Any]]:
    if not isinstance(data, Mapping):
        return []
    hits = data.get("hits")
    if isinstance(hits, Mapping):
        hits = hits.get("hits")
    return [row for row in _list(hits) if isinstance(row, Mapping)]


def _compact_topology(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, Mapping):
        return None
    neighbors = []
    for row in _list(data.get("neighbors"))[:100]:
        if isinstance(row, Mapping):
            neighbors.append(
                _select(
                    row,
                    (
                        "assetId",
                        "hostname",
                        "ip",
                        "direction",
                        "edgeType",
                        "hitCount",
                        "lastSeen",
                    ),
                )
            )
    return {
        "assetInGraph": data.get("assetInGraph"),
        "neighbors": neighbors,
        "neighborCount": data.get("neighborCount"),
        "neighborsTruncated": data.get("neighborsTruncated"),
        "blastRadius": data.get("blastRadius"),
        "computedAt": data.get("computedAt"),
        "graphStale": data.get("graphStale"),
        "assetGroup": data.get("assetGroup"),
    }


class AuditRunner:
    def __init__(self, gateway: McpGateway) -> None:
        self.gateway = gateway
        self.ledger: list[dict[str, Any]] = []
        self.domain_calls: dict[str, list[McpCallResult]] = defaultdict(list)
        self._counter = 0
        self._lock = threading.Lock()

    def _next_call_id(self, prefix: str = "C") -> str:
        with self._lock:
            self._counter += 1
            return f"{prefix}{self._counter:06d}"

    def call(
        self,
        *,
        resource: str,
        tool: str,
        purpose: str,
        arguments: Mapping[str, Any],
        argument_sources: Mapping[str, str],
        domain: str,
        call_id: str | None = None,
    ) -> McpCallResult:
        current_id = call_id or self._next_call_id()
        result = self.gateway.invoke(
            call_id=current_id,
            resource=resource,
            tool_name=tool,
            arguments=arguments,
        )
        row = make_ledger_entry(
            call_id=current_id,
            resource=resource,
            exact_tool_name=tool,
            purpose=purpose,
            key_arguments=arguments,
            argument_sources=argument_sources,
            outcome=result.outcome,
            result_count=result.result_count,
            latency_ms=result.latency_ms,
            output_domain=domain,
            raw_response_file=result.raw_response_file,
        )
        with self._lock:
            self.ledger.append(row)
            self.domain_calls[domain].append(result)
        return result

    def fetch_alerts(self, alert_ids: list[str], workers: int) -> list[McpCallResult]:
        results: list[McpCallResult | None] = [None] * len(alert_ids)

        def fetch(index: int, alert_id: str) -> tuple[int, McpCallResult]:
            result = self.call(
                resource="ai_soc_detect",
                tool="ai_soc_detect__get_detect_alert_by_alert_id",
                purpose="回查事件关联告警及其原始记录",
                arguments={"alertId": alert_id},
                argument_sources={"alertId": "incident.contributingAlertsJson"},
                domain="edr_detail",
                call_id=f"A{index + 1:06d}",
            )
            return index, result

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(fetch, index, alert_id) for index, alert_id in enumerate(alert_ids)]
            completed = 0
            for future in as_completed(futures):
                index, result = future.result()
                results[index] = result
                completed += 1
                if completed % 250 == 0 or completed == len(alert_ids):
                    print(f"resolved alerts: {completed}/{len(alert_ids)}", flush=True)
        return [result for result in results if result is not None]


def fetch_bounded_event_hits(
    runner: AuditRunner,
    search: Mapping[str, Any],
) -> tuple[list[Mapping[str, Any]], dict[str, Any]]:
    """Fetch one boundary sample without treating a truncated envelope as empty.

    Pages are requested within the search's fixed evidence budget.  If the MCP
    transport truncates a response, the same offset is retried with a smaller
    page.  The preview text is audit-only and is never parsed into evidence.
    """

    budget = int(search["budget"])
    base_arguments = _mapping(search.get("arguments"))
    base_body = dict(_mapping(base_arguments.get("body")))
    page_size = max(1, min(int(base_body.get("size") or 1), budget))
    offset = 0
    matched_total: int | None = None
    hits: list[Mapping[str, Any]] = []
    page_count = 0
    truncated_attempts = 0
    terminal_status = CallOutcome.NOT_QUERIED.value

    while len(hits) < budget:
        remaining = budget - len(hits)
        if matched_total is not None:
            remaining = min(remaining, max(matched_total - offset, 0))
        if remaining <= 0:
            terminal_status = (
                CallOutcome.SUCCESS_WITH_DATA.value
                if hits
                else CallOutcome.SUCCESS_EMPTY.value
            )
            break

        request_size = min(page_size, remaining)
        body = dict(base_body)
        body["size"] = request_size
        body["from"] = offset
        result = runner.call(
            resource="ai_soc_event",
            tool=str(search["tool"]),
            purpose=f"读取受影响资产端点行为（{search['name']}/{search['order']}）",
            arguments={"body": body},
            argument_sources=_mapping(search.get("argument_sources")),
            domain="edr_detail",
        )

        if result.outcome == CallOutcome.TRUNCATED:
            truncated_attempts += 1
            if request_size == 1:
                terminal_status = "partial_truncated" if hits else "truncated_unavailable"
                break
            page_size = max(1, request_size // 2)
            continue
        if result.outcome == CallOutcome.FAILED:
            terminal_status = "partial_failed" if hits else CallOutcome.FAILED.value
            break
        if result.outcome == CallOutcome.SUCCESS_EMPTY:
            terminal_status = (
                CallOutcome.SUCCESS_WITH_DATA.value
                if hits
                else CallOutcome.SUCCESS_EMPTY.value
            )
            break

        page_hits = _extract_event_hits(result.data)
        if isinstance(result.data, Mapping):
            total = result.data.get("total")
            if isinstance(total, int):
                matched_total = total
            elif isinstance(total, str) and total.isdigit():
                matched_total = int(total)
        page_count += 1
        if not page_hits:
            terminal_status = (
                CallOutcome.SUCCESS_WITH_DATA.value
                if hits
                else CallOutcome.SUCCESS_EMPTY.value
            )
            break

        hits.extend(page_hits[:remaining])
        offset += len(page_hits)
        terminal_status = CallOutcome.SUCCESS_WITH_DATA.value
        if len(page_hits) < request_size:
            break

    returned_hits: int | None = len(hits)
    if terminal_status in {"truncated_unavailable", CallOutcome.FAILED.value} and not hits:
        returned_hits = None
    summary = {
        "anchor": search["name"],
        "order": search["order"],
        "status": terminal_status,
        "matched_total": matched_total,
        "returned_hits": returned_hits,
        "page_count": page_count,
        "truncated_attempts": truncated_attempts,
        "budget": budget,
    }
    return hits, summary


def prepare_five_source_artifacts(
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Freeze a full audit package and derive a compact model projection."""

    audit_output = copy.deepcopy(dict(payload))
    validate_five_source_output(audit_output)
    model_output = compact_five_source_output(audit_output)
    validate_model_input(model_output)
    return audit_output, model_output


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip() or None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )


def _rows(value: Any) -> list[Mapping[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, Mapping)]
    if isinstance(value, Mapping):
        for key in ("items", "records", "rows", "data"):
            if isinstance(value.get(key), list):
                return [row for row in value[key] if isinstance(row, Mapping)]
    return []


def _successful(result: McpCallResult | None) -> bool:
    return bool(
        result
        and result.outcome
        in (CallOutcome.SUCCESS_WITH_DATA, CallOutcome.SUCCESS_EMPTY)
    )


def _tri_state(result: McpCallResult | None) -> Any:
    if result is None or result.outcome in (CallOutcome.FAILED, CallOutcome.TRUNCATED):
        return None
    if result.outcome == CallOutcome.SUCCESS_EMPTY:
        return []
    return result.data


def _ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return max(0.0, min(1.0, numerator / denominator))


def _round_half_up(value: float, places: int) -> float:
    quantum = Decimal("1").scaleb(-places)
    return float(Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP))


def build_slice_searches(
    *,
    slice_start: str,
    slice_end: str,
    targets: Iterable[Mapping[str, Any]],
    per_target_budget: int,
) -> list[dict[str, Any]]:
    """Build one forward search for every anchor before moving to the next slice."""

    if per_target_budget < 1:
        raise ValueError("per_target_budget must be positive")
    searches: list[dict[str, Any]] = []
    for target in targets:
        entity_ref = str(target["entity_ref"])
        field = str(target["field"])
        value = str(target["value"])
        searches.append(
            {
                "name": entity_ref,
                "entity_ref": entity_ref,
                "field": field,
                "value": value,
                "order": "asc",
                "budget": per_target_budget,
                "tool": "ai_soc_event__search_event",
                "arguments": {
                    "body": {
                        "timeRange": {"from": slice_start, "to": slice_end},
                        "timeField": "ocsf.metadata.original_time",
                        "filters": [{"field": field, "op": "eq", "value": value}],
                        "size": min(10, per_target_budget),
                        "sort": [
                            {
                                "field": "ocsf.metadata.original_time",
                                "order": "asc",
                            }
                        ],
                    }
                },
                "argument_sources": {
                    "body.timeRange": "event_snapshot.time_range forward slice",
                    f"body.filters.{field}": f"event_snapshot.entities.{entity_ref}",
                    "body.size": "fixed per-anchor slice budget",
                    "body.from": "adaptive pagination offset",
                    "body.sort": "fixed forward business-time order",
                },
            }
        )
    return searches


def build_intel_indicators(
    entities: Iterable[Mapping[str, Any]],
    records: Iterable[Mapping[str, Any]],
    *,
    max_indicators: int,
) -> list[dict[str, Any]]:
    """Select IP indicators from the entity index and retained related records."""

    groups: dict[str, set[str]] = defaultdict(set)
    for entity in entities:
        entity_ref = _text(entity.get("entity_ref"))
        if entity.get("entity_type") == "ip" and _text(entity.get("value")):
            groups[str(entity["value"])].add(entity_ref or "")
        for alias in _list(entity.get("aliases")):
            current = _mapping(alias)
            if current.get("type") == "ip" and _text(current.get("value")):
                groups[str(current["value"])].add(entity_ref or "")
    for record in records:
        refs = {
            str(value)
            for value in _list(record.get("entity_refs"))
            if value not in (None, "")
        }
        if not refs:
            continue
        for field in ("source_ip", "destination_ip"):
            if value := _text(record.get(field)):
                groups[value].update(refs)
    return [
        {
            "indicator_type": "ip",
            "value": value,
            "entity_refs": sorted(ref for ref in groups[value] if ref),
        }
        for value in sorted(groups)[: max(0, max_indicators)]
    ]


def calculate_completeness(
    *,
    resolved_alerts: int,
    referenced_alerts: int,
    anchor_query_successes: int,
    anchor_query_attempts: int,
    asset_query_successes: int,
    asset_query_attempts: int,
    graph_query_successes: int,
    graph_query_attempts: int,
    intel_query_successes: int,
    intel_query_attempts: int,
) -> tuple[float, dict[str, Any]]:
    """Calculate collection completeness; this is not threat probability."""

    alert_resolution = _ratio(resolved_alerts, referenced_alerts)
    anchor_query = _ratio(anchor_query_successes, anchor_query_attempts)
    edr_score = (alert_resolution + anchor_query) / 2
    graph_score = _ratio(graph_query_successes, graph_query_attempts)
    asset_score = _ratio(asset_query_successes, asset_query_attempts)
    intel_score = _ratio(intel_query_successes, intel_query_attempts)
    domain_scores = {
        "graph": {"score": round(graph_score, 4), "query_success": round(graph_score, 4)},
        "edr_detail": {
            "score": round(edr_score, 4),
            "alert_resolution": round(alert_resolution, 4),
            "anchor_query_success": round(anchor_query, 4),
        },
        "asset": {"score": round(asset_score, 4), "query_success": round(asset_score, 4)},
        "threat_intel": {"score": round(intel_score, 4), "query_success": round(intel_score, 4)},
        "history": {"score": 0.0, "reason": "agent verdict history MCP unavailable"},
    }
    score = sum(
        float(domain_scores[name]["score"]) * weight
        for name, weight in DOMAIN_WEIGHTS.items()
    )
    return _round_half_up(score, 2), {
        "definition": "technical_collection_completeness_not_threat_probability",
        "domain_weights": DOMAIN_WEIGHTS,
        "domain_scores": domain_scores,
        "counts": {
            "resolved_alerts": resolved_alerts,
            "referenced_alerts": referenced_alerts,
            "anchor_query_successes": anchor_query_successes,
            "anchor_query_attempts": anchor_query_attempts,
            "asset_query_successes": asset_query_successes,
            "asset_query_attempts": asset_query_attempts,
            "graph_query_successes": graph_query_successes,
            "graph_query_attempts": graph_query_attempts,
            "intel_query_successes": intel_query_successes,
            "intel_query_attempts": intel_query_attempts,
        },
        "score_unrounded": score,
    }


def _asset_ids(candidates: Iterable[Mapping[str, Any]]) -> list[str]:
    return sorted(
        {
            str(row["value"])
            for row in candidates
            if row.get("entity_type") == "asset" and row.get("value") not in (None, "")
        },
        key=lambda value: (not value.isdigit(), value),
    )


def _call_asset_context(
    runner: AuditRunner, asset_id: str
) -> dict[str, McpCallResult]:
    numeric_id = int(asset_id)
    sources = {"assetId": "event_snapshot.entities explicit incident asset"}
    return {
        "detail": runner.call(
            resource="ai_soc_master",
            tool="ai_soc_master__get_soc_asset_by_asset_id",
            purpose="读取锚点资产基本信息",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="asset",
        ),
        "importance": runner.call(
            resource="ai_soc_master",
            tool="ai_soc_master__get_soc_asset_importance",
            purpose="读取锚点资产重要性",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="asset",
        ),
        "business_system": runner.call(
            resource="ai_soc_master",
            tool="ai_soc_master__get_soc_asset_biz_systems",
            purpose="读取锚点资产所属业务系统",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="asset",
        ),
        "bindings": runner.call(
            resource="ai_soc_ingest",
            tool="ai_soc_ingest__get_ingest_devices_by_asset_by_asset_id",
            purpose="读取锚点资产采集绑定",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="asset",
        ),
        "topology": runner.call(
            resource="ai_soc_graph",
            tool="ai_soc_graph__get_graph_enrich_topology_by_asset_id",
            purpose="读取锚点资产一跳拓扑",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="graph",
        ),
        "accounts": runner.call(
            resource="ai_soc_graph",
            tool="ai_soc_graph__get_graph_identity_asset_accounts",
            purpose="读取锚点资产关联账户",
            arguments={"assetId": numeric_id},
            argument_sources=sources,
            domain="graph",
        ),
    }


def _account_name(row: Mapping[str, Any]) -> str | None:
    return _text(row.get("account") or row.get("username") or row.get("name"))


def _compact_logins_by_entity(
    wrappers: Iterable[Mapping[str, Any]], *, max_rows: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    result: list[dict[str, Any]] = []
    audits: list[dict[str, Any]] = []
    for wrapper in wrappers:
        rows, audit = compact_login_sequences([wrapper], max_rows=max_rows)
        for row in rows:
            result.append({"entity_ref": wrapper.get("entity_ref"), **row})
        audits.append({"entity_ref": wrapper.get("entity_ref"), "account": wrapper.get("account"), **audit})
    result.sort(
        key=lambda row: (
            str(row.get("first_seen_epoch_ms") or ""),
            str(row.get("entity_ref") or ""),
            str(row.get("account") or ""),
        )
    )
    return result[:max_rows], {"queries": audits, "retained_rows": min(len(result), max_rows)}


def _process_seed_keys(
    records: Iterable[Mapping[str, Any]], anchor_refs: set[str]
) -> set[str]:
    result: set[str] = set()
    for row in records:
        if row.get("record_origin") != "contributing_alert":
            continue
        if not set(_list(row.get("entity_refs"))).intersection(anchor_refs):
            continue
        process = _mapping(row.get("process"))
        if not any(process.get(field) not in (None, "") for field in ("uid", "pid", "name", "path", "cmdline")):
            continue
        if row.get("record_key"):
            result.add(str(row["record_key"]))
    return result


def _rule_id(incident: Mapping[str, Any]) -> int | None:
    value = incident.get("correlationRuleId") or incident.get("reasoningRuleId") or incident.get("ruleId")
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _group_ledger(ledger: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in ledger:
        key = (str(row["tool"]), str(row["purpose"]), str(row["output_domain"]))
        current = groups.setdefault(
            key,
            {
                "tool": row["tool"],
                "purpose": row["purpose"],
                "domain": row["output_domain"],
                "calls": 0,
                "success": 0,
                "truncated": 0,
                "failed": 0,
            },
        )
        current["calls"] += 1
        current["success"] += int(str(row["status"]).startswith("success_"))
        current["truncated"] += int(row["status"] == "truncated")
        current["failed"] += int(row["status"] == "failed")
    return sorted(groups.values(), key=lambda row: (row["domain"], row["tool"], row["purpose"]))


def run(args: argparse.Namespace, *, gateway: McpGateway | None = None) -> Path:
    started = time.monotonic()
    output_dir = Path(args.output_dir).resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(f"refusing to overwrite non-empty output directory: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    if gateway is None:
        gateway = McpGateway(
            bridge_url=args.bridge_url,
            bridge_key=args.bridge_key,
            raw_directory=output_dir / "raw",
            timeout=args.timeout,
        )
    runner = AuditRunner(gateway)

    incident_result = runner.call(
        resource="ai_soc_correlate",
        tool="ai_soc_correlate__get_correlate_incident_by_incident_id",
        purpose="读取安全事件声明、实体和关联告警引用",
        arguments={"incidentId": args.incident_id},
        argument_sources={"incidentId": "CLI"},
        domain="graph",
    )
    incident = _mapping(incident_result.data)
    if incident_result.outcome != CallOutcome.SUCCESS_WITH_DATA or not incident:
        raise RuntimeError("incident cannot be loaded from MCP")

    alert_ids = extract_alert_ids(incident)
    if not alert_ids:
        raise RuntimeError("incident contains no contributing alert references")
    alert_results = runner.fetch_alerts(alert_ids, args.workers)
    normalized_alerts: list[dict[str, Any]] = []
    for result in alert_results:
        if result.outcome != CallOutcome.SUCCESS_WITH_DATA or not isinstance(result.data, Mapping):
            continue
        row = normalize_alert(result.data)
        row["record_origin"] = "contributing_alert"
        normalized_alerts.append(row)
    whitelist, intel_list, fast_audit = collect_lists(runner)
    direct_alerts = [dict(result.data) for result in alert_results
                     if result.outcome == CallOutcome.SUCCESS_WITH_DATA and isinstance(result.data, Mapping)]
    fast_audit["alerts_complete"] = len(direct_alerts) == len(alert_ids)
    fast_audit["referenced_alert_count"] = len(alert_ids)
    fast_audit["resolved_alert_count"] = len(direct_alerts)
    fast_audit["alert_completeness_required"] = False
    fast_result = classify(
        incident, direct_alerts, whitelist, intel_list,
        complete=fast_audit["complete"],
        queried_at=fast_audit["queried_at"],
        list_timezone=getattr(args, "list_timezone", None),
        audit=fast_audit,
    )
    fast_audit["route"] = "fast_classification" if fast_result else "five_source"
    _dump(output_dir / "fast-classification.audit.json", fast_audit)
    if fast_result:
        _dump(output_dir / "fast-classification-output.json", fast_result)
        _dump(output_dir / "call-ledger.audit.json", sorted(runner.ledger, key=lambda row: row["call_id"]))
        _dump(output_dir / "call-ledger.json", {
            "incident_id": args.incident_id, "policy": "read_only_configured_mcp_only",
            "groups": _group_ledger(runner.ledger),
        })
        _dump(output_dir / "manifest.json", {
            "incident_id": args.incident_id, "schema_version": "1.0",
            "generated_at": _iso(datetime.now(timezone.utc)),
            "route": "fast_classification", "result_file": "fast-classification-output.json",
            "llm_invoked": False, "soc_ui_used_as_evidence": False, "penetration_prior_used": False,
        })
        print(str(output_dir), flush=True)
        return output_dir

    if not normalized_alerts:
        raise RuntimeError("no contributing alert could be resolved for five-source enrichment")

    reasoning_rule_result: McpCallResult | None = None
    if (rule_id := _rule_id(incident)) is not None:
        reasoning_rule_result = runner.call(
            resource="ai_soc_correlate",
            tool="ai_soc_correlate__get_correlate_reasoning_rules_by_rule_id",
            purpose="读取安全事件推理规则元数据",
            arguments={"ruleId": rule_id},
            argument_sources={"ruleId": "incident correlation/reasoning rule ID"},
            domain="graph",
        )
    judgement_target = build_judgement_target(
        incident,
        _mapping(reasoning_rule_result.data) if reasoning_rule_result else None,
    )

    time_range = derive_effective_time_range(incident, normalized_alerts)
    candidates = extract_incident_entities(incident)
    asset_calls_by_id: dict[str, dict[str, McpCallResult]] = {}
    for asset_id in _asset_ids(candidates):
        asset_calls_by_id[asset_id] = _call_asset_context(runner, asset_id)
    asset_records = [
        _mapping(calls["detail"].data)
        for calls in asset_calls_by_id.values()
        if calls["detail"].outcome == CallOutcome.SUCCESS_WITH_DATA
    ]
    entities, entity_index, resolution_audit = canonicalize_entities(
        candidates, asset_records, time_range
    )
    anchor_refs = {
        str(entity["entity_ref"])
        for entity in entities
        if entity.get("role") == "anchor"
    }
    alert_rows = attach_entity_refs(
        normalized_alerts, entity_index, owner_refs=anchor_refs
    )
    entities, entity_index, expansion_audit = expand_related_entities(
        entities, entity_index, alert_rows, time_range
    )
    alert_rows = attach_entity_refs(
        normalized_alerts, entity_index, owner_refs=anchor_refs
    )

    search_targets = build_anchor_search_targets(entities)
    event_query_summary: list[dict[str, Any]] = []
    nearby_events: list[dict[str, Any]] = []
    raw_fetch_count = 0
    stopped_after_slice: int | None = None
    slices = build_forward_slices(time_range[0], time_range[1], max_slices=args.max_slices)
    for slice_number, (slice_start, slice_end) in enumerate(slices, start=1):
        searches = build_slice_searches(
            slice_start=slice_start,
            slice_end=slice_end,
            targets=search_targets,
            per_target_budget=args.per_anchor_slice_events,
        )
        for search in searches:
            hits, summary = fetch_bounded_event_hits(runner, search)
            summary.update(
                {
                    "entity_ref": search["entity_ref"],
                    "slice_number": slice_number,
                    "slice_time_range": [slice_start, slice_end],
                }
            )
            event_query_summary.append(summary)
            raw_fetch_count += len(hits)
            for hit in hits:
                row = normalize_event_hit(hit)
                row["record_origin"] = "anchor_event_search"
                row["queried_entity_ref"] = search["entity_ref"]
                nearby_events.append(row)
        if raw_fetch_count >= args.max_fetched_events:
            stopped_after_slice = slice_number
            break

    all_attached = attach_entity_refs(
        [*normalized_alerts, *nearby_events],
        entity_index,
        owner_refs=anchor_refs,
    )
    deduplicated, dedup_audit = deduplicate_records(all_attached)
    seed_keys = _process_seed_keys(deduplicated, anchor_refs)
    process_linked_keys = build_process_neighborhood(
        deduplicated,
        seed_record_keys=seed_keys,
        max_hops=2,
        pid_reuse_guard_minutes=args.pid_reuse_guard_minutes,
    )
    selected_records, selection_audit = select_records(
        deduplicated,
        anchor_refs=anchor_refs,
        process_linked_keys=process_linked_keys,
        budget=args.max_model_records,
    )
    repeated_behaviors = aggregate_repeated_behaviors(selected_records)

    asset_context_by_entity: dict[str, dict[str, Any]] = {}
    topology_by_entity: dict[str, Mapping[str, Any]] = {}
    account_rows: list[dict[str, Any]] = []
    asset_id_to_ref = {
        str(entity["asset_id"]): str(entity["entity_ref"])
        for entity in entities
        if entity.get("entity_type") == "asset" and entity.get("asset_id")
    }
    for asset_id, calls in asset_calls_by_id.items():
        entity_ref = asset_id_to_ref.get(asset_id)
        if not entity_ref:
            continue
        asset_context_by_entity[entity_ref] = {
            "detail": _tri_state(calls["detail"]),
            "importance": _tri_state(calls["importance"]),
            "business_system": _tri_state(calls["business_system"]),
            "bindings": _tri_state(calls["bindings"]),
        }
        topology = _compact_topology(_tri_state(calls["topology"]))
        topology_by_entity[entity_ref] = topology or {}
        account_rows.append(
            {
                "entity_ref": entity_ref,
                "accounts": _tri_state(calls["accounts"]),
            }
        )

    login_wrappers: list[dict[str, Any]] = []
    login_start = int((parse_datetime_utc(time_range[0]) - timedelta(days=7)).timestamp() * 1000)
    login_end = int(parse_datetime_utc(time_range[1]).timestamp() * 1000)
    for account_wrapper in account_rows:
        names = sorted(
            {
                name
                for row in _rows(account_wrapper.get("accounts"))
                if (name := _account_name(row)) is not None
            }
        )[: args.max_accounts_per_asset]
        for account in names:
            result = runner.call(
                resource="ai_soc_graph",
                tool="ai_soc_graph__get_graph_lm_login_sequence",
                purpose="读取锚点资产账户近七天登录序列",
                arguments={"account": account, "windowStart": login_start, "windowEnd": login_end},
                argument_sources={
                    "account": f"graph asset account {account_wrapper['entity_ref']}",
                    "windowStart": "incident evidence start - 7 days",
                    "windowEnd": "incident evidence end",
                },
                domain="graph",
            )
            if result.outcome in (CallOutcome.SUCCESS_WITH_DATA, CallOutcome.SUCCESS_EMPTY):
                login_wrappers.append(
                    {
                        "entity_ref": account_wrapper["entity_ref"],
                        "account": account,
                        "sequence": _tri_state(result),
                    }
                )
    compact_logins, login_audit = _compact_logins_by_entity(
        login_wrappers, max_rows=args.max_login_rows
    )

    endpoint_pairs = select_endpoint_pairs(
        selected_records, anchor_refs=anchor_refs, max_pairs=args.max_pairs
    )
    query_start = parse_datetime_utc(time_range[0])
    query_end = parse_datetime_utc(time_range[1])
    if query_start is None or query_end is None:
        raise RuntimeError("effective evidence range is invalid")
    firewall_sessions: list[dict[str, Any]] = []
    flow_query_summary: list[dict[str, Any]] = []
    for pair in endpoint_pairs:
        source_ip = str(pair["source_ip"])
        destination_ip = str(pair["destination_ip"])
        result = runner.call(
            resource="ai_soc_graph",
            tool="ai_soc_graph__get_graph_flow_host_pair_ports",
            purpose="核验已保留端点对的防火墙动作聚合",
            arguments={"srcIp": source_ip, "dstIp": destination_ip, "timeFrom": time_range[0]},
            argument_sources={
                "srcIp": "retained endpoint pair",
                "dstIp": "retained endpoint pair",
                "timeFrom": "event_snapshot.time_range start",
            },
            domain="graph",
        )
        allowed_ports = {str(value) for value in _list(pair.get("destination_ports"))}
        matched = [
            row
            for row in _flow_rows(result.data)
            if _flow_overlaps(row, query_start, query_end)
            and (
                not allowed_ports
                or str(row.get("dstPort") or row.get("dst_port") or "") in allowed_ports
            )
        ]
        for row in matched:
            firewall_sessions.append(
                {
                    **_compact_firewall_session(
                        row,
                        query_source_ip=source_ip,
                        query_destination_ip=destination_ip,
                    ),
                    "entity_refs": pair.get("entity_refs", []),
                }
            )
        flow_query_summary.append(
            {
                "source_ip": source_ip,
                "destination_ip": destination_ip,
                "status": result.outcome.value,
                "returned_rows": len(_flow_rows(result.data)),
                "window_matched_rows": len(matched),
            }
        )
    unique_firewall: dict[str, dict[str, Any]] = {}
    for row in firewall_sessions:
        unique_firewall[json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)] = row
    firewall_sessions = list(unique_firewall.values())

    indicators = build_intel_indicators(
        entities, selected_records, max_indicators=args.max_intel_indicators
    )
    intelligence_by_value: dict[str, dict[str, Any]] = {}
    for indicator in indicators:
        observable = str(indicator["value"])
        matches: list[dict[str, Any]] = []
        outcomes: list[McpCallResult] = []
        for disposition in ("malicious", "whitelist", "indicator"):
            result = runner.call(
                resource="ai_soc_correlate",
                tool="ai_soc_correlate__get_correlate_intel_check",
                purpose="查询实体或已保留关系 IP 的本地威胁情报",
                arguments={"value": observable, "disposition": disposition},
                argument_sources={
                    "value": "entity index or retained related record",
                    "disposition": "fixed local intelligence lookup set",
                },
                domain="threat_intel",
            )
            outcomes.append(result)
            if result.outcome == CallOutcome.SUCCESS_WITH_DATA and _intel_positive(result.data):
                matches.append({"disposition": disposition, "data": result.data})
        all_successful = all(_successful(result) for result in outcomes)
        intelligence_by_value[observable] = {
            "queried": bool(matches) or all_successful,
            "matches": matches,
        }

    edr_domain = project_edr_domain(entities, selected_records)
    graph_domain = project_graph_domain(
        entities=entities,
        records=selected_records,
        endpoint_pairs=endpoint_pairs,
        topology_by_entity=topology_by_entity,
        account_rows=account_rows,
        login_sequences=compact_logins,
        firewall_sessions=firewall_sessions,
    )
    asset_domain = project_asset_domain(entities, asset_context_by_entity)
    threat_intel_domain = project_threat_intel_domain(indicators, intelligence_by_value)
    history_domain = {"records": []}
    context = {
        "graph": graph_domain,
        "edr_detail": edr_domain,
        "asset": asset_domain,
        "threat_intel": threat_intel_domain,
        "history": history_domain,
    }

    asset_results = [
        result
        for calls in asset_calls_by_id.values()
        for name, result in calls.items()
        if name in {"detail", "importance", "business_system", "bindings"}
    ]
    graph_results = [
        result
        for calls in asset_calls_by_id.values()
        for name, result in calls.items()
        if name in {"topology", "accounts"}
    ]
    graph_results.extend(
        result
        for result in runner.domain_calls.get("graph", [])
        if result not in graph_results and result is not incident_result and result is not reasoning_rule_result
    )
    event_search_results = [
        result
        for result in runner.domain_calls.get("edr_detail", [])
        if result not in alert_results
    ]
    intel_results = list(runner.domain_calls.get("threat_intel", []))
    completeness, completeness_audit = calculate_completeness(
        resolved_alerts=len(normalized_alerts),
        referenced_alerts=len(alert_ids),
        anchor_query_successes=sum(_successful(result) for result in event_search_results),
        anchor_query_attempts=len(event_search_results),
        asset_query_successes=sum(_successful(result) for result in asset_results),
        asset_query_attempts=len(asset_results),
        graph_query_successes=sum(_successful(result) for result in graph_results),
        graph_query_attempts=len(graph_results),
        intel_query_successes=sum(_successful(result) for result in intel_results),
        intel_query_attempts=len(intel_results),
    )
    output = {
        "unified_event_id": args.incident_id,
        "event_snapshot": {
            "event_type": incident.get("incidentType") or incident.get("title") or incident.get("name"),
            "time_range": time_range,
            "judgement_target": judgement_target,
            "entities": entities,
        },
        "enriched_context": context,
        "data_completeness": completeness,
        "enrichment_latency_ms": round((time.monotonic() - started) * 1000),
    }
    audit_output, output = prepare_five_source_artifacts(output)

    _dump(output_dir / "five-source-audit.json", audit_output)
    _dump(output_dir / "five-source-output.json", output)
    _dump(output_dir / "call-ledger.audit.json", sorted(runner.ledger, key=lambda row: row["call_id"]))
    _dump(
        output_dir / "entity-resolution.audit.json",
        {
            "incident_candidates": candidates,
            "canonicalization": resolution_audit,
            "related_expansion": expansion_audit,
            "entity_index": entity_index,
        },
    )
    _dump(
        output_dir / "fusion.audit.json",
        {
            "policy": "read_only_50500_mcp_only_no_ui_no_penetration_prior_no_llm",
            "referenced_alerts": len(alert_ids),
            "resolved_alerts": len(normalized_alerts),
            "effective_time_range": time_range,
            "search_targets": search_targets,
            "forward_slices": [list(value) for value in slices],
            "stopped_after_slice": stopped_after_slice,
            "raw_fetched_event_count": raw_fetch_count,
            "event_queries": event_query_summary,
            "deduplication": dedup_audit,
            "process_seed_count": len(seed_keys),
            "process_linked_record_count": len(process_linked_keys),
            "selection": selection_audit,
            "repeated_behavior_count": len(repeated_behaviors),
            "repeated_behaviors": repeated_behaviors,
            "endpoint_pairs": endpoint_pairs,
            "flow_queries": flow_query_summary,
            "login_projection": login_audit,
            "intel_indicators": indicators,
            "no_recursive_related_entity_expansion": True,
            "process_max_hops": 2,
        },
    )
    _dump(output_dir / "data-completeness.audit.json", completeness_audit)
    _dump(
        output_dir / "call-ledger.json",
        {
            "incident_id": args.incident_id,
            "policy": "read_only_configured_mcp_only",
            "groups": _group_ledger(runner.ledger),
        },
    )
    _dump(
        output_dir / "manifest.json",
        {
            "incident_id": args.incident_id,
            "schema_version": "1.0",
            "generated_at": _iso(datetime.now(timezone.utc)),
            "route": "five_source",
            "five_source_file": "five-source-output.json",
            "five_source_audit_file": "five-source-audit.json",
            "five_source_model_input_file": "five-source-output.json",
            "llm_invoked": False,
            "soc_ui_used_as_evidence": False,
            "penetration_prior_used": False,
        },
    )
    print(str(output_dir), flush=True)
    return output_dir


def parse_args(argv=None, *, require_bridge: bool = True) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--incident-id", required=True)
    parser.add_argument("--bridge-url", default=os.environ.get("THREAT_ANALYSIS_BRIDGE_URL"))
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--list-timezone", default=os.environ.get("SOC_LIST_TIMEZONE"),
                        help="IANA timezone for list expiry timestamps without an offset")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--max-slices", type=int, default=12)
    parser.add_argument("--per-anchor-slice-events", type=int, default=20)
    parser.add_argument("--max-fetched-events", type=int, default=1200)
    parser.add_argument("--max-model-records", type=int, default=120)
    parser.add_argument("--pid-reuse-guard-minutes", type=int, default=30)
    parser.add_argument("--max-pairs", type=int, default=20)
    parser.add_argument("--max-intel-indicators", type=int, default=20)
    parser.add_argument("--max-accounts-per-asset", type=int, default=5)
    parser.add_argument("--max-login-rows", type=int, default=100)
    args = parser.parse_args(argv)
    args.bridge_key = os.environ.get("THREAT_ANALYSIS_BRIDGE_KEY")
    if args.list_timezone:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(args.list_timezone)
        except (ZoneInfoNotFoundError, ValueError):
            parser.error("--list-timezone must be a valid IANA timezone")
    if require_bridge and not args.bridge_url:
        parser.error("--bridge-url or THREAT_ANALYSIS_BRIDGE_URL is required")
    if require_bridge and not args.bridge_key:
        parser.error("THREAT_ANALYSIS_BRIDGE_KEY is required")
    if not 1 <= args.workers <= 32:
        parser.error("--workers must be between 1 and 32")
    for field in (
        "max_slices",
        "per_anchor_slice_events",
        "max_fetched_events",
        "max_model_records",
        "max_pairs",
        "max_intel_indicators",
        "max_accounts_per_asset",
        "max_login_rows",
    ):
        if getattr(args, field) < 1:
            parser.error(f"--{field.replace('_', '-')} must be positive")
    return args


if __name__ == "__main__":
    run(parse_args())

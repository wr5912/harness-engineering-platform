"""Validation contract for the multi-anchor five-source output."""

from __future__ import annotations

from enum import Enum
from typing import Any, Mapping


DOMAIN_NAMES = ("graph", "edr_detail", "asset", "threat_intel", "history")
GRAPH_FIELDS = {
    "related_hosts",
    "related_users",
    "connection_history",
    "firewall_sessions",
    "ids_probe_alerts",
    "trust_info",
    "path_hints",
    "asset_group",
    "cross_device_corroboration",
    "topology_summary",
    "login_sequence",
}

MODEL_ENTITY_AUDIT_ONLY_FIELDS = {"aliases", "provenance", "valid_during"}
MODEL_EDR_AUDIT_ONLY_FIELDS = {
    "process_activities",
    "process_uid",
    "process_uids",
    "pid",
    "sources",
    "alert_ids",
    "sample_record_ids",
    "alert_id_count",
    "rule_id_count",
    "first_seen",
    "last_seen",
}


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def validate_five_source_output(payload: Mapping[str, Any]) -> None:
    snapshot = _mapping(payload.get("event_snapshot"), "event_snapshot")
    target = _mapping(snapshot.get("judgement_target"), "judgement_target")
    if "primary_entity" in target or "peer_entities" in target:
        raise ValueError("primary_entity/peer_entities are forbidden in the entity-based contract")
    for field in ("claim_family", "claim_type", "target_source"):
        if target.get(field) in (None, ""):
            raise ValueError(f"judgement_target.{field} is required")
    time_range = snapshot.get("time_range")
    if not isinstance(time_range, list) or len(time_range) != 2 or not all(time_range):
        raise ValueError("event_snapshot.time_range must contain start and end")
    entities = snapshot.get("entities")
    if not isinstance(entities, list) or not entities:
        raise ValueError("event_snapshot.entities must contain at least one anchor")
    refs = []
    for entity in entities:
        current = _mapping(entity, "event_snapshot.entities[]")
        if current.get("role") not in {"anchor", "related"}:
            raise ValueError("entity role must be anchor or related")
        if not current.get("entity_ref"):
            raise ValueError("entity_ref is required")
        refs.append(str(current["entity_ref"]))
    if len(refs) != len(set(refs)):
        raise ValueError("entity_ref values must be unique")
    if not any(entity.get("role") == "anchor" for entity in entities):
        raise ValueError("at least one anchor entity is required")

    context = _mapping(payload.get("enriched_context"), "enriched_context")
    if set(context) != set(DOMAIN_NAMES):
        raise ValueError(f"enriched_context domains must be exactly {DOMAIN_NAMES}")
    graph = _mapping(context["graph"], "graph")
    missing_graph = GRAPH_FIELDS - set(graph)
    if missing_graph:
        raise ValueError(f"graph missing fields: {sorted(missing_graph)}")
    edr = _mapping(context["edr_detail"], "edr_detail")
    asset = _mapping(context["asset"], "asset")
    intel = _mapping(context["threat_intel"], "threat_intel")
    history = _mapping(context["history"], "history")
    if not isinstance(edr.get("entities"), list):
        raise ValueError("edr_detail.entities must be a list")
    if not isinstance(asset.get("entities"), list):
        raise ValueError("asset.entities must be a list")
    if not isinstance(intel.get("indicators"), list):
        raise ValueError("threat_intel.indicators must be a list")
    if not isinstance(history.get("records"), list):
        raise ValueError("history.records must be a list")
    score = payload.get("data_completeness")
    if not isinstance(score, (int, float)) or not 0 <= float(score) <= 1:
        raise ValueError("data_completeness must be between 0 and 1")


def _reject_audit_only_edr_fields(value: Any, path: str) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in MODEL_EDR_AUDIT_ONLY_FIELDS:
                raise ValueError(f"audit-only field is forbidden in model input: {path}.{key}")
            _reject_audit_only_edr_fields(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_audit_only_edr_fields(item, f"{path}[{index}]")


def validate_model_input(payload: Mapping[str, Any]) -> None:
    """Validate the compact model projection without weakening the audit contract."""

    validate_five_source_output(payload)
    snapshot = _mapping(payload["event_snapshot"], "event_snapshot")
    entity_refs = {
        str(_mapping(entity, "event_snapshot.entities[]")["entity_ref"])
        for entity in snapshot["entities"]
    }
    for entity in snapshot["entities"]:
        current = _mapping(entity, "event_snapshot.entities[]")
        forbidden = MODEL_ENTITY_AUDIT_ONLY_FIELDS & set(current)
        if forbidden:
            raise ValueError(
                "audit-only entity fields are forbidden in model input: "
                f"{sorted(forbidden)}"
            )

    edr = _mapping(payload["enriched_context"]["edr_detail"], "edr_detail")
    for entity_index, entity in enumerate(edr["entities"]):
        current_entity = _mapping(entity, f"edr_detail.entities[{entity_index}]")
        entity_ref = current_entity.get("entity_ref")
        if str(entity_ref) not in entity_refs:
            raise ValueError(f"unknown EDR entity_ref: {entity_ref}")
        segments = current_entity.get("activity_segments")
        if not isinstance(segments, list):
            raise ValueError("edr_detail activity_segments must be a list")
        for segment_index, segment in enumerate(segments):
            current_segment = _mapping(
                segment,
                f"edr_detail.entities[{entity_index}].activity_segments[{segment_index}]",
            )
            processes = current_segment.get("processes", [])
            if not isinstance(processes, list):
                raise ValueError("processes must be a list")
            process_refs: set[str] = set()
            for process in processes:
                current_process = _mapping(process, "processes[]")
                process_ref = current_process.get("ref")
                if process_ref in (None, ""):
                    raise ValueError("process ref is required")
                process_ref = str(process_ref)
                if process_ref in process_refs:
                    raise ValueError(f"duplicate process ref: {process_ref}")
                process_refs.add(process_ref)
            for process in processes:
                parent_ref = _mapping(process, "processes[]").get("parent_ref")
                if parent_ref not in (None, "") and str(parent_ref) not in process_refs:
                    raise ValueError(f"unknown parent_ref: {parent_ref}")
            for field in ("file_operations", "network_details", "authentication_events", "other_events"):
                rows = current_segment.get(field, [])
                if not isinstance(rows, list):
                    raise ValueError(f"{field} must be a list")
                for row in rows:
                    process_ref = _mapping(row, f"{field}[]").get("process_ref")
                    if process_ref not in (None, "") and str(process_ref) not in process_refs:
                        raise ValueError(f"unknown process_ref: {process_ref}")
        _reject_audit_only_edr_fields(
            current_entity,
            f"edr_detail.entities[{entity_index}]",
        )


SENSITIVE_KEY_PARTS = ("password", "passwd", "token", "secret", "credential")


class CallOutcome(str, Enum):
    SUCCESS_WITH_DATA = "success_with_data"
    SUCCESS_EMPTY = "success_empty"
    TRUNCATED = "truncated"
    FAILED = "failed"
    NOT_QUERIED = "not_queried"


def canonical_tool_name(exact_tool_name: str) -> str:
    return exact_tool_name.rsplit("__", 1)[-1]


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, child in value.items():
            normalized = str(key).lower()
            result[str(key)] = (
                "***REDACTED***"
                if any(part in normalized for part in SENSITIVE_KEY_PARTS)
                else _redact(child)
            )
        return result
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def make_ledger_entry(
    *,
    call_id: str,
    resource: str,
    exact_tool_name: str,
    purpose: str,
    key_arguments: Mapping[str, Any],
    argument_sources: Mapping[str, str],
    outcome: CallOutcome,
    result_count: int | None,
    latency_ms: int,
    output_domain: str,
    raw_response_file: str,
) -> dict[str, Any]:
    """Create a concise user-facing row with exact invocation data in audit."""

    return {
        "call_id": call_id,
        "tool": canonical_tool_name(exact_tool_name),
        "purpose": purpose,
        "key_arguments": _redact(dict(key_arguments)),
        "argument_sources": dict(argument_sources),
        "status": outcome.value,
        "result_count": result_count,
        "latency_ms": latency_ms,
        "output_domain": output_domain,
        "audit": {
            "resource": resource,
            "exact_tool": exact_tool_name,
            "raw_response_file": raw_response_file,
        },
    }

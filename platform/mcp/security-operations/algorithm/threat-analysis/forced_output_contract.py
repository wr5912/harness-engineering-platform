"""Mechanical validation for the compact forced threat-analysis output.

The validator performs contract and provenance checks only.  It does not infer
whether an incident is malicious and it never consults an external truth source.
"""

from __future__ import annotations

import json
import re
from numbers import Real
from typing import Any, Mapping, Sequence


REQUIRED_FIELDS = {
    "unified_event_id",
    "verdict",
    "primary_claim",
    "secondary_findings",
    "confidence_score",
    "attack_stage",
    "technique",
    "technique_name",
    "verified_facts",
    "key_claims",
    "counter_evidence",
    "uncertainty_notes",
    "attack_chain_speculation",
    "rule_optimization_suggestions",
    "recommended_actions",
    "reasoning_summary",
}
ALLOWED_VERDICTS = {"误报", "真实告警", "可疑"}
ALLOWED_CLAIM_RESULTS = {"支持", "反驳", "证据不足"}
ALLOWED_FACT_SOURCES = {
    "graph",
    "edr_detail",
    "asset",
    "threat_intel",
    "history",
}
MAX_VERIFIED_FACTS = 8
MAX_RULE_SUGGESTIONS = 2
MAX_RECOMMENDED_ACTIONS = 2
FORBIDDEN_SOURCE_MARKERS = (
    "172.16.138.232",
    ":18060",
    "渗透攻击平台",
    "penetration platform",
)
_FACT_DECLARATION_MARKERS = (
    "研判目标",
    "原始主张",
    "事件主张",
    "威胁事件声明",
    "锚定规则",
    "推理规则",
    "规则命中",
    "规则名称",
    "规则描述",
    "事件类型为",
)
_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d+)\]")
_BARE_ENTITY_REF = re.compile(r"(?<![A-Za-z0-9_])E\d+(?![A-Za-z0-9_])")
_EDR_SEGMENT_PATH = re.compile(
    r"^(assets|entities)\[(\d+)\]\.activity_segments\[(\d+)\]\.(.+)$"
)
_GRAPH_PATH_HINT = re.compile(r"^path_hints\[(\d+)\](?:\.|$)")
_BEHAVIOR_COLLECTIONS = {
    "process_activities",
    "processes",
    "file_operations",
    "network_connections",
    "network_details",
    "authentication_activities",
    "other_activities",
    "other_events",
}
_SECONDARY_ATTACK_MARKERS = (
    "攻击",
    "爆破",
    "扫描",
    "探测",
    "侦察",
    "注入",
    "利用",
    "载荷",
    "植入",
    "恶意",
    "脚本",
    "木马",
    "后门",
    "失陷",
    "沦陷",
    "入侵",
    "横向",
    "远程服务",
    "执行",
    "下载",
    "外联",
    "回连",
    "凭据",
    "持久化",
    "提权",
    "窃取",
    "控制",
    "篡改",
    "破坏",
    "泄露",
    "C2",
    "命令与控制",
    "信标",
)
_SECONDARY_NEUTRAL_TYPES = {
    "异常行为",
    "可疑行为",
    "异常活动",
    "可疑活动",
    "行为发现",
    "事件发现",
    "日志活动",
    "命令查询",
    "主机信息收集",
    "账户信息收集",
    "审计策略查询",
}
_DIRECT_BEHAVIOR_MARKERS = (
    "执行",
    "下载",
    "连接",
    "外联",
    "回连",
    "登录",
    "访问",
    "扫描",
    "枚举",
    "创建",
    "修改",
    "注入",
    "投递",
    "移动",
    "攻击",
    "利用",
    "脚本",
    "命令",
    "进程",
    "凭据",
    "服务",
    "载荷",
    "后门",
    "文件",
    "写入",
    "启动",
    "操作",
    "计划",
    "任务",
    "INJECTION",
    "EXPLOIT",
    "PORT_SCAN",
    "CMD_INJECTION",
    "CODE_INJECTION",
    "C2",
    "BEACON",
    "MALWARE",
    "POWERSHELL",
    "CERTUTIL",
)


def _resolve_path(root: Any, path: str) -> Any:
    cursor = root
    position = 0
    for match in _PATH_TOKEN.finditer(path):
        if match.start() != position and path[position : match.start()] != ".":
            raise KeyError(path)
        position = match.end()
        key, index = match.groups()
        if key is not None:
            if not isinstance(cursor, Mapping) or key not in cursor:
                raise KeyError(path)
            cursor = cursor[key]
        else:
            if not isinstance(cursor, Sequence) or isinstance(cursor, (str, bytes)):
                raise KeyError(path)
            numeric_index = int(index)
            if numeric_index >= len(cursor):
                raise KeyError(path)
            cursor = cursor[numeric_index]
    if position != len(path):
        raise KeyError(path)
    return cursor


def _require_list(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    return value


def _require_max_items(value: Any, field: str, maximum: int) -> list[Any]:
    items = _require_list(value, field)
    if len(items) > maximum:
        raise ValueError(f"{field} must contain at most {maximum} items")
    return items


def _nonempty(value: Any) -> bool:
    """Return whether a value can carry positive evidence.

    ``False`` and ``0`` are retained because they can be meaningful native
    values. Missing strings and empty containers cannot support a claim.
    """

    return value not in (None, "", [], {})


def _require_readable_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    if _BARE_ENTITY_REF.search(value):
        raise ValueError(f"{field} contains a bare internal entity reference")
    return value


def _reject_incident_or_rule_declaration(
    value: str,
    snapshot: Mapping[str, Any],
    target: Mapping[str, Any],
    field: str,
) -> None:
    """Reject incident metadata and rule declarations masquerading as facts."""

    normalized = value.casefold()
    if any(marker.casefold() in normalized for marker in _FACT_DECLARATION_MARKERS):
        raise ValueError(f"{field} contains an incident or rule declaration")

    declared_terms: list[Any] = [
        snapshot.get("event_type"),
        target.get("claim_type"),
    ]
    anchor_rule = target.get("anchor_rule")
    if isinstance(anchor_rule, Mapping):
        declared_terms.extend(
            (anchor_rule.get("name"), anchor_rule.get("description"))
        )
    for term in declared_terms:
        if not isinstance(term, str):
            continue
        compact = term.strip()
        if len(compact) >= 4 and compact.casefold() in normalized:
            raise ValueError(f"{field} contains an incident or rule declaration")


def _validate_evidence_reference(
    evidence: Mapping[str, Any],
    five_source: Mapping[str, Any],
    field_name: str,
    warnings: list[str],
) -> Any:
    source = evidence.get("source")
    field = evidence.get("field")
    if source not in ALLOWED_FACT_SOURCES:
        raise ValueError(f"invalid {field_name} source: {source!r}")
    if not isinstance(field, str) or not field:
        raise ValueError(f"{field_name} field must be a non-empty string")
    if "value" not in evidence:
        raise ValueError(f"{field_name} must contain a value copied from input")
    full_path = f"enriched_context.{source}.{field}"
    try:
        resolved = _resolve_path(five_source, full_path)
    except KeyError as exc:
        raise ValueError(
            f"{field_name} reference does not resolve: {full_path}"
        ) from exc
    if not _nonempty(resolved):
        raise ValueError(
            f"{field_name} must resolve to a non-empty value: {full_path}"
        )
    if evidence.get("value") != resolved:
        warnings.append(f"{field_name} value does not match input: {full_path}")
    return resolved


def _primary_entity_matches(
    entity: Mapping[str, Any],
    target: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> bool:
    primary = target.get("primary_entity")
    if isinstance(primary, Mapping):
        primary_asset_id = primary.get("asset_id")
        asset_id = entity.get("asset_id")
        if primary_asset_id not in (None, "") and asset_id not in (None, ""):
            return str(primary_asset_id) == str(asset_id)

        primary_ip = primary.get("ip")
        if primary_ip not in (None, ""):
            expected = f"ip:{primary_ip}"
            if any(
                expected in (segment.get("entity_refs") or [])
                for segment in entity.get("activity_segments") or []
                if isinstance(segment, Mapping)
            ):
                return True

    anchor_entities = [
        row
        for row in snapshot.get("entities") or []
        if isinstance(row, Mapping) and row.get("role") == "anchor"
    ]
    entity_ref = entity.get("entity_ref")
    entity_asset_id = entity.get("asset_id")
    for anchor in anchor_entities:
        if entity_ref not in (None, "") and entity_ref == anchor.get("entity_ref"):
            return True
        if (
            entity_asset_id not in (None, "")
            and anchor.get("asset_id") not in (None, "")
            and str(entity_asset_id) == str(anchor.get("asset_id"))
        ):
            return True
    return False


def _edr_evidence_location(
    field: str,
    five_source: Mapping[str, Any],
) -> tuple[Mapping[str, Any], Mapping[str, Any], str] | None:
    match = _EDR_SEGMENT_PATH.match(field)
    if not match:
        return None
    collection, asset_index, segment_index, remainder = match.groups()
    enriched = five_source.get("enriched_context")
    edr = enriched.get("edr_detail") if isinstance(enriched, Mapping) else None
    assets = edr.get(collection) if isinstance(edr, Mapping) else None
    try:
        asset = assets[int(asset_index)]
        segment = asset["activity_segments"][int(segment_index)]
    except (IndexError, KeyError, TypeError):
        return None
    if not isinstance(asset, Mapping) or not isinstance(segment, Mapping):
        return None
    return asset, segment, remainder


def _is_primary_scoped_behavior(
    evidence: Mapping[str, Any], five_source: Mapping[str, Any]
) -> bool:
    if evidence.get("source") != "edr_detail":
        return False
    field = evidence.get("field")
    if not isinstance(field, str):
        return False
    location = _edr_evidence_location(field, five_source)
    if location is None:
        return False
    entity, segment, remainder = location
    snapshot = five_source.get("event_snapshot")
    target = snapshot.get("judgement_target") if isinstance(snapshot, Mapping) else None
    if (
        not isinstance(target, Mapping)
        or not isinstance(snapshot, Mapping)
        or not _primary_entity_matches(entity, target, snapshot)
    ):
        return False
    if segment.get("scope") not in {"anchor", "linked", "anchor_entity"}:
        return False
    behavior_collection = remainder.split(".", 1)[0].split("[", 1)[0]
    return behavior_collection in _BEHAVIOR_COLLECTIONS


def _is_stable_relation_evidence(
    evidence: Mapping[str, Any], five_source: Mapping[str, Any]
) -> bool:
    source = evidence.get("source")
    field = evidence.get("field")
    if not isinstance(field, str):
        return False

    if source == "graph":
        match = _GRAPH_PATH_HINT.match(field)
        if not match:
            return False
        enriched = five_source.get("enriched_context")
        graph = enriched.get("graph") if isinstance(enriched, Mapping) else None
        try:
            hint = graph["path_hints"][int(match.group(1))]
        except (IndexError, KeyError, TypeError):
            return False
        return bool(
            isinstance(hint, Mapping)
            and hint.get("relation")
            and hint.get("basis")
        )

    if source == "edr_detail":
        location = _edr_evidence_location(field, five_source)
        if location is None:
            return False
        _, segment, remainder = location
        return bool(
            segment.get("scope") == "linked"
            and remainder.startswith("relation_basis")
            and segment.get("relation_basis")
        )
    return False


def validate_forced_output(
    output: Mapping[str, Any], five_source: Mapping[str, Any]
) -> list[str]:
    """Validate structure and provenance, returning non-blocking warnings."""

    missing = REQUIRED_FIELDS - set(output)
    if missing:
        raise ValueError(f"forced output missing required fields: {sorted(missing)}")
    unexpected = set(output) - REQUIRED_FIELDS
    if unexpected:
        raise ValueError(f"forced output contains unexpected fields: {sorted(unexpected)}")
    if output["unified_event_id"] != five_source.get("unified_event_id"):
        raise ValueError("unified_event_id does not match five-source input")
    if output["verdict"] not in ALLOWED_VERDICTS:
        raise ValueError(f"unsupported verdict: {output['verdict']}")
    warnings: list[str] = []

    score = output["confidence_score"]
    if isinstance(score, bool) or not isinstance(score, Real) or not 0 <= score <= 1:
        raise ValueError("confidence_score must be a number between 0 and 1")

    serialized = json.dumps(output, ensure_ascii=False).lower()
    for marker in FORBIDDEN_SOURCE_MARKERS:
        if marker.lower() in serialized:
            raise ValueError(f"forced output contains forbidden source marker: {marker}")

    snapshot = five_source.get("event_snapshot")
    target = snapshot.get("judgement_target") if isinstance(snapshot, Mapping) else None
    if not isinstance(snapshot, Mapping) or not isinstance(target, Mapping):
        raise ValueError("five-source input has no frozen judgement target")

    facts = _require_max_items(
        output["verified_facts"], "verified_facts", MAX_VERIFIED_FACTS
    )
    fact_ids: set[str] = set()
    for index, fact in enumerate(facts):
        if not isinstance(fact, Mapping):
            raise ValueError(f"verified_facts[{index}] must be an object")
        if set(fact) != {"id", "fact", "source"}:
            raise ValueError(
                f"verified_facts[{index}] must contain exactly id, fact, and source"
            )
        fact_id = fact.get("id")
        if not isinstance(fact_id, str) or not re.fullmatch(r"F\d{2,}", fact_id):
            raise ValueError(f"verified_facts[{index}].id is invalid")
        if fact_id in fact_ids:
            raise ValueError(f"duplicate fact id: {fact_id}")
        fact_ids.add(fact_id)
        fact_text = _require_readable_text(
            fact.get("fact"), f"verified_facts[{index}].fact"
        )
        _reject_incident_or_rule_declaration(
            fact_text,
            snapshot,
            target,
            f"verified_facts[{index}].fact",
        )
        source = fact.get("source")
        if source not in ALLOWED_FACT_SOURCES:
            raise ValueError(
                f"verified_facts[{index}].source must be a five-domain source; "
                "data_completeness and other technical metadata are not allowed"
            )

    primary_claim = output["primary_claim"]
    if not isinstance(primary_claim, Mapping):
        raise ValueError("primary_claim must be an object")
    if set(primary_claim) != {"type", "result"}:
        raise ValueError("primary_claim must contain exactly type and result")
    if primary_claim.get("type") != target.get("claim_type"):
        raise ValueError("primary_claim.type does not match frozen judgement target")
    primary_result = primary_claim.get("result")
    if primary_result not in ALLOWED_CLAIM_RESULTS:
        raise ValueError("primary_claim.result is invalid")

    secondary_findings = output["secondary_findings"]
    if secondary_findings is not None and not isinstance(secondary_findings, Mapping):
        raise ValueError("secondary_findings must be an object or null")
    if isinstance(secondary_findings, Mapping):
        if set(secondary_findings) != {"type", "description"}:
            raise ValueError(
                "secondary_findings must contain exactly type and description"
            )
        finding_type = _require_readable_text(
            secondary_findings.get("type"), "secondary_findings.type"
        )
        _require_readable_text(
            secondary_findings.get("description"), "secondary_findings.description"
        )
        normalized_type = finding_type.strip()
        if (
            normalized_type in _SECONDARY_NEUTRAL_TYPES
            or not any(marker in normalized_type for marker in _SECONDARY_ATTACK_MARKERS)
        ):
            raise ValueError("secondary_findings.type lacks attack semantic")
        if output["verdict"] != "真实告警":
            raise ValueError(
                "secondary_findings can only be present when verdict is 真实告警"
            )

    if primary_result == "支持" and output["verdict"] != "真实告警":
        raise ValueError("a supported primary claim requires verdict 真实告警")

    claims = _require_list(output["key_claims"], "key_claims")
    supporting_evidence: list[Mapping[str, Any]] = []
    for index, claim in enumerate(claims):
        if not isinstance(claim, Mapping):
            raise ValueError(f"key_claims[{index}] must be an object")
        if set(claim) != {"claim", "result", "evidence", "weight"}:
            raise ValueError(
                f"key_claims[{index}] must contain exactly claim, result, evidence, and weight"
            )
        _require_readable_text(claim.get("claim"), f"key_claims[{index}].claim")
        if claim.get("result") != "支持":
            raise ValueError("key_claims may only contain supported claims")
        weight = claim.get("weight")
        if (
            isinstance(weight, bool)
            or not isinstance(weight, Real)
            or not 0 <= weight <= 1
        ):
            raise ValueError(f"key_claims[{index}].weight must be between 0 and 1")
        evidence = _require_list(claim.get("evidence"), f"key_claims[{index}].evidence")
        if not evidence:
            raise ValueError(f"key_claims[{index}].evidence must not be empty")
        for evidence_index, item in enumerate(evidence):
            if not isinstance(item, Mapping):
                raise ValueError(
                    f"key_claims[{index}].evidence[{evidence_index}] must be an object"
                )
            if set(item) != {"source", "field", "value"}:
                raise ValueError(
                    f"key_claims[{index}].evidence[{evidence_index}] must contain "
                    "exactly source, field, and value"
                )
            _validate_evidence_reference(item, five_source, "claim evidence", warnings)
            supporting_evidence.append(item)

    if isinstance(secondary_findings, Mapping) and not any(
        item.get("source") in {"graph", "edr_detail", "threat_intel"}
        for item in supporting_evidence
    ):
        raise ValueError(
            "secondary_findings requires a supported graph, edr_detail, or threat_intel claim"
        )

    if primary_result == "支持":
        if not any(
            _is_primary_scoped_behavior(item, five_source)
            for item in supporting_evidence
        ):
            raise ValueError(
                "real alert requires supporting primary anchor or linked behavior evidence"
            )
        if (
            isinstance(target, Mapping)
            and target.get("claim_family") == "entity_relation"
            and not any(
                _is_stable_relation_evidence(item, five_source)
                for item in supporting_evidence
            )
        ):
            raise ValueError(
                "real entity-relation alert requires stable relation evidence"
            )

    chain = output["attack_chain_speculation"]
    if not isinstance(chain, Mapping):
        raise ValueError("attack_chain_speculation must be an object")
    if set(chain) != {
        "current_stage",
        "observed_path",
        "possible_next_steps",
        "supporting_evidence",
    }:
        raise ValueError("attack_chain_speculation has unexpected fields")
    observed_path = _require_list(
        chain.get("observed_path"), "attack_chain_speculation.observed_path"
    )
    referenced_fact_ids: list[str] = []
    for index, node in enumerate(observed_path):
        if not isinstance(node, Mapping):
            raise ValueError(f"observed_path[{index}] must be an object")
        if set(node) != {"description", "fact_refs"}:
            raise ValueError(
                f"observed_path[{index}] must contain exactly description and fact_refs"
            )
        _require_readable_text(
            node.get("description"), f"observed_path[{index}].description"
        )
        refs = _require_list(node.get("fact_refs"), f"observed_path[{index}].fact_refs")
        referenced_fact_ids.extend(refs)
    supporting = _require_list(
        chain.get("supporting_evidence"),
        "attack_chain_speculation.supporting_evidence",
    )
    referenced_fact_ids.extend(supporting)
    unknown = sorted(set(referenced_fact_ids) - fact_ids)
    if unknown:
        raise ValueError(f"attack chain contains unknown fact references: {unknown}")

    verdict = output["verdict"]
    if verdict == "真实告警":
        if primary_result != "支持" and secondary_findings is None:
            raise ValueError(
                "real alert requires a supported primary claim or secondary_findings"
            )
        if not observed_path:
            raise ValueError("real alert requires at least one observed attack path")
    elif verdict == "可疑":
        if not observed_path:
            raise ValueError("suspicious verdict requires an observed path")
    elif observed_path:
        raise ValueError("false positive verdict cannot contain an observed attack path")

    next_steps = _require_list(
        chain.get("possible_next_steps"),
        "attack_chain_speculation.possible_next_steps",
    )
    if output["verdict"] == "真实告警":
        if not 1 <= len(next_steps) <= 3:
            raise ValueError("real alert requires 1 to 3 possible_next_steps")
    elif next_steps:
        raise ValueError("possible_next_steps must be empty unless verdict is 真实告警")
    for index, step in enumerate(next_steps):
        if not isinstance(step, Mapping):
            raise ValueError(f"possible_next_steps[{index}] must be an object")
        if set(step) != {"technique", "technique_name", "description"}:
            raise ValueError(
                f"possible_next_steps[{index}] must contain exactly technique, "
                "technique_name, and description"
            )
        for field in ("technique", "technique_name", "description"):
            _require_readable_text(
                step.get(field), f"possible_next_steps[{index}].{field}"
            )

    counter_evidence = _require_list(output["counter_evidence"], "counter_evidence")
    for index, counter in enumerate(counter_evidence):
        if not isinstance(counter, Mapping):
            raise ValueError(f"counter_evidence[{index}] must be an object")
        if set(counter) != {"claim", "fact", "source", "field", "value"}:
            raise ValueError(
                f"counter_evidence[{index}] must contain exactly claim, fact, source, field, and value"
            )
        _require_readable_text(counter.get("claim"), f"counter_evidence[{index}].claim")
        _require_readable_text(counter.get("fact"), f"counter_evidence[{index}].fact")
        _validate_evidence_reference(
            counter, five_source, "counter evidence", warnings
        )

    uncertainty_notes = output["uncertainty_notes"]
    if uncertainty_notes is not None:
        _require_readable_text(uncertainty_notes, "uncertainty_notes")
    completeness = five_source.get("data_completeness")
    incomplete_input = (
        isinstance(completeness, Real)
        and not isinstance(completeness, bool)
        and completeness < 1
    )
    if (
        verdict == "误报"
        and (score < 0.6 or incomplete_input)
        and uncertainty_notes is None
    ):
        raise ValueError(
            "low-confidence false positive requires uncertainty_notes"
        )

    _require_max_items(
        output["rule_optimization_suggestions"],
        "rule_optimization_suggestions",
        MAX_RULE_SUGGESTIONS,
    )
    _require_max_items(
        output["recommended_actions"],
        "recommended_actions",
        MAX_RECOMMENDED_ACTIONS,
    )

    readable_fields: list[tuple[str, Any]] = [
        ("reasoning_summary", output.get("reasoning_summary")),
    ]
    for index, suggestion in enumerate(output["rule_optimization_suggestions"]):
        if isinstance(suggestion, Mapping):
            readable_fields.append(
                (
                    f"rule_optimization_suggestions[{index}].suggestion",
                    suggestion.get("suggestion"),
                )
            )
    for index, action in enumerate(output["recommended_actions"]):
        if isinstance(action, Mapping):
            for field in ("action", "target", "reason"):
                readable_fields.append(
                    (f"recommended_actions[{index}].{field}", action.get(field))
                )
    for field, value in readable_fields:
        _require_readable_text(value, field)
    return warnings

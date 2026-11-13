"""Deterministic incident scope and evidence fusion primitives.

This module deliberately performs no threat reasoning.  It freezes the incident
claim, canonicalises explicitly declared entities, links only structurally
related records, removes duplicate source events and applies auditable budgets.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from fusion_pipeline import parse_datetime_utc


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _json(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str):
        return value if value is not None else fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip() or None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _first(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def _add_candidate(
    rows: list[dict[str, str]],
    seen: set[tuple[str, str]],
    entity_type: str,
    value: Any,
    provenance: str,
) -> None:
    text = _text(value)
    if not text:
        return
    key = (entity_type, text.casefold() if entity_type in {"hostname", "user"} else text)
    if key in seen:
        return
    seen.add(key)
    rows.append(
        {"entity_type": entity_type, "value": text, "provenance": provenance}
    )


def extract_incident_entities(incident: Mapping[str, Any]) -> list[dict[str, str]]:
    """Extract only entities explicitly declared by the incident object.

    Contributing-alert order and reasoning-chain steps are intentionally absent
    from this function, so they cannot silently choose a single primary host.
    """

    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    top_level = (
        ("asset", incident.get("affectedAssetId"), "incident.affectedAssetId"),
        ("asset", incident.get("attackerAssetId"), "incident.attackerAssetId"),
        ("ip", incident.get("sourceIp"), "incident.sourceIp"),
        ("ip", incident.get("targetIp"), "incident.targetIp"),
        ("ip", incident.get("attackerIp"), "incident.attackerIp"),
        ("user", incident.get("account"), "incident.account"),
    )
    for entity_type, value, provenance in top_level:
        _add_candidate(rows, seen, entity_type, value, provenance)

    entities = _json(
        _first(
            incident.get("entitiesJson"),
            incident.get("entities_json"),
            incident.get("entities"),
        ),
        [],
    )
    for index, item in enumerate(_list(entities)):
        current = _mapping(item)
        kind = str(current.get("type") or current.get("entityType") or "").upper()
        provenance = f"incident.entitiesJson[{index}]"
        if kind == "ASSET":
            _add_candidate(
                rows,
                seen,
                "asset",
                _first(current.get("assetId"), current.get("asset_id"), current.get("id")),
                provenance,
            )
        elif kind in {"IP", "IP_ADDRESS"}:
            _add_candidate(
                rows,
                seen,
                "ip",
                _first(current.get("ip"), current.get("value")),
                provenance,
            )
        elif kind in {"HOST", "HOSTNAME"}:
            _add_candidate(
                rows,
                seen,
                "hostname",
                _first(current.get("hostname"), current.get("name"), current.get("value")),
                provenance,
            )
        elif kind in {"USER", "ACCOUNT"}:
            _add_candidate(
                rows,
                seen,
                "user",
                _first(current.get("account"), current.get("username"), current.get("name")),
                provenance,
            )
    return rows


def derive_effective_time_range(
    incident: Mapping[str, Any], records: Iterable[Mapping[str, Any]]
) -> list[str]:
    """Use alert business time, with incident first/last time only as fallback."""

    times = sorted(
        parsed
        for parsed in (parse_datetime_utc(row.get("event_time")) for row in records)
        if parsed is not None
    )
    if times:
        return [_iso(times[0]), _iso(times[-1])]
    start = parse_datetime_utc(
        _first(
            incident.get("firstSeenTime"),
            incident.get("first_seen_time"),
            incident.get("firstSeen"),
        )
    )
    end = parse_datetime_utc(
        _first(
            incident.get("lastSeenTime"),
            incident.get("last_seen_time"),
            incident.get("lastSeen"),
        )
    )
    if start is None or end is None:
        raise ValueError("incident has no valid contributing-alert or incident time range")
    if end < start:
        raise ValueError("incident time range is reversed")
    return [_iso(start), _iso(end)]


def _asset_id(asset: Mapping[str, Any]) -> str | None:
    return _text(_first(asset.get("assetId"), asset.get("asset_id"), asset.get("id")))


def _asset_ip(asset: Mapping[str, Any]) -> str | None:
    return _text(_first(asset.get("ip"), asset.get("ipAddress"), asset.get("ip_address")))


def _asset_hostname(asset: Mapping[str, Any]) -> str | None:
    return _text(
        _first(asset.get("hostname"), asset.get("hostName"), asset.get("host_name"), asset.get("name"))
    )


def canonicalize_entities(
    candidates: Iterable[Mapping[str, Any]],
    asset_records: Iterable[Mapping[str, Any]],
    time_range: list[str],
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    """Canonicalise entities with asset ID as the authoritative key.

    An IP/hostname becomes an asset alias only when it maps to exactly one known
    asset.  Ambiguous mappings remain independent entities and are audited.
    """

    candidate_rows = [dict(row) for row in candidates]
    assets_by_id = {
        asset_id: dict(row)
        for row in asset_records
        if (asset_id := _asset_id(row)) is not None
    }
    requested_assets = {
        str(row["value"])
        for row in candidate_rows
        if row.get("entity_type") == "asset" and row.get("value") is not None
    }
    for asset_id in requested_assets:
        assets_by_id.setdefault(asset_id, {"assetId": asset_id})

    ip_to_assets: dict[str, set[str]] = defaultdict(set)
    host_to_assets: dict[str, set[str]] = defaultdict(set)
    for asset_id, asset in assets_by_id.items():
        if ip := _asset_ip(asset):
            ip_to_assets[ip].add(asset_id)
        if hostname := _asset_hostname(asset):
            host_to_assets[hostname.casefold()].add(asset_id)

    provisional: list[dict[str, Any]] = []
    key_to_position: dict[tuple[str, str], int] = {}
    conflicts: list[dict[str, Any]] = []

    for asset_id in sorted(requested_assets, key=lambda value: (not value.isdigit(), value)):
        asset = assets_by_id[asset_id]
        aliases: list[dict[str, Any]] = []
        for alias_type, value in (("ip", _asset_ip(asset)), ("hostname", _asset_hostname(asset))):
            if value:
                aliases.append(
                    {
                        "type": alias_type,
                        "value": value,
                        "valid_during": list(time_range),
                        "provenance": ["asset_lookup"],
                    }
                )
        key_to_position[("asset", asset_id)] = len(provisional)
        provisional.append(
            {
                "entity_type": "asset",
                "role": "anchor",
                "asset_id": asset_id,
                "aliases": aliases,
                "provenance": sorted(
                    {
                        str(row.get("provenance"))
                        for row in candidate_rows
                        if row.get("entity_type") == "asset"
                        and str(row.get("value")) == asset_id
                        and row.get("provenance")
                    }
                ),
            }
        )

    for row in candidate_rows:
        kind = str(row.get("entity_type") or "")
        value = _text(row.get("value"))
        if not value or kind == "asset":
            continue
        mapped_assets: set[str] = set()
        if kind == "ip":
            mapped_assets = ip_to_assets.get(value, set()) & requested_assets
        elif kind == "hostname":
            mapped_assets = host_to_assets.get(value.casefold(), set()) & requested_assets
        if len(mapped_assets) == 1:
            asset_id = next(iter(mapped_assets))
            entity = provisional[key_to_position[("asset", asset_id)]]
            alias_key = (kind, value.casefold() if kind == "hostname" else value)
            existing = {
                (
                    str(alias.get("type")),
                    str(alias.get("value")).casefold()
                    if alias.get("type") == "hostname"
                    else str(alias.get("value")),
                )
                for alias in entity["aliases"]
            }
            if alias_key not in existing:
                entity["aliases"].append(
                    {
                        "type": kind,
                        "value": value,
                        "valid_during": list(time_range),
                        "provenance": [str(row.get("provenance") or "incident")],
                    }
                )
            continue
        if len(mapped_assets) > 1:
            conflicts.append(
                {
                    "key": f"{kind}:{value}",
                    "asset_ids": sorted(mapped_assets),
                    "resolution": "kept_as_independent_anchor",
                }
            )
        normalized = value.casefold() if kind in {"hostname", "user"} else value
        key = (kind, normalized)
        if key in key_to_position:
            continue
        key_to_position[key] = len(provisional)
        provisional.append(
            {
                "entity_type": kind,
                "role": "anchor",
                "value": value,
                "aliases": [],
                "provenance": [str(row.get("provenance") or "incident")],
            }
        )

    def sort_key(entity: Mapping[str, Any]) -> tuple[int, str]:
        kind = str(entity.get("entity_type"))
        order = {"asset": 0, "ip": 1, "hostname": 2, "user": 3}.get(kind, 9)
        value = str(entity.get("asset_id") or entity.get("value") or "")
        return order, value.casefold()

    entities = sorted(provisional, key=sort_key)
    index: dict[str, str] = {}
    for sequence, entity in enumerate(entities, start=1):
        entity_ref = f"E{sequence}"
        entity["entity_ref"] = entity_ref
        if entity["entity_type"] == "asset":
            index[f"asset:{entity['asset_id']}"] = entity_ref
            for alias in entity["aliases"]:
                kind = str(alias["type"])
                value = str(alias["value"])
                lookup = value.casefold() if kind == "hostname" else value
                owners = ip_to_assets[value] if kind == "ip" else host_to_assets[lookup]
                if len(owners & requested_assets) == 1:
                    index[f"{kind}:{lookup}"] = entity_ref
        else:
            value = str(entity["value"])
            lookup = value.casefold() if entity["entity_type"] in {"hostname", "user"} else value
            if not any(item["key"] == f"{entity['entity_type']}:{value}" for item in conflicts):
                index[f"{entity['entity_type']}:{lookup}"] = entity_ref
    return entities, index, {"conflicts": conflicts}


def _record_anchor_refs(record: Mapping[str, Any], index: Mapping[str, str]) -> set[str]:
    refs: set[str] = set()
    asset_id = _text(record.get("affected_asset_id"))
    if asset_id and (ref := index.get(f"asset:{asset_id}")):
        refs.add(ref)
    asset = _mapping(record.get("asset"))
    for kind, value in (
        ("asset", _first(asset.get("id"), asset.get("asset_id"))),
        ("ip", asset.get("ip")),
        ("hostname", asset.get("hostname")),
        ("ip", record.get("source_ip")),
        ("ip", record.get("destination_ip")),
    ):
        text = _text(value)
        if not text:
            continue
        lookup = text.casefold() if kind == "hostname" else text
        if ref := index.get(f"{kind}:{lookup}"):
            refs.add(ref)
    return refs


def expand_related_entities(
    entities: Iterable[Mapping[str, Any]],
    index: Mapping[str, str],
    records: Iterable[Mapping[str, Any]],
    time_range: list[str],
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    """Expand alert-only entities once from explicit relations to original anchors.

    Newly added related entities are never used to discover further entities.
    """

    result = [copy.deepcopy(dict(entity)) for entity in entities]
    result_index = dict(index)
    anchor_refs = {
        str(entity["entity_ref"])
        for entity in result
        if entity.get("role") == "anchor" and entity.get("entity_ref")
    }
    candidates: dict[str, dict[str, Any]] = {}
    for record in records:
        direct_refs = _record_anchor_refs(record, index) & anchor_refs
        if not direct_refs:
            continue
        for field in ("source_ip", "destination_ip"):
            value = _text(record.get(field))
            if not value or f"ip:{value}" in result_index:
                continue
            candidates.setdefault(
                f"ip:{value}",
                {
                    "entity_type": "ip",
                    "role": "related",
                    "value": value,
                    "aliases": [],
                    "related_to": sorted(direct_refs),
                    "relation": "observed_network_endpoint_pair",
                    "valid_during": list(time_range),
                    "provenance": ["contributing_alert"],
                },
            )
        user_name = _text(_mapping(record.get("user")).get("name"))
        if user_name:
            for anchor_ref in sorted(direct_refs):
                key = f"user:{anchor_ref}:{user_name.casefold()}"
                candidates.setdefault(
                    key,
                    {
                        "entity_type": "user",
                        "role": "related",
                        "value": user_name,
                        "bound_asset_ref": anchor_ref,
                        "aliases": [],
                        "related_to": [anchor_ref],
                        "relation": "observed_asset_account",
                        "valid_during": list(time_range),
                        "provenance": ["contributing_alert"],
                    },
                )

    next_number = max(
        (
            int(str(entity.get("entity_ref", "E0"))[1:])
            for entity in result
            if str(entity.get("entity_ref", "")).startswith("E")
            and str(entity.get("entity_ref", ""))[1:].isdigit()
        ),
        default=0,
    )
    for key in sorted(candidates):
        next_number += 1
        entity = candidates[key]
        entity_ref = f"E{next_number}"
        entity["entity_ref"] = entity_ref
        result.append(entity)
        result_index[key] = entity_ref
        if entity["entity_type"] == "user" and f"user:{entity['value'].casefold()}" not in result_index:
            result_index[f"user:{entity['value'].casefold()}"] = entity_ref
    return result, result_index, {
        "related_entity_count": len(candidates),
        "recursive_expansion": False,
    }


def attach_entity_refs(
    records: Iterable[Mapping[str, Any]],
    index: Mapping[str, str],
    *,
    owner_refs: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Attach all related entities and, when unambiguous, the local owner.

    ``owner_refs`` contains the incident-declared anchors eligible to own local
    endpoint behaviour.  A record without an explicit affected asset is bound
    to a local owner only when exactly one endpoint maps to such an anchor.
    """

    eligible_owners = {str(value) for value in (owner_refs or set())}
    result: list[dict[str, Any]] = []
    for record in records:
        row = copy.deepcopy(dict(record))
        refs: set[str] = set()
        asset_id = _text(row.get("affected_asset_id"))
        if asset_id and (ref := index.get(f"asset:{asset_id}")):
            row["entity_ref"] = ref
            refs.add(ref)
        asset = _mapping(row.get("asset"))
        if not row.get("entity_ref"):
            for kind, value in (
                ("asset", _first(asset.get("id"), asset.get("asset_id"))),
                ("ip", asset.get("ip")),
                ("hostname", asset.get("hostname")),
            ):
                text = _text(value)
                if not text:
                    continue
                lookup = text.casefold() if kind == "hostname" else text
                if ref := index.get(f"{kind}:{lookup}"):
                    row["entity_ref"] = ref
                    refs.add(ref)
                    break
        for field, output_field in (
            ("source_ip", "source_entity_ref"),
            ("destination_ip", "destination_entity_ref"),
        ):
            value = _text(row.get(field))
            if value and (ref := index.get(f"ip:{value}")):
                row[output_field] = ref
                refs.add(ref)
        if not row.get("entity_ref") and eligible_owners:
            endpoint_owners = refs.intersection(eligible_owners)
            if len(endpoint_owners) == 1:
                row["entity_ref"] = next(iter(endpoint_owners))
        user_name = _text(_mapping(row.get("user")).get("name"))
        if user_name:
            scoped_key = (
                f"user:{row.get('entity_ref')}:{user_name.casefold()}"
                if row.get("entity_ref")
                else None
            )
            ref = result_index_ref = (
                index.get(scoped_key) if scoped_key else None
            ) or index.get(f"user:{user_name.casefold()}")
            if result_index_ref:
                row["user_entity_ref"] = result_index_ref
                refs.add(result_index_ref)
        row["entity_refs"] = sorted(refs)
        if len(refs) >= 2:
            row["relation_strength"] = "definite"
        result.append(row)
    return result


def _json_key(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _identity_key(record: Mapping[str, Any]) -> tuple[str, str]:
    for label, field in (
        ("raw_event_uid", "raw_event_uid"),
        ("source_record_id", "source_record_id"),
        ("edr_event_id", "edr_event_id"),
        ("raw_ref", "raw_ref"),
        ("raw_event_key", "raw_event_key"),
    ):
        if value := _text(record.get(field)):
            return label, value
    process = _mapping(record.get("process"))
    parent = _mapping(process.get("parent"))
    fingerprint = {
        "source": record.get("source"),
        "entity_ref": record.get("entity_ref"),
        "affected_asset_id": record.get("affected_asset_id"),
        "event_type": record.get("alert_type") or record.get("event_type"),
        "action": record.get("action") or record.get("native_result"),
        "process_uid": process.get("uid"),
        "process_pid": process.get("pid"),
        "process_path": process.get("path"),
        "process_cmdline": process.get("cmdline"),
        "parent_uid": parent.get("uid"),
        "source_ip": record.get("source_ip"),
        "source_port": record.get("source_port"),
        "destination_ip": record.get("destination_ip"),
        "destination_port": record.get("destination_port"),
        "protocol": record.get("protocol"),
        "user": _mapping(record.get("user")).get("name"),
        "event_time": record.get("event_time"),
    }
    digest = hashlib.sha256(_json_key(fingerprint).encode("utf-8")).hexdigest()
    return "fingerprint", digest


def deduplicate_records(
    records: Iterable[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    input_count = 0
    for raw in records:
        input_count += 1
        row = copy.deepcopy(dict(raw))
        identity = _identity_key(row)
        if identity not in grouped:
            row["record_key"] = f"{identity[0]}:{identity[1]}"
            row["alert_ids"] = sorted(
                {
                    str(value)
                    for value in [row.get("alert_id"), *_list(row.get("alert_ids"))]
                    if value not in (None, "")
                }
            )
            row["rule_ids"] = sorted(
                {
                    str(value)
                    for value in [row.get("rule_id"), *_list(row.get("rule_ids"))]
                    if value not in (None, "")
                }
            )
            grouped[identity] = row
            continue
        current = grouped[identity]
        current["alert_ids"] = sorted(
            set(current.get("alert_ids", []))
            | {
                str(value)
                for value in [row.get("alert_id"), *_list(row.get("alert_ids"))]
                if value not in (None, "")
            }
        )
        current["rule_ids"] = sorted(
            set(current.get("rule_ids", []))
            | {
                str(value)
                for value in [row.get("rule_id"), *_list(row.get("rule_ids"))]
                if value not in (None, "")
            }
        )
        for key, value in row.items():
            if current.get(key) in (None, "", [], {}) and value not in (None, "", [], {}):
                current[key] = value

    result = sorted(
        grouped.values(),
        key=lambda row: (
            parse_datetime_utc(row.get("event_time"))
            or datetime.min.replace(tzinfo=timezone.utc),
            str(row["record_key"]),
        ),
    )
    return result, {
        "input_count": input_count,
        "output_count": len(result),
        "duplicate_count": input_count - len(result),
    }


def _record_time(record: Mapping[str, Any]) -> datetime | None:
    return parse_datetime_utc(record.get("event_time"))


def _pid_link(parent: Mapping[str, Any], child: Mapping[str, Any], guard: timedelta) -> bool:
    if parent.get("entity_ref") != child.get("entity_ref"):
        return False
    parent_process = _mapping(parent.get("process"))
    child_process = _mapping(child.get("process"))
    if _text(parent_process.get("pid")) != _text(_mapping(child_process.get("parent")).get("pid")):
        return False
    parent_start = _record_time(parent)
    child_start = _record_time(child)
    if parent_start is None or child_start is None or child_start < parent_start:
        return False
    parent_end = parse_datetime_utc(parent_process.get("end_time"))
    return child_start <= parent_end if parent_end is not None else child_start - parent_start <= guard


def build_process_neighborhood(
    records: Iterable[Mapping[str, Any]],
    *,
    seed_record_keys: set[str],
    max_hops: int = 2,
    pid_reuse_guard_minutes: int = 30,
) -> set[str]:
    """Return records at most ``max_hops`` from alert process seeds."""

    rows = [dict(row) for row in records]
    by_key = {str(row.get("record_key")): row for row in rows if row.get("record_key")}
    adjacency: dict[str, set[str]] = defaultdict(set)
    guard = timedelta(minutes=pid_reuse_guard_minutes)
    for left_index, left in enumerate(rows):
        left_key = _text(left.get("record_key"))
        if not left_key:
            continue
        left_process = _mapping(left.get("process"))
        left_uid = _text(left_process.get("uid"))
        left_parent_uid = _text(_mapping(left_process.get("parent")).get("uid"))
        for right in rows[left_index + 1 :]:
            right_key = _text(right.get("record_key"))
            if not right_key or left.get("entity_ref") != right.get("entity_ref"):
                continue
            right_process = _mapping(right.get("process"))
            right_uid = _text(right_process.get("uid"))
            right_parent_uid = _text(_mapping(right_process.get("parent")).get("uid"))
            guid_link = bool(
                (left_uid and right_parent_uid == left_uid)
                or (right_uid and left_parent_uid == right_uid)
            )
            pid_link = _pid_link(left, right, guard) or _pid_link(right, left, guard)
            if guid_link or pid_link:
                adjacency[left_key].add(right_key)
                adjacency[right_key].add(left_key)

    visited = {key for key in seed_record_keys if key in by_key}
    queue = deque((key, 0) for key in sorted(visited))
    while queue:
        key, distance = queue.popleft()
        if distance >= max_hops:
            continue
        for neighbor in sorted(adjacency.get(key, set())):
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, distance + 1))
    return visited


def _record_entity_refs(record: Mapping[str, Any]) -> set[str]:
    values = {
        str(value)
        for value in _list(record.get("entity_refs"))
        if value not in (None, "")
    }
    if record.get("entity_ref"):
        values.add(str(record["entity_ref"]))
    for field in ("source_entity_ref", "destination_entity_ref", "user_entity_ref"):
        if record.get(field):
            values.add(str(record[field]))
    return values


def select_records(
    records: Iterable[Mapping[str, Any]],
    *,
    anchor_refs: set[str],
    process_linked_keys: set[str],
    budget: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Retain by relation strength, then earlier business time, within one budget."""

    rows = [dict(row) for row in records]

    def priority(row: Mapping[str, Any]) -> int:
        refs = _record_entity_refs(row)
        if len(refs & anchor_refs) >= 2:
            return 1
        if row.get("record_key") in process_linked_keys:
            return 2
        if row.get("relation_strength") == "definite" and refs & anchor_refs:
            return 3
        if refs & anchor_refs:
            return 4
        return 5

    ranked = sorted(
        rows,
        key=lambda row: (
            priority(row),
            _record_time(row) or datetime.max.replace(tzinfo=timezone.utc),
            str(row.get("record_key") or ""),
        ),
    )
    kept = ranked[: max(0, budget)]
    kept.sort(
        key=lambda row: (
            _record_time(row) or datetime.max.replace(tzinfo=timezone.utc),
            str(row.get("record_key") or ""),
        )
    )
    cutoff_candidates = [_record_time(row) for row in kept]
    cutoff = max((value for value in cutoff_candidates if value is not None), default=None)
    return kept, {
        "input_count": len(rows),
        "retained_count": len(kept),
        "dropped_count": len(rows) - len(kept),
        "cutoff_time": _iso(cutoff) if cutoff else None,
        "priority_counts": {
            str(level): sum(1 for row in rows if priority(row) == level)
            for level in range(1, 6)
        },
    }


def aggregate_repeated_behaviors(
    records: Iterable[Mapping[str, Any]], *, sample_limit: int = 3
) -> list[dict[str, Any]]:
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in records:
        process = _mapping(row.get("process"))
        user = _mapping(row.get("user"))
        signature = {
            "entity_ref": row.get("entity_ref"),
            "event_type": row.get("alert_type") or row.get("event_type"),
            "action": row.get("action") or row.get("native_result"),
            "process_path": process.get("path"),
            "process_cmdline": process.get("cmdline"),
            "user": user.get("name"),
            "destination_port": row.get("destination_port"),
            "protocol": row.get("protocol"),
        }
        groups[_json_key(signature)].append(row)

    result: list[dict[str, Any]] = []
    for signature_key, rows in groups.items():
        signature = json.loads(signature_key)
        times = sorted(
            value
            for value in (parse_datetime_utc(row.get("event_time")) for row in rows)
            if value is not None
        )
        targets = sorted(
            {
                str(row.get("destination_ip"))
                for row in rows
                if row.get("destination_ip") not in (None, "")
            }
        )
        result.append(
            {
                **{key: value for key, value in signature.items() if value not in (None, "")},
                "count": len(rows),
                "first_seen": _iso(times[0]) if times else None,
                "last_seen": _iso(times[-1]) if times else None,
                "distinct_targets": targets,
                "sample_record_ids": [
                    str(row.get("record_key")) for row in rows[:sample_limit]
                ],
                "alert_ids": sorted(
                    {
                        str(alert_id)
                        for row in rows
                        for alert_id in _list(row.get("alert_ids"))
                    }
                ),
                "rule_ids": sorted(
                    {
                        str(rule_id)
                        for row in rows
                        for rule_id in _list(row.get("rule_ids"))
                    }
                ),
            }
        )
    return sorted(
        result,
        key=lambda row: (str(row.get("first_seen") or ""), _json_key(row)),
    )


def build_forward_slices(
    start: str, end: str, *, max_slices: int = 12
) -> list[tuple[str, str]]:
    start_time = parse_datetime_utc(start)
    end_time = parse_datetime_utc(end)
    if start_time is None or end_time is None or end_time < start_time:
        raise ValueError("invalid effective time range")
    if max_slices < 1:
        raise ValueError("max_slices must be positive")
    if start_time == end_time:
        return [(_iso(start_time), _iso(end_time))]
    duration = end_time - start_time
    slice_count = min(max_slices, max(1, int(duration.total_seconds() // 3600) + 1))
    width = duration / slice_count
    result: list[tuple[str, str]] = []
    cursor = start_time
    for index in range(slice_count):
        slice_end = end_time if index == slice_count - 1 else start_time + width * (index + 1)
        result.append((_iso(cursor), _iso(slice_end)))
        cursor = slice_end
    return result

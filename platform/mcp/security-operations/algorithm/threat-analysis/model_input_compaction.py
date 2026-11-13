#!/usr/bin/env python3
"""Deterministically compact five-source evidence for the judgement model.

The audit artefacts remain unchanged.  This projection only removes repeated
provenance identifiers from the model-facing package and turns observed
network endpoint pairs into concise host-to-host path hints.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _nonempty(value: Any) -> bool:
    return value not in (None, "", [], {})


def _sparse(value: Any) -> Any:
    if isinstance(value, Mapping):
        compact = {str(key): _sparse(item) for key, item in value.items()}
        return {key: item for key, item in compact.items() if _nonempty(item)}
    if isinstance(value, list):
        compact = [_sparse(item) for item in value]
        return [item for item in compact if _nonempty(item)]
    return value


def _stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _unique(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        current = _sparse(dict(row))
        if current:
            result[_stable(current)] = current
    return list(result.values())


def _endpoint_entity_index(
    entities: Iterable[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in entities:
        entity_ref = entity.get("entity_ref")
        if entity_ref in (None, ""):
            continue
        ips: set[str] = set()
        hostname = None
        if entity.get("entity_type") == "ip" and entity.get("value") not in (None, ""):
            ips.add(str(entity["value"]))
        for alias in _list(entity.get("aliases")):
            current = _mapping(alias)
            value = current.get("value")
            if value in (None, ""):
                continue
            if current.get("type") == "ip":
                ips.add(str(value))
            elif current.get("type") == "hostname" and hostname is None:
                hostname = str(value)
        descriptor = _sparse(
            {
                "ref": str(entity_ref),
                "asset_id": entity.get("asset_id"),
                "host": hostname,
                "role": entity.get("role"),
                "entity_type": entity.get("entity_type"),
            }
        )
        for ip in ips:
            candidates[ip].append(descriptor)
    return {
        ip: sorted(
            rows,
            key=lambda row: (
                row.get("role") != "anchor",
                row.get("entity_type") != "asset",
                str(row.get("ref") or ""),
            ),
        )[0]
        for ip, rows in candidates.items()
    }


def _network_metadata(edr_detail: Mapping[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for entity in _list(edr_detail.get("entities")):
        for segment in _list(_mapping(entity).get("activity_segments")):
            for row in _list(_mapping(segment).get("network_details")):
                current = _mapping(row)
                source_ip = current.get("source_ip")
                destination_ip = current.get("destination_ip")
                if source_ip in (None, "") or destination_ip in (None, ""):
                    continue
                key = (str(source_ip), str(destination_ip))
                group = groups.setdefault(
                    key,
                    {"protocols": set(), "times": []},
                )
                if current.get("protocol") not in (None, ""):
                    group["protocols"].add(str(current["protocol"]))
                for field in ("observed_at", "first_seen", "last_seen"):
                    if current.get(field) not in (None, ""):
                        group["times"].append(str(current[field]))
                for value in _list(current.get("time_range")):
                    if value not in (None, ""):
                        group["times"].append(str(value))
    return groups


def _compact_hosts(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return _unique(
        _sparse(
            {
                "entity_ref": row.get("entity_ref"),
                "asset_id": row.get("asset_id"),
                "hostname": row.get("hostname"),
                "ip": row.get("ip"),
                "direction": row.get("direction"),
            }
        )
        for row in rows
        if row.get("relation") != "observed_network_endpoint_pair"
    )


def _compact_users(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return _unique(
        _sparse(
            {
                "entity_ref": row.get("entity_ref"),
                "name": row.get("name") or row.get("account") or row.get("username"),
                "privilege": row.get("privilege"),
                "role": row.get("role"),
            }
        )
        for row in rows
    )


def _compact_paths(
    graph: Mapping[str, Any],
    entities: Iterable[Mapping[str, Any]],
    edr_detail: Mapping[str, Any],
) -> list[dict[str, Any]]:
    def is_self_relation(row: Mapping[str, Any]) -> bool:
        source_ref = row.get("src_ref")
        destination_ref = row.get("dst_ref")
        if source_ref not in (None, "") and source_ref == destination_ref:
            return True
        source_asset = row.get("src_asset_id")
        destination_asset = row.get("dst_asset_id")
        if source_asset not in (None, "") and source_asset == destination_asset:
            return True
        source_ip = row.get("src_ip")
        destination_ip = row.get("dst_ip")
        return source_ip not in (None, "") and source_ip == destination_ip

    existing = [
        dict(row)
        for row in _list(graph.get("path_hints"))
        if isinstance(row, Mapping) and row.get("src_ip") and row.get("dst_ip")
    ]
    if existing:
        return _unique(row for row in existing if not is_self_relation(row))
    endpoint_pairs = [
        row
        for row in _list(graph.get("related_hosts"))
        if isinstance(row, Mapping)
        and row.get("relation") == "observed_network_endpoint_pair"
    ]
    entity_index = _endpoint_entity_index(entities)
    network_index = _network_metadata(edr_detail)
    result: list[dict[str, Any]] = []
    for pair in endpoint_pairs:
        source_ip = pair.get("source_ip")
        destination_ip = pair.get("destination_ip")
        if source_ip in (None, "") or destination_ip in (None, ""):
            continue
        source_ip = str(source_ip)
        destination_ip = str(destination_ip)
        source = entity_index.get(source_ip, {})
        destination = entity_index.get(destination_ip, {})
        network = network_index.get((source_ip, destination_ip), {})
        times = sorted(set(network.get("times") or []))
        path = _sparse(
            {
                    "src_ref": source.get("ref"),
                    "src_asset_id": source.get("asset_id"),
                    "src_host": source.get("host"),
                    "src_ip": source_ip,
                    "dst_ref": destination.get("ref"),
                    "dst_asset_id": destination.get("asset_id"),
                    "dst_host": destination.get("host"),
                    "dst_ip": destination_ip,
                    "protocols": sorted(network.get("protocols") or []),
                    "dst_ports": pair.get("destination_ports"),
                    "count": pair.get("observation_count"),
                    "time_range": [times[0], times[-1]] if times else None,
                    "basis": "event",
            }
        )
        if not is_self_relation(path):
            result.append(path)
    return _unique(result)


def _legacy_action(row: Mapping[str, Any]) -> Any:
    if row.get("action") not in (None, ""):
        return row.get("action")
    alert_ids = [str(value) for value in _list(row.get("alert_ids"))]
    if alert_ids and all(value.startswith("event:") for value in alert_ids):
        return row.get("event_type")
    return None


def _sorted_text(values: Iterable[Any]) -> list[str]:
    return sorted({str(value) for value in values if value not in (None, "")})


def _entity_display(row: Mapping[str, Any]) -> str | None:
    """Build a readable identity without exposing the internal E-number key."""

    def first(*fields: str) -> str | None:
        for field in fields:
            value = row.get(field)
            values = value if isinstance(value, list) else [value]
            normalized = _sorted_text(values)
            if normalized:
                return normalized[0]
        return None

    entity_type = str(row.get("entity_type") or "")
    hostname = first("hostname", "hostnames")
    ip = first("ip", "ips")
    name = first("name", "names")
    value = first("value", "values")
    asset_id = first("asset_id")

    if entity_type == "asset":
        head = hostname or ip or name or value
        qualifiers: list[str] = []
        if hostname and ip:
            qualifiers.append(ip)
        if asset_id:
            qualifiers.append(f"资产ID {asset_id}")
        if head and qualifiers:
            return f"{head}（{'，'.join(qualifiers)}）"
        if head:
            return head
        return f"资产ID {asset_id}" if asset_id else None
    if entity_type == "ip":
        return ip or value
    if entity_type in {"user", "account"}:
        return name or value
    if entity_type == "hostname":
        return hostname or value
    return hostname or ip or name or value or (f"资产ID {asset_id}" if asset_id else None)


def _compact_entity(row: Mapping[str, Any]) -> dict[str, Any]:
    aliases: dict[str, list[str]] = defaultdict(list)
    for alias in _list(row.get("aliases")):
        current = _mapping(alias)
        alias_type = current.get("type")
        value = current.get("value")
        if alias_type not in (None, "") and value not in (None, ""):
            aliases[str(alias_type)].append(str(value))
    entity_type = str(row.get("entity_type") or "")
    value = row.get("value")
    if value not in (None, ""):
        if entity_type == "ip":
            aliases["ip"].append(str(value))
        elif entity_type == "hostname":
            aliases["hostname"].append(str(value))
        elif entity_type in {"user", "account"}:
            aliases["name"].append(str(value))
        else:
            aliases["value"].append(str(value))
    for singular in ("ip", "hostname", "name", "value"):
        if singular == "value" and entity_type in {"ip", "hostname", "user", "account"}:
            continue
        direct = row.get(singular)
        if direct not in (None, ""):
            aliases[singular].append(str(direct))
        aliases[singular].extend(_list(row.get(f"{singular}s")))

    compact = {
        "entity_ref": row.get("entity_ref"),
        "entity_type": row.get("entity_type"),
        "role": row.get("role"),
        "asset_id": row.get("asset_id"),
        "bound_asset_ref": row.get("bound_asset_ref"),
        "related_to": row.get("related_to"),
    }
    for alias_type, values in aliases.items():
        unique = _sorted_text(values)
        if not unique:
            continue
        singular = {
            "ip": "ip",
            "hostname": "hostname",
            "name": "name",
            "value": "value",
        }.get(alias_type)
        if singular is None:
            continue
        compact[singular if len(unique) == 1 else f"{singular}s"] = (
            unique[0] if len(unique) == 1 else unique
        )
    compact["entity_display"] = _entity_display(compact)
    return _sparse(compact)


def _observed_time(row: Mapping[str, Any]) -> dict[str, Any]:
    if row.get("observed_at") not in (None, ""):
        return {"observed_at": row.get("observed_at")}
    elif _list(row.get("time_range")):
        return {"time_range": row.get("time_range")}
    elif row.get("first_seen") and row.get("first_seen") == row.get("last_seen"):
        return {"observed_at": row.get("first_seen")}
    elif row.get("first_seen") or row.get("last_seen"):
        return {"time_range": [row.get("first_seen"), row.get("last_seen")]}
    return {}


def _normalized_image(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip().replace("\\", "/").lower() or None


def _image_aliases(value: Any) -> list[str]:
    normalized = _normalized_image(value)
    if not normalized:
        return []
    basename = normalized.rsplit("/", 1)[-1]
    return [f"image:{normalized}", f"basename:{basename}"]


def _uid_values(row: Mapping[str, Any]) -> list[str]:
    values = [*_list(row.get("process_uids")), row.get("process_uid")]
    return _sorted_text(values)


class _ProcessRegistry:
    def __init__(self) -> None:
        self.nodes: list[dict[str, Any]] = []
        self._by_ref: dict[str, dict[str, Any]] = {}
        self._aliases: dict[str, str | None] = {}

    def _lookup_aliases(self, aliases: Iterable[str]) -> str | None:
        refs = {self._aliases.get(alias) for alias in aliases}
        refs.discard(None)
        if len(refs) == 1:
            return next(iter(refs))
        return None

    def lookup(self, row: Mapping[str, Any]) -> str | None:
        uids = _uid_values(row)
        if uids:
            return self._lookup_aliases(f"uid:{value}" for value in uids)
        if row.get("pid") not in (None, ""):
            ref = self._lookup_aliases([f"pid:{row['pid']}"])
            if ref:
                return ref
        return self._lookup_aliases(_image_aliases(row.get("image") or row.get("process_image")))

    def _bind_alias(self, alias: str, ref: str) -> None:
        if alias not in self._aliases:
            self._aliases[alias] = ref
        elif self._aliases[alias] != ref:
            self._aliases[alias] = None

    def ensure(self, row: Mapping[str, Any], *, parent_only: bool = False) -> str | None:
        if not any(
            _nonempty(row.get(field))
            for field in ("image", "process_image", "cmdline", "process_uid", "process_uids", "pid")
        ):
            return None
        ref = self.lookup(row)
        if (
            ref is not None
            and not _uid_values(row)
            and row.get("pid") in (None, "")
            and row.get("cmdline") not in (None, "")
            and self._by_ref[ref].get("cmdline") not in (None, "")
            and str(row["cmdline"]) != str(self._by_ref[ref]["cmdline"])
        ):
            # An image name is only a weak lookup key.  Distinct command lines
            # without a UID/PID must remain separate so later image-only rows
            # become ambiguous instead of acquiring a fabricated process edge.
            ref = None
        if ref is None:
            ref = f"P{len(self.nodes) + 1:03d}"
            node = {"ref": ref}
            self.nodes.append(node)
            self._by_ref[ref] = node
        node = self._by_ref[ref]
        values = {
            "image": row.get("image") or row.get("process_image"),
            "cmdline": row.get("cmdline"),
            "user": row.get("user"),
            "native_result": row.get("native_result"),
            "action": _legacy_action(row),
            "count": row.get("count") if row.get("count") not in (None, 1) else None,
            **_observed_time(row),
        }
        if parent_only:
            values = {key: value for key, value in values.items() if key in {"image", "cmdline"}}
        for key, value in values.items():
            if _nonempty(value) and not _nonempty(node.get(key)):
                node[key] = value

        for uid in _uid_values(row):
            self._bind_alias(f"uid:{uid}", ref)
        if row.get("pid") not in (None, ""):
            self._bind_alias(f"pid:{row['pid']}", ref)
        for alias in _image_aliases(row.get("image") or row.get("process_image")):
            self._bind_alias(alias, ref)
        return ref


def _collect_segment_metadata(segment: Mapping[str, Any]) -> tuple[list[str], str | None]:
    sources: list[Any] = [*_list(segment.get("source_types"))]
    users: list[str] = []
    for field in (
        "process_activities",
        "processes",
        "file_operations",
        "network_details",
        "authentication_activities",
        "other_activities",
    ):
        for row in _list(segment.get(field)):
            current = _mapping(row)
            sources.extend(_list(current.get("sources")))
            if current.get("user") not in (None, ""):
                users.append(str(current["user"]))
    unique_users = _sorted_text(users)
    return _sorted_text(sources), unique_users[0] if len(unique_users) == 1 else None


def _compact_related_activity(
    row: Mapping[str, Any],
    *,
    kind: str,
    registry: _ProcessRegistry,
    owner_ips: set[str],
    default_user: str | None,
) -> dict[str, Any]:
    process_ref = row.get("process_ref") or registry.lookup(row)
    process_image = None if process_ref else row.get("process_image")
    common = {
        "process_ref": process_ref,
        "process_image": process_image,
        "count": row.get("count") if row.get("count") not in (None, 1) else None,
        **_observed_time(row),
    }
    if kind == "file_operations":
        values = {
            "path": row.get("path"),
            "operation": row.get("operation"),
            "hashes": row.get("hashes"),
            **common,
        }
    elif kind == "network_details":
        source_ip = row.get("source_ip")
        values = {
            "source_ip": source_ip if str(source_ip or "") not in owner_ips else None,
            "source_port": row.get("source_port"),
            "destination_ip": row.get("destination_ip"),
            "destination_port": row.get("destination_port"),
            "protocol": row.get("protocol"),
            "network_session_id": row.get("network_session_id"),
            "disposition": row.get("disposition"),
            **common,
        }
    elif kind == "authentication_activities":
        values = {
            "user": row.get("user") if row.get("user") != default_user else None,
            "session_id": row.get("session_id"),
            "result": row.get("result"),
            "source_ip": row.get("source_ip"),
            "destination_ip": row.get("destination_ip"),
            "event_type": row.get("event_type"),
            "count": common.get("count"),
            **_observed_time(row),
        }
    else:
        values = {
            "event_type": row.get("event_type"),
            "request_path": row.get("request_path"),
            "disposition": row.get("disposition"),
            "count": common.get("count"),
            **_observed_time(row),
        }
    return _sparse(values)


def _compact_segment(segment: Mapping[str, Any], owner_ips: set[str]) -> dict[str, Any]:
    sources, default_user = _collect_segment_metadata(segment)
    registry = _ProcessRegistry()

    existing_processes = [
        row for row in _list(segment.get("processes")) if isinstance(row, Mapping)
    ]
    if existing_processes and not _list(segment.get("process_activities")):
        registry.nodes = [_sparse(dict(row)) for row in existing_processes]
        registry._by_ref = {
            str(row["ref"]): row for row in registry.nodes if row.get("ref") not in (None, "")
        }
        for row in registry.nodes:
            for alias in _image_aliases(row.get("image")):
                registry._bind_alias(alias, str(row.get("ref")))
    else:
        for raw in _list(segment.get("process_activities")):
            row = _mapping(raw)
            parent = _mapping(row.get("parent"))
            parent_ref = registry.ensure(parent, parent_only=True)
            process_ref = registry.ensure(row)
            if process_ref and parent_ref and process_ref != parent_ref:
                registry._by_ref[process_ref]["parent_ref"] = parent_ref

    if default_user:
        for node in registry.nodes:
            if node.get("user") == default_user:
                node.pop("user", None)

    compact = {
        "segment_id": segment.get("segment_id"),
        "scope": segment.get("scope"),
        "time_range": segment.get("time_range"),
        "default_user": default_user,
        "source_types": sources,
        "processes": registry.nodes,
    }
    for kind in (
        "file_operations",
        "network_details",
        "authentication_activities",
        "other_activities",
    ):
        compact[kind] = [
            current
            for current in (
                _compact_related_activity(
                    _mapping(row),
                    kind=kind,
                    registry=registry,
                    owner_ips=owner_ips,
                    default_user=default_user,
                )
                for row in _list(segment.get(kind))
            )
            if current
        ]
    return _sparse(compact)


MODEL_PROVENANCE_FIELDS = {
    "rule_id",
    "rule_ids",
    "rule_id_count",
    "alert_ids",
    "alert_id_count",
    "sample_record_ids",
}


def _remove_model_provenance(value: Any) -> Any:
    """Remove audit-only identifiers while retaining sourced behavior facts."""

    if isinstance(value, Mapping):
        return {
            str(key): _remove_model_provenance(item)
            for key, item in value.items()
            if key not in MODEL_PROVENANCE_FIELDS
        }
    if isinstance(value, list):
        return [_remove_model_provenance(item) for item in value]
    return value


def _entity_ips(entity: Mapping[str, Any]) -> set[str]:
    values = [entity.get("ip"), *_list(entity.get("ips"))]
    return {str(value) for value in values if value not in (None, "")}


def compact_five_source_output(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return an idempotent model-facing projection of one five-source package."""

    output = copy.deepcopy(dict(payload))
    snapshot = dict(_mapping(output.get("event_snapshot")))
    context = _mapping(output.get("enriched_context"))
    graph = dict(_mapping(context.get("graph")))
    edr_detail = dict(_mapping(context.get("edr_detail")))
    audit_entities = [row for row in _list(snapshot.get("entities")) if isinstance(row, Mapping)]
    entities = [_compact_entity(row) for row in audit_entities]
    snapshot["entities"] = entities
    output["event_snapshot"] = snapshot

    graph["path_hints"] = _compact_paths(graph, audit_entities, edr_detail)
    graph["related_hosts"] = _compact_hosts(
        row for row in _list(graph.get("related_hosts")) if isinstance(row, Mapping)
    )
    graph["related_users"] = _compact_users(
        row for row in _list(graph.get("related_users")) if isinstance(row, Mapping)
    )
    graph = _remove_model_provenance(graph)

    entity_index = {
        str(entity.get("entity_ref")): entity
        for entity in entities
        if entity.get("entity_ref") not in (None, "")
    }
    compact_edr_entities: list[dict[str, Any]] = []
    for entity in _list(edr_detail.get("entities")):
        if not isinstance(entity, Mapping):
            continue
        entity_ref = str(entity.get("entity_ref") or "")
        owner_ips = _entity_ips(entity_index.get(entity_ref, {}))
        segments = [
            _compact_segment(segment, owner_ips)
            for segment in _list(entity.get("activity_segments"))
            if isinstance(segment, Mapping)
        ]
        segments = [segment for segment in segments if segment]
        if segments:
            compact_edr_entities.append(
                _sparse(
                    {
                        "entity_ref": entity_ref,
                        "entity_display": entity_index.get(entity_ref, {}).get(
                            "entity_display"
                        ),
                        "activity_segments": segments,
                    }
                )
            )
    edr_detail["entities"] = compact_edr_entities

    context = dict(context)
    context["graph"] = graph
    context["edr_detail"] = edr_detail
    output["enriched_context"] = context
    return output


def _dump_atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(args.input).resolve()
    destination = Path(args.output).resolve()
    payload = json.loads(source.read_text(encoding="utf-8"))
    _dump_atomic(destination, compact_five_source_output(payload))
    print(destination)


if __name__ == "__main__":
    main()

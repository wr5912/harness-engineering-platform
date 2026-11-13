"""Deterministic normalization for incident alerts.

The functions in this module deliberately avoid semantic threat reasoning.  They
only extract stable fields from incident alerts and event-store records.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Mapping



def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _first_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                return item
    return {}


def _first(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _path(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _strings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item not in (None, "")]
    if value in (None, ""):
        return []
    return [str(value)]


def _parse_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def extract_alert_ids(incident: Mapping[str, Any]) -> list[str]:
    """Return contributing alert IDs in source order without duplicates."""

    candidates = _first(
        incident.get("contributingAlertsJson"),
        incident.get("contributing_alerts_json"),
        incident.get("contributingAlerts"),
        incident.get("contributing_alerts"),
    )
    candidates = _parse_json(candidates)
    if isinstance(candidates, Mapping):
        candidates = _first(candidates.get("items"), candidates.get("alerts"))
    if not isinstance(candidates, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        if isinstance(item, Mapping):
            value = _first(item.get("alertId"), item.get("alert_id"), item.get("id"))
        else:
            value = item
        if value is None:
            continue
        alert_id = str(value)
        if alert_id not in seen:
            seen.add(alert_id)
            result.append(alert_id)
    return result


def parse_datetime_utc(value: Any) -> datetime | None:
    """Parse timestamps from SOC sources, truncating sub-microsecond precision."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    text = str(value).strip()
    text = re.sub(r"(\.\d{6})\d+(?=Z$|[+-]\d{2}:?\d{2}$)", r"\1", text)
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso_utc(value: Any) -> str | None:
    if value is None or value == "":
        return None
    parsed = parse_datetime_utc(value)
    if parsed is None:
        return str(value).strip()
    return parsed.isoformat().replace("+00:00", "Z")


def normalize_alert(alert: Mapping[str, Any]) -> dict[str, Any]:
    """Extract only stable, directly sourced alert and raw-record fields."""

    ocsf = _mapping(alert.get("ocsf"))
    evidence = _first_mapping(ocsf.get("evidences"))
    triggering_event = _mapping(alert.get("triggering_event"))
    raw = _mapping(triggering_event.get("raw"))
    embedded = _mapping(_parse_json(ocsf.get("raw_data")))
    raw_eventdata = _mapping(
        _first(
            _path(embedded, "data", "win", "eventdata"),
            _path(raw, "data", "win", "eventdata"),
            _path(embedded, "win", "eventdata"),
        )
    )
    src_endpoint = _mapping(
        _first(evidence.get("src_endpoint"), ocsf.get("src_endpoint"))
    )
    dst_endpoint = _mapping(
        _first(evidence.get("dst_endpoint"), ocsf.get("dst_endpoint"))
    )
    evidence_data = _mapping(evidence.get("data"))
    safeline = _mapping(_mapping(ocsf.get("unmapped")).get("safeline"))
    source = str(_first(alert.get("source"), "UNKNOWN"))
    device = _mapping(ocsf.get("device"))
    asset_id = _first(
        alert.get("affected_asset_id"),
        _path(device, "asset", "uid"),
        embedded.get("asset_id"),
    )
    raw_id = _first(
        alert.get("triggering_event_id"),
        triggering_event.get("id"),
        raw.get("id"),
        raw.get("event_id"),
        raw_eventdata.get("eventRecordID"),
        raw_eventdata.get("eventRecordId"),
    )
    alert_id = str(_first(alert.get("alert_id"), alert.get("id"), ""))
    raw_event_key = (
        f"{source}:{asset_id if asset_id is not None else '-'}:{raw_id}"
        if raw_id is not None
        else f"ALERT:{alert_id}"
    )

    actor = _mapping(evidence.get("actor"))
    actor_process = _mapping(actor.get("process"))
    ocsf_process = _mapping(ocsf.get("process"))
    process = actor_process or ocsf_process
    process_file = _mapping(process.get("file"))
    parent = _mapping(
        _first(process.get("parent_process"), process.get("parent"))
    )
    parent_file = _mapping(parent.get("file"))
    actor_user = _mapping(_first(process.get("user"), actor.get("user")))
    process_path = _first(
        process.get("path"),
        process_file.get("path"),
        raw_eventdata.get("image"),
        _path(embedded, "edr", "process_file_path"),
    )
    parent_path = _first(
        parent.get("path"),
        parent_file.get("path"),
        raw_eventdata.get("parentImage"),
        _path(embedded, "edr", "parent_process_file_path"),
    )
    process_info = {
        "uid": _first(
            process.get("uid"),
            process.get("guid"),
            raw_eventdata.get("processGuid"),
        ),
        "pid": _first(
            process.get("pid"),
            raw_eventdata.get("processId"),
            _path(embedded, "edr", "process_pid"),
        ),
        "name": _first(
            process.get("name"),
            process_file.get("name"),
            str(process_path).replace("/", "\\").rsplit("\\", 1)[-1]
            if process_path
            else None,
        ),
        "path": process_path,
        "cmdline": _first(
            process.get("cmd_line"),
            process.get("cmdline"),
            process.get("command_line"),
            raw_eventdata.get("commandLine"),
        ),
        "parent": {
            "uid": _first(
                parent.get("uid"),
                parent.get("guid"),
                raw_eventdata.get("parentProcessGuid"),
            ),
            "pid": _first(
                parent.get("pid"),
                raw_eventdata.get("parentProcessId"),
                _path(embedded, "edr", "parent_process_pid"),
            ),
            "name": _first(
                parent.get("name"),
                parent_file.get("name"),
                str(parent_path).replace("/", "\\").rsplit("\\", 1)[-1]
                if parent_path
                else None,
            ),
            "path": parent_path,
            "cmdline": _first(
                parent.get("cmd_line"),
                parent.get("cmdline"),
                parent.get("command_line"),
                raw_eventdata.get("parentCommandLine"),
            ),
        },
    }
    user_name = _first(
        actor_user.get("name"),
        actor_user.get("uid"),
        raw_eventdata.get("user"),
        _path(embedded, "edr", "process_user"),
    )
    target_file = _first(
        raw_eventdata.get("targetFilename"),
        raw_eventdata.get("targetFileName"),
        evidence_data.get("file_path"),
    )
    file_operations = []
    if target_file:
        file_operations.append(
            {
                "path": target_file,
                "operation": _first(
                    evidence_data.get("operation"),
                    alert.get("alert_type"),
                    ocsf.get("activity_name"),
                ),
                "hashes": _strings(raw_eventdata.get("hashes")),
            }
        )

    return {
        "alert_id": alert_id,
        "source_record_id": str(raw_id) if raw_id is not None else None,
        "raw_event_key": raw_event_key,
        "source": source,
        "event_time": _iso_utc(
            _first(
                _path(embedded, "metadata", "original_time"),
                _path(ocsf, "metadata", "original_time"),
                raw_eventdata.get("utcTime"),
                raw_eventdata.get("systemTime"),
                raw.get("timestamp"),
                _mapping(ocsf.get("finding_info")).get("created_time"),
                ocsf.get("time"),
                alert.get("created_at"),
            )
        ),
        "alert_type": _first(alert.get("alert_type"), alert.get("alert_type_code")),
        "severity": alert.get("severity"),
        "rule_id": _first(alert.get("rule_id"), raw.get("rule_id"), evidence_data.get("rule_id")),
        "source_ip": _first(
            alert.get("source_ip"),
            src_endpoint.get("ip"),
            raw.get("src_ip"),
        ),
        "destination_ip": _first(
            alert.get("destination_ip"),
            dst_endpoint.get("ip"),
            raw.get("host"),
            raw_eventdata.get("destinationIp"),
        ),
        "source_port": _first(src_endpoint.get("port"), raw.get("src_port")),
        "destination_port": _first(
            dst_endpoint.get("port"),
            raw.get("dst_port"),
            raw_eventdata.get("destinationPort"),
        ),
        "protocol": _first(
            _path(ocsf, "connection_info", "protocol_name"),
            raw_eventdata.get("protocol"),
            raw.get("protocol"),
        ),
        "network_session_id": _first(
            _path(ocsf, "connection_info", "uid"),
            _path(ocsf, "connection_info", "session_id"),
            evidence_data.get("network_session_id"),
            evidence_data.get("flow_id"),
            raw.get("network_session_id"),
            raw.get("flow_id"),
        ),
        "authentication_session_id": _first(
            evidence_data.get("authentication_session_id"),
            evidence_data.get("logon_id"),
            raw_eventdata.get("logonGuid"),
            raw_eventdata.get("targetLogonId"),
            raw_eventdata.get("subjectLogonId"),
            raw.get("authentication_session_id"),
        ),
        "native_result": _first(
            evidence_data.get("result"),
            evidence_data.get("outcome"),
            raw_eventdata.get("result"),
            raw_eventdata.get("status"),
            raw.get("result"),
            raw.get("outcome"),
        ),
        "affected_asset_id": asset_id,
        "asset": {
            "id": asset_id,
            "hostname": _first(device.get("hostname"), device.get("name")),
            "ip": device.get("ip"),
        },
        "user": {"name": user_name} if user_name else {},
        "process": process_info,
        "file_operations": file_operations,
        "request_path": _first(evidence_data.get("url_path"), raw.get("url_path")),
        "disposition": _first(safeline.get("disposition"), raw.get("action")),
        "techniques": sorted(set(_strings(alert.get("technique")))),
    }


def normalize_event_hit(hit: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize one event-store hit through the same source-neutral path."""

    source = _mapping(hit.get("_source")) or _mapping(hit.get("source")) or hit
    ocsf = _mapping(source.get("ocsf"))
    event_id = _first(hit.get("_id"), hit.get("id"), source.get("id"))
    device = _mapping(ocsf.get("device"))
    return normalize_alert(
        {
            "alert_id": f"event:{event_id}",
            "source": _first(
                _path(ocsf, "metadata", "product", "name"),
                hit.get("_index"),
                source.get("source"),
                "event_store",
            ),
            "created_at": _first(
                _path(ocsf, "metadata", "original_time"),
                source.get("@timestamp"),
                ocsf.get("time"),
            ),
            "affected_asset_id": _path(device, "asset", "uid"),
            "triggering_event_id": event_id,
            "alert_type": _first(ocsf.get("activity_name"), ocsf.get("class_name")),
            "ocsf": ocsf,
            "triggering_event": {"raw": source},
        }
    )

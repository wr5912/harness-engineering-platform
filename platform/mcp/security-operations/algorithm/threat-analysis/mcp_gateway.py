"""固定研判流程到本轮本机 MCP bridge 的最小客户端。"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from fusion_contract import CallOutcome


# 状态与报告入口保留固定 allowlist；取证路由由 Node bridge 动态映射并预检。
FIXED_RUNTIME_TOOLS = frozenset(
    {
        ("ai_soc_correlate", "ai_soc_correlate__get_correlate_incident_judge_pending"),
        ("ai_soc_correlate", "ai_soc_correlate__create_incident_judgement_claim"),
        ("ai_soc_correlate", "ai_soc_correlate__update_incident_judgement_result"),
        ("ai_soc_correlate", "ai_soc_correlate__create_correlate_incident_judgement_fail"),
        ("report-write", "save_persistence_result"),
    }
)


@dataclass(frozen=True)
class McpCallResult:
    outcome: CallOutcome
    data: Any
    result_count: int | None
    latency_ms: int
    raw_response_file: str
    response: Mapping[str, Any]


def extract_result_data(response: Mapping[str, Any]) -> Any:
    result = response.get("result")
    if isinstance(result, Mapping) and "data" in result:
        return result.get("data")
    return result


def _is_empty_data(data: Any) -> bool:
    if data is None or data == [] or data == {} or data == "":
        return True
    if isinstance(data, Mapping) and isinstance(data.get("items"), list):
        if data["items"]:
            return False
        total = data.get("total")
        return total in (None, 0, "0")
    if isinstance(data, Mapping) and "total" in data:
        total = data.get("total")
        if total in (0, "0"):
            hits = data.get("hits")
            return hits in (None, [])
    return False


def classify_response(response: Mapping[str, Any]) -> CallOutcome:
    status = str(response.get("status", "")).lower()
    status_code = response.get("status_code")
    result = response.get("result")
    inner_code = result.get("code") if isinstance(result, Mapping) else None
    if status not in {"success", "ok"}:
        return CallOutcome.FAILED
    if status_code not in (None, 200, "200") or inner_code not in (None, 200, "200"):
        return CallOutcome.FAILED
    if isinstance(result, Mapping) and result.get("_truncated") is True:
        return CallOutcome.TRUNCATED
    return (
        CallOutcome.SUCCESS_EMPTY
        if _is_empty_data(extract_result_data(response))
        else CallOutcome.SUCCESS_WITH_DATA
    )


def result_count(data: Any) -> int | None:
    if data is None:
        return 0
    if isinstance(data, list):
        return len(data)
    if isinstance(data, Mapping):
        total = data.get("total")
        if isinstance(total, int):
            return total
        if isinstance(total, str) and total.isdigit():
            return int(total)
        items = data.get("items")
        if isinstance(items, list):
            return len(items)
        return 0 if not data else 1
    return 1


def _default_transport(
    endpoint: str,
    payload: Mapping[str, Any],
    timeout: int,
    *,
    bearer_token: str | None = None,
) -> Any:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        parsed.setdefault("status", "error")
        parsed.setdefault("status_code", error.code)
        return parsed
    except urllib.error.URLError as error:
        return {
            "status": "error",
            "status_code": None,
            "error_type": type(error.reason).__name__,
        }
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {
            "status": "error",
            "status_code": None,
            "error_type": "UNPARSEABLE_RESPONSE",
        }


class McpGateway:
    def __init__(
        self,
        *,
        bridge_url: str,
        bridge_key: str,
        raw_directory: Path,
        transport: Callable[[str, Mapping[str, Any], int], Any] | None = None,
        timeout: int = 120,
    ) -> None:
        if not isinstance(bridge_url, str) or not bridge_url.strip():
            raise ValueError("missing threat-analysis bridge URL")
        if not isinstance(bridge_key, str) or not bridge_key:
            raise ValueError("missing threat-analysis bridge key")
        self.bridge_url = bridge_url.rstrip("/")
        self.bridge_key = bridge_key
        self.raw_directory = raw_directory
        self.transport = transport or (
            lambda endpoint, payload, request_timeout: _default_transport(
                endpoint,
                payload,
                request_timeout,
                bearer_token=self.bridge_key,
            )
        )
        self.timeout = timeout

    def _invoke_bridge(
        self,
        resource: str,
        tool_name: str,
        arguments: Mapping[str, Any],
        timeout: int | None = None,
    ) -> Mapping[str, Any]:
        response = self.transport(
            f"{self.bridge_url}/invoke",
            {
                "resource": resource,
                "tool": tool_name,
                "args": dict(arguments),
            },
            self.timeout if timeout is None else timeout,
        )
        if isinstance(response, Mapping):
            return response
        return {
            "status": "error",
            "status_code": None,
            "error_type": "NON_OBJECT_RESPONSE",
        }

    def invoke_trusted(
        self,
        *,
        resource: str,
        tool_name: str,
        arguments: Mapping[str, Any],
        timeout: int = 30,
    ) -> Mapping[str, Any]:
        """调用固定流程显式允许的状态或报告工具，不扩大只读取证入口。"""

        if (resource, tool_name) not in FIXED_RUNTIME_TOOLS:
            raise PermissionError(f"tool did not pass fixed runtime gate: {tool_name}")
        return self._invoke_bridge(resource, tool_name, arguments, timeout)

    def invoke(
        self,
        *,
        call_id: str,
        resource: str,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> McpCallResult:
        if (resource, tool_name) in FIXED_RUNTIME_TOOLS:
            raise PermissionError(f"fixed runtime tool requires trusted entry: {tool_name}")
        started = time.monotonic()
        response = self._invoke_bridge(resource, tool_name, arguments)
        latency_ms = round((time.monotonic() - started) * 1000)
        self.raw_directory.mkdir(parents=True, exist_ok=True)
        raw_path = self.raw_directory / f"{call_id}.json"
        raw_path.write_text(
            json.dumps(response, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        outcome = classify_response(response)
        data = extract_result_data(response)
        return McpCallResult(
            outcome=outcome,
            data=data,
            result_count=(
                result_count(data)
                if outcome not in (CallOutcome.FAILED, CallOutcome.TRUNCATED)
                else None
            ),
            latency_ms=latency_ms,
            raw_response_file=str(raw_path),
            response=response,
        )

"""Run isolated model evaluations against frozen five-source incident data.

The module deliberately keeps transport, parsing, and contract validation
separate.  A model response is frozen before it is parsed or validated and is
never repaired or retried with a different prompt.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from forced_output_contract import validate_forced_output


DEFAULT_TIMEOUT_SECONDS = 180
Transport = Callable[[str, dict[str, Any], str | None, int], dict[str, Any]]


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _redact_secret(value: str, secret: str | None) -> str:
    return value.replace(secret, "[REDACTED]") if secret else value


def build_chat_request(
    *,
    system_prompt: str,
    five_source: Mapping[str, Any],
    model: str,
    temperature: float = 0,
) -> dict[str, Any]:
    """Build the fixed two-message request used by each analysis."""

    if not 0 <= temperature <= 2:
        raise ValueError("temperature must be between 0 and 2")

    user_content = (
        "请严格按照系统提示词研判以下安全事件。"
        "除该 JSON 外没有其他案例事实输入：\n\n"
        f"{_canonical_json(five_source)}"
    )
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": temperature,
        "stream": False,
        "response_format": {"type": "json_object"},
    }


def _default_transport(
    endpoint: str,
    payload: dict[str, Any],
    api_key: str | None,
    timeout: int,
) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if api_key is not None:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Model API returned HTTP {exc.code}: {response_body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Model API request failed: {exc.reason}") from exc

    decoded = json.loads(response_body)
    if not isinstance(decoded, dict):
        raise ValueError("Model API response must be a JSON object")
    return decoded


def extract_json_output(response: Mapping[str, Any]) -> dict[str, Any]:
    """Parse raw JSON or one complete JSON Markdown fence without content repair."""

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("Model API response has no choices")
    first_choice = choices[0]
    if not isinstance(first_choice, Mapping):
        raise ValueError("Model API response choice must be an object")
    message = first_choice.get("message")
    if not isinstance(message, Mapping):
        raise ValueError("Model API response choice has no message")
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError("Model API response message content must be a string")

    fenced = re.fullmatch(r"```json[ \t]*\r?\n(.*)\r?\n```", content, re.DOTALL)
    if fenced is not None:
        content = fenced.group(1)
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError("Model output must be a JSON object")
    return parsed


def run_inference(
    *,
    five_source: Mapping[str, Any],
    system_prompt: str,
    base_url: str,
    model: str,
    api_key: str | None,
    output_dir: Path,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    temperature: float = 0,
    transport: Transport = _default_transport,
) -> dict[str, Any]:
    """Call the model once, freeze its response, and validate its output."""

    if api_key is not None and not api_key.strip():
        raise ValueError("API key is empty; use explicit no-auth mode instead")
    incident_id = five_source.get("unified_event_id")
    if not isinstance(incident_id, str) or not incident_id:
        raise ValueError("five-source input has no unified_event_id")

    output_dir = Path(output_dir)
    frozen_artifacts = (
        "request-metadata.json",
        "raw-response.json",
        "model-analysis-output.json",
        "forced-analysis-output.json",
        "validation.json",
    )
    existing = [name for name in frozen_artifacts if (output_dir / name).exists()]
    if existing:
        raise FileExistsError(
            f"analysis result directory already contains frozen artifacts: {existing}"
        )
    output_dir.mkdir(parents=True, exist_ok=True)

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    request_payload = build_chat_request(
        system_prompt=system_prompt,
        five_source=five_source,
        model=model,
        temperature=temperature,
    )
    metadata = {
        "unified_event_id": incident_id,
        "endpoint": endpoint,
        "model": model,
        "temperature": temperature,
        "stream": False,
        "response_format": {"type": "json_object"},
        "auth_mode": "none" if api_key is None else "bearer",
        "timeout_seconds": timeout,
        "input_sha256": _sha256_text(_canonical_json(five_source)),
        "system_prompt_sha256": _sha256_text(system_prompt),
        "request_sha256": _sha256_text(_canonical_json(request_payload)),
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    _write_json(output_dir / "request-metadata.json", metadata)

    try:
        response = transport(endpoint, request_payload, api_key, timeout)
    except Exception as exc:
        safe_error = _redact_secret(str(exc), api_key)
        _write_json(
            output_dir / "validation.json",
            {
                "status": "request_failed",
                "error_type": type(exc).__name__,
                "error": safe_error,
            },
        )
        raise RuntimeError(safe_error) from None

    metadata["response_model"] = response.get("model")
    metadata["responded_at"] = datetime.now(timezone.utc).isoformat()
    _write_json(output_dir / "request-metadata.json", metadata)
    _write_json(output_dir / "raw-response.json", response)
    try:
        forced_output = extract_json_output(response)
        _write_json(output_dir / "model-analysis-output.json", forced_output)
        warnings = validate_forced_output(forced_output, five_source)
    except Exception as exc:
        _write_json(
            output_dir / "validation.json",
            {
                "status": "failed",
                "error_type": type(exc).__name__,
                "error": str(exc),
            },
        )
        raise

    _write_json(output_dir / "forced-analysis-output.json", forced_output)

    _write_json(
        output_dir / "validation.json",
        {
            "status": "passed_with_warnings" if warnings else "passed",
            "warnings": warnings,
            "validated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return forced_output

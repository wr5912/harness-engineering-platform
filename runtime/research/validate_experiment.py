#!/usr/bin/env python3
"""校验一个 Harness Experiment 的最小可复现研究记录。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from evaluation_contract import cases_digest, load_evaluation

ADAPTER = Path(__file__).resolve().parents[1] / "adapters/dsh-container"
if str(ADAPTER) not in sys.path:
    sys.path.insert(0, str(ADAPTER))
from scenario_analysis import summarize_review, summarize_source_diagnosis, validate_analysis
from source_contract import EXPERIMENT as EXPERIMENT_RE, LEGACY_EXPERIMENT_IDS, NEW_EXPERIMENT

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


RUN_RE = re.compile(
    r"^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
RELEASE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
OUTCOMES = {"adopt", "continue", "reject", "inconclusive"}
RUN_STATUSES = {"planned", "running", "completed", "failed", "cancelled"}
EXECUTION_STATUSES = {"completed", "error", "skipped"}
VERDICTS = {"passed", "failed", "inconclusive"}
GAP_CLASSIFICATIONS = {"harness", "input", "method", "environment", "unknown"}


def issue(code: str, message: str, path: Path | None = None) -> dict[str, str]:
    result = {"code": code, "message": message}
    if path is not None:
        result["path"] = str(path)
    return result


def load_yaml(path: Path) -> dict:
    if yaml is None:
        raise RuntimeError("缺少 PyYAML；请先安装 runtime/research/requirements.txt")
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("必须是 YAML object")
    return value


def has_text(path: Path) -> bool:
    if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    visible = []
    in_comment = False
    for line in text.splitlines():
        stripped = line.strip()
        if "<!--" in stripped:
            in_comment = True
        if not in_comment and stripped and not stripped.startswith("#"):
            visible.append(stripped)
        if "-->" in stripped:
            in_comment = False
    return any(item.lower() not in {"todo", "tbd", "待补充", "占位"} for item in visible)


def material_files(directory: Path) -> list[Path]:
    if not directory.is_dir() or directory.is_symlink():
        return []
    result = []
    for path in directory.rglob("*"):
        if path.is_file() and not path.is_symlink() and path.stat().st_size > 0 \
                and path.name not in {".gitkeep", ".keep", ".DS_Store"}:
            result.append(path)
    return result


def valid_baseline_ref(value: object) -> bool:
    if value == "none:first-experiment":
        return True
    if not isinstance(value, str):
        return False
    if value.startswith("git:"):
        return bool(COMMIT_RE.fullmatch(value[4:]))
    if value.startswith("release:"):
        return bool(RELEASE_RE.fullmatch(value[8:]))
    return False


def valid_id_list(values: object, *, nonempty: bool = False) -> bool:
    return isinstance(values, list) \
        and (not nonempty or bool(values)) \
        and all(isinstance(value, str) and bool(value.strip()) for value in values) \
        and len(values) == len(set(values))


def valid_source_verification(value: object, with_implementation: bool = False,
                              with_mcp_fixture: bool = False) -> bool:
    if not isinstance(value, dict) or set(value) != {"status", "reason", "checks"}:
        return False
    checks = value["checks"]
    components = {"candidate", "workspace", "presets", "managed"}
    if with_implementation:
        components.add("evaluation_implementation")
    if with_mcp_fixture:
        components.add("mcp_fixture")
    if not isinstance(checks, list) or len(checks) != len(components) \
            or any(not isinstance(item, dict) or not isinstance(item.get("component"), str) for item in checks) \
            or {item["component"] for item in checks} != components:
        return False
    for item in checks:
        expected, actual, status = item.get("expected_sha256"), item.get("actual_sha256"), item.get("status")
        if expected is not None and not (isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected)):
            return False
        hashes = all(isinstance(digest, str) and bool(re.fullmatch(r"[0-9a-f]{64}", digest))
                     for digest in (expected, actual))
        if status == "matched" and hashes and expected == actual \
                or status == "changed" and hashes and expected != actual:
            if set(item) != {"component", "status", "expected_sha256", "actual_sha256"}:
                return False
        elif status == "unavailable" and actual is None and isinstance(item.get("error_type"), str):
            if set(item) != {"component", "status", "expected_sha256", "actual_sha256", "error_type"}:
                return False
        else:
            return False
    statuses = {item["status"] for item in checks}
    status = "changed" if "changed" in statuses else "unavailable" if "unavailable" in statuses else "matched"
    reason = "source-changed" if status == "changed" else "source-unavailable" if status == "unavailable" else None
    return value["status"] == status and value["reason"] == reason


def material_evidence(run_dir: Path, value: object) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    relative = Path(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return False
    target = run_dir / relative
    if target.is_file() and not target.is_symlink() and target.stat().st_size > 0:
        return True
    return target.is_dir() and not target.is_symlink() and any(
        path.is_file() and not path.is_symlink() and path.stat().st_size > 0
        for path in target.rglob("*")
    )


def validate_result(
    path: Path,
    expected_run: str,
    allowed_input_ids: set[str],
    errors: list[dict[str, str]],
) -> list[dict]:
    seen: set[str] = set()
    rows: list[dict] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(issue("RESULT_JSON", f"第 {line_number} 行不是合法 JSON：{exc.msg}", path))
            continue
        if not isinstance(row, dict):
            errors.append(issue("RESULT_OBJECT", f"第 {line_number} 行必须是 object", path))
            continue
        required = (
            "run_id", "trial_id", "input_id", "execution_status", "verdict", "observation", "evidence_ref"
        )
        missing = [name for name in required if name not in row]
        if missing:
            errors.append(issue("RESULT_FIELDS", f"第 {line_number} 行缺少：{', '.join(missing)}", path))
            continue
        if row["run_id"] != expected_run:
            errors.append(issue("RESULT_RUN", f"第 {line_number} 行 run_id 与目录不一致", path))
        trial_id = row["trial_id"]
        if not isinstance(trial_id, str) or not trial_id.strip():
            errors.append(issue("RESULT_TRIAL", f"第 {line_number} 行 trial_id 必须是非空字符串", path))
        elif trial_id in seen:
            errors.append(issue("RESULT_TRIAL_DUPLICATE", f"重复 trial_id：{trial_id}", path))
        else:
            seen.add(trial_id)
        if not isinstance(row["input_id"], str) or not row["input_id"].strip():
            errors.append(issue("RESULT_INPUT", f"第 {line_number} 行 input_id 必须是非空字符串", path))
        elif row["input_id"] not in allowed_input_ids:
            errors.append(issue("RESULT_INPUT_SELECTION", f"第 {line_number} 行 input_id 未被本 Experiment 选择", path))
        execution_status = row["execution_status"]
        verdict = row["verdict"]
        execution_valid = isinstance(execution_status, str) and execution_status in EXECUTION_STATUSES
        verdict_valid = isinstance(verdict, str) and verdict in VERDICTS
        if not execution_valid:
            errors.append(issue("RESULT_EXECUTION_STATUS", f"第 {line_number} 行 execution_status 不合法", path))
        if not verdict_valid:
            errors.append(issue("RESULT_VERDICT", f"第 {line_number} 行 verdict 不合法", path))
        if execution_valid and verdict_valid \
                and execution_status in {"error", "skipped"} and verdict != "inconclusive":
            errors.append(issue("RESULT_DIMENSIONS", f"第 {line_number} 行 error/skipped 只能给出 inconclusive", path))
        if not isinstance(row["observation"], str) or not row["observation"].strip():
            errors.append(issue("RESULT_OBSERVATION", f"第 {line_number} 行 observation 必须非空", path))
        if execution_status == "error" and not (
            isinstance(row.get("failure_reason"), str) and row["failure_reason"].strip()
        ):
            errors.append(issue("RESULT_FAILURE_REASON", f"第 {line_number} 行执行错误必须说明原因", path))
        if not material_evidence(path.parent, row["evidence_ref"]):
            errors.append(issue("RESULT_EVIDENCE", f"第 {line_number} 行 evidence_ref 未指向 Run 内的实质证据", path))
        rows.append(row)
    return rows


def validate_gaps(path: Path, expected_run: str, errors: list[dict[str, str]]) -> None:
    seen = set()
    required = {"gap_id", "run_id", "classification", "title", "observed", "next_step"}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(issue("RUN_GAP", f"第 {line_number} 行不是合法 JSON：{exc.msg}", path))
            continue
        if not isinstance(row, dict) or set(row) - required - {"evidence_ref"} or not required <= set(row) \
                or not isinstance(row["gap_id"], str) or not row["gap_id"].startswith("gap-") \
                or row["gap_id"] in seen or row["run_id"] != expected_run \
                or not isinstance(row["classification"], str) \
                or row["classification"] not in GAP_CLASSIFICATIONS \
                or any(not isinstance(row[key], str) or not row[key].strip()
                       for key in ("title", "observed", "next_step")) \
                or "evidence_ref" in row and not material_evidence(path.parent, row["evidence_ref"]):
            errors.append(issue("RUN_GAP", f"第 {line_number} 行研究缺口无效", path))
            continue
        seen.add(row["gap_id"])


def validate_run(
    run_dir: Path,
    experiment_id: str,
    agent_id: str,
    evaluation_ref: str,
    evaluation_path: Path,
    errors: list[dict[str, str]],
) -> None:
    if not RUN_RE.fullmatch(run_dir.name):
        errors.append(issue("RUN_NAME", "Run 目录必须使用 run-<UUIDv4>", run_dir))
        return
    manifest_path = run_dir / "run.yaml"
    if not manifest_path.is_file():
        errors.append(issue("RUN_MANIFEST", "Run 缺少 run.yaml", run_dir))
        return
    try:
        manifest = load_yaml(manifest_path)
    except (OSError, ValueError, RuntimeError) as exc:
        errors.append(issue("RUN_MANIFEST", str(exc), manifest_path))
        return
    expected = {
        "run_id": run_dir.name,
        "experiment_id": experiment_id,
        "agent_id": agent_id,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            errors.append(issue("RUN_IDENTITY", f"{key} 必须是 {value}", manifest_path))
    if manifest.get("schema_version") != "2.0":
        errors.append(issue("RUN_SCHEMA", "Run schema_version 必须是 2.0", manifest_path))
    if manifest.get("kind") not in {"research", "technical"}:
        errors.append(issue("RUN_KIND", "kind 必须是 research 或 technical", manifest_path))
    status = manifest.get("status")
    if status not in RUN_STATUSES:
        errors.append(issue("RUN_STATUS", "Run status 不合法", manifest_path))
    sealed = status in {"completed", "failed", "cancelled"}
    run_evaluation_ref = manifest.get("evaluation_ref")
    valid_evaluation_ref = run_evaluation_ref == evaluation_ref or (
        sealed and isinstance(run_evaluation_ref, str)
        and run_evaluation_ref.split("#", 1)[0] == evaluation_ref
    )
    if not valid_evaluation_ref:
        errors.append(issue("RUN_EVALUATION_REF", f"evaluation_ref 必须是 {evaluation_ref}", manifest_path))
    if "plan_ref" in manifest:
        errors.append(issue("RUN_PLAN_REF", "Run 不再允许引用 Experiment 本地 plan", manifest_path))
    inputs = run_dir / "inputs.lock.json"
    if not inputs.is_file() or inputs.stat().st_size == 0:
        errors.append(issue("RUN_INPUTS", "Run 缺少 inputs.lock.json", run_dir))
        locked_inputs = {}
    else:
        try:
            locked_inputs = json.loads(inputs.read_text(encoding="utf-8"))
            if not isinstance(locked_inputs, dict):
                raise ValueError("必须是 JSON object")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            errors.append(issue("RUN_INPUTS", f"inputs.lock.json 无效：{exc}", inputs))
            locked_inputs = {}
    if "plan_sha256" in locked_inputs:
        errors.append(issue("RUN_PLAN_REF", "Run 输入锁不再允许保存本地 plan 摘要", inputs))
    if locked_inputs.get("schema_version") != "2.0" or locked_inputs.get("run_id") != run_dir.name:
        errors.append(issue("RUN_INPUTS_SCHEMA", "输入锁必须是当前 Run 的 2.0 合同", inputs))
    comparison_ref = locked_inputs.get("compare_to_run_id")
    if comparison_ref is not None:
        references = [] if not isinstance(comparison_ref, str) or not RUN_RE.fullmatch(comparison_ref) \
            or comparison_ref == run_dir.name else list(run_dir.parents[2].glob(f"*/runs/{comparison_ref}/run.yaml"))
        if len(references) != 1:
            errors.append(issue("RUN_COMPARISON_REF", "对照 Run 必须是唯一的已封存 Run", inputs))
        else:
            try:
                reference = load_yaml(references[0])
                if reference.get("agent_id") != agent_id or reference.get("status") not in {"completed", "failed", "cancelled"}:
                    raise ValueError("对照 Run 必须属于同一 Agent 且已封存")
            except (OSError, ValueError, RuntimeError) as exc:
                errors.append(issue("RUN_COMPARISON_REF", str(exc), inputs))
    locked_cases = locked_inputs.get("evaluation_cases")
    valid_cases = isinstance(locked_cases, list) and bool(locked_cases) and all(
        isinstance(case, dict)
        and isinstance(case.get("case_id"), str) and bool(case["case_id"])
        and isinstance(case.get("title"), str) and bool(case["title"])
        and isinstance(case.get("inputs"), list) and bool(case["inputs"])
        and all(isinstance(value, str) and bool(value.strip()) for value in case["inputs"])
        and isinstance(case.get("expected_behavior"), str) and bool(case["expected_behavior"].strip())
        for case in locked_cases
    )
    if valid_cases:
        case_ids = [case["case_id"] for case in locked_cases]
        valid_cases = len(case_ids) == len(set(case_ids))
    else:
        case_ids = []

    has_catalog = "case_catalog" in locked_inputs or "selection_mode" in locked_inputs
    catalog = locked_inputs.get("case_catalog")
    selection_mode = locked_inputs.get("selection_mode")
    review_mode = locked_inputs.get("review_mode", "ai" if selection_mode == "full" else "none")
    if review_mode not in {"ai", "none"}:
        errors.append(issue("RUN_REVIEW_MODE", "Run 证据复核模式无效", inputs))
    valid_catalog = isinstance(catalog, list) and bool(catalog) and all(
        isinstance(item, dict) and set(item) == {"case_id", "scene", "fast"}
        and isinstance(item["case_id"], str) and bool(item["case_id"])
        and isinstance(item["scene"], str) and bool(item["scene"].strip())
        and isinstance(item["fast"], bool)
        for item in catalog
    )
    if valid_catalog:
        catalog_ids = [item["case_id"] for item in catalog]
        valid_catalog = len(catalog_ids) == len(set(catalog_ids)) and set(case_ids) <= set(catalog_ids)
    if has_catalog:
        if not valid_catalog or selection_mode not in {"fast", "full", "explicit"}:
            errors.append(issue("RUN_CASE_CATALOG", "Run 场景目录或选择模式无效", inputs))
        elif selection_mode != "explicit":
            expected_ids = [item["case_id"] for item in catalog
                            if selection_mode == "full" or item["fast"]]
            if case_ids != expected_ids:
                errors.append(issue("RUN_CASE_SELECTION", "所选 Case 与 fast/full 场景目录不一致", inputs))

    if status in {"planned", "running"}:
        if not valid_cases:
            errors.append(issue("RUN_EVALUATION_CASES", "未封存 Run 必须锁定完整 Case", inputs))
    elif not valid_cases:
        historical = locked_inputs.get("evaluation_selection")
        case_ids = historical.get("case_ids", []) if isinstance(historical, dict) else []
        if not valid_id_list(case_ids, nonempty=True):
            errors.append(issue("RUN_EVALUATION_CASES", "封存 Run 缺少有效的历史 Case 选择", inputs))
            case_ids = []
    # 当前用例可继续维护；Run 的完整性只依赖其冻结快照。
    if valid_cases and (status in {"planned", "running"} or "evaluation_sha256" in locked_inputs):
        if locked_inputs.get("evaluation_sha256") != cases_digest(locked_cases):
            errors.append(issue("RUN_EVALUATION_HASH", "Run 锁定的 Case 摘要与冻结内容不一致", inputs))
    selected_ids = set(case_ids)
    results = run_dir / "results.jsonl"
    rows: list[dict] = []
    if results.is_file():
        rows = validate_result(results, run_dir.name, selected_ids, errors)
    if status == "completed" and {row.get("input_id") for row in rows} != selected_ids:
        errors.append(issue("RUN_RESULT_COVERAGE", "completed Run 必须记录每个锁定 Case", results))
    if status in {"completed", "failed", "cancelled"} and not (run_dir / "summary.json").is_file():
        errors.append(issue("RUN_SUMMARY", "已封存 Run 缺少 summary.json", run_dir))
    summary_path = run_dir / "summary.json"
    if summary_path.is_file():
        execution_counts = {name: sum(row.get("execution_status") == name for row in rows) for name in sorted(EXECUTION_STATUSES)}
        verdict_counts = {name: sum(row.get("verdict") == name for row in rows) for name in sorted(VERDICTS)}
        overall = "failed" if verdict_counts["failed"] else (
            "inconclusive" if verdict_counts["inconclusive"] or not rows else "passed"
        )
        legacy_summary = {
            "schema_version": "2.0",
            "run_id": run_dir.name,
            "trial_count": len(rows),
            "execution_status_counts": execution_counts,
            "verdict_counts": verdict_counts,
            "overall_verdict": overall,
        }
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(issue("RUN_SUMMARY", f"summary.json 无效：{exc}", summary_path))
        else:
            expected_summary = legacy_summary
            if isinstance(summary, dict) and summary.get("schema_version") in {"3.0", "4.0"}:
                analysis_for_summary = {}
                try:
                    analysis_for_summary = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
                    review = summarize_review(analysis_for_summary)
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    review = {"status": None, "case_count": None, "verdict_counts": None, "overall_verdict": None}
                effective = "inconclusive" if status != "completed" else (
                    review["overall_verdict"] if review["status"] == "completed"
                    else overall if review["status"] == "not_requested"
                    else "inconclusive"
                )
                expected_summary = {
                    "schema_version": "4.0" if "review_contract" in locked_inputs else "3.0",
                    "run_id": run_dir.name,
                    "trial_count": len(rows),
                    "execution_status_counts": execution_counts,
                    "machine_trial_verdict_counts": verdict_counts,
                    "machine_overall_verdict": overall,
                    "review_status": review["status"],
                    "reviewed_case_count": review["case_count"],
                    "reviewed_case_verdict_counts": review["verdict_counts"],
                    "reviewed_overall_verdict": review["overall_verdict"],
                    "effective_verdict": effective,
                }
                if "review_contract" in locked_inputs:
                    try:
                        expected_summary["source_diagnosis"] = summarize_source_diagnosis(analysis_for_summary)
                    except (KeyError, TypeError, ValueError, AttributeError):
                        expected_summary["source_diagnosis"] = None
                        errors.append(issue("RUN_SUMMARY_CONTENT", "源码诊断摘要与本 Run 记录不一致", summary_path))
                if "source_verification" in summary:
                    verification = summary["source_verification"]
                    if not valid_source_verification(verification, isinstance(locked_inputs.get("evaluation_implementation"), dict),
                                                     isinstance(locked_inputs.get("mcp_fixture"), dict)) \
                            or status == "completed" and verification.get("status") != "matched":
                        errors.append(issue("RUN_SOURCE_VERIFICATION", "来源核对记录无效或未匹配来源却标记 completed", summary_path))
                    expected_summary["source_verification"] = verification
            if summary != expected_summary:
                errors.append(issue("RUN_SUMMARY_CONTENT", "summary.json 与逐项结果不一致", summary_path))
    if status in {"completed", "failed", "cancelled"}:
        for field, path in (("results_sha256", results), ("summary_sha256", summary_path)):
            expected_hash = hashlib.sha256(path.read_bytes() if path.is_file() else b"").hexdigest()
            if manifest.get(field) != expected_hash:
                errors.append(issue("RUN_HASH", f"{field} 与文件不一致", manifest_path))
        report_path = run_dir / "report.md"
        if report_path.is_file() or manifest.get("report_sha256"):
            expected_hash = hashlib.sha256(report_path.read_bytes() if report_path.is_file() else b"").hexdigest()
            if manifest.get("report_sha256") != expected_hash:
                errors.append(issue("RUN_HASH", "report_sha256 与文件不一致", manifest_path))
        gaps_path = run_dir / "gaps.jsonl"
        artifact_index = run_dir / "artifacts/index.json"
        if artifact_index.is_file() or manifest.get("artifacts_sha256"):
            expected_hash = hashlib.sha256(artifact_index.read_bytes() if artifact_index.is_file() else b"").hexdigest()
            if manifest.get("artifacts_sha256") != expected_hash:
                errors.append(issue("RUN_HASH", "artifacts_sha256 与文件不一致", manifest_path))
            try:
                artifacts = json.loads(artifact_index.read_text(encoding="utf-8"))["artifacts"]
                for artifact in artifacts:
                    relative = Path(artifact["path"])
                    output = run_dir / relative
                    if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "artifacts" \
                            or output.is_symlink() or not output.is_file() \
                            or hashlib.sha256(output.read_bytes()).hexdigest() != artifact["sha256"]:
                        raise ValueError("产物文件与导出索引不一致")
            except (OSError, ValueError, KeyError, TypeError, IndexError):
                errors.append(issue("RUN_ARTIFACT", "产物文件与导出索引不一致", artifact_index))
        if gaps_path.is_file() or manifest.get("gaps_sha256"):
            expected_hash = hashlib.sha256(gaps_path.read_bytes() if gaps_path.is_file() else b"").hexdigest()
            if manifest.get("gaps_sha256") != expected_hash:
                errors.append(issue("RUN_HASH", "gaps_sha256 与文件不一致", manifest_path))
            if gaps_path.is_file():
                validate_gaps(gaps_path, run_dir.name, errors)
        if has_catalog:
            analysis_path = run_dir / "analysis.json"
            if not analysis_path.is_file():
                errors.append(issue("RUN_ANALYSIS", "新 Run 缺少场景诊断记录", run_dir))
            else:
                if manifest.get("analysis_sha256") != hashlib.sha256(analysis_path.read_bytes()).hexdigest():
                    errors.append(issue("RUN_HASH", "analysis_sha256 与文件不一致", manifest_path))
                if valid_catalog and valid_cases:
                    try:
                        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
                        validate_analysis(analysis, run_dir, rows, locked_inputs)
                        if analysis.get("schema_version") in {"2.0", "3.0"} \
                                and status == "completed" and review_mode == "ai" \
                                and analysis.get("review_status") != "completed":
                            raise ValueError("已请求 AI 复核的 completed Run 必须完成全部证据复核")
                    except (OSError, ValueError, KeyError, TypeError, IndexError) as exc:
                        errors.append(issue("RUN_ANALYSIS", f"场景诊断与 Run 事实不一致：{exc}", analysis_path))


def validate(experiment: Path) -> tuple[dict, int]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    match = EXPERIMENT_RE.fullmatch(experiment.name)
    if not experiment.is_dir() or experiment.is_symlink() or not match:
        payload = {"schema_version": "1.0", "valid": False, "errors": [issue("EXPERIMENT_PATH", "输入必须是 EXP/VAR-<agent-id>-NNN-r<12位十六进制> 或旧编号实体目录", experiment)], "warnings": []}
        return payload, 2
    if not NEW_EXPERIMENT.fullmatch(experiment.name) and experiment.name not in LEGACY_EXPERIMENT_IDS:
        errors.append(issue("EXPERIMENT_NAME", "新业务版本使用 EXP-、变体使用 VAR-，均须包含 -r<12位小写十六进制>；无后缀名称仅兼容固定历史身份", experiment))
    agent_id = match.group(1)
    repository = experiment.parents[2]
    evaluation_path = repository / "agents" / agent_id / "evaluation.md"
    evaluation_ref = f"agents/{agent_id}/evaluation.md"
    try:
        load_evaluation(evaluation_path)
    except (OSError, ValueError) as exc:
        errors.append(issue("EVALUATION_CONTRACT", str(exc), evaluation_path))
        evaluation_valid = False
    else:
        evaluation_valid = True
    change_path = experiment / "change.yaml"
    try:
        change = load_yaml(change_path)
    except (OSError, ValueError, RuntimeError) as exc:
        errors.append(issue("CHANGE", str(exc), change_path))
        change = {}
    required = {
        "schema_version": "1.0",
        "experiment_id": experiment.name,
        "agent_id": agent_id,
    }
    for key, expected in required.items():
        if change.get(key) != expected:
            errors.append(issue("CHANGE_IDENTITY", f"{key} 必须是 {expected}", change_path))
    if experiment.name.startswith("VAR-") and not isinstance(change.get("compute_variant"), dict):
        errors.append(issue("COMPUTE_VARIANT", "VAR 变体必须声明 compute_variant", change_path))
    if not valid_baseline_ref(change.get("baseline_ref")):
        errors.append(issue("BASELINE_REF", "baseline_ref 必须是 git:<commit>、release:<id> 或 none:first-experiment", change_path))
    status = change.get("status")
    if status not in {"active", "completed"}:
        errors.append(issue("EXPERIMENT_STATUS", "status 必须是 active 或 completed", change_path))
    outcome = change.get("outcome")
    if status == "completed" and outcome not in OUTCOMES:
        errors.append(issue("EXPERIMENT_OUTCOME", "完成的 Experiment 必须声明 outcome", change_path))
    if status == "active" and outcome not in (None, ""):
        warnings.append(issue("ACTIVE_OUTCOME", "active Experiment 通常不应提前固定 outcome", change_path))
    # 平台的版本特性、融合来源与创建状态共用 change.yaml，旧 Experiment 无需补字段。
    features = change.get("features", [])
    if not isinstance(features, list):
        errors.append(issue("FEATURES", "features 必须是数组", change_path))
    else:
        feature_ids = set()
        for feature in features:
            if not isinstance(feature, dict) or any(not isinstance(feature.get(key), str) or not feature[key].strip()
                                                    for key in ("id", "title", "description")):
                errors.append(issue("FEATURES", "特性必须有 id、title 和 description", change_path))
                continue
            if feature["id"] in feature_ids:
                errors.append(issue("FEATURES", "特性 id 不得重复", change_path))
            feature_ids.add(feature["id"])
            for key in ("source_refs", "evidence_refs"):
                refs = feature.get(key, [])
                if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref.strip() for ref in refs):
                    errors.append(issue("FEATURES", f"{key} 必须是字符串数组", change_path))
    fusion_sources = change.get("fusion_sources", [])
    if not isinstance(fusion_sources, list):
        errors.append(issue("FUSION_SOURCES", "fusion_sources 必须是数组", change_path))
    else:
        for source in fusion_sources:
            identifier = source if isinstance(source, str) else source.get("experiment_id") if isinstance(source, dict) else None
            if not isinstance(identifier, str) or not EXPERIMENT_RE.fullmatch(identifier):
                errors.append(issue("FUSION_SOURCES", "融合来源需要有效 Experiment ID", change_path))
            if isinstance(source, dict) and not re.fullmatch(r"git:[0-9a-fA-F]{40}", str(source.get("ref", ""))):
                errors.append(issue("FUSION_SOURCES", "结构化融合来源必须固定 Git 提交", change_path))
    creation = change.get("creation")
    if creation is not None and (not isinstance(creation, dict) or creation.get("status") not in {"integrating", "completed"}
                                 or not isinstance(creation.get("plan"), dict) or not isinstance(creation.get("receipts"), list)):
        errors.append(issue("VERSION_CREATION", "版本创建需要有效状态、确认方案及验证回执", change_path))
    if not has_text(experiment / "hypothesis.md"):
        errors.append(issue("HYPOTHESIS", "hypothesis.md 缺少实质内容", experiment / "hypothesis.md"))
    if not material_files(experiment / "candidate"):
        errors.append(issue("CANDIDATE", "candidate/ 缺少真实资产", experiment / "candidate"))
    local_plan = experiment / "evaluation/plan.yaml"
    if local_plan.exists():
        errors.append(issue("EVALUATION_PLAN", "评测口径只能维护在 Agent 的 evaluation.md", local_plan))
    if status == "completed" and not has_text(experiment / "decision.md"):
        errors.append(issue("DECISION", "完成的 Experiment 缺少实质 decision.md", experiment / "decision.md"))
    runs = experiment / "runs"
    if runs.exists():
        if not runs.is_dir() or runs.is_symlink():
            errors.append(issue("RUNS", "runs 必须是实体目录", runs))
        else:
            for run_dir in sorted(path for path in runs.iterdir() if path.name not in {".DS_Store"}):
                if run_dir.is_dir():
                    if evaluation_valid:
                        validate_run(
                            run_dir,
                            experiment.name,
                            agent_id,
                            evaluation_ref,
                            evaluation_path,
                            errors,
                        )
                else:
                    errors.append(issue("RUN_ENTRY", "runs/ 只能包含 Run 目录", run_dir))
    payload = {
        "schema_version": "1.0",
        "experiment_id": experiment.name,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }
    return payload, 0 if not errors else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", type=Path)
    args = parser.parse_args()
    payload, code = validate(args.experiment.resolve())
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

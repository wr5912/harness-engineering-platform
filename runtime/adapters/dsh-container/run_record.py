#!/usr/bin/env python3
"""创建、查询并封存 Research Run，生成场景分析报告。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
import yaml
from datetime import datetime, timezone
from pathlib import Path

ADAPTER = Path(__file__).resolve().parent
sys.path.insert(0, str(ADAPTER))
from workspace_paths import PROGRAM_ROOT, asset_root, workspace_id
REPO = asset_root()
EVALUATION_SCRIPTS = PROGRAM_ROOT / "runtime/research"
for import_root in (ADAPTER, EVALUATION_SCRIPTS):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from evaluation_contract import cases_digest, execution_from, load_evaluation
from scenario_analysis import analyze, summarize_review, validate_analysis
from source_contract import EXPERIMENT as EXPERIMENT_RE, resolve


_MUTATION_PATH = Path(__file__).with_name("mutation-receipt.py")
_MUTATION_SPEC = importlib.util.spec_from_file_location("dsh_mutation_receipt", _MUTATION_PATH)
_mutation_receipt = importlib.util.module_from_spec(_MUTATION_SPEC)
_MUTATION_SPEC.loader.exec_module(_mutation_receipt)
snapshot = _mutation_receipt.snapshot

RUN_ID_RE = re.compile(
    r"^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
RELEASE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
RESULT_FIELDS = (
    "run_id", "trial_id", "input_id", "execution_status", "verdict", "observation", "evidence_ref"
)
EXECUTION_STATUSES = ("completed", "error", "skipped")
VERDICTS = ("passed", "failed", "inconclusive")
RUN_STATUSES = ("planned", "running", "completed", "failed", "cancelled")
FINAL_STATUSES = ("completed", "failed", "cancelled")
RUN_KINDS = ("research", "technical")
GAP_CLASSIFICATIONS = ("harness", "input", "method", "environment", "unknown")
STATUS_ZH = {"planned": "计划", "running": "运行中", "completed": "已完成", "failed": "失败", "cancelled": "已取消"}
EXECUTION_STATUS_ZH = {"completed": "已完成", "error": "执行错误", "skipped": "已跳过"}
VERDICT_ZH = {"passed": "通过", "failed": "失败", "inconclusive": "无法判定"}


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def evaluation_implementation() -> dict:
    """冻结实际执行及评审资产身份；缺失文件保留 null，不用当前版本回填旧 Run。"""
    names = ["dsh-eval", "dsh-eval-api.mjs", "dsh-eval-browser.mjs", "dsh-eval-common.mjs",
             "run_record.py", "scenario_analysis.py", "evaluation-judge-guard.mjs",
             "scenario-analysis-guard.mjs"]
    names += [path.relative_to(ADAPTER).as_posix()
              for path in sorted((ADAPTER / "evaluation-presets").rglob("*")) if path.is_file()]
    return {name: hashlib.sha256((ADAPTER / name).read_bytes()).hexdigest()
            if (ADAPTER / name).is_file() else None for name in names}


def valid_baseline_ref(value: str) -> bool:
    if value == "none:first-experiment":
        return True
    if value.startswith("git:"):
        return bool(COMMIT_RE.fullmatch(value[4:]))
    if value.startswith("release:"):
        return bool(RELEASE_RE.fullmatch(value[8:]))
    return False


def tree_digest(repo: Path, root: Path) -> dict:
    root = root.absolute()
    try:
        root.relative_to(repo)
    except ValueError as exc:
        raise ValueError("run inputs must live inside the repository") from exc
    return snapshot(root, allowed_roots={root})


def candidate_digest(root: Path) -> str:
    """与平台版本验证相同：记录 Candidate 文件路径、权限与内容，排除运行状态和依赖。"""
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Candidate must be a real directory")
    excluded = {"runs", "history", "RuntimeHOME", "sessions", "cache", ".git", "node_modules", "__pycache__"}
    digest = hashlib.sha256()

    def walk(folder: Path) -> None:
        for entry in sorted(folder.iterdir(), key=lambda path: path.name):
            if entry.name in excluded or entry.name.endswith(".llm-api-key"):
                continue
            if entry.is_symlink():
                raise ValueError("Candidate must not contain symlinks")
            if entry.is_dir():
                walk(entry)
            elif entry.is_file():
                record = [entry.relative_to(root).as_posix(), 0o755 if entry.stat().st_mode & 0o111 else 0o644,
                          hashlib.sha256(entry.read_bytes()).hexdigest()]
                digest.update(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    walk(root)
    return digest.hexdigest()


def verify_run_source(repo: Path, manifest: dict, inputs: dict) -> dict:
    """封存前核对初始 Candidate 及挂载清单；清单摘要也包含目录权限。"""
    checks = []

    def check(component: str, expected: str | None, read) -> None:
        actual = None
        error_type = None
        try:
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise ValueError("Run did not record a source digest")
            actual = read()
            status = "matched" if actual == expected else "changed"
        except (OSError, ValueError, KeyError, TypeError) as error:
            status = "unavailable"
            error_type = type(error).__name__
        checks.append({"component": component, "status": status,
                       "expected_sha256": expected, "actual_sha256": actual,
                       **({"error_type": error_type} if error_type else {})})

    candidate = repo / "evolution/experiments" / manifest["experiment_id"] / "candidate"
    check("candidate", inputs.get("candidate_sha256"), lambda: candidate_digest(candidate))
    trees = inputs.get("harness_trees", {})
    contract = None
    try:
        contract = resolve(inputs["source_id"], repo=repo)
    except (OSError, ValueError, KeyError, TypeError):
        pass

    def snapshot_digest(value: dict) -> str:
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                         separators=(",", ":")).encode("utf-8")).hexdigest()

    def current_tree(name: str) -> str:
        if contract is None:
            raise ValueError("Run source can no longer be resolved")
        return snapshot_digest(tree_digest(repo, Path(contract[name])))

    for name in ("workspace", "presets", "managed"):
        frozen = trees.get(name) if isinstance(trees, dict) else None
        check(name, snapshot_digest(frozen) if isinstance(frozen, dict) else None,
              lambda name=name: current_tree(name))
    implementation = inputs.get("evaluation_implementation")
    if isinstance(implementation, dict):
        check("evaluation_implementation", snapshot_digest(implementation),
              lambda: snapshot_digest(evaluation_implementation()))
    statuses = {item["status"] for item in checks}
    status = "changed" if "changed" in statuses else "unavailable" if "unavailable" in statuses else "matched"
    return {"status": status, "reason": "source-changed" if status == "changed" else
            "source-unavailable" if status == "unavailable" else None, "checks": checks}


def git_version(repo: Path) -> dict:
    def git(*args: str) -> tuple[int, str]:
        completed = subprocess.run(
            ["git", *args], cwd=repo, text=True, capture_output=True, check=False, timeout=60
        )
        return completed.returncode, completed.stdout.strip()

    commit_code, commit = git("rev-parse", "HEAD")
    status_code, status = git("status", "--porcelain")
    if commit_code != 0 or status_code != 0:
        return {"commit": None, "dirty": None, "detail": "无法读取 Git 版本"}
    changed = [line for line in status.splitlines() if line.strip()]
    return {"commit": commit, "dirty": bool(changed), "changed_path_count": len(changed)}


def read_flat_yaml(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or ":" not in stripped:
                continue
            key, _, value = stripped.partition(":")
            if key in values:
                raise ValueError(f"duplicate key in {path.name}: {key}")
            raw = value.strip()
            if raw.startswith('"') and raw.endswith('"'):
                raw = json.loads(raw)
                if not isinstance(raw, str):
                    raise ValueError(f"invalid string value in {path.name}: {key}")
            values[key] = raw
    return values


def read_change_yaml(path: Path) -> dict:
    """change.yaml 可以包含继承来源和特性等嵌套数据。Run 清单仍使用原有标量合同。"""
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a YAML mapping")
    return value


def write_flat_yaml(path: Path, values: dict[str, str]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}: {json.dumps(value, ensure_ascii=False)}\n")


def append_jsonl(path: Path, value: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_report(
    path: Path,
    manifest: dict[str, str],
    summary: dict,
    rows: list[dict],
    executor: str | None,
    case_contracts: dict[str, dict] | None = None,
    analysis: dict | None = None,
    selection_mode: str | None = None,
    gaps: list[dict] | None = None,
    comparison_markdown: str | None = None,
) -> None:
    def cell(value: object) -> str:
        return str(value).replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", "<br>")

    machine_counts = summary.get("machine_trial_verdict_counts", summary.get("verdict_counts", {}))
    machine_overall = summary.get("machine_overall_verdict", summary.get("overall_verdict"))
    effective = summary.get("effective_verdict", summary.get("overall_verdict"))
    review_counts = summary.get("reviewed_case_verdict_counts")
    review_status = summary.get("review_status", "legacy")
    reviews = {
        item["case_id"]: item
        for scene in (analysis or {}).get("scenes", [])
        for item in scene.get("case_reviews", [])
    }
    lines = [
        "# 测试评估报告",
        "",
        "> 本文件由 `run_record.py finalize` 根据本 Run 的结构化记录自动生成，请勿手工编辑。",
        "",
        f"- Run：`{manifest['run_id']}`",
        f"- Experiment：`{manifest['experiment_id']}`",
        f"- Agent：`{manifest['agent_id']}`",
        f"- 状态：{STATUS_ZH.get(manifest['status'], manifest['status'])}",
        f"- 有效结论：{VERDICT_ZH.get(effective, effective)}",
        f"- 机器结论：{VERDICT_ZH.get(machine_overall, machine_overall)}",
        f"- 证据复核：`{review_status}`",
        f"- 开始时间：`{manifest['created_at']}`",
        f"- 完成时间：`{manifest['finished_at']}`",
    ]
    if executor:
        lines.append(f"- 执行通道：`{executor}`")
    if selection_mode:
        lines.append(f"- Case 选择：`{selection_mode}`")
    source_verification = summary.get("source_verification")
    if source_verification:
        lines.append(f"- 封存来源核对：`{source_verification['status']}`")
        if source_verification["status"] != "matched":
            changed = ", ".join(item["component"] for item in source_verification["checks"]
                                if item["status"] != "matched")
            lines.extend(["", f"`{source_verification['reason']}`：{changed} 与初始锁定来源不一致或无法读取。"
                          "原始 Case 结果保留，本 Run 不能用于证明锁定来源通过；请固定来源后重新运行。"])
    lines.extend([
        "",
        "## 统计",
        "",
        "| 口径 | 总数 | 已完成 | 执行错误 | 已跳过 | 通过 | 失败 | 无法判定 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| 机器 Trial | {summary['trial_count']} | {summary['execution_status_counts']['completed']} | "
            f"{summary['execution_status_counts']['error']} | "
            f"{summary['execution_status_counts']['skipped']} | "
            f"{machine_counts['passed']} | {machine_counts['failed']} | {machine_counts['inconclusive']} |"
        ),
    ])
    if review_counts is not None:
        lines.append(
            f"| 证据复核 Case | {summary['reviewed_case_count']} | - | - | - | "
            f"{review_counts['passed']} | {review_counts['failed']} | {review_counts['inconclusive']} |"
        )
    lines.extend([
        "",
        "机器 Trial 与证据复核 Case 是两种口径；有效结论优先采用完整证据复核。未选场景不代表通过。",
        "",
    ])
    if analysis and analysis.get("scenes"):
        lines.extend([
            "## 场景覆盖与归因",
            "",
            "| 场景 | 定义 Case | 已选 | 机器通过 | 机器失败 | 机器无法判定 | 未执行 | 复核状态 | 复核通过/失败/无法判定 |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
        ])
        for scene in analysis["scenes"]:
            counts = scene.get("machine_counts", scene.get("counts"))
            scene_reviews = scene.get("case_reviews", [])
            reviewed = {name: sum(item.get("reviewed_verdict") == name for item in scene_reviews) for name in VERDICTS}
            lines.append(
                f"| {cell(scene['scene'])} | {len(scene['case_ids'])} | "
                f"{len(scene['selected_case_ids'])} | "
                f"{counts['passed']} | {counts['failed']} | {counts['inconclusive']} | "
                f"{counts['not_executed']} | {scene.get('review_status', scene.get('status'))} | "
                f"{reviewed['passed']}/{reviewed['failed']}/{reviewed['inconclusive']} |"
            )
        lines.extend(["### 缺口与归因", ""])
        findings = [(scene["scene"], item) for scene in analysis["scenes"] for item in scene.get("findings", [])]
        if not findings:
            lines.extend(["未形成结构化缺口与根因假设；这不表示不存在缺口。", ""])
        for scene_name, finding in findings:
            refs = "、".join(f"[{cell(ref)}]({ref})" for ref in finding["evidence_refs"])
            lines.extend([
                f"#### {cell(scene_name)} · {cell(finding['category'])}",
                "",
                f"- 观察到的缺口：{cell(finding['observed_gap'])}",
                f"- 根因假设：{cell(finding['root_cause_hypothesis'])}",
                f"- 支持 Case：{', '.join(finding['support_case_ids'])}；证据：{refs}",
                f"- 反例 Case：{', '.join(finding['counterexample_case_ids']) or '无'}",
                f"- 替代解释：{cell(finding['alternative'])}",
                f"- 证伪方法：{cell(finding['falsification'])}",
                "",
            ])

        lines.extend(["### 人工记录的研究缺口", ""])
        if gaps:
            lines.extend([
                "| 分类 | 标题 | 观察 | 下一步 | 证据 |",
                "| --- | --- | --- | --- | --- |",
            ])
            for gap in gaps:
                ref = gap.get("evidence_ref")
                evidence = f"[{cell(ref)}]({ref})" if ref else "-"
                lines.append(
                    f"| {cell(gap['classification'])} | {cell(gap['title'])} | {cell(gap['observed'])} | "
                    f"{cell(gap['next_step'])} | {evidence} |"
                )
            lines.append("")
        else:
            lines.extend(["本 Run 未追加人工研究缺口。", ""])
    lines.extend([
        "## Case 结果与证据复核",
        "",
    ])
    if analysis:
        lines.extend([
            cell(analysis.get("review_reason", "历史 Run 未记录统一复核状态。")),
            "",
        ])
    lines.extend([
        "有逐 Case 复核时，判定说明采用复核理由；否则采用机器观察。原始机器观察保留在 [`results.jsonl`](results.jsonl)。",
        "",
        "| Case | 输入 | 判定依据 | 执行状态 | 机器结论 | 复核结论 | 是否修正 | 判定说明 | 证据 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in rows:
        evidence_ref = row["evidence_ref"]
        contract = (case_contracts or {}).get(row["input_id"], {})
        basis = cell(contract.get("expected_behavior", ""))
        verdict = VERDICT_ZH.get(row["verdict"], row["verdict"])
        reviewed = reviews.get(row["input_id"])
        reviewed_verdict = VERDICT_ZH[reviewed["reviewed_verdict"]] if reviewed else "-"
        corrected = (
            "是" if reviewed and reviewed["machine_verdict"] != reviewed["reviewed_verdict"]
            else "否" if reviewed else "-"
        )
        decision_reason = cell(reviewed["reason"] if reviewed else row["observation"])
        evidence_refs = list(dict.fromkeys([
            evidence_ref,
            *(reviewed["evidence_refs"] if reviewed else []),
        ]))
        evidence = "、".join(f"[{cell(ref)}]({ref})" for ref in evidence_refs)
        case_label = f"`{cell(row['input_id'])}`"
        if row["execution_status"] == "skipped":
            case_label = f"~~{case_label}~~"
        lines.append(
            f"| {case_label} | {cell('<br>'.join(contract.get('inputs', [])))} | {basis} | "
            f"{EXECUTION_STATUS_ZH.get(row['execution_status'], row['execution_status'])} | "
            f"{verdict} | {reviewed_verdict} | {corrected} | {decision_reason} | {evidence} |"
        )
    if not rows:
        lines.append("| - | - | - | - | - | - | - | 本 Run 未记录 Case 结果。 | - |")
    if comparison_markdown:
        lines.extend(["", comparison_markdown])
    lines.extend([
        "",
        "## 结构化记录",
        "",
        "机器结果、证据复核与后续分析以 [`summary.json`](summary.json)、[`results.jsonl`](results.jsonl) 和 [`analysis.json`](analysis.json) 为准。人工缺口以 `gaps.jsonl` 为准（如存在）。",
        "",
    ])
    path.write_text("\n".join(lines), encoding="utf-8")


def case_contracts_for(run_dir: Path) -> dict[str, dict]:
    value = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
    cases = value.get("evaluation_cases", []) if isinstance(value, dict) else []
    return {
        case["case_id"]: case
        for case in cases
        if isinstance(case, dict) and isinstance(case.get("case_id"), str)
    }


def load_run_manifest(repo: Path, run_id: str) -> tuple[Path, dict[str, str]]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise ValueError("run 必须是 run-<UUIDv4>")
    matches = []
    experiments = repo / "evolution/experiments"
    if experiments.is_dir():
        for experiment in experiments.iterdir():
            run_dir = experiment / "runs" / run_id
            if run_dir.is_dir() and not run_dir.is_symlink():
                matches.append(run_dir)
    if len(matches) != 1:
        raise ValueError(f"unknown or ambiguous run: {run_id}")
    run_dir = matches[0]
    return run_dir, read_flat_yaml(run_dir / "run.yaml")


def selected_input_ids(run_dir: Path) -> set[str]:
    value = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
    cases = value.get("evaluation_cases") if isinstance(value, dict) else None
    identifiers = [case.get("case_id") for case in cases] if isinstance(cases, list) else None
    if not isinstance(identifiers, list) or not identifiers \
            or any(not isinstance(identifier, str) or not identifier for identifier in identifiers):
        raise ValueError("inputs.lock.json 缺少有效的 Case 锁定")
    return set(identifiers)


def validate_evidence_ref(run_dir: Path | None, value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("evidence_ref must be a non-empty relative path")
    relative = Path(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError("evidence_ref must be a safe relative path")
    if run_dir is None:
        return
    target = run_dir / relative
    material = target.is_file() and not target.is_symlink() and target.stat().st_size > 0
    if target.is_dir() and not target.is_symlink():
        material = any(path.is_file() and not path.is_symlink() and path.stat().st_size > 0
                       for path in target.rglob("*"))
    if not material:
        raise ValueError("evidence_ref must point to material evidence inside the Run")


def validate_trial_row(
    run_id: str,
    row: dict,
    allowed_input_ids: set[str] | None = None,
    run_dir: Path | None = None,
) -> None:
    missing = [field for field in RESULT_FIELDS if field not in row]
    if missing:
        raise ValueError("trial row missing fields: " + ", ".join(missing))
    if row["run_id"] != run_id:
        raise ValueError("trial row run_id must match the selected Run")
    for field in ("trial_id", "input_id", "observation"):
        if not isinstance(row[field], str) or not row[field].strip():
            raise ValueError(f"{field} must be a non-empty string")
    if allowed_input_ids is not None and row["input_id"] not in allowed_input_ids:
        raise ValueError("input_id must be selected by this Run's evaluation contract")
    if not isinstance(row["execution_status"], str) or row["execution_status"] not in EXECUTION_STATUSES:
        raise ValueError("execution_status must be one of completed/error/skipped")
    if not isinstance(row["verdict"], str) or row["verdict"] not in VERDICTS:
        raise ValueError("verdict must be one of passed/failed/inconclusive")
    if row["execution_status"] != "completed" and row["verdict"] != "inconclusive":
        raise ValueError("error/skipped execution must have inconclusive verdict")
    if row["execution_status"] == "error" and not (
        isinstance(row.get("failure_reason"), str) and row["failure_reason"].strip()
    ):
        raise ValueError("error execution must carry failure_reason")
    validate_evidence_ref(run_dir, row["evidence_ref"])


def run_view(repo: Path, run_id: str, case_id: str | None = None) -> dict:
    run_dir, manifest = load_run_manifest(repo, run_id)
    inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
    locked_cases = inputs.get("evaluation_cases")
    # 历史 Run 只有选择记录时，保留未知合同，不用当前定义补造冻结事实。
    frozen = {case["case_id"]: case for case in locked_cases} if isinstance(locked_cases, list) else {
        selected_id: None for selected_id in inputs.get("evaluation_selection", {}).get("case_ids", [])
    }
    if case_id and case_id not in frozen:
        raise ValueError(f"Run 未选择 Case：{case_id}")
    evaluation_path = repo / manifest["evaluation_ref"]
    current = load_evaluation(evaluation_path)["cases"] if evaluation_path.is_file() else {}
    rows_path = run_dir / "results.jsonl"
    rows = [json.loads(line) for line in rows_path.read_text(encoding="utf-8").splitlines() if line.strip()] if rows_path.is_file() else []
    analysis_path = run_dir / "analysis.json"
    analysis = json.loads(analysis_path.read_text(encoding="utf-8")) if analysis_path.is_file() else {}
    reviews = {item["case_id"]: item for scene in analysis.get("scenes", [])
               for item in scene.get("case_reviews", [])}
    findings = [item for scene in analysis.get("scenes", []) for item in scene.get("findings", [])]
    summary_path = run_dir / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() else None
    image_path = run_dir / "evidence/dsh-image.json"
    image = json.loads(image_path.read_text(encoding="utf-8")) if image_path.is_file() else None
    missing = []
    if not isinstance(locked_cases, list):
        missing.append("inputs.lock.json 未冻结 Case 定义，无法判断合同是否变化")
    if summary is None:
        missing.append("summary.json")
    if image is None:
        missing.append("evidence/dsh-image.json")
    cases = []
    for selected_id, contract in frozen.items():
        if case_id and selected_id != case_id:
            continue
        selected_rows = [row for row in rows if row["input_id"] == selected_id]
        review = reviews.get(selected_id)
        evidence_dir = run_dir / "evidence" / selected_id
        response_path = evidence_dir / "response.json"
        response = json.loads(response_path.read_text(encoding="utf-8")) if response_path.is_file() else None
        trace_path = evidence_dir / "trace.jsonl"
        session_created_at = None
        if trace_path.is_file():
            with trace_path.open(encoding="utf-8") as trace:
                first_line = trace.readline()
            if first_line.strip():
                created = json.loads(first_line).get("event", {}).get("createdAt")
                if isinstance(created, (int, float)):
                    session_created_at = datetime.fromtimestamp(created / 1000, timezone.utc).isoformat()
        refs = list(dict.fromkeys([
            *(row["evidence_ref"] for row in selected_rows),
            *(review.get("evidence_refs", []) if review else []),
        ]))
        evidence = []
        for ref in refs:
            try:
                validate_evidence_ref(run_dir, ref)
                evidence.append({"path": (run_dir / ref).relative_to(repo).as_posix(), "present": True})
            except ValueError:
                evidence.append({"path": ref, "present": False})
                missing.append(f"{selected_id}: {ref}")
        checks_path = evidence_dir / "checks.json"
        checks = json.loads(checks_path.read_text(encoding="utf-8")) if checks_path.is_file() else None
        calls = {}
        tools_path = evidence_dir / "tools.jsonl"
        if tools_path.is_file():
            for line in tools_path.read_text(encoding="utf-8").splitlines():
                event = json.loads(line).get("event", {})
                data = event.get("data", {})
                if event.get("type") == "tool/call":
                    calls[data.get("callId")] = {"name": data.get("name"), "status": "no_result"}
                elif event.get("type") == "tool/result":
                    message = data.get("message", {})
                    call_id = message.get("source", {}).get("callId")
                    if call_id in calls:
                        error = data.get("error")
                        calls[call_id]["status"] = "error" if error or message.get("isError") else "ok" if message else "unknown"
                        calls[call_id]["error_code"] = error.get("code") if isinstance(error, dict) else None
        if not selected_rows:
            missing.append(f"{selected_id}: results.jsonl")
        if checks is None:
            missing.append(f"{selected_id}: checks.json")
        cases.append({
            "case_id": selected_id,
            "frozen": contract,
            "current": current.get(selected_id),
            "contract_changed": current.get(selected_id) != contract if contract is not None else None,
            "trials": selected_rows,
            "output": response.get("assistant_texts") if response else None,
            "actual_routes": [turn.get("route") for turn in response.get("turns", [])] if response else None,
            "registered_tools": [turn.get("tool_names") for turn in response.get("turns", [])] if response else None,
            "tool_calls": list(calls.values()),
            "review": review,
            "findings": [finding for finding in findings if selected_id in finding.get("support_case_ids", [])
                         or selected_id in finding.get("counterexample_case_ids", [])],
            "load_observation": {key: checks.get(key) for key in (
                "session_id", "session_preset", "session_workspace", "preset_matches", "workspace_matches",
                "guard",
            )} if checks else None,
            "session_created_at": session_created_at,
            "raw_evidence": {name: {"path": (evidence_dir / name).relative_to(repo).as_posix(),
                                    "present": (evidence_dir / name).is_file()}
                             for name in ("response.json", "trace.jsonl", "tools.jsonl", "judge.json",
                                          "judge-trace.jsonl", "checks.json")},
            "evidence": evidence,
        })
    return {
        "run_id": run_id,
        "run_path": run_dir.relative_to(repo).as_posix(),
        "manifest": manifest,
        "source": {**{key: inputs.get(key) for key in (
            "source_id", "baseline_ref", "git_version", "evaluation_sha256",
            "executor", "model", "created_at", "compare_to_run_id", "candidate_sha256",
            "review_mode", "configured_capabilities", "dependency_env",
            "program_origin", "asset_origin", "evaluation_implementation", "declared_guard",
        )}, "candidate_trees": {key: {"tree_sha256": value.get("tree_sha256"),
                                        "file_count": value.get("file_count")}
                                  for key, value in inputs.get("harness_trees", {}).items()},
            "inputs_lock_path": (run_dir / "inputs.lock.json").relative_to(repo).as_posix()},
        "candidate_path": f"evolution/experiments/{manifest['experiment_id']}/candidate",
        "image": image,
        "summary": summary,
        "uncovered_case_ids": [item["case_id"] for item in inputs.get("case_catalog", [])
                               if item["case_id"] not in frozen],
        "cases": cases,
        "missing": missing,
    }


def comparison_run_view(repo: Path, run_id: str, agent_id: str | None = None,
                        case_id: str | None = None) -> dict:
    run_dir, manifest = load_run_manifest(repo, run_id)
    if agent_id and manifest.get("agent_id") != agent_id:
        raise ValueError("只能比较同一 Agent 的 Run")
    if manifest.get("status") not in FINAL_STATUSES:
        raise ValueError("对照 Run 必须已封存")
    for field, name in (("results_sha256", "results.jsonl"), ("summary_sha256", "summary.json"),
                        ("analysis_sha256", "analysis.json"), ("report_sha256", "report.md")):
        expected = manifest.get(field)
        if not expected or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"对照 Run 缺少有效 {field}")
        path = run_dir / name
        if path.is_symlink() or (not path.is_file() and (name != "results.jsonl" or path.exists())):
            raise ValueError(f"对照 Run 缺少有效 {name}")
        actual = hashlib.sha256(path.read_bytes() if path.is_file() else b"").hexdigest()
        if actual != expected:
            raise ValueError(f"对照 Run {name} 摘要不匹配")
    return run_view(repo, run_id, case_id)


def compare_views(left: dict, right: dict) -> dict:
    completed = subprocess.run(
        ["node", str(ADAPTER / "run-comparison.ts")],
        input=json.dumps({"left": left, "right": right}, ensure_ascii=False),
        text=True, capture_output=True, check=False, timeout=30,
    )
    if completed.returncode:
        raise ValueError("Run 对照生成失败")
    return json.loads(completed.stdout)


def run_index_facts(run_dir: Path, manifest: dict) -> dict:
    """从本 Run 的冻结用例与结果生成列表摘要，不读取当前用例或轨迹。"""
    facts = {"title": None, "case_scope": None, "case_counts": None, "effective_verdict": None}
    summary_path = run_dir / "summary.json"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() and not summary_path.is_symlink() else None
    except (OSError, ValueError):
        summary = None
    if manifest.get("status") == "completed" and isinstance(summary, dict) and summary.get("run_id", manifest.get("run_id")) == manifest.get("run_id"):
        verdict = summary.get("effective_verdict")
        if verdict is None:
            verdict = summary.get("machine_overall_verdict")
        if verdict is None:
            verdict = summary.get("overall_verdict")
        if verdict in VERDICTS:
            facts["effective_verdict"] = verdict

    inputs_path = run_dir / "inputs.lock.json"
    try:
        inputs = json.loads(inputs_path.read_text(encoding="utf-8")) if inputs_path.is_file() and not inputs_path.is_symlink() else None
    except (OSError, ValueError):
        inputs = None
    if not isinstance(inputs, dict):
        return facts
    frozen = inputs.get("evaluation_cases")
    if isinstance(frozen, list):
        selected = [item for item in frozen if isinstance(item, dict) and isinstance(item.get("case_id"), str)]
        case_ids = list(dict.fromkeys(item["case_id"] for item in selected))
    else:
        selected = []
        selection = inputs.get("evaluation_selection")
        raw_ids = selection.get("case_ids") if isinstance(selection, dict) else None
        if not isinstance(raw_ids, list):
            return facts
        case_ids = list(dict.fromkeys(item for item in raw_ids if isinstance(item, str)))
    if not case_ids:
        return facts
    facts["case_scope"] = f"{len(case_ids)} 项已选用例"
    catalog = inputs.get("case_catalog")
    scene_by_id = {item["case_id"]: item.get("scene") for item in catalog
                   if isinstance(item, dict) and isinstance(item.get("case_id"), str) and isinstance(item.get("scene"), str)} if isinstance(catalog, list) else {}
    scenes = {scene_by_id.get(case_id) for case_id in case_ids}
    scene = next(iter(scenes)) if len(scenes) == 1 else None
    scene_name = scene.strip() if isinstance(scene, str) else ""
    first_title = selected[0].get("title") if selected else None
    if len(case_ids) == 1 and isinstance(first_title, str) and first_title.strip():
        facts["title"] = first_title.strip()
    elif scene_name and scene_name not in ("未分组", "未分类", "无分组"):
        facts["title"] = scene_name if scene_name.endswith(("评测", "验证")) else f"{scene_name}评测"
    elif isinstance(first_title, str) and first_title.strip():
        facts["title"] = f"{first_title.strip()}等 {len(case_ids)} 项用例"
    else:
        facts["title"] = f"{len(case_ids)} 项用例评测"

    results_path = run_dir / "results.jsonl"
    analysis_path = run_dir / "analysis.json"
    try:
        if results_path.is_symlink() or analysis_path.is_symlink():
            return facts
        rows = [json.loads(line) for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()] if results_path.is_file() else []
        analysis = json.loads(analysis_path.read_text(encoding="utf-8")) if analysis_path.is_file() else {}
        if not isinstance(analysis, dict) or not isinstance(analysis.get("scenes", []), list) or not all(isinstance(row, dict) for row in rows):
            return facts
    except (OSError, ValueError):
        return facts
    trials = {case_id: [] for case_id in case_ids}
    for row in rows:
        if isinstance(row.get("input_id"), str) and row["input_id"] in trials:
            trials[row["input_id"]].append(row.get("verdict"))
    reviews = {item["case_id"]: item.get("reviewed_verdict") for scene in analysis.get("scenes", []) if isinstance(scene, dict)
               for item in (scene.get("case_reviews") if isinstance(scene.get("case_reviews"), list) else [])
               if isinstance(item, dict) and isinstance(item.get("case_id"), str)}
    counts = {key: 0 for key in (*VERDICTS, "mixed", "pending")}
    for case_id in case_ids:
        reviewed = reviews.get(case_id)
        verdicts = trials[case_id]
        observed = reviewed if reviewed in VERDICTS else ("pending" if not verdicts or any(verdict not in VERDICTS for verdict in verdicts)
                   else verdicts[0] if all(verdict == verdicts[0] for verdict in verdicts) else "mixed")
        counts[observed] += 1
    facts["case_counts"] = {"total": len(case_ids), **counts}
    return facts


def agent_experiments(repo: Path, agent: str) -> list[dict]:
    experiments = []
    for root in sorted((repo / "evolution/experiments").glob(f"EXP-{agent}-*")):
        match = EXPERIMENT_RE.fullmatch(root.name)
        if not root.is_dir() or root.is_symlink() or not match or match.group(1) != agent:
            continue
        change = read_change_yaml(root / "change.yaml")
        runs = []
        for path in sorted((root / "runs").glob("run-*/run.yaml")):
            if path.is_symlink() or path.parent.is_symlink():
                continue
            manifest = read_flat_yaml(path)
            runs.append({**{key: manifest.get(key) for key in ("run_id", "status", "created_at", "finished_at")},
                         **run_index_facts(path.parent, manifest)})
        experiments.append({"experiment_id": root.name, "status": change.get("status"), "runs": runs})
    return experiments


def command_index(repo: Path, args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.agent):
        raise ValueError("agent 必须是小写 kebab-case")
    print(json.dumps({"agent_id": args.agent, "evaluation_path": f"agents/{args.agent}/evaluation.md",
                      "experiments": agent_experiments(repo, args.agent)}, ensure_ascii=False, indent=2))


def command_overview(repo: Path) -> None:
    """一次列出全部 Agent 的 Run 索引；页面汇总读取不按 Agent 重复启动解析进程。"""
    agents = []
    for path in sorted((repo / "agents").glob("*")):
        agent = path.name
        if not path.is_dir() or path.is_symlink() or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", agent):
            continue
        agents.append({"agent_id": agent, "evaluation_path": f"agents/{agent}/evaluation.md",
                       "experiments": agent_experiments(repo, agent)})
    print(json.dumps({"agents": agents}, ensure_ascii=False, indent=2))


def command_show(repo: Path, args: argparse.Namespace) -> None:
    print(json.dumps(run_view(repo, args.run, args.case), ensure_ascii=False, indent=2))


def command_compare(repo: Path, args: argparse.Namespace) -> None:
    left = comparison_run_view(repo, args.left, case_id=args.case)
    right = comparison_run_view(repo, args.right, left["manifest"]["agent_id"], args.case)
    result = compare_views(left, right)
    result.pop("markdown")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def command_init(repo: Path, args: argparse.Namespace) -> None:
    contract = resolve(args.source, repo=repo)
    experiment_id = contract.get("experiment_id")
    agent_id = contract.get("agent_id")
    match = EXPERIMENT_RE.fullmatch(experiment_id or "")
    if not match or match.group(1) != agent_id:
        raise ValueError("source must resolve to a consistent Experiment and Agent")
    experiment = repo / "evolution/experiments" / experiment_id
    if not experiment.is_dir() or experiment.is_symlink():
        raise ValueError(f"unknown experiment: {experiment_id}")
    change = read_change_yaml(experiment / "change.yaml")
    baseline_ref = args.baseline_ref or change.get("baseline_ref", "")
    if not valid_baseline_ref(baseline_ref):
        raise ValueError("baseline_ref must be git:<commit>, release:<id> or none:first-experiment")
    evaluation_relative = Path("agents") / agent_id / "evaluation.md"
    evaluation_path = repo / evaluation_relative
    evaluation = load_evaluation(evaluation_path)
    cases = execution_from(evaluation, args.case)
    catalog = evaluation["catalog"]
    selected = [case["case_id"] for case in cases]
    expected = [item["case_id"] for item in catalog if args.selection_mode == "full"
                or args.selection_mode == "fast" and item["fast"]]
    if args.selection_mode != "explicit" and selected != expected:
        raise ValueError("selection_mode 与所选 Case 不一致")
    evaluation_ref = evaluation_relative.as_posix()
    version = git_version(repo)
    comparison_ref = getattr(args, "compare_to", None)
    if comparison_ref:
        comparison_run_view(repo, comparison_ref, agent_id)
    run_id = "run-" + str(uuid.uuid4())
    run_dir = experiment / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    try:
        source_digest = candidate_digest(experiment / "candidate")
        inputs = {
            "schema_version": "2.0",
            "run_id": run_id,
            "source_id": contract["source_id"],
            "source_kind": contract["source_kind"],
            "baseline_ref": baseline_ref,
            "candidate_sha256": source_digest,
            "created_at": utc_now(),
            "harness_trees": {
                "workspace": tree_digest(repo, Path(contract["workspace"])),
                "presets": tree_digest(repo, Path(contract["presets"])),
                "managed": tree_digest(repo, Path(contract["managed"])),
            },
            "reference_tree": tree_digest(repo, Path(contract["reference_root"])) if contract.get("reference_root") else None,
            "evaluation_sha256": cases_digest(cases),
            "evaluation_cases": cases,
            "case_catalog": catalog,
            "selection_mode": args.selection_mode,
            "review_mode": args.review_mode or ("ai" if args.selection_mode == "full" else "none"),
            "configured_capabilities": contract["config_markers"],
            "declared_guard": contract.get("guard"),
            "evaluation_implementation": evaluation_implementation(),
            "dependency_env": {name: bool(os.environ.get(name)) for name in
                               contract["required_env_names"] + contract["optional_env_names"]},
            "git_version": version,
            "program_origin": {**git_version(PROGRAM_ROOT), "root": str(PROGRAM_ROOT)},
            "asset_origin": {**version, "workspace_id": workspace_id(repo),
                             "candidate_sha256": source_digest},
        }
        # 固定外部接口边界样本；两侧比较不能仅凭相同用户输入推定工具返回一致。
        fixture = experiment / "candidate/dsh/managed/compute-workflow/fixtures.json"
        if fixture.exists():
            if fixture.is_symlink() or not fixture.is_file():
                raise ValueError("外部输入样本必须是 Candidate 内普通文件")
            frozen_fixture = fixture.read_bytes()
            fixture_value = json.loads(frozen_fixture)
            mode = fixture_value.get("mode")
            if mode not in {"mock-replay", "replay"}:
                raise ValueError("外部输入样本必须明确标记 mock-replay 或 replay")
            inputs["external_inputs"] = {"mode": mode,
                                         "fixture_sha256": hashlib.sha256(frozen_fixture).hexdigest()}
            (run_dir / "evidence").mkdir(exist_ok=True)
            (run_dir / "evidence/external-inputs.json").write_bytes(frozen_fixture)
        if args.model:
            inputs["model"] = args.model
        if args.executor:
            inputs["executor"] = args.executor
        if comparison_ref:
            inputs["compare_to_run_id"] = comparison_ref
        with (run_dir / "inputs.lock.json").open("w", encoding="utf-8") as handle:
            json.dump(inputs, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        manifest = {
            "schema_version": "2.0",
            "run_id": run_id,
            "experiment_id": experiment_id,
            "agent_id": agent_id,
            "kind": args.kind,
            "status": "planned",
            "created_at": utc_now(),
            "source_id": contract["source_id"],
            "baseline_ref": baseline_ref,
            "evaluation_ref": evaluation_ref,
        }
        write_flat_yaml(run_dir / "run.yaml", manifest)
    except BaseException:
        shutil.rmtree(run_dir)
        raise
    print(run_id)


def command_record(repo: Path, args: argparse.Namespace) -> None:
    run_dir, manifest = load_run_manifest(repo, args.run)
    if manifest.get("status") not in {"planned", "running"}:
        raise ValueError("finalized Run refuses new results")
    if args.trial_file == "-":
        row = json.loads(sys.stdin.read())
    else:
        row = json.loads(Path(args.trial_file).read_text(encoding="utf-8"))
    if not isinstance(row, dict):
        raise ValueError("trial must be a JSON object")
    validate_trial_row(args.run, row, selected_input_ids(run_dir), run_dir)
    results = run_dir / "results.jsonl"
    if results.is_file():
        for line in results.read_text(encoding="utf-8").splitlines():
            if line.strip() and json.loads(line).get("trial_id") == row["trial_id"]:
                raise ValueError("trial_id duplicated inside the Run")
    append_jsonl(results, row)
    if manifest["status"] == "planned":
        manifest["status"] = "running"
        write_flat_yaml(run_dir / "run.yaml", manifest)
    print(args.run)


def load_gaps(run_dir: Path, run_id: str) -> list[dict]:
    path = run_dir / "gaps.jsonl"
    if not path.is_file():
        return []
    rows = []
    seen = set()
    required = {"gap_id", "run_id", "classification", "title", "observed", "next_step"}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or set(row) - required - {"evidence_ref"} or not required <= set(row) \
                or not isinstance(row["gap_id"], str) or not row["gap_id"].startswith("gap-") \
                or row["gap_id"] in seen or row["run_id"] != run_id \
                or not isinstance(row["classification"], str) \
                or row["classification"] not in GAP_CLASSIFICATIONS \
                or any(not isinstance(row[key], str) or not row[key].strip()
                       for key in ("title", "observed", "next_step")):
            raise ValueError("gaps.jsonl 包含无效研究缺口")
        if "evidence_ref" in row:
            validate_evidence_ref(run_dir, row["evidence_ref"])
        seen.add(row["gap_id"])
        rows.append(row)
    return rows


def command_gap(repo: Path, args: argparse.Namespace) -> None:
    run_dir, manifest = load_run_manifest(repo, args.run)
    if manifest.get("status") in FINAL_STATUSES:
        raise ValueError("finalized Run refuses new gaps")
    if not args.title.strip() or not args.observed.strip() or not args.next_step.strip():
        raise ValueError("gap 必须提供非空标题、观察和下一步")
    row = {
        "gap_id": "gap-" + str(uuid.uuid4()),
        "run_id": args.run,
        "classification": args.classification,
        "title": args.title.strip(),
        "observed": args.observed.strip(),
        "next_step": args.next_step.strip(),
    }
    if args.evidence:
        validate_evidence_ref(run_dir, args.evidence)
        row["evidence_ref"] = args.evidence.strip()
    append_jsonl(run_dir / "gaps.jsonl", row)
    print(row["gap_id"])


def command_finalize(repo: Path, args: argparse.Namespace) -> None:
    run_dir, manifest = load_run_manifest(repo, args.run)
    if manifest.get("status") not in {"planned", "running"}:
        raise ValueError("Run is already finalized")
    results = run_dir / "results.jsonl"
    execution_counts = {name: 0 for name in EXECUTION_STATUSES}
    verdict_counts = {name: 0 for name in VERDICTS}
    allowed_input_ids = selected_input_ids(run_dir)
    rows = []
    if results.is_file():
        for line in results.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            validate_trial_row(args.run, row, allowed_input_ids, run_dir)
            rows.append(row)
            execution_counts[row["execution_status"]] += 1
            verdict_counts[row["verdict"]] += 1
    if verdict_counts["failed"]:
        machine_overall = "failed"
    elif verdict_counts["inconclusive"] or not sum(verdict_counts.values()):
        machine_overall = "inconclusive"
    else:
        machine_overall = "passed"
    if args.status == "completed":
        covered = {
            json.loads(line)["input_id"]
            for line in results.read_text(encoding="utf-8").splitlines()
            if line.strip()
        } if results.is_file() else set()
        if covered != allowed_input_ids:
            raise ValueError("completed Run must record every selected Case")
    inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
    source_verification = verify_run_source(repo, manifest, inputs)
    final_status = "failed" if args.status == "completed" and source_verification["status"] != "matched" else args.status
    analysis_path = run_dir / "analysis.json"
    if analysis_path.is_file():
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    else:
        analysis = analyze(run_dir, rows, inputs, status=final_status)
    validate_analysis(analysis, run_dir, rows, inputs)
    if final_status == "completed" and inputs.get("review_mode", "ai" if inputs.get("selection_mode") == "full" else "none") == "ai" \
            and analysis.get("review_status") != "completed":
        raise ValueError("已请求 AI 复核的 Run 必须完成全部已选 Case 的证据复核后才能标记 completed")
    if not analysis_path.is_file():
        with analysis_path.open("w", encoding="utf-8") as handle:
            json.dump(analysis, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    review = summarize_review(analysis)
    effective = "inconclusive" if final_status != "completed" else (
        review["overall_verdict"] if review["status"] == "completed"
        else machine_overall if review["status"] == "not_requested"
        else "inconclusive"
    )
    summary = {
        "schema_version": "3.0",
        "run_id": args.run,
        "trial_count": sum(execution_counts.values()),
        "execution_status_counts": execution_counts,
        "machine_trial_verdict_counts": verdict_counts,
        "machine_overall_verdict": machine_overall,
        "review_status": review["status"],
        "reviewed_case_count": review["case_count"],
        "reviewed_case_verdict_counts": review["verdict_counts"],
        "reviewed_overall_verdict": review["overall_verdict"],
        "effective_verdict": effective,
        "source_verification": source_verification,
    }
    gaps = load_gaps(run_dir, args.run)
    summary_path = run_dir / "summary.json"
    with summary_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    manifest["status"] = final_status
    manifest["finished_at"] = utc_now()
    comparison_markdown = None
    if inputs.get("compare_to_run_id"):
        left = comparison_run_view(repo, inputs["compare_to_run_id"], manifest["agent_id"])
        comparison_markdown = compare_views(left, run_view(repo, args.run))["markdown"]
    report_path = run_dir / "report.md"
    write_report(
        report_path, manifest, summary, rows, inputs.get("executor"),
        case_contracts_for(run_dir),
        analysis,
        inputs.get("selection_mode"),
        gaps,
        comparison_markdown,
    )
    manifest["results_sha256"] = hashlib.sha256(results.read_bytes() if results.is_file() else b"").hexdigest()
    manifest["summary_sha256"] = hashlib.sha256(summary_path.read_bytes()).hexdigest()
    manifest["report_sha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
    manifest["analysis_sha256"] = hashlib.sha256(analysis_path.read_bytes()).hexdigest()
    artifact_index = run_dir / "artifacts/index.json"
    if artifact_index.is_file():
        manifest["artifacts_sha256"] = hashlib.sha256(artifact_index.read_bytes()).hexdigest()
    gaps = run_dir / "gaps.jsonl"
    if gaps.is_file():
        manifest["gaps_sha256"] = hashlib.sha256(gaps.read_bytes()).hexdigest()
    write_flat_yaml(run_dir / "run.yaml", manifest)
    if source_verification["status"] != "matched":
        print(f"{source_verification['reason']}: Run {args.run} 已按 {final_status} 封存，有效结论 inconclusive", file=sys.stderr)
    print(args.run)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO, help="仓库根目录")
    commands = parser.add_subparsers(dest="command", required=True)
    init_parser = commands.add_parser("init", help="创建 Run 并记录输入身份")
    init_parser.add_argument("--source", required=True, help="当前支持 experiment:<id>")
    init_parser.add_argument("--case", action="append", default=[], help="必须显式选择的 Case；可重复")
    init_parser.add_argument("--kind", default="research", choices=RUN_KINDS)
    init_parser.add_argument("--baseline-ref", help="默认读取 Experiment change.yaml")
    init_parser.add_argument("--model", help="可选的预期模型标识，不改变 Runtime 设置")
    init_parser.add_argument("--executor", help="可选的执行通道标识")
    init_parser.add_argument("--compare-to", help="已封存的同 Agent Run ID，封存时在报告中加入对照")
    init_parser.add_argument("--selection-mode", choices=("fast", "full", "explicit"), default="explicit")
    init_parser.add_argument("--review-mode", choices=("ai", "none"), help="默认沿用选择档位的历史复核行为")
    record_parser = commands.add_parser("record", help="追加一条观察")
    record_parser.add_argument("--run", required=True)
    record_parser.add_argument("trial_file", help="Trial JSON 文件；- 表示标准输入")
    gap_parser = commands.add_parser("gap", help="追加一个研究缺口")
    gap_parser.add_argument("--run", required=True)
    gap_parser.add_argument("--classification", required=True, choices=GAP_CLASSIFICATIONS)
    gap_parser.add_argument("--title", required=True)
    gap_parser.add_argument("--observed", required=True)
    gap_parser.add_argument("--next-step", required=True)
    gap_parser.add_argument("--evidence", help="可选证据引用")
    finalize_parser = commands.add_parser("finalize", help="生成摘要并封存 Run")
    finalize_parser.add_argument("--run", required=True)
    finalize_parser.add_argument("--status", required=True, choices=FINAL_STATUSES)
    index_parser = commands.add_parser("index", help="按 Agent 列出 Experiment 和 Run")
    index_parser.add_argument("--agent", required=True)
    commands.add_parser("overview", help="列出全部 Agent 的 Experiment 和 Run")
    show_parser = commands.add_parser("show", help="查看 Run 的冻结口径、结果和证据")
    show_parser.add_argument("--run", required=True)
    show_parser.add_argument("--case", help="只查看一个已选 Case")
    compare_parser = commands.add_parser("compare", help="并列比较两个 Run 的共同 Case")
    compare_parser.add_argument("--left", required=True)
    compare_parser.add_argument("--right", required=True)
    compare_parser.add_argument("--case", help="只比较一个共同 Case")
    args = parser.parse_args()
    try:
        repo = args.repo.resolve()
        if not repo.is_dir():
            raise ValueError("仓库根目录不存在")
        if args.command == "init":
            command_init(repo, args)
        elif args.command == "record":
            command_record(repo, args)
        elif args.command == "gap":
            command_gap(repo, args)
        elif args.command == "finalize":
            command_finalize(repo, args)
        elif args.command == "index":
            command_index(repo, args)
        elif args.command == "overview":
            command_overview(repo)
        elif args.command == "show":
            command_show(repo, args)
        else:
            command_compare(repo, args)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"run record failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

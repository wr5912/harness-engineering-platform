from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import runpy
import signal
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest import mock
import uuid
import zipfile
from pathlib import Path
from asset_fixture import historical_assets


ROOT = Path(__file__).resolve().parents[1]
ASSETS = historical_assets()
INSPECT_SOURCE = ROOT / "runtime/research/inspect_source.py"
VALIDATE_REPOSITORY = ROOT / "runtime/research/validate_repository.py"
VALIDATE_EXPERIMENT = ROOT / "runtime/research/validate_experiment.py"
EVALUATION_CONTRACT = ROOT / "runtime/research/evaluation_contract.py"
RUN_RECORD = ROOT / "runtime/adapters/dsh-container/run_record.py"
DSH_EVAL = ROOT / "runtime/adapters/dsh-container/dsh-eval"
SCENARIO_ANALYSIS = ROOT / "runtime/adapters/dsh-container/scenario_analysis.py"
EXPERIMENT_ID = "EXP-security-operations-expert-001"
AGENT_ID = "security-operations-expert"


def run_json(script: Path, *args: object, cwd: Path = ROOT) -> tuple[subprocess.CompletedProcess[str], dict]:
    completed = subprocess.run(
        ["python3", str(script), *(str(value) for value in args)],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
        timeout=180,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
             "HARNESS_PROGRAM_ROOT": str(cwd), "HARNESS_ASSET_ROOT": str(ASSETS if cwd == ROOT else cwd)},
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - assertion detail
        raise AssertionError(f"输出不是 JSON：{completed.stdout}\nstderr={completed.stderr}") from exc
    return completed, payload


def error_codes(payload: dict) -> set[str]:
    return {item.get("code", "") for item in payload.get("errors", [])}


def copy_repository(destination: Path) -> Path:
    target = destination / "repo"
    ignored = shutil.ignore_patterns(".git", ".local", ".pytest_cache", ".code-review-graph", "__pycache__", "*.pyc", "node_modules")
    shutil.copytree(
        ROOT,
        target,
        ignore=lambda folder, names: set(ignored(folder, names)) | ({"agents", "evolution"} if Path(folder) == ROOT else set()),
    )
    # 兼容历史同根 fixture；真实业务资料来自显式数据工作区，程序不再持有副本。
    for name in ("agents", "evolution"):
        if not (target / name).exists():
            shutil.copytree(ASSETS / name, target / name,
                            ignore=shutil.ignore_patterns("node_modules", "__pycache__", "*.pyc"))
    catalog = target / "runtime/adapters/dsh-container/sources.json"
    if not catalog.exists():
        shutil.copyfile(ASSETS / "config/sources.json", catalog)
    sites = target / "config/sites.json"
    sites.parent.mkdir(parents=True, exist_ok=True)
    if not sites.exists():
        shutil.copyfile(ASSETS / "config/sites.json", sites)
    default_model = target / "config/business-model-default.json"
    if not default_model.exists():
        default_model.write_text(json.dumps({
            "schema_version": "1.2",
            "default": {"provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off"},
        }) + "\n", encoding="utf-8")
    return target


def case_contract_digest(path: Path, case_ids: list[str]) -> str:
    spec = importlib.util.spec_from_file_location("evaluation_contract_digest", EVALUATION_CONTRACT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.evaluation_digest(path, case_ids)


def evaluation_case_ids(repository: Path, *, fast_only: bool = False) -> list[str]:
    spec = importlib.util.spec_from_file_location("evaluation_case_ids", EVALUATION_CONTRACT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    evaluation = module.load_evaluation(repository / "agents" / AGENT_ID / "evaluation.md")
    return [item["case_id"] for item in evaluation["catalog"] if item["fast"]] if fast_only else evaluation["case_ids"]


def write_minimal_experiment(root: Path, *, status: str = "active", outcome: str | None = None,
                             experiment_id: str = "EXP-example-agent-001-r0123456789ab") -> Path:
    experiment = root / "evolution/experiments" / experiment_id
    (experiment / "candidate").mkdir(parents=True)
    evaluation = root / "agents/example-agent/evaluation.md"
    evaluation.parent.mkdir(parents=True)
    evaluation.write_text(
        """# 示例评测

#### U-EXAMPLE-001 最小研究输入

**用户输入**

> 最小输入。

**预期**

观察与输入一致。
""",
        encoding="utf-8",
    )
    lines = [
        'schema_version: "1.0"',
        f"experiment_id: {experiment_id}",
        "agent_id: example-agent",
        "baseline_ref: none:first-experiment",
        f"status: {status}",
    ]
    if outcome is not None:
        lines.append(f"outcome: {outcome}")
    (experiment / "change.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (experiment / "hypothesis.md").write_text("# 假设\n\n比较一个具体变化。\n", encoding="utf-8")
    (experiment / "candidate/harness.yaml").write_text('schema_version: "1.0"\nvalue: candidate\n', encoding="utf-8")
    if status == "completed":
        (experiment / "decision.md").write_text("# 决定\n\n根据观察停止本实验。\n", encoding="utf-8")
    return experiment


def release_records(release: Path) -> list[dict]:
    records = []
    for path in sorted(release.rglob("*"), key=lambda item: item.relative_to(release).as_posix()):
        relative = path.relative_to(release).as_posix()
        if not path.is_file() or relative in {"manifest.yaml", "artifact-manifest.json"}:
            continue
        data = path.read_bytes()
        records.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    return records


def write_research_release(repository: Path, name: str = "security-operations-expert-v1.0.0") -> Path:
    release = repository / "releases" / name
    release.mkdir(parents=True)
    (release / "harness.yaml").write_text('schema_version: "1.0"\nentry: dsh/workspace\n', encoding="utf-8")
    (release / "runtime.yaml").write_text('schema_version: "1.0"\nruntime: dsh\n', encoding="utf-8")
    (release / "evaluation.md").write_text("# 研究总结\n\n已记录限定范围的观察。\n", encoding="utf-8")
    (release / "README.md").write_text("# Research Release\n\n用于复现研究，不是生产部署批准。\n", encoding="utf-8")
    records = release_records(release)
    raw = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    (release / "manifest.yaml").write_text(
        "\n".join(
            [
                'schema_version: "1.0"',
                f"release_id: {name}",
                "agent_id: security-operations-expert",
                'version: "1.0.0"',
                f"source_experiment: {EXPERIMENT_ID}",
                "source_commit: " + "a" * 40,
                "evaluation_ref: evaluation.md",
                'runtime_compatibility: "DSH test-runtime"',
                f"artifact_digest: sha256:{digest}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (release / "artifact-manifest.json").write_text(
        json.dumps({"schema_version": "1.0", "tree_sha256": digest, "files": records}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return release


class SourceInspectorTests(unittest.TestCase):
    def test_clean_directory_is_read_without_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            source.mkdir()
            (source / "AGENTS.md").write_text("# 示例\n", encoding="utf-8")
            completed, payload = run_json(INSPECT_SOURCE, source)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertFalse(payload["errors"])

    def test_zip_path_traversal_is_rejected_without_extracting(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "source.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../escape.txt", "not extracted")
            completed, payload = run_json(INSPECT_SOURCE, archive)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("PATH_TRAVERSAL", error_codes(payload))
            self.assertFalse((root / "escape.txt").exists())

    def test_tar_path_traversal_is_rejected_without_extracting(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "source.tar"
            payload_file = root / "payload.txt"
            payload_file.write_text("not extracted", encoding="utf-8")
            with tarfile.open(archive, "w") as handle:
                handle.add(payload_file, arcname="../escape.txt")
            payload_file.unlink()
            completed, payload = run_json(INSPECT_SOURCE, archive)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("PATH_TRAVERSAL", error_codes(payload))
            self.assertFalse((root / "escape.txt").exists())

    def test_sensitive_filename_is_reported_without_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            source.mkdir()
            secret = "do-not-print-this-value"
            (source / ".env").write_text("TOKEN=" + secret, encoding="utf-8")
            completed, payload = run_json(INSPECT_SOURCE, source)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("SENSITIVE_FILENAME", {item["code"] for item in payload["warnings"]})
        self.assertNotIn(secret, completed.stdout)


class RepositoryValidatorTests(unittest.TestCase):
    def test_program_skill_check_does_not_require_data_business_skills(self) -> None:
        spec = importlib.util.spec_from_file_location("program_repository_validator", VALIDATE_REPOSITORY)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in module.REQUIRED_SKILLS:
                shutil.copytree(ROOT / ".agents/skills" / name, root / ".agents/skills" / name)
            errors = []
            module.validate_skills(root, errors)
            self.assertEqual(errors, [])
            self.assertNotIn("harness-evolution", module.REQUIRED_SKILLS)
            self.assertNotIn("research-eval", module.REQUIRED_SKILLS)
            shutil.rmtree(root / ".agents/skills/dsh-platform-development")
            module.validate_skills(root, errors)
            self.assertIn("SKILL_REQUIRED", error_codes({"errors": errors}))

    def test_data_workspace_validates_without_copied_program_or_standards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_minimal_experiment(root)
            (root / "agents/example-agent/manifest.yaml").write_text("agent_id: example-agent\n")
            (root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-fixture"}))
            (root / "config").mkdir()
            (root / "config/sources.json").write_text('{"schema_version":"1.1","sources":{}}')
            completed, payload = run_json(VALIDATE_REPOSITORY, root)
            self.assertEqual(completed.returncode, 0, payload)
            self.assertFalse((root / ".agents").exists())
            self.assertFalse((root / "docs").exists())

    def test_current_repository_passes_project_contract(self) -> None:
        # 程序合同由 HARNESS_PROGRAM_ROOT 定位，业务资产从独立数据根读取。
        completed, payload = run_json(VALIDATE_REPOSITORY, ROOT)
        self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))
        self.assertTrue(payload["valid"])
        self.assertIn("不代表 Experiment 结果", payload["scope"])

    def test_project_contract_does_not_require_research_slogans(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            agents = repository / "AGENTS.md"
            agents.write_text(
                agents.read_text(encoding="utf-8").replace("Research Mode", "Harness 研究流程").replace("研究优先", "需求驱动"),
                encoding="utf-8",
            )
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertEqual(completed.returncode, 0, payload)
        self.assertTrue(payload["valid"])

    def test_project_contract_still_requires_core_principles(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            agents = repository / "AGENTS.md"
            original = agents.read_text(encoding="utf-8")
            for phrase in ("LLM API Key 禁止提交或推送", "禁止过度工程化和过度安全化"):
                with self.subTest(phrase=phrase):
                    agents.write_text(original.replace(phrase, ""), encoding="utf-8")
                    completed, payload = run_json(VALIDATE_REPOSITORY, repository)
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertIn("RESEARCH_MODE", error_codes(payload))

    def test_project_skill_metadata_and_references_are_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            skill = repository / ".agents/skills/continuous-dev-progress-vs-project-vision-gap-assessment"
            metadata = skill / "agents/openai.yaml"
            original = metadata.read_text(encoding="utf-8")
            metadata.write_text(original.replace("allow_implicit_invocation: false", "allow_implicit_invocation: true"), encoding="utf-8")
            (skill / "references/presentation-spec.md").unlink()
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            metadata.write_text(original.replace("allow_implicit_invocation: false", 'allow_implicit_invocation: "false"'), encoding="utf-8")
            typed_completed, typed_payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("SKILL_OPENAI", error_codes(payload))
        self.assertIn("SKILL_RESOURCE", error_codes(payload))
        self.assertTrue(any("此技能只允许显式调用" in item["message"] for item in payload["errors"]))
        self.assertNotEqual(typed_completed.returncode, 0)
        self.assertIn("SKILL_OPENAI", error_codes(typed_payload))
        self.assertTrue(any("policy.allow_implicit_invocation 必须是 bool" in item["message"] for item in typed_payload["errors"]))

    def test_llm_api_key_ignore_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            gitignore = repository / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8").replace("*.llm-api-key", "*.local-key"),
                encoding="utf-8",
            )
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("LLM_KEY_IGNORE", error_codes(payload))

    def test_agent_evaluation_source_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            (repository / "agents/security-operations-expert/evaluation.md").unlink()
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("AGENT_SOURCE", error_codes(payload))

    def test_memory_must_be_explicit_true(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            config = repository / ".codex/config.toml"
            config.write_text(config.read_text(encoding="utf-8").replace("memories = true", 'memories = "true"'), encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("MEMORY", error_codes(payload))

    def test_acceptance_matrix_rejects_undeclared_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            matrix = repository / "docs/ai-agent-harness项目验收矩阵.md"
            matrix.write_text(matrix.read_text(encoding="utf-8") + "\n新增 `PA-99`。\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("MATRIX_COUNT", error_codes(payload))

    def test_acceptance_matrix_rejects_missing_path_details(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            matrix = repository / "docs/ai-agent-harness项目验收矩阵.md"
            matrix.write_text(matrix.read_text(encoding="utf-8").replace("### PA-01 ", "### 准备 ", 1), encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("MATRIX_COUNT", error_codes(payload))

    def test_plugin_build_dependencies_are_not_research_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            cache = repository / "platform/plugin/node_modules"
            cache.mkdir(parents=True)
            (cache / "local-dependency").symlink_to(repository / "README.md")
            output = repository / "platform/plugin/lib"
            output.mkdir(exist_ok=True)
            (output / "linked-build.js").symlink_to(repository / "README.md")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            self.assertEqual(completed.returncode, 0, payload)
            source = repository / "platform/plugin/src"
            (source / "linked-source.ts").symlink_to(repository / "README.md")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            self.assertIn("ASSET_SYMLINK", error_codes(payload))
            (source / "linked-source.ts").unlink()
            candidate_cache = repository / "evolution/experiments" / EXPERIMENT_ID / "candidate/dsh/workspace/node_modules"
            candidate_cache.mkdir()
            (candidate_cache / "linked-asset").symlink_to(repository / "README.md")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            self.assertEqual(completed.returncode, 0, payload)
            candidate_source = candidate_cache.parent / "linked-asset"
            candidate_source.symlink_to(repository / "README.md")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            self.assertIn("ASSET_SYMLINK", error_codes(payload))

    def test_review_principles_link_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            agents = repository / "AGENTS.md"
            agents.write_text(
                agents.read_text(encoding="utf-8").replace(
                    "](docs/项目审查原则.md)", "](docs/不存在.md)"
                ),
                encoding="utf-8",
            )
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("REVIEW_LINK", error_codes(payload))

    def test_retired_production_skill_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            retired = repository / ".agents/skills/delivery-review"
            retired.mkdir()
            (retired / "SKILL.md").write_text("---\nname: delivery-review\n---\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("RETIRED_SKILL", error_codes(payload))

    def test_physical_baseline_and_current_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            (repository / "evolution/baselines").mkdir()
            current = repository / "agents/security-operations-expert/current"
            current.mkdir()
            (current / "harness.yaml").write_text("value: duplicate\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        codes = error_codes(payload)
        self.assertIn("BASELINES_FORBIDDEN", codes)
        self.assertIn("CURRENT_FORBIDDEN", codes)

    def test_invalid_experiment_baseline_reference_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            change = repository / f"evolution/experiments/{EXPERIMENT_ID}/change.yaml"
            change.write_text(change.read_text(encoding="utf-8").replace("none:first-experiment", "latest"), encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("EXPERIMENT_BASELINE_REF", error_codes(payload))

    def test_controlled_standard_hash_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            controlled = repository / "docs/standards/Harness_Asset_Repository规范_v1.0.md"
            controlled.write_text(controlled.read_text(encoding="utf-8") + "\nchanged\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("STANDARD_HASH", error_codes(payload))

    def test_valid_research_release_passes_and_tamper_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            release = write_research_release(repository)
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
            self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))
            (release / "harness.yaml").write_text('schema_version: "1.0"\nentry: changed\n', encoding="utf-8")
            completed, payload = run_json(VALIDATE_REPOSITORY, repository)
        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue({"RELEASE_DIGEST", "RELEASE_ARTIFACT"} <= error_codes(payload))


class ResearchEvalTests(unittest.TestCase):
    def test_new_unsuffixed_experiment_is_rejected_even_after_git_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = Path(temp)
            experiment = write_minimal_experiment(repository, experiment_id="EXP-example-agent-001")
            subprocess.run(["git", "init", "-q", str(repository)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                            "commit", "-qm", "fixture"], check=True, capture_output=True)
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(error_codes(payload), {"EXPERIMENT_NAME"})
        self.assertIn("固定历史身份", payload["errors"][0]["message"])

    def test_historical_unsuffixed_experiment_keeps_original_identity(self) -> None:
        for identity in ("EXP-security-operations-expert-013", "EXP-security-operations-expert-020"):
            with self.subTest(identity=identity):
                completed, payload = run_json(VALIDATE_EXPERIMENT, ASSETS / "evolution/experiments" / identity)
                self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False))

    def test_nested_version_features_and_fixed_fusion_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp))
            change = experiment / "change.yaml"
            change.write_text(change.read_text(encoding="utf-8") + "\nfeatures:\n"
                              "  - id: route\n    title: 路由\n    description: 保留路由能力\n"
                              "    source_refs: [EXP-test-agent-001]\n    evidence_refs: []\n"
                              "fusion_sources:\n  - experiment_id: EXP-test-agent-002\n"
                              f"    ref: git:{'a' * 40}\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False))
            change.write_text(change.read_text(encoding="utf-8").replace(f"git:{'a' * 40}", "git:latest"), encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("FUSION_SOURCES", error_codes(payload))

    def test_current_experiment_passes(self) -> None:
        experiment = ASSETS / "evolution/experiments" / EXPERIMENT_ID
        completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))
        self.assertTrue(payload["valid"])

    def test_active_minimal_experiment_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp))
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))

    def test_completed_experiment_requires_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp), status="completed")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("EXPERIMENT_OUTCOME", error_codes(payload))

    def test_result_separates_execution_from_verdict_and_requires_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp))
            run_id = "run-" + str(uuid.uuid4())
            run_dir = experiment / "runs" / run_id
            run_dir.mkdir(parents=True)
            (run_dir / "run.yaml").write_text(
                "\n".join(
                    [
                        'schema_version: "2.0"',
                        f"run_id: {run_id}",
                        "experiment_id: EXP-example-agent-001-r0123456789ab",
                        "agent_id: example-agent",
                        "kind: research",
                        "status: running",
                        "evaluation_ref: agents/example-agent/evaluation.md",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            evaluation = experiment.parents[2] / "agents/example-agent/evaluation.md"
            (run_dir / "inputs.lock.json").write_text(
                json.dumps(
                    {
                        "schema_version": "2.0",
                        "run_id": run_id,
                        "evaluation_sha256": case_contract_digest(evaluation, ["U-EXAMPLE-001"]),
                        "evaluation_cases": [
                            {
                                "case_id": "U-EXAMPLE-001",
                                "title": "最小研究输入",
                                "inputs": ["最小输入。"],
                                "expected_behavior": "观察与输入一致。",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            evidence = run_dir / "evidence/U-EXAMPLE-001/checks.json"
            evidence.parent.mkdir(parents=True)
            evidence.write_text('{"checked":true}\n', encoding="utf-8")
            row = {
                "run_id": run_id,
                "trial_id": "trial-1",
                "input_id": "U-EXAMPLE-001",
                "execution_status": "completed",
                "verdict": "passed",
                "observation": "观察到预期变化",
                "evidence_ref": "evidence/U-EXAMPLE-001",
            }
            (run_dir / "results.jsonl").write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))
            del row["observation"]
            (run_dir / "results.jsonl").write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("RESULT_FIELDS", error_codes(payload))

    def test_running_and_sealed_runs_keep_frozen_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp), status="completed", outcome="adopt")
            run_id = "run-" + str(uuid.uuid4())
            run_dir = experiment / "runs" / run_id
            run_dir.mkdir(parents=True)
            (run_dir / "run.yaml").write_text(
                "\n".join(
                    [
                        'schema_version: "2.0"',
                        f"run_id: {run_id}",
                        "experiment_id: EXP-example-agent-001-r0123456789ab",
                        "agent_id: example-agent",
                        "kind: research",
                        "status: running",
                        "evaluation_ref: agents/example-agent/evaluation.md",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            evaluation = experiment.parents[2] / "agents/example-agent/evaluation.md"
            old_digest = case_contract_digest(evaluation, ["U-EXAMPLE-001"])
            (run_dir / "inputs.lock.json").write_text(
                json.dumps(
                    {
                        "schema_version": "2.0",
                        "run_id": run_id,
                        "evaluation_sha256": old_digest,
                        "evaluation_cases": [
                            {
                                "case_id": "U-EXAMPLE-001",
                                "title": "最小研究输入",
                                "inputs": ["最小输入。"],
                                "expected_behavior": "观察与输入一致。",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            evidence = run_dir / "evidence/U-EXAMPLE-001/checks.json"
            evidence.parent.mkdir(parents=True)
            evidence.write_text('{"checked":true}\n', encoding="utf-8")
            row = {
                "run_id": run_id,
                "trial_id": "trial-1",
                "input_id": "U-EXAMPLE-001",
                "execution_status": "completed",
                "verdict": "passed",
                "observation": "观察到预期变化",
                "evidence_ref": "evidence/U-EXAMPLE-001",
            }
            (run_dir / "results.jsonl").write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "schema_version": "2.0",
                        "run_id": run_id,
                        "trial_count": 1,
                        "execution_status_counts": {"completed": 1, "error": 0, "skipped": 0},
                        "verdict_counts": {"passed": 1, "failed": 0, "inconclusive": 0},
                        "overall_verdict": "passed",
                    }
                ) + "\n",
                encoding="utf-8",
            )
            changed_evaluation = evaluation.read_text(encoding="utf-8").replace(
                "观察与输入一致。", "观察与当前输入一致。"
            )
            evaluation.write_text(changed_evaluation, encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False))
            locked_path = run_dir / "inputs.lock.json"
            original = locked_path.read_text(encoding="utf-8")
            tampered = json.loads(original)
            tampered["evaluation_cases"][0]["title"] = "篡改冻结标题"
            locked_path.write_text(json.dumps(tampered), encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("RUN_EVALUATION_HASH", error_codes(payload))
            locked_path.write_text(original, encoding="utf-8")
            manifest = run_dir / "run.yaml"
            manifest.write_text(
                manifest.read_text(encoding="utf-8").replace("status: running", "status: completed")
                + f"results_sha256: {hashlib.sha256((run_dir / 'results.jsonl').read_bytes()).hexdigest()}\n"
                + f"summary_sha256: {hashlib.sha256((run_dir / 'summary.json').read_bytes()).hexdigest()}\n",
                encoding="utf-8",
            )
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
        self.assertEqual(completed.returncode, 0, json.dumps(payload, ensure_ascii=False, indent=2))

    def test_local_plan_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            experiment = write_minimal_experiment(Path(temp))
            (experiment / "evaluation").mkdir()
            (experiment / "evaluation/plan.yaml").write_text("cases: []\n", encoding="utf-8")
            completed, payload = run_json(VALIDATE_EXPERIMENT, experiment)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("EVALUATION_PLAN", error_codes(payload))


class RunRecordTests(unittest.TestCase):
    def test_finalization_detects_evaluator_implementation_change(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_implementation_test", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inputs = {"source_id": "experiment:test", "candidate_sha256": "a" * 64,
                  "harness_trees": {name: {} for name in ("workspace", "presets", "managed")},
                  "evaluation_implementation": {"driver": "original"}}
        with mock.patch.object(module, "candidate_digest", return_value="a" * 64), \
                mock.patch.object(module, "resolve", return_value={name: ROOT / name for name in ("workspace", "presets", "managed")}), \
                mock.patch.object(module, "tree_digest", return_value={}), \
                mock.patch.object(module, "evaluation_implementation", return_value={"driver": "changed"}):
            result = module.verify_run_source(ROOT, {"experiment_id": EXPERIMENT_ID}, inputs)
        self.assertEqual(result["status"], "changed")
        self.assertEqual(result["checks"][-1]["component"], "evaluation_implementation")

    def test_comparison_rejects_program_and_judge_drift_and_unknown_guard(self) -> None:
        view = {
            "run_id": "left", "run_path": "runs/left", "manifest": {"agent_id": AGENT_ID, "status": "completed"},
            "source": {"executor": "api", "model": "test-model", "review_mode": "none",
                       "configured_capabilities": {}, "dependency_env": {},
                       "git_version": {"commit": "a" * 40, "dirty": False},
                       "program_origin": {"commit": "b" * 40, "dirty": False},
                       "evaluation_implementation": {"judge": "c" * 64}},
            "image": {"image_build_fingerprint": "test", "local_image_id": "test"},
            "cases": [{"case_id": "U-CASE-001", "frozen": {},
                       "trials": [{"execution_status": "completed", "verdict": "passed", "observation": "成功"}],
                       "output": [], "actual_routes": [{"provider": "test", "model": "test", "reasoningEffort": "off"}],
                       "review": None, "load_observation": {"preset_matches": True, "workspace_matches": True},
                       "tool_calls": [], "evidence": []}], "missing": [],
        }
        def compare(right):
            result = subprocess.run(["node", str(ROOT / "runtime/adapters/dsh-container/run-comparison.ts")],
                                    input=json.dumps({"left": view, "right": right}), text=True,
                                    capture_output=True, check=True)
            return json.loads(result.stdout)
        right = json.loads(json.dumps(view))
        self.assertTrue(compare(right)["causal_comparable"])
        right["source"]["program_origin"] = {"commit": "d" * 40, "dirty": True}
        right["source"]["evaluation_implementation"]["judge"] = "e" * 64
        right["source"]["declared_guard"] = "/opt/dsh-managed/guard.mjs"
        comparison = compare(right)
        self.assertFalse(comparison["causal_comparable"])
        self.assertIn("program_origin: 平台程序提交不同", comparison["limits"])
        self.assertIn("evaluation_implementation: 不同", comparison["limits"])
        self.assertTrue(any("Guard 实际激活未验证" in item for item in comparison["limits"]))

    def test_inspection_comparison_uses_tool_receipt_without_legacy_env(self) -> None:
        def view(run_id: str, calls: list[dict]) -> dict:
            return {
                "run_id": run_id, "run_path": f"runs/{run_id}",
                "manifest": {"agent_id": AGENT_ID, "status": "completed"},
                "source": {"executor": "api", "model": "test-model", "review_mode": "none",
                           "configured_capabilities": {}, "dependency_env": {},
                           "git_version": {"commit": "test", "dirty": False}},
                "image": {"image_build_fingerprint": "test", "local_image_id": "test"},
                "cases": [{"case_id": "U-INS-001", "frozen": {},
                           "trials": [{"execution_status": "completed", "verdict": "passed",
                                       "observation": "成功"}], "output": [],
                           "actual_routes": [{"model": "test-model"}], "review": None,
                           "load_observation": {"preset_matches": True, "workspace_matches": True},
                           "tool_calls": calls, "evidence": []}], "missing": [],
            }

        old = view("old", [{"name": "mcp__inspection__list_executable_inspections", "status": "ok"}])
        new = view("new", [{"name": "mcp__inspection__get_inspection_result", "status": "ok"}])
        script = ROOT / "runtime/adapters/dsh-container/run-comparison.ts"
        compared = subprocess.run(["node", str(script)], input=json.dumps({"left": old, "right": new}),
                                  text=True, capture_output=True, check=False)
        self.assertEqual(compared.returncode, 0, compared.stderr)
        self.assertFalse(any("巡检服务依赖未确认可用" in item
                             for item in json.loads(compared.stdout)["limits"]))
        new["cases"][0]["tool_calls"] = []
        unconfirmed = subprocess.run(["node", str(script)], input=json.dumps({"left": old, "right": new}),
                                     text=True, capture_output=True, check=False)
        self.assertEqual(unconfirmed.returncode, 0, unconfirmed.stderr)
        self.assertIn("U-INS-001: right 巡检服务依赖未确认可用", json.loads(unconfirmed.stdout)["limits"])
        new["cases"][0]["tool_calls"] = [{"name": None, "status": "ok"}]
        unnamed = subprocess.run(["node", str(script)], input=json.dumps({"left": old, "right": new}),
                                 text=True, capture_output=True, check=False)
        self.assertEqual(unnamed.returncode, 0, unnamed.stderr)
        self.assertIn("U-INS-001: right 巡检服务依赖未确认可用", json.loads(unnamed.stdout)["limits"])

    def test_init_captures_clean_git_before_creating_run(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            experiment = repo / f"evolution/experiments/{EXPERIMENT_ID}"
            experiment.mkdir(parents=True)
            (experiment / "change.yaml").write_text("baseline_ref: none:first-experiment\n", encoding="utf-8")
            (experiment / "candidate").mkdir()
            (experiment / "candidate/basic.txt").write_text("最小 Candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=Test", "-c",
                            "user.email=test@example.invalid", "commit", "-qm", "initial"], check=True)
            contract = {"experiment_id": EXPERIMENT_ID, "agent_id": AGENT_ID,
                        "source_id": f"experiment:{EXPERIMENT_ID}", "source_kind": "experiment",
                        "workspace": str(repo), "presets": str(repo), "managed": str(repo),
                        "config_markers": ["test"], "required_env_names": [], "optional_env_names": []}
            args = argparse.Namespace(source=f"experiment:{EXPERIMENT_ID}", baseline_ref=None,
                                      case=["U-INS-001"], selection_mode="explicit",
                                      kind="research", model=None, executor="api", review_mode=None)
            with mock.patch.object(module, "resolve", return_value=contract), \
                    mock.patch.object(module, "load_evaluation", return_value={
                        "case_ids": ["U-INS-001"], "cases": {"U-INS-001": {"case_id": "U-INS-001"}}, "catalog": [],
                    }), \
                    mock.patch.object(module, "tree_digest", return_value={}):
                module.command_init(repo, args)
            run_dir = next((experiment / "runs").iterdir())
            inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            self.assertFalse(inputs["git_version"]["dirty"])
            self.assertEqual(inputs["review_mode"], "none")

    def test_historical_inspection_tool_failure_is_visible(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        view = module.run_view(ASSETS, "run-548ae419-80a4-47dc-9fd2-94d972f29010", "U-INS-001")
        case = view["cases"][0]
        self.assertNotIn("mcp__inspection__list_executable_inspections", case["registered_tools"][0])
        self.assertEqual(case["tool_calls"][0], {
            "name": "mcp__inspection__list_executable_inspections",
            "status": "error", "error_code": "UNKNOWN_TOOL",
        })
        successful = module.run_view(ASSETS, "run-548ae419-80a4-47dc-9fd2-94d972f29010", "U-INS-003")
        self.assertEqual(successful["cases"][0]["tool_calls"][0]["status"], "ok")

    def test_flat_yaml_round_trip_preserves_escaped_strings(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "run.yaml"
            expected = {"schema_version": "2.0", "source_id": 'line\\break:"值"'}
            module.write_flat_yaml(path, expected)
            self.assertEqual(module.read_flat_yaml(path), expected)

    def test_report_distinguishes_skipped_from_execution_error(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rows = [
            {"input_id": "U-ONE", "execution_status": "completed", "verdict": "inconclusive",
             "observation": "已完成", "evidence_ref": "evidence/U-ONE"},
            {"input_id": "U-TWO", "execution_status": "skipped", "verdict": "inconclusive",
             "observation": "未执行", "evidence_ref": "evidence/U-TWO"},
            {"input_id": "U-THREE", "execution_status": "error", "verdict": "inconclusive",
             "observation": "执行错误", "evidence_ref": "evidence/U-THREE"},
        ]
        summary = {
            "trial_count": 3,
            "execution_status_counts": {"completed": 1, "error": 1, "skipped": 1},
            "machine_trial_verdict_counts": {"passed": 0, "failed": 0, "inconclusive": 3},
            "machine_overall_verdict": "inconclusive",
            "review_status": "not_requested",
            "reviewed_case_verdict_counts": None,
            "effective_verdict": "inconclusive",
        }
        manifest = {
            "run_id": "run-test", "experiment_id": "EXP-test-001", "agent_id": "test",
            "status": "completed", "created_at": "2026-01-01T00:00:00Z",
            "finished_at": "2026-01-01T00:01:00Z",
        }
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.md"
            module.write_report(report, manifest, summary, rows, "api")
            text = report.read_text(encoding="utf-8")
        self.assertIn("| 机器 Trial | 3 | 1 | 1 | 1 | 0 | 0 | 3 |", text)
        self.assertIn("| `U-ONE` |  |  | 已完成 | 无法判定 | - | - | 已完成 |", text)
        self.assertIn("| ~~`U-TWO`~~ |  |  | 已跳过 | 无法判定 | - | - | 未执行 |", text)
        self.assertIn("| `U-THREE` |  |  | 执行错误 | 无法判定 | - | - | 执行错误 |", text)
        self.assertNotIn("~~`U-THREE`~~", text)

    def test_lifecycle_records_and_seals_observations(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            init = subprocess.run(
                [
                    "python3", str(repository / "runtime/adapters/dsh-container/run_record.py"),
                    "--repo", str(repository), "init", "--source", f"experiment:{EXPERIMENT_ID}",
                    "--case", "U-INS-001", "--kind", "research", "--model", "deepseek-official",
                ],
                cwd=repository, text=True, capture_output=True, check=False, timeout=180,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(init.returncode, 0, init.stderr)
            run_id = init.stdout.strip()
            run_dir = repository / f"evolution/experiments/{EXPERIMENT_ID}/runs/{run_id}"
            evidence = run_dir / "evidence/U-INS-001/checks.json"
            evidence.parent.mkdir(parents=True)
            evidence.write_text('{"loaded":true}\n', encoding="utf-8")
            (evidence.parent / "response.json").write_text(
                json.dumps({"assistant_texts": ["请补充证据"],
                            "turns": [{"route": {"model": "test-model"}}]}, ensure_ascii=False),
                encoding="utf-8",
            )
            trial = repository / "trial.json"
            trial.write_text(
                json.dumps(
                    {
                        "run_id": run_id,
                        "trial_id": "trial-1",
                        "input_id": "U-INS-001",
                        "execution_status": "completed",
                        "verdict": "passed",
                        "observation": "目标会话观察到新增 Skill",
                        "evidence_ref": "evidence/U-INS-001",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            base = ["python3", str(repository / "runtime/adapters/dsh-container/run_record.py"), "--repo", str(repository)]
            record = subprocess.run(base + ["record", "--run", run_id, str(trial)], cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(record.returncode, 0, record.stderr)
            finalize = subprocess.run(base + ["finalize", "--run", run_id, "--status", "completed"], cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(finalize.returncode, 0, finalize.stderr)
            sealed = subprocess.run(base + ["record", "--run", run_id, str(trial)], cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertNotEqual(sealed.returncode, 0)
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["execution_status_counts"]["completed"], 1)
            self.assertEqual(summary["machine_trial_verdict_counts"]["passed"], 1)
            self.assertEqual(summary["machine_overall_verdict"], "passed")
            self.assertEqual(summary["review_status"], "not_requested")
            self.assertEqual(summary["effective_verdict"], "passed")
            self.assertIn('baseline_ref: "none:first-experiment"', (run_dir / "run.yaml").read_text(encoding="utf-8"))
            inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            self.assertIn("git_version", inputs)
            self.assertEqual(
                [case["case_id"] for case in inputs["evaluation_cases"]],
                ["U-INS-001"],
            )
            self.assertIn(
                'evaluation_ref: "agents/security-operations-expert/evaluation.md"',
                (run_dir / "run.yaml").read_text(encoding="utf-8"),
            )
            indexed = subprocess.run(base + ["index", "--agent", AGENT_ID], cwd=repository,
                                     text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(indexed.returncode, 0, indexed.stderr)
            self.assertIn(run_id, [item["run_id"] for experiment in json.loads(indexed.stdout)["experiments"]
                                   for item in experiment["runs"]])
            shown = subprocess.run(base + ["show", "--run", run_id, "--case", "U-INS-001"],
                                   cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(shown.returncode, 0, shown.stderr)
            view = json.loads(shown.stdout)
            self.assertEqual(view["cases"][0]["frozen"]["case_id"], "U-INS-001")
            self.assertEqual(view["cases"][0]["trials"][0]["verdict"], "passed")
            self.assertEqual(view["cases"][0]["output"], ["请补充证据"])
            self.assertEqual(view["cases"][0]["actual_routes"][0]["model"], "test-model")
            self.assertTrue(view["cases"][0]["evidence"][0]["present"])
            self.assertTrue(view["cases"][0]["raw_evidence"]["response.json"]["present"])
            compared = subprocess.run(base + ["compare", "--left", run_id, "--right", run_id],
                                      cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(compared.returncode, 0, compared.stderr)
            self.assertTrue(json.loads(compared.stdout)["comparable"])
            old_report = (run_dir / "report.md").read_bytes()
            invalid = subprocess.run(base + ["init", "--source", f"experiment:{EXPERIMENT_ID}",
                                             "--case", "U-INS-001", "--compare-to", "run-invalid"],
                                     cwd=repository, text=True, capture_output=True, check=False, timeout=180)
            self.assertNotEqual(invalid.returncode, 0)
            next_run = subprocess.run(base + ["init", "--source", f"experiment:{EXPERIMENT_ID}",
                                              "--case", "U-INS-001", "--model", "local-qwen",
                                              "--compare-to", run_id], cwd=repository, text=True,
                                      capture_output=True, check=False, timeout=180)
            self.assertEqual(next_run.returncode, 0, next_run.stderr)
            next_id = next_run.stdout.strip()
            next_dir = repository / f"evolution/experiments/{EXPERIMENT_ID}/runs/{next_id}"
            next_evidence = next_dir / "evidence/U-INS-001"
            next_evidence.mkdir(parents=True)
            (next_evidence / "checks.json").write_text('{"loaded":true}\n', encoding="utf-8")
            next_trial = {**json.loads(trial.read_text(encoding="utf-8")),
                          "run_id": next_id, "trial_id": "trial-2", "verdict": "failed",
                          "observation": "新版结果有差异"}
            next_record = subprocess.run(base + ["record", "--run", next_id, "-"],
                                         cwd=repository, text=True, capture_output=True, check=False,
                                         input=json.dumps(next_trial), timeout=180)
            self.assertEqual(next_record.returncode, 0, next_record.stderr)
            next_finalize = subprocess.run(base + ["finalize", "--run", next_id, "--status", "completed"],
                                           cwd=repository, text=True, capture_output=True,
                                           check=False, timeout=180)
            self.assertEqual(next_finalize.returncode, 0, next_finalize.stderr)
            report = (next_dir / "report.md").read_text(encoding="utf-8")
            self.assertIn("## 与之前版本的对比", report)
            self.assertIn("model: 不同", report)
            self.assertIn("U-INS-001", report)
            self.assertEqual((run_dir / "report.md").read_bytes(), old_report)
            newer = subprocess.run(base + ["compare", "--left", run_id, "--right", next_id],
                                   cwd=repository, text=True, capture_output=True,
                                   check=False, timeout=180)
            self.assertEqual(newer.returncode, 0, newer.stderr)
            self.assertTrue(json.loads(newer.stdout)["comparable"])
            self.assertFalse(json.loads(newer.stdout)["causal_comparable"])
            self.assertIn("model: 不同", json.loads(newer.stdout)["limits"])

    def test_unselected_input_is_rejected(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        row = {
            "run_id": "run-" + str(uuid.uuid4()),
            "trial_id": "trial-1",
            "input_id": "T-NOT-SELECTED",
            "execution_status": "completed",
            "verdict": "passed",
            "observation": "不应写入",
            "evidence_ref": "evidence/checks.json",
        }
        with self.assertRaisesRegex(ValueError, "selected"):
            module.validate_trial_row(row["run_id"], row, {"U-INS-001"})

    def test_open_run_requires_full_case_snapshot(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp)
            (run_dir / "inputs.lock.json").write_text(
                json.dumps({"evaluation_selection": {"case_ids": ["T-LEGACY"]}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "Case 锁定"):
                module.selected_input_ids(run_dir)

    def test_execution_error_requires_inconclusive_verdict_and_reason(self) -> None:
        spec = importlib.util.spec_from_file_location("run_record_contract", RUN_RECORD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        base = {
            "run_id": "run-" + str(uuid.uuid4()),
            "trial_id": "trial-1",
            "input_id": "input-1",
            "execution_status": "error",
            "verdict": "failed",
            "observation": "legacy row",
            "evidence_ref": "evidence/checks.json",
        }
        with self.assertRaisesRegex(ValueError, "inconclusive"):
            module.validate_trial_row(base["run_id"], base)
        base["verdict"] = "inconclusive"
        with self.assertRaisesRegex(ValueError, "failure_reason"):
            module.validate_trial_row(base["run_id"], base)

    def test_completed_run_requires_every_selected_case(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            script = repository / "runtime/adapters/dsh-container/run_record.py"
            initialized = subprocess.run(
                ["python3", str(script), "--repo", str(repository), "init",
                 "--source", f"experiment:{EXPERIMENT_ID}", "--case", "U-INS-001"],
                cwd=repository, text=True, capture_output=True, check=False, timeout=180,
            )
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            finalized = subprocess.run(
                ["python3", str(script), "--repo", str(repository), "finalize",
                 "--run", initialized.stdout.strip(), "--status", "completed"],
                cwd=repository, text=True, capture_output=True, check=False, timeout=180,
            )
        self.assertNotEqual(finalized.returncode, 0)
        self.assertIn("every selected Case", finalized.stderr)


class DshEvalTests(unittest.TestCase):
    def test_markdown_export_prefers_verified_target_tool_artifact_and_rejects_bad_digest(self) -> None:
        module = runpy.run_path(str(DSH_EVAL))
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            evidence = run / "evidence/U-CASE-001"
            evidence.mkdir(parents=True)
            (evidence / "response.json").write_text(json.dumps({"assistant_texts": ["报告已生成，共三台设备。"]}), encoding="utf-8")
            (evidence / "checks.json").write_text(json.dumps({"root_session_log": "target.jsonl"}), encoding="utf-8")
            report = "# 三台设备巡检报告\n\n| 设备 | 状态 |\n| A | 正常 |\n| B | 正常 |\n| C | 正常 |\n"
            receipt = {"run_id": "task-" + str(uuid.uuid4()), "completed": True, "source_kind": "basic_mock",
                       "report_sha256": hashlib.sha256(report.encode()).hexdigest(), "markdown": report}
            rows = [
                {"session_log": "child.jsonl", "event": {"type": "tool/call", "data": {"callId": "child", "name": "other"}}},
                {"session_log": "target.jsonl", "event": {"type": "tool/call", "data": {"callId": "actual-call", "name": "inspection"}}},
                {"session_log": "target.jsonl", "event": {"type": "tool/result", "data": {"message": {
                    "source": {"callId": "actual-call"}, "content": [{"type": "text", "text": json.dumps(receipt)}]}}}},
            ]
            tools = evidence / "tools.jsonl"
            tools.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            module["export_response_artifacts"](run, [{"case_id": "U-CASE-001"}], {"U-CASE-001": {"execution_status": "completed"}}, "inspection-report.md")
            artifact = json.loads((run / "artifacts/index.json").read_text())["artifacts"][0]
            self.assertEqual((run / artifact["path"]).read_bytes(), report.encode())
            self.assertEqual(artifact["origin"], "tool-result")
            self.assertEqual(artifact["source_call_id"], "actual-call")
            self.assertEqual(artifact["source_kind"], "basic_mock")
            self.assertEqual(artifact["source_sha256"], hashlib.sha256(tools.read_bytes()).hexdigest())
            receipt["report_sha256"] = "0" * 64
            rows[-1]["event"]["data"]["message"]["content"][0]["text"] = json.dumps(receipt)
            tools.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            with self.assertRaisesRegex(module["EvaluationError"], "tool-artifact-digest-mismatch"):
                module["exported_tool_markdown"](run, "U-CASE-001")

    REQUIRED_RUNTIME_ENV = (
        "DEEPSEEK_API_KEY",
        "SEC_OPS_MCP_URL",
        "SEC_OPS_MCP_TOKEN",
        "INSPECTION_MCP_URL",
        "INSPECTION_MCP_TOKEN",
        "LOCAL_LLM_BASE_URL",
        "LOCAL_LLM_API_KEY",
    )

    def test_locked_harness_keeps_binary_digest_without_decoding(self) -> None:
        spec = importlib.util.spec_from_file_location("scenario_analysis_binary_test", SCENARIO_ANALYSIS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            roots = {name: Path(temp) / name for name in ("workspace", "presets", "managed")}
            for root in roots.values():
                root.mkdir()
            files = {"note.md": b"hello", "model.wasm": b"\x00\xff"}
            for name, content in files.items():
                (roots["workspace"] / name).write_bytes(content)
            inputs = {"source_id": "experiment:test", "harness_trees": {
                name: {"files": [
                    {"path": path, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                    for path, content in files.items()
                ] if name == "workspace" else []}
                for name in roots
            }}
            with mock.patch.dict("sys.modules", {"source_contract": mock.Mock(
                resolve=lambda *_args, **_kwargs: roots,
            )}):
                result = module._locked_harness(inputs)
                self.assertEqual(result[0]["content"], "hello")
                self.assertEqual(result[1]["content"], None)
                self.assertTrue(result[1]["binary"])
                (roots["workspace"] / "model.wasm").write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "harness-lock-digest-mismatch"):
                    module._locked_harness(inputs)

    def test_readable_view_preserves_json_and_deduplicates_tool_content(self) -> None:
        spec = importlib.util.spec_from_file_location("scenario_analysis_view_test", SCENARIO_ANALYSIS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            plain = {"text": "第一行\n第二行", "value": [1, True, None]}
            (run / "plain.json").write_text(
                json.dumps(plain, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
            )
            shared = [{"type": "text", "text": "重复内容" * 1000}]
            events = [
                {
                    "event": {"type": "tool/result", "data": {"message": {"content": [{
                        "toolCallId": call_id, "content": shared,
                    }]}}},
                    "session_log": "session.v3.jsonl",
                }
                for call_id in ("call-a", "call-b")
            ]
            (run / "tools.jsonl").write_text(
                "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in events),
                encoding="utf-8",
            )
            descriptors = module._write_readable_views(
                run, {"scene-01": ["plain.json", "tools.jsonl"]},
            )["scene-01"]
            lines = [
                line
                for item in descriptors
                for line in (run / item["path"]).read_text(encoding="utf-8").splitlines()
            ]
            json_chunks, content_chunks = {}, {}
            for line in lines:
                if line.startswith("J\t"):
                    _, source, record, fraction, chunk = line.split("\t", 4)
                    json_chunks.setdefault((int(source), int(record)), []).append(
                        (int(fraction.split("/", 1)[0]), chunk)
                    )
                elif line.startswith("C\t"):
                    _, digest, fraction, chunk = line.split("\t", 3)
                    content_chunks.setdefault(digest, []).append(
                        (int(fraction.split("/", 1)[0]), chunk)
                    )
            values = {
                key: json.loads("".join(chunk for _, chunk in sorted(chunks)))
                for key, chunks in json_chunks.items()
            }
            canonical = json.dumps(shared, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            restored = "".join(chunk for _, chunk in sorted(content_chunks[digest]))
            manifest = json.loads(
                (run / "evidence/analysis/readable/manifest.json").read_text(encoding="utf-8")
            )

        self.assertEqual(values[(1, 1)], plain)
        self.assertEqual([values[(2, index)]["event"]["data"]["message"]["content"][0]["toolCallId"]
                          for index in (1, 2)], ["call-a", "call-b"])
        self.assertTrue(all(
            values[(2, index)]["event"]["data"]["message"]["content"][0]["content"]
            == {"$analysis_content_ref": digest} for index in (1, 2)
        ))
        self.assertEqual(json.loads(restored), shared)
        self.assertEqual(len(content_chunks), 1)
        self.assertEqual(manifest["groups"][0]["content_refs"], 1)
        self.assertTrue(all(item["bundle"] == "scene-01" for item in descriptors))

    def test_finding_accepts_counterexample_and_empty_tool_evidence(self) -> None:
        spec = importlib.util.spec_from_file_location("scenario_analysis_finding_test", SCENARIO_ANALYSIS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            (run / "evidence/support").mkdir(parents=True)
            (run / "evidence/counterexample").mkdir(parents=True)
            (run / "evidence/support/response.json").write_text("{}\n", encoding="utf-8")
            (run / "evidence/counterexample/tools.jsonl").write_text("", encoding="utf-8")
            finding = {
                "category": "harness_mechanism",
                "observed_gap": "支持 Case 暴露能力缺口。",
                "root_cause_hypothesis": "Harness 缺少对应约束。",
                "support_case_ids": ["support"],
                "counterexample_case_ids": ["counterexample"],
                "evidence_refs": [
                    "evidence/support/response.json",
                    "evidence/counterexample/tools.jsonl",
                ],
                "alternative": "也可能是外部数据差异。",
                "falsification": "固定外部数据后重跑。",
            }
            parsed = module._parse_findings([finding], ["support", "counterexample"], run)
            (run / "evidence/counterexample/response.json").write_text("", encoding="utf-8")

            self.assertEqual(parsed, [finding])
            self.assertFalse(module._material_ref(
                run, "evidence/counterexample/response.json",
            ))

    def test_analysis_output_accepts_only_plain_or_single_json_fence(self) -> None:
        spec = importlib.util.spec_from_file_location("scenario_analysis_json_test", SCENARIO_ANALYSIS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = {"case_reviews": [], "findings": []}

        self.assertEqual(module._parse_json_output(json.dumps(expected)), expected)
        self.assertEqual(module._parse_json_output(
            f"```json\n{json.dumps(expected)}\n```",
        ), expected)
        with self.assertRaises(json.JSONDecodeError):
            module._parse_json_output(f"结果如下：\n```json\n{json.dumps(expected)}\n```")

    def test_analysis_access_accepts_successful_empty_file_read(self) -> None:
        spec = importlib.util.spec_from_file_location("scenario_analysis_access_test", SCENARIO_ANALYSIS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        required_path = "evidence/analysis/readable/scene-01/part-001.txt"
        raw = {
            "tool_names": ["glob", "grep", "read"],
            "tool_accesses": [
                {
                    "name": "read",
                    "arguments": {"file_path": required_path},
                    "result": {"is_error": False, "read": {
                        "path": f"/work/evaluation-run/{required_path}",
                        "offset": 1, "line_numbers": [1], "total_lines": 1,
                    }},
                },
                {
                    "name": "read",
                    "arguments": {"file_path": "evidence/U-INS-001/tools.jsonl"},
                    "result": {"is_error": False, "read": {
                        "path": "/work/evaluation-run/evidence/U-INS-001/tools.jsonl",
                        "offset": 1, "line_numbers": [], "total_lines": 0,
                    }},
                },
            ],
        }
        required = [{
            "bundle": "scene-01", "path": required_path,
            "total_lines": 1, "sha256": "0" * 64,
        }]

        module._validate_evidence_access(raw, required)
        raw["tool_accesses"][1]["result"]["read"]["offset"] = 2
        with self.assertRaisesRegex(ValueError, "analysis-tools-invalid"):
            module._validate_evidence_access(raw, required)

    def runtime_fixture(self, root: Path, *, mode: str = "pass") -> tuple[Path, dict[str, str], Path]:
        repository = copy_repository(root)
        image_contract = json.loads(subprocess.check_output(
            [
                "python3",
                str(repository / "runtime/adapters/dsh-container/source_contract.py"),
                "--repo", str(repository),
                "--source",
                "experiment:EXP-security-operations-expert-006",
            ],
            cwd=repository,
            text=True,
        ))["image"]
        image_fingerprint = image_contract["build_fingerprint"]
        image_platform = image_contract["platform"]
        command_log = root / "dsh-dev.jsonl"
        fake_dsh = root / "fake-dsh-dev"
        fake_dsh.write_text(
            f"""#!/usr/bin/env python3
import json
import os
import sys

with open(os.environ["TEST_DSH_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1] == "url":
    print("http://127.0.0.1:3090/?token=opaque-eval-auth-token")
elif sys.argv[1] == "up":
    print(json.dumps({{
        "image_tag": "ai-agent-harness/dsh:test",
        "image_id": "sha256:{'a' * 64}",
        "image_ref": "ai-agent-harness/dsh:test@sha256:{'a' * 64}",
        "image_build_fingerprint": "{image_fingerprint}",
        "platform": "{image_platform}",
    }}))
else:
    print("{{}}")
""",
            encoding="utf-8",
        )
        fake_dsh.chmod(0o755)
        fake_browser = root / "fake-browser"
        fake_browser.write_text(
            """#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

payload = json.load(sys.stdin)
mode = os.environ["TEST_BROWSER_MODE"]
target_route = {
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "maxTokens": 256000,
    "reasoningEffort": "off",
}
if payload.get("operation") == "review":
    if os.environ.get("TEST_ANALYSIS_MODE") == "unavailable":
        raise SystemExit(9)
    if payload.get("workspace") != "/work/evaluation-run" \
            or payload.get("preset_id") != "scenario-analysis" \
            or payload.get("judge_preset_id") != "scenario-analysis" \
            or payload.get("model_route") != target_route:
        raise SystemExit(6)
    results = []
    for scene_index, scene in enumerate(payload["scenes"]):
        repairing = "session_id" in scene
        review_input = json.loads(scene["prior_prompts"][0] if repairing else scene["prompt"])
        if repairing:
            repair = json.loads(scene["prompt"])
            if repair.get("validation_error") != "analysis-output-invalid":
                raise SystemExit(10)
        cases = review_input["cases"]
        if any(
            set(item) != {
                "case_id", "inputs", "expected_behavior", "machine_verdict", "evidence_dir",
            } or not item["inputs"] or not item["expected_behavior"]
            for item in cases
        ):
            raise SystemExit(8)
        required = review_input["required_evidence"]
        expected = ["inputs.lock.json", "results.jsonl", "evidence/analysis/harness.json"] + [
            f"evidence/{item['case_id']}/{name}"
            for item in cases
            for name in ("response.json", "checks.json", "tools.jsonl")
        ]
        bundle = scene["scene_id"]
        if review_input.get("evidence_sources") != expected \
                or "harness_files" in review_input or any(
            set(item) != {"bundle", "path", "total_lines", "sha256"}
            or item["bundle"] != bundle
            or not item["path"].startswith(f"evidence/analysis/readable/{bundle}/")
            or not item["path"].endswith(".txt")
            or not isinstance(item["total_lines"], int) or item["total_lines"] < 1
            for item in required
        ):
            raise SystemExit(7)
        reviews = []
        for case_index, item in enumerate(cases):
            reviewed = item["machine_verdict"]
            if os.environ.get("TEST_ANALYSIS_MODE") == "correct-first" \
                    and scene_index == 0 and case_index == 0:
                reviewed = "failed"
            reviews.append({
                "case_id": item["case_id"],
                "reviewed_verdict": reviewed,
                "reason": "已核对预期、回复、检查结果和完整工具事件。",
            })
        finding = {
            "category": "harness_mechanism",
            "observed_gap": "机器结论未表达场景证据中的能力边界。",
            "root_cause_hypothesis": "当前 Harness 对该边界缺少明确约束。",
            "support_case_ids": [cases[0]["case_id"]],
            "counterexample_case_ids": [cases[1]["case_id"]] if len(cases) > 1 else [],
            "evidence_refs": [f"evidence/{cases[0]['case_id']}/response.json"] + (
                [f"evidence/{cases[1]['case_id']}/response.json"] if len(cases) > 1 else []
            ),
            "alternative": "也可能由外部工具测试数据造成。",
            "falsification": "固定工具数据后重跑该场景并比较完整证据。",
        }
        text = json.dumps({
            "case_reviews": reviews,
            "findings": [finding],
        })
        accesses = [
            {
                "name": "read",
                "arguments": {"file_path": f"/work/evaluation-run/{item['path']}"},
                "result": {
                    "is_error": False,
                    "read": {
                        "path": f"/work/evaluation-run/{item['path']}",
                        "offset": 1,
                        "line_numbers": list(range(1, item["total_lines"] + 1)),
                        "total_lines": item["total_lines"],
                    },
                },
            }
            for item in required
        ]
        analysis_mode = os.environ.get("TEST_ANALYSIS_MODE")
        if analysis_mode == "invalid":
            accesses.pop()
        elif analysis_mode == "failed-read":
            accesses[0]["result"] = {"is_error": True}
        elif analysis_mode == "partial-read":
            accesses[0]["result"]["read"]["line_numbers"].pop()
        if analysis_mode == "repair-output" and not repairing:
            text = json.dumps({"case_reviews": reviews, "findings": [finding], "unexpected": True})
        results.append({
            "scene_id": scene["scene_id"],
            "session_id": scene.get("session_id", f"judge-session-{scene_index}"),
            "route": target_route,
            "tool_names": ["glob", "grep", "read"],
            "tool_accesses": accesses,
            "text": text,
        })
    print(json.dumps({"operation": "review", "results": results}))
    raise SystemExit(0)
if mode == "exception":
    raise SystemExit(9)
if mode == "hang":
    Path(os.environ["TEST_BROWSER_READY"]).write_text("ready\\n", encoding="utf-8")
    time.sleep(120)

rows = []
for index, item in enumerate(payload["cases"]):
    evidence = Path(payload["evidence_root"]) / item["case_id"]
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "response.json").write_text(json.dumps({
        "inputs": item["inputs"],
        "assistant_texts": ["模型连通"],
        "session_id": f"target-session-{index}",
        "turns": [{"assistant_text": "模型连通", "route": target_route}] + [
            {"assistant_text": "继续处理", "route": None}
            for _ in item["inputs"][1:]
        ],
    }) + "\\n")
    (evidence / "trace.jsonl").write_text(json.dumps({"route": "local-qwen"}) + "\\n")
    (evidence / "tools.jsonl").write_text(
        json.dumps({"event": {
            "type": "tool/call", "name": "inspection", "arguments": {"case_id": item["case_id"]},
        }}) + "\\n" + json.dumps({"event": {
            "type": "tool/result", "name": "inspection",
            "result": {"ok": True, "case_id": item["case_id"]},
        }}) + "\\n"
    )
    (evidence / "checks.json").write_text(json.dumps({"completed": True}) + "\\n")
    if mode == "partial-hang" and index == 1:
        (evidence / "checks.json").write_text(json.dumps({"completed": False, "session_id": "partial-session"}) + "\\n")
        Path(os.environ["TEST_BROWSER_READY"]).write_text("ready\\n", encoding="utf-8")
        time.sleep(120)
    if mode == "safety-stop":
        rows.append({
            "case_id": item["case_id"],
            "execution_status": "error",
            "verdict": "inconclusive",
            "observation": "Session 身份漂移",
            "failure_reason": "identity-drift",
            "evidence_ref": f"evidence/{item['case_id']}",
        })
        print(json.dumps({
            "schema_version": "1.0",
            "rows": rows,
            "stop_reason": "identity-drift",
        }))
        raise SystemExit(0)
    verdict = "inconclusive" if mode == "browser-smoke" else \
        "failed" if mode == "case-failure" and index == 0 else "passed"
    rows.append({
        "case_id": item["case_id"],
        "execution_status": "completed",
        "verdict": verdict,
        "observation": "替身浏览器完成评测链路",
        "evidence_ref": f"evidence/{item['case_id']}",
    })
    if mode == "partial-hang":
        (evidence / "case-result.json").write_text(json.dumps(rows[-1]) + "\\n")
print(json.dumps({"schema_version": "1.0", "rows": rows}))
""",
            encoding="utf-8",
        )
        fake_browser.chmod(0o755)
        env = {
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "HARNESS_ASSET_ROOT": str(repository),
            "HARNESS_PROGRAM_ROOT": str(repository),
            "DSH_EVAL_DSH_DEV": str(fake_dsh),
            "DSH_EVAL_API_DRIVER": str(fake_browser),
            "DSH_EVAL_BROWSER_DRIVER": str(fake_browser),
            "TEST_DSH_LOG": str(command_log),
            "TEST_BROWSER_MODE": mode,
            "TEST_ANALYSIS_MODE": "valid",
            "TEST_BROWSER_READY": str(root / "browser-ready"),
        }
        for name in self.REQUIRED_RUNTIME_ENV:
            env[name] = "http://example.invalid" if name.endswith(("_URL", "BASE_URL")) else "test-value"
        return repository, env, command_log

    def run_eval(
        self,
        repository: Path,
        env: dict[str, str],
        *case_ids: str,
        timeout: int = 240,
        executor: str = "api",
        mode: str | None = None,
        compare_to: str | None = None,
        review: str | None = None,
        export_response_markdown: str | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        command = [
            "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
            "--source", "experiment:EXP-security-operations-expert-006",
            "--executor", executor,
            "--timeout-seconds", "10",
        ]
        if mode:
            command.extend(("--mode", mode))
        if compare_to:
            command.extend(("--compare-to", compare_to))
        if review:
            command.extend(("--review", review))
        if export_response_markdown:
            command.extend(("--export-response-markdown", export_response_markdown))
        for case_id in case_ids:
            command.extend(("--case", case_id))
        completed = subprocess.run(
            command,
            cwd=repository,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
            env=env,
        )
        return completed, json.loads(completed.stdout)

    def test_dry_run_has_no_runtime_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            runs = repository / "evolution/experiments/EXP-security-operations-expert-006/runs"
            before = set(runs.glob("run-*")) if runs.is_dir() else set()
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
            for name in self.REQUIRED_RUNTIME_ENV:
                env.pop(name, None)
            completed = subprocess.run(
                [
                    "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                    "--source", "experiment:EXP-security-operations-expert-006",
                    "--case", "U-INS-001", "--dry-run",
                ],
                cwd=repository, text=True, capture_output=True, check=False, timeout=180, env=env,
            )
            payload = json.loads(completed.stdout)
            after = set(runs.glob("run-*")) if runs.is_dir() else set()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(payload["executor"], "api")
        self.assertTrue(payload["runtime_required"])
        self.assertEqual(payload["missing_env_names"], list(self.REQUIRED_RUNTIME_ENV))
        self.assertEqual(before, after)

    def test_explicit_export_copies_only_actual_final_response_before_sealing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp))
            completed, payload = self.run_eval(repository, env, "U-INS-001", export_response_markdown="inspection-report.md")
            self.assertEqual(completed.returncode, 0, completed.stderr)
            run = (repository / payload["summary"]).parent
            index = json.loads((run / "artifacts/index.json").read_text())
            self.assertEqual(len(index["artifacts"]), 1)
            artifact = index["artifacts"][0]
            output = (run / artifact["path"]).read_bytes()
            response = json.loads((run / artifact["source_evidence"]).read_text())
            self.assertEqual(output, response["assistant_texts"][-1].encode("utf-8"))
            self.assertEqual(artifact["sha256"], hashlib.sha256(output).hexdigest())
            self.assertEqual(artifact["source_sha256"], hashlib.sha256((run / artifact["source_evidence"]).read_bytes()).hexdigest())
            self.assertEqual(artifact["path"], "artifacts/U-INS-001/inspection-report.md")
            (run / artifact["path"]).write_text("修改后的内容", encoding="utf-8")
            checked, validation = run_json(repository / "runtime/research/validate_experiment.py", run.parents[1], cwd=repository)
            self.assertNotEqual(checked.returncode, 0)
            self.assertIn("RUN_ARTIFACT", error_codes(validation))

    def test_runtime_flow_seals_run_stops_instance_and_does_not_persist_auth_url(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repository, env, command_log = self.runtime_fixture(root)
            expected_case_count = len(evaluation_case_ids(repository))
            previous_run = "run-a739c37c-d72b-425f-9a65-ff064616c580"
            previous_report = repository / f"evolution/experiments/EXP-security-operations-expert-008/runs/{previous_run}/report.md"
            old_report = previous_report.read_bytes()
            completed, payload = self.run_eval(repository, env, "U-INS-001", compare_to=previous_run)
            run_dir = (repository / payload["summary"]).parent
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            report = (repository / payload["report"]).read_text(encoding="utf-8")
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            inputs = (run_dir / "inputs.lock.json").read_text(encoding="utf-8")
            manifest = (run_dir / "run.yaml").read_text(encoding="utf-8")
            commands = [json.loads(line) for line in command_log.read_text(encoding="utf-8").splitlines()]
            persisted = b"\n".join(path.read_bytes() for path in run_dir.rglob("*") if path.is_file())
            self.assertEqual(previous_report.read_bytes(), old_report)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(payload["executor"], "api")
        self.assertEqual(payload["verdict"], "passed")
        self.assertEqual(payload["review_status"], "not_requested")
        self.assertEqual(
            payload["cases"],
            {"total": 1, "passed": 1, "failed": 0, "inconclusive": 0},
        )
        self.assertTrue(payload["instance_stopped"])
        self.assertEqual(summary["machine_overall_verdict"], "passed")
        self.assertEqual(summary["effective_verdict"], "passed")
        self.assertEqual(summary["review_status"], "not_requested")
        self.assertIn("# 测试评估报告", report)
        self.assertIn("- Case 选择：`explicit`", report)
        self.assertIn("`U-INS-001`", report)
        self.assertIn("## Case 结果与证据复核", report)
        self.assertIn("## 与之前版本的对比", report)
        self.assertIn(f"[{previous_run}]", report)
        self.assertIn(
            "| Case | 输入 | 判定依据 | 执行状态 | 机器结论 | 复核结论 | 是否修正 | 判定说明 | 证据 |",
            report,
        )
        self.assertIn("执行一次常规巡检。", report)
        self.assertIn("通过", report)
        self.assertIn("## 场景覆盖与归因", report)
        self.assertIn("### 缺口与归因", report)
        self.assertEqual(sum(len(scene["case_ids"]) for scene in analysis["scenes"]), expected_case_count)
        self.assertEqual(sum(len(scene["selected_case_ids"]) for scene in analysis["scenes"]), 1)
        self.assertEqual(analysis["review_status"], "not_requested")
        self.assertEqual(
            sum(scene["review_status"] == "not_evaluated" for scene in analysis["scenes"]),
            len(analysis["scenes"]) - 1,
        )
        self.assertIn('executor": "api"', inputs)
        self.assertIn(f'"compare_to_run_id": "{previous_run}"', inputs)
        self.assertIn("report_sha256:", manifest)
        self.assertEqual([command[0] for command in commands], ["up", "url", "down"])
        self.assertNotIn("opaque-eval-auth-token", completed.stdout + completed.stderr)
        self.assertNotIn(b"opaque-eval-auth-token", persisted)

    def test_case_failure_continues_and_returns_one(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp), mode="case-failure")
            completed, payload = self.run_eval(
                repository,
                env,
                "U-INS-001",
                "U-INS-002",
                executor="api",
            )
            results = [
                json.loads(line)
                for line in ((repository / payload["summary"]).parent / "results.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            run_dir = (repository / payload["summary"]).parent
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            report = (run_dir / "report.md").read_text(encoding="utf-8")
            commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(payload["executor"], "api")
        self.assertEqual(payload["verdict"], "failed")
        self.assertEqual(
            payload["cases"],
            {"total": 2, "passed": 1, "failed": 1, "inconclusive": 0},
        )
        self.assertEqual(
            [row["input_id"] for row in results],
            ["U-INS-001", "U-INS-002"],
        )
        self.assertEqual(commands, ["up", "url", "down"])
        self.assertEqual(analysis["review_status"], "not_requested")
        self.assertFalse(any(scene["findings"] for scene in analysis["scenes"]))
        self.assertIn("未形成结构化缺口与根因假设；这不表示不存在缺口。", report)

    def test_browser_smoke_completes_without_business_verdict_or_review(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp), mode="browser-smoke")
            completed, payload = self.run_eval(repository, env, "U-INS-001", executor="browser")
            run_dir = (repository / payload["summary"]).parent
            result = json.loads((run_dir / "results.jsonl").read_text(encoding="utf-8"))
            commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(payload["executor"], "browser")
        self.assertEqual(payload["verdict"], "inconclusive")
        self.assertEqual(payload["review_status"], "not_requested")
        self.assertEqual(result["execution_status"], "completed")
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertEqual(commands, ["up", "url", "down"])

    def test_browser_refuses_business_review_and_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp))
            reviewed, _ = self.run_eval(
                repository, env, "U-INS-001", executor="browser", review="ai",
            )
            judged, payload = self.run_eval(repository, env, "U-INS-001", executor="browser")
            result = json.loads((repository / payload["summary"]).parent.joinpath("results.jsonl")
                                .read_text(encoding="utf-8"))
        self.assertEqual(reviewed.returncode, 2, reviewed.stderr)
        self.assertEqual(judged.returncode, 2, judged.stderr)
        self.assertEqual(result["execution_status"], "error")
        self.assertEqual(payload["verdict"], "inconclusive")

    def test_invalid_full_review_preserves_evidence_and_fails_closed(self) -> None:
        for analysis_mode in ("invalid", "failed-read", "partial-read"):
            with self.subTest(analysis_mode=analysis_mode), tempfile.TemporaryDirectory() as temp:
                repository, env, command_log = self.runtime_fixture(
                    Path(temp), mode="case-failure",
                )
                env["TEST_ANALYSIS_MODE"] = analysis_mode
                completed, payload = self.run_eval(repository, env, mode="full")
                run_dir = (repository / payload["summary"]).parent
                analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
                summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
                manifest = (run_dir / "run.yaml").read_text(encoding="utf-8")
                commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertEqual(payload["verdict"], "inconclusive")
                self.assertEqual(payload["review_status"], "failed")
                self.assertEqual(analysis["review_status"], "failed")
                self.assertTrue(all(
                    scene["review_status"] == "failed" and scene["diagnostic"]
                    for scene in analysis["scenes"] if scene["selected_case_ids"]
                ))
                self.assertEqual(
                    {scene["diagnostic"]["stage"] for scene in analysis["scenes"]
                     if scene["selected_case_ids"]},
                    {"evidence-access"},
                )
                self.assertEqual(summary["effective_verdict"], "inconclusive")
                self.assertIn('status: "failed"', manifest)
                self.assertEqual(commands, ["up", "url", "up", "url", "down", "down"])

    def test_full_review_covers_every_case_and_can_correct_machine_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp))
            expected_case_count = len(evaluation_case_ids(repository))
            env["TEST_ANALYSIS_MODE"] = "correct-first"
            completed, payload = self.run_eval(repository, env, mode="full")
            run_dir = (repository / payload["summary"]).parent
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            report = (run_dir / "report.md").read_text(encoding="utf-8")
            selected_scenes = [scene for scene in analysis["scenes"] if scene["selected_case_ids"]]
            commands = [json.loads(line) for line in command_log.read_text().splitlines()]
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(payload["review_status"], "completed")
        self.assertEqual(payload["cases"], {
            "total": expected_case_count, "passed": expected_case_count, "failed": 0, "inconclusive": 0,
        })
        self.assertEqual(payload["reviewed_cases"], {
            "total": expected_case_count, "passed": expected_case_count - 1, "failed": 1, "inconclusive": 0,
        })
        self.assertEqual(summary["machine_overall_verdict"], "passed")
        self.assertEqual(summary["reviewed_overall_verdict"], "failed")
        self.assertEqual(summary["effective_verdict"], "failed")
        self.assertEqual(analysis["reviewed_case_count"], expected_case_count)
        self.assertTrue(all(scene["review_status"] == "completed" for scene in selected_scenes))
        self.assertEqual(
            len({scene["analysis_session"]["session_id"] for scene in selected_scenes}),
            len(selected_scenes),
        )
        self.assertTrue(all(scene["findings"] for scene in selected_scenes))
        self.assertNotIn("### 证据复核", report)
        self.assertIn("## Case 结果与证据复核", report)
        self.assertIn("原始机器观察保留在 [`results.jsonl`](results.jsonl)", report)
        self.assertEqual(report.count("| `U-INS-001` |"), 1)
        self.assertIn("### 缺口与归因", report)
        self.assertIn("机器结论未表达场景证据中的能力边界", report)
        self.assertIn("| 是 |", report)
        self.assertEqual(
            [command[0] for command in commands],
            ["up", "url", "up", "url", "down", "down"],
        )
        self.assertEqual(
            commands[2][commands[2].index("--analysis-workspace") + 1],
            str(run_dir.resolve()),
        )

    def test_explicit_case_can_request_ai_review(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp))
            completed, payload = self.run_eval(repository, env, "U-INS-001", review="ai")
            run_dir = (repository / payload["summary"]).parent
            inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(inputs["selection_mode"], "explicit")
        self.assertEqual(inputs["review_mode"], "ai")
        self.assertEqual(analysis["review_status"], "completed")
        self.assertEqual(analysis["reviewed_case_count"], 1)
        self.assertEqual(commands, ["up", "url", "up", "url", "down", "down"])

    def test_full_review_repairs_invalid_output_in_same_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp))
            expected_case_count = len(evaluation_case_ids(repository))
            env["TEST_ANALYSIS_MODE"] = "repair-output"
            completed, payload = self.run_eval(repository, env, mode="full")
            run_dir = (repository / payload["summary"]).parent
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            attempts = sorted((run_dir / "evidence/analysis").glob(
                "scene-*/attempt-01-response.json"
            ))
            sessions = [
                (json.loads(path.read_text(encoding="utf-8"))["session_id"],
                 json.loads((path.parent / "response.json").read_text(encoding="utf-8"))["session_id"])
                for path in attempts
            ]

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(analysis["review_status"], "completed")
        self.assertEqual(analysis["reviewed_case_count"], expected_case_count)
        self.assertEqual(len(attempts), sum(bool(scene["selected_case_ids"]) for scene in analysis["scenes"]))
        self.assertTrue(all(first == repaired for first, repaired in sessions))

    def test_manual_gap_is_rendered_without_starting_analysis_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp))
            script = repository / "runtime/adapters/dsh-container/run_record.py"
            base = ["python3", str(script), "--repo", str(repository)]
            init = subprocess.run(
                base + ["init", "--source", "experiment:EXP-security-operations-expert-006",
                        "--case", "U-INS-001"], cwd=repository, env=env,
                text=True, capture_output=True, check=False, timeout=180,
            )
            self.assertEqual(init.returncode, 0, init.stderr)
            run_id = init.stdout.strip()
            run_dir = repository / f"evolution/experiments/EXP-security-operations-expert-006/runs/{run_id}"
            evidence = run_dir / "evidence/U-INS-001/response.json"
            evidence.parent.mkdir(parents=True)
            evidence.write_text(json.dumps({"assistant_text": "目标回复与预期不符"}), encoding="utf-8")
            row = {
                "run_id": run_id, "trial_id": "trial-manual-1", "input_id": "U-INS-001",
                "execution_status": "completed", "verdict": "failed",
                "observation": "与预期不符", "evidence_ref": "evidence/U-INS-001/response.json",
            }
            record = subprocess.run(base + ["record", "--run", run_id, "-"],
                                    cwd=repository, env=env, input=json.dumps(row),
                                    text=True, capture_output=True, check=False, timeout=180)
            self.assertEqual(record.returncode, 0, record.stderr)
            gap = subprocess.run(
                base + [
                    "gap", "--run", run_id, "--classification", "harness",
                    "--title", "巡检输出缺少证据字段", "--observed", "回复未给出报告链接",
                    "--next-step", "补充约束后重跑", "--evidence", "evidence/U-INS-001/response.json",
                ],
                cwd=repository, env=env, text=True, capture_output=True, check=False, timeout=180,
            )
            self.assertEqual(gap.returncode, 0, gap.stderr)
            finalize = subprocess.run(base + ["finalize", "--run", run_id, "--status", "completed"],
                                      cwd=repository, env=env, text=True,
                                      capture_output=True, check=False, timeout=180)
            self.assertEqual(finalize.returncode, 0, finalize.stderr)
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            report = (run_dir / "report.md").read_text(encoding="utf-8")
        self.assertFalse(command_log.exists())
        self.assertEqual(analysis["review_status"], "not_requested")
        self.assertIn("### 人工记录的研究缺口", report)
        self.assertIn("巡检输出缺少证据字段", report)
        self.assertIn("evidence/U-INS-001/response.json", report)

    def test_analysis_content_validation_rejects_tampered_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp), mode="case-failure")
            completed, payload = self.run_eval(repository, env, "U-INS-001")
            self.assertEqual(completed.returncode, 1, completed.stderr)
            run_dir = (repository / payload["summary"]).parent
            analysis_path = run_dir / "analysis.json"
            original_hash = hashlib.sha256(analysis_path.read_bytes()).hexdigest()
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
            analysis["scenes"][0]["machine_counts"]["failed"] = 0
            analysis_path.write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")
            manifest = run_dir / "run.yaml"
            manifest.write_text(
                manifest.read_text(encoding="utf-8").replace(
                    original_hash, hashlib.sha256(analysis_path.read_bytes()).hexdigest()
                ), encoding="utf-8",
            )
            checked, verdict = run_json(
                repository / "runtime/research/validate_experiment.py",
                repository / "evolution/experiments/EXP-security-operations-expert-006", cwd=repository,
            )
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("RUN_ANALYSIS", error_codes(verdict))

    def test_fast_full_and_explicit_case_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            expected_case_ids = evaluation_case_ids(repository)
            expected_fast_case_ids = evaluation_case_ids(repository, fast_only=True)
            command = [
                "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                "--source", "experiment:EXP-security-operations-expert-006",
                "--dry-run",
            ]
            fast = subprocess.run(
                command, cwd=repository, text=True, capture_output=True, check=False, timeout=180,
            )
            full = subprocess.run(
                command + ["--mode", "full"], cwd=repository, text=True,
                capture_output=True, check=False, timeout=180,
            )
            explicit = subprocess.run(
                command + ["--mode", "full", "--case", "U-INS-002"], cwd=repository,
                text=True, capture_output=True, check=False, timeout=180,
            )
            evaluation = repository / "agents/security-operations-expert/evaluation.md"
            evaluation.write_text(
                evaluation.read_text(encoding="utf-8").replace("**评估档位：** `fast`\n\n", ""),
                encoding="utf-8",
            )
            missing = subprocess.run(
                command, cwd=repository, text=True, capture_output=True, check=False, timeout=180,
            )
        self.assertEqual(fast.returncode, 0, fast.stderr)
        self.assertEqual(json.loads(fast.stdout)["case_ids"], expected_fast_case_ids)
        self.assertEqual(json.loads(fast.stdout)["selection_mode"], "fast")
        self.assertEqual(full.returncode, 0, full.stderr)
        self.assertEqual(json.loads(full.stdout)["case_ids"], expected_case_ids)
        self.assertEqual(json.loads(full.stdout)["selection_mode"], "full")
        self.assertEqual(explicit.returncode, 0, explicit.stderr)
        self.assertEqual(json.loads(explicit.stdout)["case_ids"], ["U-INS-002"])
        self.assertEqual(json.loads(explicit.stdout)["selection_mode"], "explicit")
        self.assertEqual(missing.returncode, 2)
        self.assertIn("没有标记 fast", missing.stderr)

    def test_default_fast_run_locks_selected_scenes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp))
            expected_fast_case_ids = evaluation_case_ids(repository, fast_only=True)
            completed, payload = self.run_eval(repository, env)
            run_dir = (repository / payload["summary"]).parent
            inputs = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            analysis = json.loads((run_dir / "analysis.json").read_text(encoding="utf-8"))
            report = (run_dir / "report.md").read_text(encoding="utf-8")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(inputs["selection_mode"], "fast")
        self.assertIn("- Case 选择：`fast`", report)
        self.assertEqual([item["case_id"] for item in inputs["evaluation_cases"]], expected_fast_case_ids)
        self.assertEqual(analysis["review_status"], "not_requested")
        self.assertEqual(sum(scene["machine_counts"]["passed"] for scene in analysis["scenes"]), len(expected_fast_case_ids))
        self.assertEqual(sum(scene["machine_counts"]["not_executed"] for scene in analysis["scenes"]), 0)

    def test_case_patterns_select_in_document_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository = copy_repository(Path(temp))
            command = [
                "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                "--source", "experiment:EXP-security-operations-expert-006", "--dry-run",
                "--case", "U-INS-*", "--case", "U-INS-001",
            ]
            selected = subprocess.run(
                command, cwd=repository, text=True, capture_output=True, check=False, timeout=180,
            )
            unmatched = subprocess.run(
                [
                    "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                    "--source", "experiment:EXP-security-operations-expert-006",
                    "--dry-run", "--case", "U-NOT-*",
                ], cwd=repository, text=True,
                capture_output=True, check=False, timeout=180,
            )
            selected_payload = json.loads(selected.stdout)
        self.assertEqual(selected.returncode, 0, selected.stderr)
        self.assertEqual(selected_payload["case_ids"], [
            "U-INS-001", "U-INS-002", "U-INS-003", "U-INS-004", "U-INS-005", "U-INS-006", "U-INS-007",
        ])
        self.assertEqual(unmatched.returncode, 2, unmatched.stderr)
        self.assertIn("未匹配 Case 模式：U-NOT-*", unmatched.stderr)

    def test_preflight_failure_does_not_create_run_or_start_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp))
            validator = repository / "runtime/research/validate_repository.py"
            validator.write_text(
                'import json\nprint(json.dumps({"valid": False, "errors": [{"code": "test-invalid"}]}))\nraise SystemExit(1)\n',
                encoding="utf-8",
            )
            runs = repository / "evolution/experiments/EXP-security-operations-expert-006/runs"
            before = set(runs.glob("run-*")) if runs.is_dir() else set()
            completed, payload = self.run_eval(repository, env, "U-INS-001")
            after = set(runs.glob("run-*")) if runs.is_dir() else set()
            instance_started = command_log.exists()
        self.assertEqual(completed.returncode, 2, completed.stderr)
        self.assertIsNone(payload["run_id"])
        self.assertEqual(payload["verdict"], "inconclusive")
        self.assertEqual(before, after)
        self.assertFalse(instance_started)

    def test_mid_run_exception_is_sealed_and_instance_is_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, command_log = self.runtime_fixture(Path(temp), mode="exception")
            completed, payload = self.run_eval(repository, env, "U-INS-001")
            run_dir = (repository / payload["summary"]).parent
            result = json.loads((run_dir / "results.jsonl").read_text(encoding="utf-8"))
            manifest = (run_dir / "run.yaml").read_text(encoding="utf-8")
            commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
        self.assertEqual(completed.returncode, 2, completed.stderr)
        self.assertEqual(payload["verdict"], "inconclusive")
        self.assertEqual(result["execution_status"], "error")
        self.assertIn('status: "failed"', manifest)
        self.assertEqual(commands, ["up", "url", "down"])

    def test_safety_stop_marks_remaining_cases_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repository, env, _ = self.runtime_fixture(Path(temp), mode="safety-stop")
            completed, payload = self.run_eval(
                repository,
                env,
                "U-INS-001",
                "U-INS-002",
            )
            run_dir = (repository / payload["summary"]).parent
            results = [
                json.loads(line)
                for line in (run_dir / "results.jsonl").read_text(encoding="utf-8").splitlines()
            ]
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual([row["execution_status"] for row in results], ["error", "skipped"])
        self.assertEqual(
            payload["cases"],
            {"total": 2, "passed": 0, "failed": 0, "inconclusive": 2},
        )

    def assert_signal_seals_cancelled_run(self, cancellation_signal: int) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repository, env, command_log = self.runtime_fixture(root, mode="hang")
            process = subprocess.Popen(
                [
                    "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                    "--source", "experiment:EXP-security-operations-expert-006",
                    "--case", "U-INS-001", "--timeout-seconds", "10",
                ],
                cwd=repository,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            ready = root / "browser-ready"
            deadline = time.monotonic() + 180
            while not ready.is_file() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(ready.is_file(), "浏览器替身未进入运行阶段")
            process.send_signal(cancellation_signal)
            stdout, stderr = process.communicate(timeout=30)
            payload = json.loads(stdout)
            run_dir = (repository / payload["summary"]).parent
            result = json.loads((run_dir / "results.jsonl").read_text(encoding="utf-8"))
            manifest = (run_dir / "run.yaml").read_text(encoding="utf-8")
            commands = [json.loads(line)[0] for line in command_log.read_text().splitlines()]
        self.assertEqual(process.returncode, 2, stderr)
        self.assertEqual(result["execution_status"], "skipped")
        self.assertIn('status: "cancelled"', manifest)
        self.assertEqual(commands, ["up", "url", "down"])
        self.assertTrue(payload["cancelled"])
        self.assertTrue(payload["instance_stopped"])

    def test_sigint_seals_cancelled_run_and_stops_instance(self) -> None:
        self.assert_signal_seals_cancelled_run(signal.SIGINT)

    def test_sigterm_seals_cancelled_run_and_stops_instance(self) -> None:
        self.assert_signal_seals_cancelled_run(signal.SIGTERM)

    def test_cancel_preserves_completed_trial_and_in_progress_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repository, env, _ = self.runtime_fixture(root, mode="partial-hang")
            process = subprocess.Popen([
                "python3", str(repository / "runtime/adapters/dsh-container/dsh-eval"), "--repo", str(repository),
                "--source", "experiment:EXP-security-operations-expert-006",
                "--case", "U-INS-001", "--case", "U-INS-002", "--timeout-seconds", "10",
            ], cwd=repository, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            try:
                runs = repository / "evolution/experiments/EXP-security-operations-expert-006/runs"
                previous = {path.name for path in runs.glob("run-*")}
                deadline = time.monotonic() + 180
                selected = None
                while time.monotonic() < deadline and process.poll() is None:
                    selected = next((run for run in runs.glob("run-*") if run.name not in previous and (run / "results.jsonl").is_file()
                                     and "U-INS-001" in (run / "results.jsonl").read_text()), None)
                    if selected and (root / "browser-ready").is_file():
                        break
                    time.sleep(0.05)
                self.assertIsNotNone(selected, "第一条 Case 应在第二条完成前持久保存")
                evidence = selected / "evidence/U-INS-002"
                original = {name: (evidence / name).read_bytes() for name in ("trace.jsonl", "tools.jsonl", "response.json", "checks.json")}
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 2, stderr)
                payload = json.loads(stdout)
                rows = [json.loads(line) for line in (selected / "results.jsonl").read_text().splitlines()]
                self.assertEqual([row["execution_status"] for row in rows], ["completed", "skipped"])
                for name, content in original.items():
                    self.assertEqual((evidence / name).read_bytes(), content, name)
                self.assertTrue(json.loads((evidence / "interruption.json").read_text())["trace_available"])
                self.assertTrue(payload["cancelled"])
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.communicate(timeout=30)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=5)

    def test_process_deadline_stops_and_seals_without_platform_timer(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repository, env, _ = self.runtime_fixture(root, mode="hang")
            env["HARNESS_EVAL_DEADLINE_AT"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + 8))
            env["HARNESS_EVAL_JOB_ID"] = str(uuid.uuid4())
            completed, payload = self.run_eval(repository, env, "U-INS-001")
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertTrue(payload["cancelled"])
            self.assertTrue(payload["instance_stopped"])
            execution = json.loads(((repository / payload["summary"]).parent / "execution.json").read_text())
            self.assertEqual(execution["failure_reason"], "budget-deadline-exceeded")
            self.assertEqual(execution["job_id"], env["HARNESS_EVAL_JOB_ID"])


class EvaluationSourceTests(unittest.TestCase):
    @staticmethod
    def load_contract():
        spec = importlib.util.spec_from_file_location("evaluation_contract", EVALUATION_CONTRACT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_fast_marker_does_not_change_case_digest_and_malformed_marker_fails(self) -> None:
        contract = self.load_contract()
        source = ASSETS / "agents/test01/evaluation.md"
        with tempfile.TemporaryDirectory() as temp:
            plain = Path(temp) / "evaluation.md"
            plain.write_text(source.read_text(encoding="utf-8").replace(
                "**评估档位：** `fast`\n\n", ""
            ), encoding="utf-8")
            self.assertEqual(
                contract.evaluation_digest(source, ["U-IDENTITY-001"]),
                contract.evaluation_digest(plain, ["U-IDENTITY-001"]),
            )
            plain.write_text(source.read_text(encoding="utf-8").replace(
                "**评估档位：** `fast`", "**评估档位：** `full`"
            ), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "评估档位"):
                contract.load_evaluation(plain)

    def test_scene_counts_each_case_once_across_trials(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "scenario_analysis", ROOT / "runtime/adapters/dsh-container/scenario_analysis.py",
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inputs = {
            "run_id": "run-test",
            "case_catalog": [{"case_id": "U-ONE-001", "scene": "同一场景", "fast": True}],
            "evaluation_cases": [{"case_id": "U-ONE-001"}],
        }
        rows = [
            {"input_id": "U-ONE-001", "execution_status": "completed", "verdict": "passed"},
            {"input_id": "U-ONE-001", "execution_status": "completed", "verdict": "failed"},
        ]
        with tempfile.TemporaryDirectory() as temp:
            scene = module.analyze(Path(temp), rows, inputs, status="failed")["scenes"][0]
        self.assertEqual(scene["machine_counts"], {
            "passed": 0, "failed": 1, "inconclusive": 0, "not_executed": 0,
        })

    def test_candidate_model_configuration_is_unchanged(self) -> None:
        profile_text = (
            ASSETS / "evolution/experiments/EXP-security-operations-expert-006"
            / "candidate/dsh/managed/security-operations-expert.patch.yml"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "- id: agent-default-model\n  config:\n"
            "    provider: deepseek-official\n    model: deepseek-flash",
            profile_text,
        )
        self.assertIn("- id: llm-deepseek\n  config:\n    reasoningEffort: off", profile_text)

    def test_unknown_case_selection_is_rejected(self) -> None:
        evaluation = ASSETS / "agents" / AGENT_ID / "evaluation.md"
        with self.assertRaisesRegex(ValueError, "未定义"):
            self.load_contract().execution_for(evaluation, ["U-NOT-DEFINED"])

    def test_duplicate_inputs_and_old_case_shape_are_rejected(self) -> None:
        module = self.load_contract()
        with tempfile.TemporaryDirectory() as temp:
            evaluation = Path(temp) / "evaluation.md"
            evaluation.write_text(
                """# 示例

#### U-ONE-001 一
**用户输入**
> 相同输入。
**预期**
结果一。

#### U-TWO-001 二
**用户输入**
> 相 同 输 入。
**预期**
结果二。
""",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "业务测试输入重复"):
                module.load_evaluation(evaluation)

            evaluation.write_text(
                """# 示例

#### T-CONTRACT-STATIC 静态合同
**用户输入**
> 检查合同。
**预期**
通过。
""",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "只允许业务 U-\* Case"):
                module.load_evaluation(evaluation)


if __name__ == "__main__":
    unittest.main()

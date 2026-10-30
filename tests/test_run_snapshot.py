from __future__ import annotations

import argparse
import contextlib
import importlib.machinery
import importlib.util
import io
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import test_validators as fixtures


def load_module(path: Path, prefix: str):
    loader = importlib.machinery.SourceFileLoader(f"{prefix}_{uuid.uuid4().hex}", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def evaluation_text(case_id: str, stage: str) -> str:
    return f"""# 测试用例

### {stage}场景

#### {case_id} {stage}用例

**评估档位：** `fast`

**用户输入**

> {stage}输入。

**预期**

{stage}预期。
"""


def recorded_run(module, repo: Path, external_fixture: bytes | None = None) -> tuple[Path, dict]:
    experiment = fixtures.write_minimal_experiment(repo)
    if external_fixture is not None:
        fixture = experiment / "candidate/dsh/managed/compute-workflow/fixtures.json"
        fixture.parent.mkdir(parents=True)
        fixture.write_bytes(external_fixture)
    for name in ("workspace", "presets", "managed"):
        folder = experiment / "candidate" / name
        folder.mkdir()
        (folder / "role.md").write_text("基本测试角色。\n", encoding="utf-8")
    contract = {
        "source_id": f"experiment:{experiment.name}", "source_kind": "experiment",
        "experiment_id": experiment.name, "agent_id": "example-agent",
        **{name: str(experiment / "candidate" / name) for name in ("workspace", "presets", "managed")},
        "config_markers": [], "required_env_names": [], "optional_env_names": [],
    }
    args = argparse.Namespace(source=contract["source_id"], baseline_ref=None, case=["U-EXAMPLE-001"],
                              selection_mode="explicit", kind="research", model=None,
                              executor="api", review_mode="none", compare_to=None)
    with mock.patch.object(module, "resolve", return_value=contract), contextlib.redirect_stdout(io.StringIO()) as output:
        module.command_init(repo, args)
    run_id = output.getvalue().strip()
    run_dir = experiment / "runs" / run_id
    (run_dir / "evidence").mkdir(exist_ok=True)
    (run_dir / "evidence/observation.txt").write_text("基本测试观察。", encoding="utf-8")
    trial = repo / "trial.json"
    trial.write_text(json.dumps({"run_id": run_id, "trial_id": "trial-" + str(uuid.uuid4()),
                                "input_id": "U-EXAMPLE-001", "execution_status": "completed", "verdict": "passed",
                                "observation": "基本测试观察。", "evidence_ref": "evidence/observation.txt"}), encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()):
        module.command_record(repo, argparse.Namespace(run=run_id, trial_file=str(trial)))
    return run_dir, contract


class FrozenRunSnapshotTests(unittest.TestCase):
    def test_experiment_index_skips_ignored_residue_but_reports_missing_visible_manifest(self) -> None:
        module = load_module(fixtures.RUN_RECORD, "ignored_experiment_residue")
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
            (repo / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
            experiment = repo / "evolution/experiments/EXP-example-agent-998"
            ignored = experiment / "candidate/node_modules/cache.js"
            ignored.parent.mkdir(parents=True)
            ignored.write_text("cached", encoding="utf-8")

            errors = []
            self.assertEqual(module.agent_experiments(repo, "example-agent", errors), [])
            self.assertEqual(errors, [], "仅剩 Git 忽略产物的目录不应污染 Run 列表")

            visible = experiment / "notes.md"
            visible.write_text("尚未完成的版本资料", encoding="utf-8")
            for stage in ("untracked", "tracked", "tracked-deleted"):
                with self.subTest(stage=stage):
                    if stage == "tracked":
                        subprocess.run(["git", "-C", str(repo), "add", "--", str(visible.relative_to(repo))],
                                       check=True, capture_output=True)
                    elif stage == "tracked-deleted":
                        visible.unlink()
                    errors = []
                    self.assertEqual(module.agent_experiments(repo, "example-agent", errors), [])
                    self.assertEqual(len(errors), 1)
                    self.assertEqual(errors[0]["experiment_id"], experiment.name)
                    self.assertEqual(errors[0]["path"], str((experiment / "change.yaml").relative_to(repo)))
                    self.assertIn("FileNotFoundError", errors[0]["error"])

    def test_overview_isolates_invalid_run_and_experiment(self) -> None:
        module = load_module(fixtures.ROOT / "runtime/adapters/dsh-container/run_record.py", "record")
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            run_dir, _ = recorded_run(module, repo)
            bad_run = run_dir.parent / ("run-" + str(uuid.uuid4()))
            bad_run.mkdir()
            (bad_run / "run.yaml").write_text("run_id: first\nrun_id: second\n", encoding="utf-8")
            bad_exp = repo / "evolution/experiments/EXP-example-agent-999"
            bad_exp.mkdir()
            (bad_exp / "change.yaml").write_text("invalid: [\n", encoding="utf-8")
            (repo / "agents/another-agent").mkdir()
            with contextlib.redirect_stdout(io.StringIO()) as output:
                module.command_overview(repo)
            result = json.loads(output.getvalue())
            self.assertEqual(len(result["agents"]), 2)
            self.assertEqual(len(result["errors"]), 2)
            example = next(agent for agent in result["agents"] if agent["agent_id"] == "example-agent")
            self.assertEqual(example["experiments"][0]["runs"][0]["run_id"], run_dir.name)

    def test_external_inputs_freeze_original_bytes_and_explicit_mode(self) -> None:
        for mode in ("mock-replay", "replay"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                repo = Path(temporary)
                module = load_module(fixtures.RUN_RECORD, "external_inputs_snapshot")
                original = (f'{{ "mode" : "{mode}", "observations": ["原始样本"] }}\r\n').encode("utf-8")
                run_dir, _ = recorded_run(module, repo, original)
                locked = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
                self.assertEqual(locked["external_inputs"], {
                    "mode": mode, "fixture_sha256": hashlib.sha256(original).hexdigest(),
                })
                frozen = run_dir / "evidence/external-inputs.json"
                self.assertEqual(frozen.read_bytes(), original, "封存原始字节，不能重新序列化后冒充原摘要")
                candidate_fixture = run_dir.parents[1] / "candidate/dsh/managed/compute-workflow/fixtures.json"
                candidate_fixture.write_text('{"mode":"mock-replay","observations":["后续修改"]}', encoding="utf-8")
                self.assertEqual(frozen.read_bytes(), original, "后续 Candidate 编辑不能改写本次封存输入")
                self.assertEqual(json.loads((run_dir / "inputs.lock.json").read_text())["external_inputs"], locked["external_inputs"])

    def test_external_inputs_reject_missing_or_invalid_mode_without_partial_run(self) -> None:
        for value in ({}, {"mode": "live"}, {"mode": "mock"}, {"mode": None}, {"mode": ""}):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as temporary:
                repo = Path(temporary)
                module = load_module(fixtures.RUN_RECORD, "external_inputs_mode")
                with self.assertRaisesRegex(ValueError, "mock-replay 或 replay"):
                    recorded_run(module, repo, json.dumps(value).encode("utf-8"))
                runs = next((repo / "evolution/experiments").iterdir()) / "runs"
                self.assertEqual(list(runs.iterdir()), [], "拒绝无效输入后不留下部分 Run")

    def test_run_without_external_fixture_does_not_claim_frozen_external_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            module = load_module(fixtures.RUN_RECORD, "external_inputs_absent")
            run_dir, _ = recorded_run(module, Path(temporary))
            locked = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            self.assertNotIn("external_inputs", locked)
            self.assertFalse((run_dir / "evidence/external-inputs.json").exists())

    def test_run_records_program_and_asset_versions_separately(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            (repo / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-fixture"}))
            module = load_module(fixtures.RUN_RECORD, "run_origins")
            run_dir, _ = recorded_run(module, repo)
            inputs = json.loads((run_dir / "inputs.lock.json").read_text())
            self.assertEqual(inputs["asset_origin"]["workspace_id"], "workspace-fixture")
            self.assertEqual(inputs["asset_origin"]["commit"], inputs["git_version"]["commit"])
            self.assertEqual(inputs["asset_origin"]["candidate_sha256"], inputs["candidate_sha256"])
            self.assertEqual(inputs["program_origin"]["root"], str(module.PROGRAM_ROOT))
            self.assertNotEqual(str(repo), inputs["program_origin"]["root"])
            self.assertEqual(inputs["harness_review"], {"schema_version": 1, "generated": [], "sources": []})
            for name in ("harness-runtime.mts", "platform/plugin/src/agents/asset-build.ts",
                         "platform/plugin/src/agents/asset-build-core.ts", "platform/plugin/src/agents/asset-dependencies.ts",
                         "platform/plugin/src/models/harness-runtime.ts"):
                self.assertRegex(inputs["evaluation_implementation"][name], r"^[a-f0-9]{64}$")

    def test_build_review_bridge_failure_or_candidate_mismatch_keeps_full_text_contract(self) -> None:
        module = load_module(fixtures.RUN_RECORD, "review_bridge_fallback")
        empty = {"schema_version": 1, "generated": [], "sources": []}
        for result in (subprocess.CompletedProcess([], 1, stdout="", stderr="unavailable"),
                       subprocess.CompletedProcess([], 0, stdout="not-json", stderr=""),
                       subprocess.CompletedProcess([], 0, stdout=json.dumps({
                           "schema_version": 1, "generated": [{"path": "generated.mjs"}], "sources": [],
                           "candidate_sha256": "other",
                       }), stderr="")):
            with self.subTest(result=result), mock.patch.object(module.subprocess, "run", return_value=result):
                self.assertEqual(module.build_review_evidence(Path("."), "EXP-test-001", {"asset_builds": {"entry": {}}}, "frozen"), empty)

    def test_finalize_verifies_frozen_source_and_preserves_real_case_results(self) -> None:
        for mutation in ("unchanged", "content", "directory_permission", "unresolvable"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                repo = Path(temporary)
                module = load_module(fixtures.RUN_RECORD, "run_source_verification")
                run_dir, contract = recorded_run(module, repo)
                inputs_before = (run_dir / "inputs.lock.json").read_bytes()
                results_before = (run_dir / "results.jsonl").read_bytes()
                candidate = run_dir.parents[1] / "candidate"
                if mutation == "content":
                    (candidate / "harness.yaml").write_text('schema_version: "1.0"\nvalue: changed-during-run\n', encoding="utf-8")
                if mutation == "directory_permission":
                    (candidate / "managed").chmod(0o500)
                resolve = mock.patch.object(module, "resolve", side_effect=ValueError("source missing")) \
                    if mutation == "unresolvable" else mock.patch.object(module, "resolve", return_value=contract)
                try:
                    with resolve, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as diagnostic:
                        module.command_finalize(repo, argparse.Namespace(run=run_dir.name, status="completed"))
                finally:
                    (candidate / "managed").chmod(0o755)
                manifest = module.read_flat_yaml(run_dir / "run.yaml")
                summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
                changed = mutation != "unchanged"
                self.assertEqual(manifest["status"], "failed" if changed else "completed")
                self.assertEqual(summary["effective_verdict"], "inconclusive" if changed else "passed")
                self.assertEqual(summary["machine_overall_verdict"], "passed")
                self.assertEqual((run_dir / "inputs.lock.json").read_bytes(), inputs_before)
                self.assertEqual((run_dir / "results.jsonl").read_bytes(), results_before)
                verification = summary["source_verification"]
                self.assertEqual(verification["status"], "unavailable" if mutation == "unresolvable" else "changed" if changed else "matched")
                if changed:
                    self.assertIn(verification["reason"], diagnostic.getvalue())
                    self.assertIn(verification["reason"], (run_dir / "report.md").read_text(encoding="utf-8"))
                if mutation == "directory_permission":
                    checks = {item["component"]: item["status"] for item in verification["checks"]}
                    self.assertEqual(checks, {"candidate": "matched", "workspace": "matched", "presets": "matched", "managed": "changed", "evaluation_implementation": "matched"})
                completed, validation = fixtures.run_json(fixtures.VALIDATE_EXPERIMENT, run_dir.parents[1])
                self.assertEqual(completed.returncode, 0, validation)
                self.assertTrue(validation["valid"])
                if mutation == "content":
                    # 聚合状态不能掩盖下属清单中的摘要差异。
                    verification["status"] = "matched"
                    (run_dir / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
                    _, invalid = fixtures.run_json(fixtures.VALIDATE_EXPERIMENT, run_dir.parents[1])
                    self.assertIn("RUN_SOURCE_VERIFICATION", fixtures.error_codes(invalid))

    def test_cancelled_run_keeps_cancelled_status_when_source_has_changed(self) -> None:
        module = load_module(fixtures.RUN_RECORD, "cancelled_run_source")
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            run_dir, contract = recorded_run(module, repo)
            (run_dir.parents[1] / "candidate/harness.yaml").write_text("value: changed-during-run\n", encoding="utf-8")
            with mock.patch.object(module, "resolve", return_value=contract), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                module.command_finalize(repo, argparse.Namespace(run=run_dir.name, status="cancelled"))
            self.assertEqual(module.read_flat_yaml(run_dir / "run.yaml")["status"], "cancelled")
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["source_verification"]["reason"], "source-changed")
            self.assertEqual(summary["effective_verdict"], "inconclusive")

    def test_init_uses_one_authoritative_read_when_evaluation_changes_during_initialization(self) -> None:
        module = load_module(fixtures.RUN_RECORD, "run_snapshot")
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            experiment = fixtures.write_minimal_experiment(repo)
            evaluation = repo / "agents/example-agent/evaluation.md"
            case_id = "U-EXAMPLE-001"
            evaluation.write_text(evaluation_text(case_id, "初始化读取"), encoding="utf-8")
            original_load = module.load_evaluation
            before = original_load(evaluation)
            frozen_cases = module.execution_from(before, [case_id])

            def read_then_change(path: Path) -> dict:
                value = original_load(path)
                evaluation.write_text(evaluation_text(case_id, "并发保存"), encoding="utf-8")
                return value

            contract = {
                "source_id": f"experiment:{experiment.name}", "source_kind": "experiment",
                "experiment_id": experiment.name, "agent_id": "example-agent",
                "workspace": str(experiment / "candidate"), "presets": str(experiment / "candidate"),
                "managed": str(experiment / "candidate"), "config_markers": [],
                "required_env_names": [], "optional_env_names": [],
            }
            args = argparse.Namespace(source=contract["source_id"], baseline_ref=None, case=[case_id],
                                      selection_mode="fast", kind="research", model=None,
                                      executor="api", review_mode="none", compare_to=None)
            # 只隔离此最小夹具不提供的来源解析；初始化、解析、摘要和写入执行实际代码。
            with mock.patch.object(module, "resolve", return_value=contract), \
                    mock.patch.object(module, "load_evaluation", side_effect=read_then_change) as read, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                module.command_init(repo, args)
            self.assertEqual(read.call_count, 1)
            run_dir = experiment / "runs" / output.getvalue().strip()
            locked = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
            self.assertEqual(locked["evaluation_cases"], frozen_cases)
            self.assertEqual(locked["case_catalog"], before["catalog"])
            self.assertEqual(locked["evaluation_sha256"], module.cases_digest(frozen_cases))
            self.assertNotEqual(locked["evaluation_sha256"], module.cases_digest(module.execution_from(original_load(evaluation), [case_id])))
            completed, validation = fixtures.run_json(fixtures.VALIDATE_EXPERIMENT, experiment)
            self.assertEqual(completed.returncode, 0, validation)
            self.assertTrue(validation["valid"])

    def test_runtime_driver_executes_init_snapshot_instead_of_earlier_plan_or_later_definition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            helper = fixtures.DshEvalTests()
            repo, env, _ = helper.runtime_fixture(root)
            with mock.patch.dict(os.environ, env, clear=True):
                module = load_module(repo / "runtime/adapters/dsh-container/dsh-eval", "dsh_eval_snapshot")
            evaluation = repo / "agents/security-operations-expert/evaluation.md"
            case_id = "U-INS-001"
            planning_cases = module.execution_for(evaluation, [case_id])
            captured = root / "actual-driver-payload.json"
            fixture_driver = env["DSH_EVAL_API_DRIVER"]
            tee_driver = root / "capture-driver"
            tee_driver.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, subprocess, sys\n"
                "from pathlib import Path\n"
                "payload = json.load(sys.stdin)\n"
                "Path(os.environ['TEST_FROZEN_PAYLOAD']).write_text(json.dumps(payload), encoding='utf-8')\n"
                "completed = subprocess.run([os.environ['TEST_ORIGINAL_DRIVER']], input=json.dumps(payload), text=True, capture_output=True)\n"
                "sys.stdout.write(completed.stdout)\n"
                "sys.stderr.write(completed.stderr)\n"
                "raise SystemExit(completed.returncode)\n",
                encoding="utf-8",
            )
            tee_driver.chmod(0o755)
            env.update({"DSH_EVAL_API_DRIVER": str(tee_driver), "TEST_FROZEN_PAYLOAD": str(captured),
                        "TEST_ORIGINAL_DRIVER": fixture_driver})
            initialize = module.initialize_run
            initialized = {}

            def initialize_after_concurrent_save(source, cases, *args, **kwargs):
                self.assertEqual(cases, planning_cases)
                evaluation.write_text(evaluation_text(case_id, "真正初始化"), encoding="utf-8")
                run_id = initialize(source, cases, *args, **kwargs)
                run_dir = repo / "evolution/experiments/EXP-security-operations-expert-006/runs" / run_id
                initialized["locked"] = json.loads((run_dir / "inputs.lock.json").read_text(encoding="utf-8"))
                # Run 创建后继续保存用例，执行器仍必须使用自身冻结输入。
                evaluation.write_text(evaluation_text(case_id, "运行期间再次保存"), encoding="utf-8")
                return run_id

            args = argparse.Namespace(source="experiment:EXP-security-operations-expert-006", case=[case_id],
                                      mode="fast", executor="api", review="none", dry_run=False,
                                      model=None, compare_to=None, timeout_seconds=10, export_response_markdown=None)
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(module, "initialize_run", side_effect=initialize_after_concurrent_save), \
                    contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()) as diagnostics:
                exit_code = module.execute(args)
            self.assertEqual(exit_code, 0, diagnostics.getvalue())
            result = json.loads(output.getvalue())
            self.assertEqual(result["verdict"], "passed")
            actual_payload = json.loads(captured.read_text(encoding="utf-8"))
            locked = initialized["locked"]
            self.assertEqual(actual_payload["cases"], locked["evaluation_cases"])
            self.assertNotEqual(actual_payload["cases"], planning_cases)
            self.assertNotEqual(actual_payload["cases"], module.execution_for(evaluation, [case_id]))
            self.assertEqual(actual_payload["cases"][0]["inputs"], ["真正初始化输入。"])
            run_dir = (repo / result["summary"]).parent
            recorded_response = json.loads((run_dir / "evidence" / case_id / "response.json").read_text(encoding="utf-8"))
            self.assertEqual(recorded_response["inputs"], locked["evaluation_cases"][0]["inputs"])
            report = (repo / result["report"]).read_text(encoding="utf-8")
            self.assertIn("真正初始化输入。", report)
            self.assertNotIn("运行期间再次保存输入。", report)


if __name__ == "__main__":
    unittest.main()

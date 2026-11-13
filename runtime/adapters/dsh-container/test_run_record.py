"""真实初始化核对预分配身份、独占写入和初始化提交边界，不启动业务实例。"""

import argparse
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

ADAPTER = Path(__file__).resolve().parent
sys.path.insert(0, str(ADAPTER))
import run_record

SPEC = importlib.util.spec_from_loader("evaluation_run_identity", SourceFileLoader("evaluation_run_identity", str(ADAPTER / "dsh-eval")))
evaluation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluation)
EXPERIMENT = "EXP-alpha-001-raaaaaaaaaaaa"
CASE = "U-BASIC-001"


class RunInitializationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="run-identity-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.experiment = self.root / "evolution/experiments" / EXPERIMENT
        self.write("workspace.json", json.dumps({"schemaVersion": 1, "id": "workspace-run-identity", "legacyRoots": []}))
        self.write(".gitignore", ".local/\n")
        self.write("agents/alpha/manifest.yaml", f"schema_version: '1.0'\nagent_id: alpha\nactive_experiment: {EXPERIMENT}\n")
        self.write("agents/alpha/evaluation.md", "# 评测\n\n#### U-BASIC-001 固定输入\n\n**用户输入**\n\n> 原始问题\n\n**预期**\n\n原始回答\n")
        self.write(f"evolution/experiments/{EXPERIMENT}/change.yaml", f"schema_version: '1.0'\nexperiment_id: {EXPERIMENT}\nagent_id: alpha\nstatus: active\nbaseline_ref: none:first-experiment\n")
        self.write(f"evolution/experiments/{EXPERIMENT}/hypothesis.md", "验证初始化身份与输入冻结。\n")
        candidate = f"evolution/experiments/{EXPERIMENT}/candidate"
        self.write(candidate + "/harness.yaml", "schema_version: '1.0'\nloadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha\n  profile_patch: dsh/managed/alpha.patch.yml\ncredential_environment_keys: []\nrole_instructions:\n  alpha: dsh/workspace/AGENTS.md\n")
        self.write(candidate + "/dsh/workspace/AGENTS.md", "初始化夹具角色。\n")
        self.write(candidate + "/dsh/workspace/.env", "# DSH Bootstrap environment is supplied only by the invoking container environment.\n")
        self.write(candidate + "/dsh/presets/alpha/agent.cordis.yml", "[]\n")
        self.write(candidate + "/dsh/managed/alpha.patch.yml", "[]\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "-qm", "固定初始化夹具")
        environment = {key: value for key, value in os.environ.items() if key not in ("HARNESS_EVAL_RUN_ID", "HARNESS_EVAL_REQUEST_SHA256", "HARNESS_EVAL_JOB_ID")}
        patcher = mock.patch.dict(os.environ, environment, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding="utf-8")

    def git(self, *args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.root), *args], check=True, capture_output=True)

    def args(self, run_id=None, experiment=EXPERIMENT):
        return argparse.Namespace(source=f"experiment:{experiment}", run_id=run_id,
                                  baseline_ref=None, case=[CASE], selection_mode="explicit", kind="research",
                                  model=None, executor="browser", review_mode="none", compare_to=None,
                                  source_ref=None, timeout_seconds=30)

    def initialize(self, run_id=None, experiment=EXPERIMENT):
        with redirect_stdout(io.StringIO()) as output:
            run_record.command_init(self.root, self.args(run_id, experiment))
        identity = output.getvalue().strip()
        return identity, self.root / "evolution/experiments" / experiment / "runs" / identity

    def additional_experiment(self):
        identity = "EXP-alpha-002-rbbbbbbbbbbbb"
        directory = self.root / "evolution/experiments" / identity
        shutil.copytree(self.experiment, directory, ignore=shutil.ignore_patterns("runs"))
        change = directory / "change.yaml"
        change.write_text(change.read_text().replace(EXPERIMENT, identity), encoding="utf-8")
        self.git("add", ".")
        self.git("-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "-qm", "增加并发初始化来源")
        return identity

    def failing_initialization_script(self):
        path = self.root / "committed-init-error.py"
        path.write_text(f"""import sys
sys.path.insert(0, {str(ADAPTER)!r})
import run_record
if 'init' in sys.argv[1:]:
    original=run_record.write_flat_yaml
    def fail(path,values):
        original(path,values)
        if path.name=='run.yaml': raise OSError('fixture-committed-init-return-error')
    run_record.write_flat_yaml=fail
run_record.main()
""", encoding="utf-8")
        return path

    def test_default_and_explicit_identity_are_frozen_without_initialization_marker(self):
        first, directory = self.initialize()
        self.assertRegex(first, r"^run-[0-9a-f-]{36}$")
        expected = "run-" + str(uuid.uuid4())
        actual, explicit = self.initialize(expected)
        self.assertEqual(actual, expected)
        for identity, run in ((first, directory), (expected, explicit)):
            self.assertEqual(json.loads((run / "inputs.lock.json").read_text())["run_id"], identity)
            self.assertEqual(run_record.read_run_manifest(run / "run.yaml")["run_id"], identity)
            self.assertFalse((run / ".initialization.json").exists())

    def test_occupied_directory_and_invalid_id_never_change_existing_data(self):
        identity, directory = self.initialize()
        before = {path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
        with self.assertRaises(FileExistsError):
            self.initialize(identity)
        self.assertEqual({path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}, before)
        empty_id = "run-" + str(uuid.uuid4())
        empty = self.experiment / "runs" / empty_id
        empty.mkdir()
        with self.assertRaises(FileExistsError):
            self.initialize(empty_id)
        self.assertTrue(empty.is_dir())
        for invalid in ("run-invalid", "../run-" + str(uuid.uuid4()), "run-" + str(uuid.uuid4()).upper()):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "run_id"):
                self.initialize(invalid)

    def test_environment_identity_must_match_explicit_id(self):
        identity = "run-" + str(uuid.uuid4())
        with mock.patch.dict(os.environ, {"HARNESS_EVAL_RUN_ID": identity}):
            self.assertEqual(self.initialize()[0], identity)
            with self.assertRaisesRegex(ValueError, "不一致"):
                self.initialize("run-" + str(uuid.uuid4()))

    def test_other_experiment_occupied_identity_including_partial_path_is_rejected(self):
        other = self.additional_experiment()
        identity, directory = self.initialize()
        original = {path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
        with self.assertRaises(FileExistsError):
            self.initialize(identity, other)
        self.assertFalse((self.root / "evolution/experiments" / other / "runs" / identity).exists())
        self.assertEqual({path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}, original)
        for occupied_kind in ("partial", "dangling-link"):
            allocated = "run-" + str(uuid.uuid4())
            occupied = self.experiment / "runs" / allocated
            if occupied_kind == "partial":
                occupied.mkdir()
            else:
                occupied.symlink_to("missing-run-directory", target_is_directory=True)
            with self.subTest(kind=occupied_kind), self.assertRaises(FileExistsError):
                self.initialize(allocated, other)
            self.assertTrue(os.path.lexists(occupied))

    def test_two_cli_processes_cannot_create_same_identity_in_different_experiments(self):
        other = self.additional_experiment()
        identity = "run-" + str(uuid.uuid4())
        script = """import run_record,sys
print('ready',flush=True)
sys.stdin.buffer.read(1)
sys.argv=['run_record.py','--repo',sys.argv[1],'init','--source',sys.argv[2],'--executor','browser','--review-mode','none','--case',sys.argv[3],'--run-id',sys.argv[4]]
run_record.main()
"""
        processes = [subprocess.Popen([sys.executable, "-c", script, str(self.root), f"experiment:{source}", CASE, identity],
                                      cwd=ADAPTER, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for source in (EXPERIMENT, other)]
        for process in processes:
            self.addCleanup(lambda process=process: process.kill() if process.poll() is None else None)
            self.assertEqual(process.stdout.readline(), b"ready\n")
        for process in processes:
            process.stdin.write(b"1")
            process.stdin.flush()
        results = [process.communicate(timeout=20) for process in processes]
        self.assertEqual(sorted(process.returncode for process in processes), [0, 1])
        winner = next(index for index, process in enumerate(processes) if process.returncode == 0)
        self.assertEqual(results[winner][0].decode().strip(), identity)
        self.assertIn("Run ID 已占用", results[1 - winner][1].decode())
        path, manifest = run_record.load_run_manifest(self.root, identity)
        self.assertEqual(manifest["run_id"], identity)
        self.assertEqual(len(list((self.root / "evolution/experiments").glob(f"*/runs/{identity}"))), 1)
        self.assertTrue((path / "inputs.lock.json").is_file())

    def test_initialization_failure_cleans_only_owned_directory(self):
        identity = "run-" + str(uuid.uuid4())
        directory = self.experiment / "runs" / identity
        def fail(_candidate):
            marker = json.loads((directory / ".initialization.json").read_text())
            self.assertEqual(marker["run_id"], identity)
            self.assertEqual(marker["workspace_id"], "workspace-run-identity")
            self.assertEqual(marker["asset_root"], str(self.root))
            self.assertEqual(marker["pid"], os.getpid())
            self.assertTrue(marker["process_start"])
            self.assertEqual(marker["request_sha256"], "a" * 64)
            raise OSError("fixture-lock-write-failed")
        with mock.patch.dict(os.environ, {"HARNESS_EVAL_REQUEST_SHA256": "a" * 64}), mock.patch.object(run_record, "candidate_digest", side_effect=fail):
            with self.assertRaisesRegex(OSError, "fixture-lock-write-failed"):
                self.initialize(identity)
        self.assertFalse(directory.exists())

    def test_committed_manifest_survives_marker_removal_failure(self):
        original = Path.unlink
        def unlink(path, *args, **kwargs):
            if path.name == ".initialization.json":
                raise PermissionError("fixture-marker-unlink")
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "unlink", unlink):
            identity, directory = self.initialize()
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["run_id"], identity)
        self.assertEqual(json.loads((directory / "inputs.lock.json").read_text())["run_id"], identity)
        self.assertTrue((directory / ".initialization.json").exists())

    def test_committed_manifest_survives_write_return_failure(self):
        identity = "run-" + str(uuid.uuid4())
        directory = self.experiment / "runs" / identity
        original = run_record.write_flat_yaml
        def fail_after_commit(path, values):
            original(path, values)
            if path.name == "run.yaml":
                raise OSError("fixture-manifest-committed-before-error")
        with mock.patch.object(run_record, "write_flat_yaml", side_effect=fail_after_commit):
            with self.assertRaisesRegex(OSError, "fixture-manifest-committed-before-error"):
                self.initialize(identity)
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["run_id"], identity)
        self.assertEqual(json.loads((directory / "inputs.lock.json").read_text())["run_id"], identity)

    def test_committed_subprocess_error_is_recovered_as_failed_run(self):
        identity = "run-" + str(uuid.uuid4())
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        script = self.failing_initialization_script()
        with mock.patch.dict(os.environ, {"HARNESS_EVAL_REQUEST_SHA256": "d" * 64}), \
                mock.patch.object(evaluation, "REPO", self.root), mock.patch.object(evaluation, "RUN_RECORD", script), \
                mock.patch.object(evaluation, "start_instance", side_effect=AssertionError("提交异常不能启动实例")), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as logs:
            result = evaluation.execute_owned_run(self.args(identity), contract, cases, "explicit", "none")
        directory = self.experiment / "runs" / identity
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["run_id"], identity)
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["status"], "failed")
        self.assertEqual(json.loads((directory / "inputs.lock.json").read_text())["run_id"], identity)
        self.assertIn("Run 已创建，执行准备失败", logs.getvalue())
        self.assertNotIn("Research Run:", logs.getvalue())

    def test_existing_committed_run_is_not_adopted_or_rewritten_after_conflict(self):
        identity, directory = self.initialize()
        marker = {"schema_version": "1.0", "run_id": identity, "asset_root": str(self.root),
                  "workspace_id": "workspace-run-identity", "parent_pid": os.getpid(), "request_sha256": None}
        (directory / ".initialization.json").write_text(json.dumps(marker), encoding="utf-8")
        before = {path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        with mock.patch.object(evaluation, "REPO", self.root), \
                mock.patch.object(evaluation, "finalize_run", side_effect=AssertionError("不能封存已有 Run")), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            result = evaluation.execute_owned_run(self.args(identity), contract, cases, "explicit", "none")
        self.assertEqual(result, 2)
        self.assertIsNone(json.loads(output.getvalue())["run_id"])
        self.assertEqual({path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}, before)

    def test_concurrent_other_parent_commit_is_not_adopted(self):
        identity = "run-" + str(uuid.uuid4())
        script = self.failing_initialization_script()
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        def create_in_other_parent(*_args, **_kwargs):
            command = [sys.executable, str(script), "--repo", str(self.root), "init", "--source", f"experiment:{EXPERIMENT}",
                       "--executor", "browser", "--review-mode", "none", "--case", CASE, "--run-id", identity]
            outer = subprocess.run([sys.executable, "-c", "import subprocess,sys;raise SystemExit(subprocess.run(sys.argv[1:],capture_output=True).returncode)", *command],
                                   capture_output=True, check=False)
            self.assertEqual(outer.returncode, 1)
            raise evaluation.EvaluationError("fixture-competing-initialization")
        with mock.patch.object(evaluation, "REPO", self.root), mock.patch.object(evaluation, "initialize_run", side_effect=create_in_other_parent), \
                mock.patch.object(evaluation, "finalize_run", side_effect=AssertionError("不能封存其他调用的 Run")), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            result = evaluation.execute_owned_run(self.args(identity), contract, cases, "explicit", "none")
        directory = self.experiment / "runs" / identity
        self.assertEqual(result, 2)
        self.assertIsNone(json.loads(output.getvalue())["run_id"])
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["status"], "planned")
        self.assertNotEqual(json.loads((directory / ".initialization.json").read_text())["parent_pid"], os.getpid())
        self.assertFalse((directory / "execution.json").exists())

    def test_sigkill_keeps_owned_initialization_marker_for_safe_recovery(self):
        identity = "run-" + str(uuid.uuid4())
        directory = self.experiment / "runs" / identity
        script = """import run_record,sys,time
from pathlib import Path
def pause(*args): time.sleep(60)
run_record.candidate_digest=pause
sys.argv=['run_record.py','--repo',sys.argv[1],'init','--source',sys.argv[2],'--executor','browser','--review-mode','none','--case',sys.argv[3],'--run-id',sys.argv[4]]
run_record.main()
"""
        process = subprocess.Popen([sys.executable, "-c", script, str(self.root), f"experiment:{EXPERIMENT}", CASE, identity], cwd=ADAPTER, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, "HARNESS_EVAL_REQUEST_SHA256": "b" * 64})
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (directory / ".initialization.json").exists():
            if process.poll() is not None:
                self.fail(process.communicate()[1].decode())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        process.kill()
        process.communicate(timeout=5)
        marker = json.loads((directory / ".initialization.json").read_text())
        self.assertEqual(marker["pid"], process.pid)
        self.assertEqual(marker["request_sha256"], "b" * 64)
        self.assertFalse((directory / "run.yaml").exists())

    def test_committed_run_is_preserved_and_failed_when_execution_handoff_cannot_write(self):
        identity = "run-" + str(uuid.uuid4())
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        original = evaluation.write_json
        attempts = 0
        def fail_first_execution(path, value):
            nonlocal attempts
            if path.name == "execution.json":
                attempts += 1
                if attempts == 1:
                    raise OSError("fixture-execution-write-failed")
            original(path, value)
        args = self.args(identity)
        with mock.patch.object(evaluation, "REPO", self.root), mock.patch.object(evaluation, "write_json", side_effect=fail_first_execution), \
                mock.patch.object(evaluation, "start_instance", side_effect=AssertionError("不能启动实例")), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as logs:
            result = evaluation.execute_owned_run(args, contract, cases, "explicit", "none")
        directory = self.experiment / "runs" / identity
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["run_id"], identity)
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["status"], "failed")
        self.assertTrue((directory / "inputs.lock.json").exists())
        self.assertNotIn("Research Run:", logs.getvalue())
        self.assertNotIn("job_id", json.loads((directory / "execution.json").read_text()))

    def test_corrupt_committed_inputs_keep_identity_and_failed_manifest(self):
        identity = "run-" + str(uuid.uuid4())
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        original = evaluation.initialize_run
        def corrupt_after_commit(*args, **kwargs):
            result = original(*args, **kwargs)
            (self.experiment / "runs" / result / "inputs.lock.json").write_text("{broken-lock")
            return result
        with mock.patch.object(evaluation, "REPO", self.root), mock.patch.object(evaluation, "initialize_run", side_effect=corrupt_after_commit), \
                mock.patch.object(evaluation, "start_instance", side_effect=AssertionError("不能启动实例")), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            result = evaluation.execute_owned_run(self.args(identity), contract, cases, "explicit", "none")
        directory = self.experiment / "runs" / identity
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["run_id"], identity)
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["status"], "failed")
        self.assertEqual((directory / "inputs.lock.json").read_text(), "{broken-lock")

    def test_creation_progress_follows_persisted_run_only_execution_identity(self):
        identity = "run-" + str(uuid.uuid4())
        contract = run_record.resolve(f"experiment:{EXPERIMENT}", repo=self.root)
        cases = run_record.execution_from(run_record.load_evaluation(self.root / "agents/alpha/evaluation.md"), [CASE])
        directory = self.experiment / "runs" / identity
        messages = []
        def progress(message):
            messages.append(message)
            if message.startswith("Research Run:"):
                execution = json.loads((directory / "execution.json").read_text())
                self.assertEqual(execution["run_id"], identity)
                self.assertEqual(execution["request_sha256"], "c" * 64)
                self.assertEqual(execution["workspace_id"], "workspace-run-identity")
                self.assertNotIn("job_id", execution)
                self.assertTrue((directory / "run.yaml").is_file())
                self.assertTrue((directory / "inputs.lock.json").is_file())
        with mock.patch.dict(os.environ, {"HARNESS_EVAL_RUN_ID": identity, "HARNESS_EVAL_REQUEST_SHA256": "c" * 64}), \
                mock.patch.object(evaluation, "REPO", self.root), mock.patch.object(evaluation, "progress", side_effect=progress), \
                mock.patch.object(evaluation, "start_instance", side_effect=evaluation.EvaluationError("fixture-instance-unavailable")), \
                mock.patch.object(evaluation, "stop_instance", return_value=True), mock.patch.object(evaluation, "validate_after_run"), \
                redirect_stdout(io.StringIO()) as output:
            result = evaluation.execute_owned_run(self.args(identity), contract, cases, "explicit", "none")
        self.assertEqual(result, 2)
        self.assertIn(f"Research Run: {identity}", messages)
        self.assertEqual(json.loads(output.getvalue())["run_id"], identity)
        self.assertEqual(run_record.read_run_manifest(directory / "run.yaml")["status"], "failed")


if __name__ == "__main__":
    unittest.main()

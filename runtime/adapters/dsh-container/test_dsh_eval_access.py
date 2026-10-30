"""评测入口同时接受当前免认证 URL 和历史 Token URL。"""

import importlib.util
import io
import hashlib
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import json
import types
import unittest
from unittest import mock
from contextlib import redirect_stderr

spec = importlib.util.spec_from_loader("dsh_eval", SourceFileLoader("dsh_eval", str(Path(__file__).with_name("dsh-eval"))))
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


CHILD = '''
import json,sys
from pathlib import Path
root=Path(__file__).parent
with (root/"calls.jsonl").open("a") as output:
    output.write(json.dumps({"script":Path(__file__).name,"args":sys.argv[1:],"python":sys.executable})+"\\n")
name=Path(__file__).name
if name.startswith("validate"):
    print(json.dumps({"valid":True,"errors":[]}))
elif name=="run_record.py":
    if sys.argv[3]=="init": print("run-11111111-1111-4111-8111-111111111111")
    elif sys.argv[3]=="record": json.loads(sys.stdin.read())
elif sys.argv[1]=="up":
    image="sha256:"+"1"*64
    print(json.dumps({"image_tag":"fixture","image_id":image,"image_ref":"fixture@"+image,"image_build_fingerprint":image,"platform":"fixture"}))
elif sys.argv[1]=="url": print("http://127.0.0.1:3081/?token=fixture-only")
'''


class EvaluationAccessTest(unittest.TestCase):
    def test_preflight_error_keeps_variant_identity_in_result(self):
        identity = "VAR-example-agent-001-r0123456789ab"
        for source in (identity, "experiment:" + identity):
            with self.subTest(source=source), mock.patch.object(sys, "argv", ["dsh-eval", "--source", source]), \
                    mock.patch.object(evaluation, "execute", side_effect=evaluation.EvaluationError("synthetic")), \
                    mock.patch.object(evaluation, "emit_result") as emit, redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as stopped:
                evaluation.main()
            self.assertEqual(stopped.exception.code, 2)
            self.assertEqual(emit.call_args.args[0], identity)

    def setUp(self):
        self.environment_patch = mock.patch.dict(os.environ, {})
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "config").mkdir()
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/hep/", "assistant": "/assistant/"}))
        self.repo_patch = mock.patch.object(evaluation, "REPO", self.root)
        self.repo_patch.start()

    def tearDown(self):
        self.repo_patch.stop()
        self.temporary.cleanup()

    def test_external_workspace_site_configuration_is_used(self):
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/platform/", "assistant": "/custom-agent/"}))
        url = "http://127.0.0.1:3081/custom-agent/"
        with mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url, "")):
            self.assertEqual(evaluation.authentication_url("probe"), url)

    def test_local_plain_and_legacy_token_urls_are_accepted(self):
        for url in ("http://127.0.0.1:3081/", "http://127.0.0.1:3081/?token=test-only",
                    "http://127.0.0.1:3081/assistant/", "http://127.0.0.1:3081/assistant/?token=test-only"):
            with self.subTest(url=url), mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url + "\n", "")):
                self.assertEqual(evaluation.authentication_url("probe"), url)

    def test_malformed_external_and_credential_urls_are_rejected(self):
        for url in ("http://127.0.0.1.evil:3081/", "http://example.org:3081/", "https://127.0.0.1:3081/", "http://127.0.0.1/", "http://user:pass@127.0.0.1:3081/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/", "http://127.0.0.1:3081/api/", "http://127.0.0.1:3081/assistant",
                    "http://127.0.0.1:3081/assistant/api/", "http://127.0.0.1:3081/#fragment"):
            with self.subTest(url=url), mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url, "")):
                with self.assertRaises(evaluation.EvaluationError):
                    evaluation.authentication_url("probe")


class ReviewTargetRouteTest(unittest.TestCase):
    def test_native_provider_routes_are_preserved_and_mixed_or_invalid_routes_fail(self):
        import scenario_analysis
        cases = [{"case_id": "U-FIRST"}, {"case_id": "U-SECOND"}]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def write(route, case):
                target = root / "evidence" / case["case_id"] / "response.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps({"response": {"turns": [{"route": route}]}}))
            for provider, model in (("deepseek-official", "deepseek-flash"),
                                    ("xiaomi-token-plan-cn", "mimo-v2.6-flash"),
                                    ("local-qwen", "Qwen3.5-2B")):
                route = {"provider": provider, "model": model, "reasoningEffort": "off"}
                for case in cases:
                    write(route, case)
                self.assertEqual(scenario_analysis._target_route(root, cases), route)
            write({"provider": "xiaomi-token-plan-cn", "model": "mimo-v2.6-pro"}, cases[1])
            with self.assertRaisesRegex(ValueError, "target-route-mixed"):
                scenario_analysis._target_route(root, cases)
            write({"provider": "", "model": "mimo-v2.6-flash"}, cases[0])
            with self.assertRaisesRegex(ValueError, "target-route-invalid"):
                scenario_analysis._target_route(root, cases)


class EvaluationModelPolicyTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch(mock.patch.object(evaluation, "REPO", self.root))
        agent = self.root / "agents/example-agent"
        agent.mkdir(parents=True)
        manifest = agent / "manifest.yaml"
        manifest.write_text("agent_id: example-agent\n", encoding="utf-8")
        selected = {"provider": "xiaomi-token-plan-cn", "model": "MiMo-V2.6-Flash", "reasoningEffort": "off"}
        config = self.root / "config"
        config.mkdir()
        default = config / "business-model-default.json"
        default.write_text(json.dumps({"schema_version": "1.2", "default": selected}), encoding="utf-8")
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({
            "agent_id": "example-agent",
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "business_model_revision": hashlib.sha256(default.read_bytes()).hexdigest(),
            "allowed": [{"provider": selected["provider"], "model": selected["model"]}],
            "default": selected,
            "credential_refs": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
            "patch": [
                {"id": "agent-default-model", "config": selected},
                {"id": "llm-deepseek", "disabled": True},
                {"id": "llm-deepseek-account", "disabled": True},
                {"id": "llm-pi-ai", "config": {"providers": {"xiaomi-token-plan-cn": {
                    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY", "models": [{"id": "MiMo-V2.6-Flash"}],
                }}}},
            ],
        }), encoding="utf-8")
        self.contract = {
            "source_id": "experiment:EXP-example-agent-001", "experiment_id": "EXP-example-agent-001",
            "agent_id": "example-agent", "required_env_names": ["DEEPSEEK_API_KEY", "LOCAL_LLM_BASE_URL", "OPS_MCP_URL"],
            "image": {"local_image_tag": "fixture", "build_fingerprint": "sha256:" + "1" * 64},
        }
        self.cases = [{"case_id": "U-INS-001"}]

    def patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def test_dry_run_uses_same_policy_as_real_instance_and_keeps_business_environment(self):
        path = str(self.policy)
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key"}, clear=True):
            plan = evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                              path, "MiMo-V2.6-Flash")
        self.assertEqual(plan["required_env_names"], ["OPS_MCP_URL", "XIAOMI_TOKEN_PLAN_CN_API_KEY"])
        self.assertEqual(plan["missing_env_names"], ["OPS_MCP_URL"])
        self.assertNotIn("DEEPSEEK_API_KEY", plan["required_env_names"])
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "--model-policy"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none")
        image = "sha256:" + "1" * 64
        reply = subprocess.CompletedProcess([], 0, json.dumps({
            "image_tag": "fixture", "image_id": image, "image_ref": "fixture@" + image,
            "image_build_fingerprint": image, "platform": "fixture",
        }), "")
        with mock.patch.object(evaluation, "checked_process", return_value=reply) as process:
            evaluation.start_instance(self.contract["source_id"], "eval-fixture", path)
        command = process.call_args.args[0]
        self.assertEqual(command[-2:], ["--model-policy", path])
        self.assertNotIn("fixture-key", str(process.call_args))

    def test_direct_dry_run_keeps_source_default_and_legacy_environment(self):
        selected = {"provider": "local-qwen", "model": "Qwen3.8-27B"}
        (self.root / "config/business-model-default.json").write_text(json.dumps({
            "schema_version": "1.2", "default": selected,
        }), encoding="utf-8")
        managed = self.root / "candidate/managed"
        managed.mkdir(parents=True)
        (managed / "example-agent.patch.yml").write_text(
            "- id: agent-default-model\n  config:\n    provider: local-qwen\n    model: Qwen3.8-27B\n"
            "- id: llm-pi-ai\n  config:\n    providers:\n      local-qwen:\n"
            "        models:\n          - id: Qwen3.8-27B\n",
            encoding="utf-8",
        )
        contract = {**self.contract, "managed": str(managed),
                    "patch": "/opt/dsh-managed/example-agent.patch.yml"}
        direct = evaluation.dry_run_payload(contract, self.cases, "api", "fast", "explicit", "none")
        self.assertEqual(direct["required_env_names"], self.contract["required_env_names"])
        self.assertIn("DEEPSEEK_API_KEY", direct["missing_env_names"])

    def test_source_only_draft_preview_does_not_load_runtime_model_policy(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model=None, model_policy=None,
                                     compare_to=None, dry_run=True, source_check=True)
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        with mock.patch.object(evaluation, "DSH_DEV", self.root / "missing-dsh-dev"), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(evaluation.execute(args), 0)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["required_env_names"], self.contract["required_env_names"])
        self.assertEqual(plan["case_ids"], ["U-INS-001"])
        self.assertEqual(plan["preflight_scope"], "source-and-cases")

    def test_source_check_cannot_replace_runtime_model_preflight(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model=None, model_policy=None,
                                     compare_to=None, dry_run=False, source_check=True)
        with self.assertRaisesRegex(evaluation.EvaluationError, "--source-check"):
            evaluation.execute(args)
        args.dry_run = True
        args.model = "MiMo-V2.6-Flash"
        with self.assertRaisesRegex(evaluation.EvaluationError, "--source-check"):
            evaluation.execute(args)
        args.model = None
        args.source_check = False
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "--model-policy"):
            evaluation.execute(args)

    def test_missing_business_environment_blocks_before_validation_or_run_creation(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model="MiMo-V2.6-Flash",
                                     model_policy=str(self.policy), compare_to=None, dry_run=False)
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        validation = self.patch(mock.patch.object(evaluation, "validate_before_run", return_value={"repository": {"valid": True}}))
        run = self.patch(mock.patch.object(evaluation, "execute_owned_run", return_value=0))
        self.patch(mock.patch.object(evaluation, "emit_result"))
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key"}, clear=True), \
                redirect_stderr(io.StringIO()):
            self.assertEqual(evaluation.execute(args), 2)
        validation.assert_not_called()
        run.assert_not_called()
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key", "OPS_MCP_URL": "http://tools"}, clear=True):
            self.assertEqual(evaluation.execute(args), 0)
        validation.assert_called_once()
        run.assert_called_once()

    def test_expected_model_and_policy_identity_must_match_before_run(self):
        with self.assertRaisesRegex(evaluation.EvaluationError, "--model 与实例默认模型不一致"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                       str(self.policy), "other-model")
        with self.assertRaisesRegex(evaluation.EvaluationError, "--model 与实例默认模型不一致"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                       expected_model="other-model")
        wrong_agent = dict(self.contract, agent_id="another-agent")
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "模型策略不可用"):
            evaluation.dry_run_payload(wrong_agent, self.cases, "api", "fast", "explicit", "none",
                                       str(self.policy))


class EvaluationInterpreterTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dsh eval interpreter ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "config").mkdir()
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/hep/", "assistant": "/assistant/"}))
        binary = self.root / "bin"
        binary.mkdir()
        fallback = binary / "python3"
        fallback.write_text("#!/bin/sh\necho unavailable-python3 >&2\nexit 77\n")
        fallback.chmod(0o755)
        environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                           HARNESS_PYTHON=sys.executable)
        environment.pop("DSH_EVAL_DSH_DEV", None)
        self.patch(mock.patch.dict(os.environ, environment, clear=True))
        self.patch(mock.patch.object(evaluation, "REPO", self.root))

    def patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def children(self):
        for key, name in (("VALIDATE_REPOSITORY", "validate_repository.py"),
                          ("VALIDATE_EXPERIMENT", "validate_experiment.py"),
                          ("RUN_RECORD", "run_record.py"), ("DSH_DEV", "dsh-dev")):
            script = self.root / name
            script.write_text(CHILD)
            self.patch(mock.patch.object(evaluation, key, script))

    def calls(self):
        return [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]

    def test_validation_runs_real_scripts_with_parent_python_despite_unusable_path_python(self):
        checks = evaluation.validate_before_run({"experiment_root": str(self.root)})
        for check in checks.values():
            self.assertFalse(check["valid"])
            self.assertIn("error_codes", check, check)
            self.assertNotEqual(check["exit_code"], 77)

    def test_run_lifecycle_and_default_instance_children_keep_parent_python(self):
        self.children()
        contract = {"experiment_root": str(self.root)}
        self.assertTrue(all(check["valid"] for check in evaluation.validate_before_run(contract).values()))
        evaluation.validate_after_run(contract)
        run_id = evaluation.initialize_run("fixture", [{"case_id": "U-BASIC-001"}], "api", "explicit", "none")
        evaluation.record_trial(run_id, "U-BASIC-001", {
            "execution_status": "completed", "verdict": "passed", "observation": "模拟状态正常",
            "evidence_ref": "evidence/U-BASIC-001/checks.json",
        })
        evaluation.finalize_run(run_id, "completed")
        evaluation.start_instance("fixture", "fixture")
        evaluation.authentication_url("fixture")
        self.assertTrue(evaluation.stop_instance("fixture"))
        calls = self.calls()
        self.assertEqual([row["script"] for row in calls], [
            "validate_repository.py", "validate_experiment.py", "validate_experiment.py",
            "run_record.py", "run_record.py", "run_record.py", "dsh-dev", "dsh-dev", "dsh-dev",
        ])
        self.assertEqual(calls[0]["args"], [str(self.root), "--experiment", self.root.name])
        self.assertEqual({row["python"] for row in calls}, {sys.executable})
        self.assertEqual([row["args"][0] for row in calls[-3:]], ["up", "url", "down"])

    def test_review_and_custom_non_python_instance_entry_preserve_execution_semantics(self):
        self.children()
        import scenario_analysis
        self.patch(mock.patch.object(scenario_analysis, "ADAPTER", self.root))
        self.patch(mock.patch.object(scenario_analysis, "_locked_harness", return_value=[]))
        self.patch(mock.patch.object(scenario_analysis, "_target_route", return_value={}))
        self.patch(mock.patch.object(scenario_analysis, "_review_driver", side_effect=RuntimeError("fixture-driver-stop")))
        override = self.root / "custom-entry"
        override.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(self.root / 'dsh-dev'))} \"$@\"\n")
        override.chmod(0o755)
        for custom in (False, True):
            if custom:
                os.environ["DSH_EVAL_DSH_DEV"] = str(override)
                evaluation.start_instance("fixture", "fixture")
                evaluation.authentication_url("fixture")
                self.assertTrue(evaluation.stop_instance("fixture"))
            run = self.root / "evolution/experiments/EXP-fixture-001/runs" / str(custom)
            scenario_analysis.review_full(run, [], {"run_id": "run-fixture", "source_id": "fixture", "evaluation_cases": [], "case_catalog": []},
                                          model_policy_path=str(self.root / "model-policy.json") if custom else None)
        calls = self.calls()
        self.assertEqual([row["args"][0] for row in calls], ["up", "url", "down"] * 3)
        self.assertEqual({row["python"] for row in calls}, {sys.executable})
        self.assertEqual(calls[6]["args"][-2:], ["--model-policy", str(self.root / "model-policy.json")])

    def test_validator_failure_keeps_exit_status_and_safe_diagnostic_in_progress(self):
        self.children()
        os.environ["FIXTURE_API_KEY"] = "fixture-private-value"
        failure = "import sys\nprint('RuntimeError: fixture-private-value token=fixture-secret', file=sys.stderr)\nsys.exit(17)\n"
        evaluation.VALIDATE_REPOSITORY.write_text(failure)
        evaluation.VALIDATE_EXPERIMENT.write_text(failure)
        contract = {"experiment_root": str(self.root), "experiment_id": "EXP-fixture-001", "agent_id": "fixture"}
        check = evaluation.validate_before_run(contract)["repository"]
        self.assertEqual(check["exit_code"], 17)
        self.assertEqual(check["error"], "RuntimeError: <redacted> token=<redacted>")
        with self.assertRaisesRegex(evaluation.EvaluationError, "退出码 17.*RuntimeError"):
            evaluation.validate_after_run(contract)
        for name, result in (("resolve", contract), ("load_evaluation", {}), ("select_case_ids", []),
                             ("execution_for", []), ("dry_run_payload", {"missing_env_names": []})):
            self.patch(mock.patch.object(evaluation, name, return_value=result))
        self.patch(mock.patch.object(evaluation, "emit_result"))
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = evaluation.execute(types.SimpleNamespace(source="fixture", case=[], mode="fast", executor="api",
                                       review="none", compare_to=None, dry_run=False))
        self.assertEqual(result, 2)
        self.assertIn("repository（退出码 17）：RuntimeError", stderr.getvalue())
        self.assertNotIn("fixture-private-value", stderr.getvalue())
        self.assertNotIn("fixture-secret", stderr.getvalue())
        self.assertNotIn("JSONDecodeError", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

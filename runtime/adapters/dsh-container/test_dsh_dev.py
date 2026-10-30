"""dsh-dev 启动器的纯函数与状态文件契约测试；不启动容器。"""

import contextlib
import hashlib
from functools import partial
import http.server
import importlib.util
import io
import json
from importlib.machinery import SourceFileLoader
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock


ADAPTER = Path(__file__).resolve().parent
sys.path.insert(0, str(ADAPTER.parents[2] / "tests"))
from asset_fixture import historical_assets
SPEC = importlib.util.spec_from_loader(
    "dsh_dev", SourceFileLoader("dsh_dev", str(ADAPTER / "dsh-dev"))
)
assert SPEC is not None and SPEC.loader is not None
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)
dev.REPO = historical_assets()
dev.SOURCES = dev.REPO / "config/sources.json"
dev.resolve = partial(dev.resolve, repo=dev.REPO)

TOKEN = "dsh web: http://127.0.0.1:3081/?token=secret-token-value\n"
IMAGE_TAG = dev.resolve()["image"]["local_image_tag"]


def isolate_registration_guard(test):
    """非归属用例隔离新增前置检查；专项测试保留真实检查并仅模拟 Docker 查询。"""
    patch = mock.patch.object(dev, "require_docker_registration")
    patch.start()
    test.addCleanup(patch.stop)


class McpPromoteTest(unittest.TestCase):
    def setUp(self):
        isolate_registration_guard(self)

    def test_promote_writes_only_candidate_seed_from_matching_running_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            managed = Path(directory)
            seed = managed / "web-profile.seed.patch.yml"
            seed.write_text("old", encoding="utf-8")
            source = "experiment:EXP-security-operations-expert-013"
            manifest = {"source_id": source, "mounts": {"managed": str(managed)}}
            result = subprocess.CompletedProcess([], 0, stdout="new", stderr="")
            with mock.patch.object(dev, "load_instance", return_value=(managed, manifest)), \
                 mock.patch.object(dev, "resolve", return_value={"managed": str(managed)}), \
                 mock.patch.object(dev, "running_container", return_value=("container", "started")), \
                 mock.patch.object(dev.subprocess, "run", return_value=result):
                with contextlib.redirect_stdout(io.StringIO()):
                    dev.command_mcp_promote(types.SimpleNamespace(name="example"))
            self.assertEqual(seed.read_text(encoding="utf-8"), "new")

    def test_promote_rejects_mismatched_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            managed = Path(directory)
            seed = managed / "web-profile.seed.patch.yml"
            seed.write_text("old", encoding="utf-8")
            manifest = {"source_id": "experiment:EXP-security-operations-expert-013",
                        "mounts": {"managed": "/another/candidate"}}
            with mock.patch.object(dev, "load_instance", return_value=(managed, manifest)), \
                 mock.patch.object(dev, "resolve", return_value={"managed": str(managed)}), \
                 self.assertRaises(SystemExit):
                dev.command_mcp_promote(types.SimpleNamespace(name="example"))
            self.assertEqual(seed.read_text(encoding="utf-8"), "old")


class HarnessInitTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        (self.repo / "agents").mkdir()
        (self.repo / "evolution/experiments").mkdir(parents=True)
        adapter = self.repo / "runtime/adapters/dsh-container"
        adapter.mkdir(parents=True)
        self.sources = adapter / "sources.json"
        self.sources.write_text('{"schema_version":"1.1","sources":{}}\n', encoding="utf-8")
        self.lock = adapter / "source.lock.json"
        self.lock.write_bytes((ADAPTER / "source.lock.json").read_bytes())

    def tearDown(self):
        self.temporary.cleanup()

    def create(self, agent_id="test01"):
        with mock.patch.object(dev.secrets, "token_hex", return_value="0123456789ab"):
            return dev.create_harness(
                agent_id, repo=self.repo, sources=self.sources, lock_path=self.lock
            )

    def test_creates_minimal_resolvable_first_experiment(self):
        result = self.create()
        self.assertEqual(result, {
            "agent_id": "test01",
            "experiment_id": "EXP-test01-001-r0123456789ab",
            "source_id": "experiment:EXP-test01-001-r0123456789ab",
        })
        contract = dev.resolve(
            result["source_id"], repo=self.repo, sources=self.sources, lock_path=self.lock
        )
        self.assertEqual(contract["agent_id"], "test01")
        self.assertEqual(contract["preset_id"], "test01")
        expected = {
            "agents/test01/manifest.yaml",
            "agents/test01/evaluation.md",
            "evolution/experiments/EXP-test01-001-r0123456789ab/change.yaml",
            "evolution/experiments/EXP-test01-001-r0123456789ab/hypothesis.md",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/harness.yaml",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/workspace/.env",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/workspace/AGENTS.md",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/managed/test01.patch.yml",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/presets/test01/agent.cordis.yml",
            "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/presets/test01/preset.yml",
        }
        actual = {
            path.relative_to(self.repo).as_posix()
            for root in (self.repo / "agents/test01", self.repo / "evolution/experiments/EXP-test01-001-r0123456789ab")
            for path in root.rglob("*") if path.is_file()
        }
        self.assertEqual(actual, expected)
        self.assertEqual(
            (self.repo / "evolution/experiments/EXP-test01-001-r0123456789ab/candidate/dsh/workspace/.env").read_bytes(),
            (ADAPTER / "verification-home-controls/locked-bootstrap.env").read_bytes(),
        )
        evaluation = (self.repo / "agents/test01/evaluation.md").read_text(encoding="utf-8")
        self.assertIn("#### U-IDENTITY-001 身份装载", evaluation)
        self.assertIn("**用户输入**", evaluation)
        self.assertIn("> 你是谁？请用一句中文回答。", evaluation)
        self.assertIn("**预期**", evaluation)
        self.assertNotIn("**执行器", evaluation)
        generated = "\n".join(
            path.read_text(encoding="utf-8") for path in self.repo.rglob("*")
            if path.is_file() and path != self.lock
        )
        self.assertNotRegex(generated, r"sk-[A-Za-z0-9]{16,}")
        self.assertIn("DEEPSEEK_API_KEY", generated)

    def test_invalid_id_and_collisions_do_not_overwrite(self):
        original = self.sources.read_bytes()
        with self.assertRaisesRegex(ValueError, "kebab-case"):
            self.create("Test01")
        self.assertEqual(self.sources.read_bytes(), original)
        self.assertFalse((self.repo / "agents/Test01").exists())

        agent = self.repo / "agents/test01"
        agent.mkdir()
        marker = agent / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            self.create()
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        self.assertEqual(self.sources.read_bytes(), original)
        self.assertFalse((self.repo / "evolution/experiments/EXP-test01-001-r0123456789ab").exists())

    def test_resolution_failure_rolls_back_files_and_catalog(self):
        original = self.sources.read_bytes()
        with mock.patch.object(dev, "resolve", side_effect=ValueError("invalid source")):
            with self.assertRaisesRegex(ValueError, "invalid source"):
                self.create()
        self.assertEqual(self.sources.read_bytes(), original)
        self.assertFalse((self.repo / "agents/test01").exists())
        self.assertFalse((self.repo / "evolution/experiments/EXP-test01-001-r0123456789ab").exists())

    def test_random_suffix_retries_occupied_id(self):
        (self.repo / "evolution/experiments/EXP-test01-001-r0123456789ab").mkdir()
        with mock.patch.object(dev.secrets, "token_hex", side_effect=["0123456789ab", "abcdef123456"]):
            result = dev.create_harness("test01", repo=self.repo, sources=self.sources, lock_path=self.lock)
        self.assertEqual(result["experiment_id"], "EXP-test01-001-rabcdef123456")


class RenderComposeTest(unittest.TestCase):
    def test_runtime_model_policy_follows_candidate_and_optional_patches(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        for analysis_workspace in (False, True):
            with self.subTest(analysis_workspace=analysis_workspace):
                rendered = dev.render_compose(
                    template, mode="verification", name="probe", project="dsh-dev-probe", port=3081,
                    analysis_workspace=analysis_workspace, lan_access=not analysis_workspace,
                    unsafe_no_auth=not analysis_workspace, skip_testing_notice=True,
                )
                policy = "      - /opt/dsh-adapter/runtime-model.patch.yml\n"
                self.assertEqual(rendered.count(policy), 1)
                self.assertIn(policy + "      - --patch\n      - /opt/harness-model-runtime/model.patch.yml\n"
                              "      - --no-open\n", rendered)
                self.assertIn("target: /opt/harness-model-runtime/model-runtime.mjs\n        read_only: true", rendered)
                self.assertIn("target: /opt/harness-model-runtime/model.patch.yml\n        read_only: true", rendered)
                self.assertLess(rendered.index(dev.SKIP_TESTING_NOTICE_PATCH), rendered.index(policy))
                if not analysis_workspace:
                    self.assertLess(rendered.index("${DSH_MANAGED_PATCH"), rendered.index(policy))
                    self.assertLess(rendered.index(dev.LAN_LISTEN_PATCH), rendered.index(policy))

    def test_verification_template_gets_host_network_and_port(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="probe", project="dsh-dev-probe", port=3081)
        self.assertIn("name: dsh-dev-probe", rendered)
        self.assertIn("  dsh:\n    container_name: probe\n", rendered)
        self.assertIn("    network_mode: host\n", rendered)
        self.assertIn("      - --host\n      - 127.0.0.1\n      - --port\n      - \"3081\"\n", rendered)
        self.assertIn("dsh-dev-probe-home", rendered)
        self.assertIn("dsh-dev-probe-fallback", rendered)
        self.assertNotIn("dsh-verification-home", rendered)
        self.assertNotIn("0.0.0.0", rendered)
        self.assertNotIn("source: ./", rendered)
        self.assertIn(f"source: {ADAPTER}/verification-home-controls", rendered)
        self.assertIn("/opt/dsh-adapter/verification-home-controls/web-base-path.patch.yml", rendered)
        self.assertIn("source: ${DSH_WEB_ADAPTER_HOST:?", rendered)
        self.assertIn("target: /opt/dsh-web\n        read_only: true", rendered)

    def test_host_network_instances_map_the_standard_host_alias(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        for analysis_workspace in (False, True):
            with self.subTest(analysis_workspace=analysis_workspace):
                rendered = dev.render_compose(
                    template, mode="verification", name="probe", project="dsh-dev-probe", port=3081,
                    analysis_workspace=analysis_workspace,
                )
                self.assertIn("    network_mode: host\n    extra_hosts:\n"
                              "      - host.docker.internal:host-gateway\n", rendered)
                self.assertEqual(rendered.count("host.docker.internal:host-gateway"), 1)

    def test_lan_template_enables_authenticated_remote_settings(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="lan", project="dsh-dev-lan", port=3154,
            lan_access=True,
        )
        self.assertIn("      - --profile\n      - web\n", rendered)
        self.assertNotIn("      - --host\n", rendered)
        self.assertIn(
            "      - --patch\n"
            "      - /opt/dsh-adapter/verification-home-controls/lan-listen.patch.yml\n",
            rendered,
        )
        self.assertNotIn("web-lan.patch.yml", rendered)
        self.assertNotIn("web-unsafe-no-auth.patch.yml", rendered)
        listener_patch = (ADAPTER / "verification-home-controls/lan-listen.patch.yml").read_text()
        self.assertIn("- id: webserver\n", listener_patch)
        self.assertIn("host: 0.0.0.0\n", listener_patch)
        self.assertNotIn("web-remote-settings", listener_patch)
        self.assertNotIn("auth-gate", listener_patch)
        self.assertIn('      - --port\n      - "3154"\n', rendered)

    def test_runtime_upgrade_uses_new_derived_fallback_volume_without_changing_home(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="probe", project="dsh-dev-probe", port=3081,
            image_fingerprint="sha256:" + "a" * 64,
        )
        self.assertIn("dsh-dev-probe-fallback-aaaaaaaaaaaa", rendered)
        self.assertIn("dsh-dev-probe-home", rendered)

    def test_no_auth_and_notice_patches_are_independent_of_lan_access(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        for lan_access in (False, True):
            for unsafe_no_auth in (False, True):
                for skip_testing_notice in (False, True):
                    rendered = dev.render_compose(
                        template, mode="verification", name="probe", project="dsh-dev-probe",
                        port=3081, lan_access=lan_access, unsafe_no_auth=unsafe_no_auth,
                        skip_testing_notice=skip_testing_notice,
                    )
                    self.assertEqual(dev.UNSAFE_NO_AUTH_PATCH in rendered, unsafe_no_auth)
                    self.assertEqual(dev.SKIP_TESTING_NOTICE_PATCH in rendered, skip_testing_notice)
                    self.assertEqual("lan-listen.patch.yml" in rendered, lan_access)

    def test_trusted_proxy_host_is_explicit_and_validated(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="portal", project="dsh-dev-portal",
            port=13181, trusted_host="172.16.138.232:18120",
        )
        self.assertIn(
            '      - --host\n      - 127.0.0.1\n      - --port\n      - "13181"\n'
            '      - --trusted-host\n      - "172.16.138.232:18120"\n', rendered,
        )
        self.assertNotIn("--trusted-host", dev.render_compose(
            template, mode="verification", name="portal", project="dsh-dev-portal", port=13181,
        ))
        for invalid in ("", "https://172.16.138.232:18120", "*.example.com", "host:65536"):
            with self.assertRaises(SystemExit):
                dev.render_compose(
                    template, mode="verification", name="portal", project="dsh-dev-portal",
                    port=13181, trusted_host=invalid,
                )

    def test_source_runtime_environment_names_are_rendered_once(self):
        business_names = (
            "DEEPSEEK_API_KEY", "SEC_OPS_MCP_URL", "SEC_OPS_MCP_TOKEN",
            "INSPECTION_MCP_URL", "INSPECTION_MCP_TOKEN",
            "THREAT_ANALYSIS_MCP_URL", "THREAT_ANALYSIS_MCP_TOKEN",
        )
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        for business_name in business_names:
            self.assertNotIn(business_name, template)
        rendered = dev.render_compose(
            template,
            mode="verification",
            name="models",
            project="dsh-dev-models",
            port=3082,
            runtime_env_names=["DEEPSEEK_API_KEY", "LOCAL_LLM_BASE_URL", "LOCAL_LLM_BASE_URL"],
        )
        self.assertEqual(rendered.count("      - DEEPSEEK_API_KEY\n"), 1)
        self.assertEqual(rendered.count("      - LOCAL_LLM_BASE_URL\n"), 1)

    def test_plugin_dependencies_are_an_optional_read_only_mount(self):
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="voice", project="dsh-dev-voice", port=3081,
            plugin_node_modules=True,
        )
        self.assertIn("source: ${DSH_PLUGIN_NODE_MODULES_HOST:?", rendered)
        self.assertIn("target: /opt/node_modules\n        read_only: true", rendered)
        self.assertNotIn("DSH_PLUGIN_NODE_MODULES_HOST", dev.render_compose(
            template, mode="verification", name="plain", project="dsh-dev-plain", port=3081,
        ))
        with self.assertRaises(SystemExit):
            dev.render_compose(
                template, mode="verification", name="analysis", project="dsh-dev-analysis",
                port=3081, analysis_workspace=True, plugin_node_modules=True,
            )

    def test_missing_anchor_fails_closed(self):
        with self.assertRaises(SystemExit):
            dev.render_compose("services:\n  dsh:\n    working_dir: /tmp\n", mode="verification",
                               name="probe", project="dsh-dev-probe", port=3081)


class ModelPolicyTest(unittest.TestCase):
    def test_model_policy_start_lock_serializes_instance_startup_with_authorization_save(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            lock = repo / "config/.business-model-policy.lock"
            with dev.model_policy_start_lock(repo):
                self.assertTrue(lock.is_file())
                with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                    with dev.model_policy_start_lock(repo, timeout=0.01):
                        self.fail("第二次启动不应越过模型策略锁")
                self.assertIn("业务模型设置", error.getvalue())
            self.assertFalse(lock.exists())

            args = types.SimpleNamespace(source="experiment:EXP-example-agent-001", dry_run=False,
                                         analysis_workspace=None)
            observed = []
            with mock.patch.object(dev, "REPO", repo), \
                    mock.patch.object(dev, "resolve", return_value={"agent_id": "example-agent"}), \
                    mock.patch.object(dev, "instance_startup_lock", return_value=contextlib.nullcontext()), \
                    mock.patch.object(dev, "prepare_up", return_value=({"agent_id": "example-agent"}, None)), \
                    mock.patch.object(dev, "existing_runtime_environment", return_value={}), \
                    mock.patch.object(dev, "_command_up", side_effect=lambda *_: observed.append(lock.is_file())):
                dev.command_up(args)
            self.assertEqual(observed, [True])
            self.assertFalse(lock.exists())

    def policy(self, **changes):
        value = {
            "agent_id": "example-agent",
            "allowed": [{"provider": "deepseek-official", "model": "deepseek-flash"}],
            "default": {"provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off"},
            "patch": [
                {"id": "agent-default-model", "config": {"provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off"}},
                {"id": "llm-deepseek", "config": {"apiKeyEnv": "DEEPSEEK_API_KEY", "models": [{"id": "deepseek-flash"}]}},
                {"id": "llm-pi-ai", "config": {"providers": {}}},
                {"id": "llm-deepseek-account", "disabled": True},
            ],
            "credential_refs": ["DEEPSEEK_API_KEY"],
            "business_model_revision": "a" * 64,
        }
        value.update(changes)
        return value

    def test_platform_projection_replaces_source_model_env_but_keeps_tool_env(self):
        selected = {"provider": "xiaomi-token-plan-cn", "model": "mimo-v2.5"}
        policy = dev._model_policy({
            "agent_id": "example-agent", "allowed": [selected], "default": selected,
            "patch": [
                {"id": "agent-default-model", "config": selected},
                {"id": "llm-deepseek", "disabled": True},
                {"id": "llm-deepseek-account", "disabled": True},
                {"id": "llm-pi-ai", "config": {"providers": {"xiaomi-token-plan-cn": {
                    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY", "models": [{"id": "mimo-v2.5"}]
                }}}},
            ],
            "credential_refs": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
            "manifest_sha256": "0" * 64,
            "business_model_revision": "a" * 64,
        }, "example-agent", source="platform", manifest_sha256="0" * 64)
        contract = EvaluationModeContractTest().contract(
            model_policy=policy,
            required_env_names=["DEEPSEEK_API_KEY", "SEC_OPS_MCP_URL", "LOCAL_LLM_BASE_URL",
                                "SEC_OPS_MCP_TOKEN"],
            optional_env_names=["LOCAL_LLM_API_KEY", "INSPECTION_MCP_TOKEN"],
        )
        expected = ["SEC_OPS_MCP_URL", "SEC_OPS_MCP_TOKEN", "XIAOMI_TOKEN_PLAN_CN_API_KEY"]
        self.assertEqual(dev.required_env_names(contract), expected)
        environment = {"SEC_OPS_MCP_URL": "http://tools", "SEC_OPS_MCP_TOKEN": "tool-fixture",
                       "XIAOMI_TOKEN_PLAN_CN_API_KEY": "model-fixture", "INSPECTION_MCP_TOKEN": "other-tool-fixture",
                       "LOCAL_LLM_API_KEY": "old-model-fixture"}
        with mock.patch.dict(os.environ, environment, clear=True):
            dev.check_environment(contract)
            self.assertEqual(dev.runtime_env_names(contract), expected + ["INSPECTION_MCP_TOKEN"])
            with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)), \
                    mock.patch.object(dev, "assert_model_policy_current"):
                target = dev.write_instance("mimo-probe", mode="verification", contract=contract, port=3082)
                state = json.loads((target / "instance.json").read_text(encoding="utf-8"))
                compose = (target / "compose.yaml").read_text(encoding="utf-8")
            self.assertEqual(state["required_env_names"], expected)
            self.assertIn("      - XIAOMI_TOKEN_PLAN_CN_API_KEY\n", compose)
            self.assertIn("      - SEC_OPS_MCP_TOKEN\n", compose)
            for name in dev.SOURCE_MODEL_ENV_NAMES:
                self.assertNotIn(f"      - {name}\n", compose)
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "model-fixture"}, clear=True), \
                contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.check_environment(contract)
        self.assertIn("SEC_OPS_MCP_URL", error.getvalue())
        self.assertNotIn("DEEPSEEK_API_KEY", error.getvalue())

    def test_source_model_env_remains_for_direct_and_analysis(self):
        direct_policy = dev._model_policy({"agent_id": "example-agent", "allowed": [
            {"provider": "local-qwen", "model": "Qwen3.8-27B"}],
            "default": {"provider": "local-qwen", "model": "Qwen3.8-27B"}},
            "example-agent", source="business-config", manifest_sha256="0" * 64)
        contract = EvaluationModeContractTest().contract(
            model_policy=direct_policy,
            required_env_names=["DEEPSEEK_API_KEY", "LOCAL_LLM_BASE_URL", "LOCAL_LLM_API_KEY", "SEC_OPS_MCP_URL"],
        )
        self.assertEqual(dev.required_env_names(contract), contract["required_env_names"])
        contract["model_policy"] = dev.analysis_model_policy("example-agent")
        self.assertEqual(dev.required_env_names(contract, "/tmp/analysis-run"), ["DEEPSEEK_API_KEY"])
        self.assertEqual(dev.runtime_env_names(contract, "/tmp/analysis-run"), ["DEEPSEEK_API_KEY"])

    def test_direct_default_requires_source_or_adapter_model_connection(self):
        with tempfile.TemporaryDirectory() as temporary:
            managed = Path(temporary)
            source_patch = managed / "example-agent.patch.yml"
            source_patch.write_text("- id: agent-default-model\n  config:\n    provider: local-qwen\n"
                                    "    model: Qwen3.8-27B\n- id: llm-pi-ai\n  config:\n"
                                    "    providers:\n      local-qwen:\n        models:\n"
                                    "          - id: Qwen3.8-27B\n", encoding="utf-8")
            contract = {"managed": str(managed), "patch": "/opt/dsh-managed/example-agent.patch.yml"}
            local = dev._model_policy({"agent_id": "example-agent", "allowed": [
                {"provider": "local-qwen", "model": "Qwen3.8-27B"}],
                "default": {"provider": "local-qwen", "model": "Qwen3.8-27B"}},
                "example-agent", source="business-config", manifest_sha256=None)
            dev.assert_direct_model_available(contract, local)
            deepseek = dev._model_policy({"agent_id": "example-agent", "allowed": [
                {"provider": "deepseek-official", "model": "deepseek-flash"}],
                "default": {"provider": "deepseek-official", "model": "deepseek-flash"}},
                "example-agent", source="business-config", manifest_sha256=None)
            dev.assert_direct_model_available(contract, deepseek)
            mimo = dev._model_policy({"agent_id": "example-agent", "allowed": [
                {"provider": "xiaomi-token-plan-cn", "model": "MiMo-V2.6-Flash"}],
                "default": {"provider": "xiaomi-token-plan-cn", "model": "MiMo-V2.6-Flash"}},
                "example-agent", source="business-config", manifest_sha256=None)
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.assert_direct_model_available(contract, mimo)
            self.assertIn("--model-policy", error.getvalue())
            source_patch.write_text("- id: agent-default-model\n  config:\n"
                                    "    provider: xiaomi-token-plan-cn\n    model: MiMo-V2.6-Flash\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.assert_direct_model_available(contract, mimo)
            source_patch.write_text("- id: agent-default-model\n  config:\n"
                                    "    provider: xiaomi-token-plan-cn\n    model: MiMo-V2.6-Flash\n"
                                    "- id: llm-pi-ai\n  config:\n    providers:\n"
                                    "      xiaomi-token-plan-cn:\n        models:\n"
                                    "          - id: MiMo-V2.6-Flash\n", encoding="utf-8")
            dev.assert_direct_model_available(contract, mimo)
            source_patch.write_text("- id: agent-default-model\n  config:\n"
                                    "    provider: xiaomi-token-plan-cn\n    model: MiMo-V2.6-Flash\n"
                                    "- id: agent-default-model\n  config:\n"
                                    "    provider: xiaomi-token-plan-cn\n    model: MiMo-V2.6-Flash\n"
                                    "- id: llm-pi-ai\n  config:\n    providers:\n"
                                    "      xiaomi-token-plan-cn:\n        models:\n"
                                    "          - id: MiMo-V2.6-Flash\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.assert_direct_model_available(contract, mimo)

    def test_platform_projection_retains_selected_legacy_model_ref(self):
        policy = dev._model_policy(self.policy(manifest_sha256="0" * 64), "example-agent",
                                   source="platform", manifest_sha256="0" * 64)
        contract = EvaluationModeContractTest().contract(
            model_policy=policy,
            required_env_names=["DEEPSEEK_API_KEY", "LOCAL_LLM_BASE_URL", "SEC_OPS_MCP_URL"],
        )
        self.assertEqual(dev.required_env_names(contract), ["SEC_OPS_MCP_URL", "DEEPSEEK_API_KEY"])

    def test_platform_projection_is_read_only_and_only_refs_enter_compose(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary) / "instances"):
            repo = Path(temporary) / "data"
            manifest = repo / "agents/example-agent/manifest.yaml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("agent_id: example-agent\nmodel_access:\n  allowed:\n"
                                "    - provider: deepseek-official\n      model: deepseek-flash\n", encoding="utf-8")
            manifest_digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
            config = repo / "config"
            config.mkdir()
            default_file = config / "business-model-default.json"
            default_file.write_text(json.dumps({
                "schema_version": "1.2", "default": {"provider": "deepseek-official", "model": "deepseek-flash"}
            }), encoding="utf-8")
            source = Path(temporary) / "model-policy.json"
            source.write_text(json.dumps(self.policy(manifest_sha256=manifest_digest,
                business_model_revision=hashlib.sha256(default_file.read_bytes()).hexdigest())), encoding="utf-8")
            policy = dev.read_model_policy(str(source), "example-agent", repo=repo)
            self.assertEqual(policy["source"], "platform")
            self.assertEqual(policy["credential_refs"], ["DEEPSEEK_API_KEY"])
            self.assertEqual(policy["manifest_sha256"], manifest_digest)
            dev.assert_model_policy_current(policy, repo=repo)
            patch = json.loads(dev.model_policy_patch(policy))
            self.assertEqual(patch[-1]["insert"][0]["name"], "file:///opt/harness-model-runtime/model-runtime.mjs")
            self.assertEqual(patch[-1]["insert"][0]["config"]["allowed"], policy["allowed"])
            self.assertEqual(patch[-1]["insert"][0]["config"],
                             {"agentId": "example-agent", "allowed": policy["allowed"]})
            local = [{"provider": "threat-analysis-delivery", "model": "fixed-summary"}]
            with_local = json.loads(dev.model_policy_patch(policy, local))[-1]["insert"][0]["config"]
            self.assertEqual(with_local["allowed"], policy["allowed"])
            self.assertEqual(with_local["localRoutes"], local)
            contract = EvaluationModeContractTest().contract(model_policy=policy)
            contract["agent_id"] = "example-agent"
            with mock.patch.object(dev, "assert_model_policy_current"):
                target = dev.write_instance("model-probe", mode="verification", contract=contract, port=3082)
            state = json.loads((target / "instance.json").read_text())
            self.assertEqual(state["model_policy"]["sha256"], policy["sha256"])
            self.assertNotIn("patch", state["model_policy"])
            self.assertEqual(dev.instance_compose_env(state)["DSH_MODEL_PATCH_HOST"], str(target / "model.patch.yml"))
            self.assertEqual(dev.required_env_names(contract), ["DEEPSEEK_API_KEY"])
            self.assertIn("      - DEEPSEEK_API_KEY\n", (target / "compose.yaml").read_text())
            default_file.write_text(json.dumps({"schema_version": "1.2", "default": None}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.assert_model_policy_current(policy, repo=repo)
            self.assertIn("业务默认模型配置已在启动过程中变化", error.getvalue())
            default_file.write_text(json.dumps({"schema_version": "1.2",
                "default": {"provider": "deepseek-official", "model": "deepseek-flash"}}), encoding="utf-8")
            manifest.write_text(manifest.read_text() + "# newer\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.assert_model_policy_current(policy, repo=repo)

    def test_unmarked_default_and_arbitrary_plugin_are_rejected(self):
        outside = self.policy(manifest_sha256="0" * 64,
                              default={"provider": "deepseek-official", "model": "deepseek-pro"})
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dev._model_policy(outside, "example-agent", source="platform", manifest_sha256="0" * 64)
        injected = self.policy(manifest_sha256="0" * 64,
                               patch=[{"insert": [{"id": "other", "name": "file:///tmp/other.mjs"}]}])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dev._model_policy(injected, "example-agent", source="platform", manifest_sha256="0" * 64)
        secret = self.policy(manifest_sha256="0" * 64,
                             patch=[{"id": "llm-pi-ai", "config": {"providers": {"other": {"headers": {"Authorization": "Bearer secret"}}}}}])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dev._model_policy(secret, "example-agent", source="platform", manifest_sha256="0" * 64)

    def test_direct_launcher_uses_only_confirmed_unified_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            manifest = repo / "agents/example-agent/manifest.yaml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("agent_id: example-agent\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertIn("尚未确认业务智能体统一默认模型", error.getvalue())
            # 旧 Agent manifest 授权不再影响直连实例。
            manifest.write_text("agent_id: example-agent\nmodel_access:\n  allowed:\n"
                                "    - provider: local-qwen\n      model: Qwen3.8-27B\n"
                                "    - provider: deepseek-official\n      model: deepseek-flash\n"
                                "  default:\n    provider: local-qwen\n    model: Qwen3.8-27B\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertIn("尚未确认业务智能体统一默认模型", error.getvalue())
            config = repo / "config"
            config.mkdir()
            (config / "business-model-default.json").write_text(json.dumps({
                "schema_version": "1.0", "default": {"provider": "local-qwen", "model": "Qwen3.8-27B"}
            }), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertIn("尚未确认业务智能体统一默认模型", error.getvalue())
            allowed = [{"provider": "local-qwen", "model": "Qwen3.8-27B"},
                       {"provider": "deepseek-official", "model": "deepseek-flash"}]
            (config / "business-model-default.json").write_text(json.dumps({
                "schema_version": "1.1", "allowed": allowed, "default": allowed[0]
            }), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertIn("尚未确认业务智能体统一默认模型", error.getvalue())
            (config / "business-model-default.json").write_text(json.dumps({
                "schema_version": "1.2", "default": allowed[0]
            }), encoding="utf-8")
            selected = dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertEqual(selected["default"]["model"], "Qwen3.8-27B")
            self.assertEqual(selected["allowed"], [allowed[0]])
            self.assertEqual(selected["source"], "business-config")
            self.assertFalse(dev.model_policy_summary(selected)["platform_sync"])
            self.assertEqual(selected["patch"][0]["id"], "agent-default-model")
            (config / "business-model-default.json").write_text(json.dumps({
                "schema_version": "1.2", "default": {**allowed[0], "reasoningEffort": "off"}
            }), encoding="utf-8")
            selected_with_effort = dev.read_model_policy(None, "example-agent", repo=repo)
            self.assertEqual(selected_with_effort["default"]["reasoningEffort"], "off")
            self.assertEqual(selected_with_effort["allowed"], [allowed[0]])
            self.assertEqual(selected_with_effort["patch"][0]["config"]["reasoningEffort"], "off")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(None, "example-agent", repo=repo, selected=allowed[1])
            self.assertIn("直连启动只能使用业务统一默认模型", error.getvalue())
            (config / "business-model-default.json").write_text(json.dumps({
                "schema_version": "1.0", "default": None
            }), encoding="utf-8")
            self.assertEqual(dev.read_business_model_policy(repo)["migration_required"], True)

    def test_analysis_instance_keeps_its_own_model_route(self):
        policy = dev.analysis_model_policy("example-agent")
        self.assertEqual(dev.model_policy_patch(policy), "[]\n")
        self.assertFalse(dev.model_policy_summary(policy)["enforced"])
        dev.assert_model_policy_current(policy)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)):
            contract = EvaluationModeContractTest().contract(model_policy=policy)
            target = dev.write_instance("analysis-probe", mode="verification", contract=contract, port=3082,
                                        analysis_workspace="/tmp/analysis-run")
            state = json.loads((target / "instance.json").read_text())
            self.assertEqual(state["model_policy"]["source"], "analysis-runtime")
            self.assertEqual(json.loads((target / "model.patch.yml").read_text()), [])
            entry = dev.instance_entry(target, state, {"projects": {}, "homes": {}})
            self.assertEqual(entry["model_policy"]["sha256"], state["model_policy"]["sha256"])

    def test_analysis_reuses_projected_model_connections_without_business_runtime(self):
        selected = {"provider": "xiaomi-token-plan-cn", "model": "mimo-v2.6-flash", "reasoningEffort": "off"}
        projected = {
            "allowed": [{"provider": selected["provider"], "model": selected["model"]}],
            "default": selected, "credential_refs": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
            "patch": [
                {"id": "agent-default-model", "config": selected},
                {"id": "llm-pi-ai", "config": {"providers": {selected["provider"]: {
                    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY", "models": [{"id": selected["model"]}],
                }}}},
            ],
            "harness_runtime": {"role_instructions": {"main": "dsh/workspace/AGENTS.md"}},
            "asset_dependencies": {"status": "ready"},
        }
        policy = dev.analysis_model_policy("example-agent", projected)
        self.assertEqual(policy["default"], selected)
        self.assertNotIn("harness_runtime", policy)
        self.assertNotIn("asset_dependencies", policy)
        self.assertEqual(json.loads(dev.model_policy_patch(policy)), projected["patch"])
        contract = EvaluationModeContractTest().contract(model_policy=policy,
                                                       required_env_names=["DEEPSEEK_API_KEY", "OPS_MCP_URL"])
        self.assertEqual(dev.required_env_names(contract, "/fixture/analysis"), ["XIAOMI_TOKEN_PLAN_CN_API_KEY"])
        self.assertEqual(dev.runtime_env_names(contract, "/fixture/analysis"), ["XIAOMI_TOKEN_PLAN_CN_API_KEY"])
        args = types.SimpleNamespace(source="experiment:EXP-example-agent-001", mode="verification",
                                     name="analysis-mimo", port=3082, model_policy="/fixture/model-policy.json",
                                     analysis_workspace="/fixture/analysis")
        with mock.patch.object(dev, "resolve", return_value=contract), \
                mock.patch.object(dev, "existing_instance", return_value=None), \
                mock.patch.object(dev, "validate_analysis_workspace", return_value="/fixture/analysis"), \
                mock.patch.object(dev, "read_model_policy", return_value=projected) as reader, \
                mock.patch.object(dev, "assert_asset_dependencies") as dependencies:
            prepared, current = dev.prepare_up(args)
            reader.assert_called_once_with("/fixture/model-policy.json", contract["agent_id"], repo=dev.REPO)
            dependencies.assert_not_called()
            self.assertIsNone(current)
            self.assertEqual(prepared["model_policy"]["source"], "analysis-runtime")
            self.assertEqual(prepared["model_policy"]["default"], selected)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)):
            target = dev.write_instance("analysis-mimo", mode="verification", contract=contract, port=3082,
                                        analysis_workspace="/fixture/analysis")
            compose = (target / "compose.yaml").read_text()
            self.assertIn("      - XIAOMI_TOKEN_PLAN_CN_API_KEY\n", compose)
            self.assertNotIn("      - DEEPSEEK_API_KEY\n", compose)
            self.assertNotIn("      - OPS_MCP_URL\n", compose)
            self.assertEqual(json.loads((target / "model.patch.yml").read_text()), projected["patch"])

    def test_eval_source_reads_candidate_local_routes_without_expanding_external_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            managed = Path(temporary) / "managed"
            managed.mkdir()
            (managed / "role-tool-matrix.yaml").write_text(
                "runtime_capabilities:\n"
                "  local_tools: [skill]\n"
                "  local_model_routes:\n"
                "    - provider: threat-analysis-delivery\n"
                "      model: fixed-summary\n", encoding="utf-8")
            routes = dev.source_local_model_routes({"managed": str(managed)})
            policy = dev._model_policy({"agent_id": "example-agent", "allowed": [
                {"provider": "catalog-model", "model": "catalog-route"}],
                "default": {"provider": "catalog-model", "model": "catalog-route"}},
                "example-agent", source="business-config", manifest_sha256=None)
            config = json.loads(dev.model_policy_patch(policy, routes))[-1]["insert"][0]["config"]
            self.assertEqual(config["allowed"], [{"provider": "catalog-model", "model": "catalog-route"}])
            self.assertEqual(config["localRoutes"], routes)
            business_config = json.loads(dev.model_policy_patch(policy, routes, business=True))[-1]["insert"][0]["config"]
            self.assertEqual(business_config["assetRoot"], "/opt/harness-business-assets")

    def test_policy_file_must_be_regular_absolute_and_match_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "data"
            manifest = repo / "agents/example-agent/manifest.yaml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("agent_id: example-agent\nmodel_access:\n  allowed:\n"
                                "    - provider: deepseek-official\n      model: deepseek-flash\n"
                                "  default:\n    provider: deepseek-official\n    model: deepseek-flash\n"
                                "    reasoningEffort: off\n", encoding="utf-8")
            config = repo / "config"
            config.mkdir()
            default_file = config / "business-model-default.json"
            default_file.write_text(json.dumps({
                "schema_version": "1.2", "default": {"provider": "deepseek-official", "model": "deepseek-flash"}
            }), encoding="utf-8")
            source = Path(temporary) / "model-policy.json"
            source.write_text(json.dumps(self.policy(manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
                business_model_revision=hashlib.sha256(default_file.read_bytes()).hexdigest())), encoding="utf-8")
            default_file.write_text(json.dumps({"schema_version": "1.2", "default": None}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(str(source), "example-agent", repo=repo)
            self.assertIn("尚未确认业务智能体统一默认模型", error.getvalue())
            default_file.write_text(json.dumps({"schema_version": "1.2", "default": {
                "provider": "other", "model": "different"}}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                dev.read_model_policy(str(source), "example-agent", repo=repo)
            self.assertIn("配置修订不一致", error.getvalue())
            default_file.write_text(json.dumps({"schema_version": "1.2", "default": {
                "provider": "deepseek-official", "model": "deepseek-flash"}}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.read_model_policy(str(source), "other-agent", repo=repo)
            alias = Path(temporary) / "alias.json"
            alias.symlink_to(source)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.read_model_policy(str(alias), "example-agent", repo=repo)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.read_model_policy("relative.json", "example-agent", repo=repo)
            stale = self.policy(manifest_sha256="0" * 64)
            source.write_text(json.dumps(stale), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.read_model_policy(str(source), "example-agent", repo=repo)

class EvaluationModeContractTest(unittest.TestCase):
    """新实例只有 eval 模式，且 Candidate 始终只读。"""

    def contract(self, **overrides):
        contract = {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "source_kind": "experiment",
            "agent_id": "security-operations-expert",
            "workspace": "/tmp/ws",
            "presets": "/tmp/presets",
            "managed": "/tmp/managed",
            "preset_id": "security-operations-expert",
            "patch": "/opt/dsh-managed/security-operations-expert.patch.yml",
            "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
            "required_env_names": [],
            "image": {"local_image_tag": IMAGE_TAG},
        }
        contract.update(overrides)
        return contract

    def test_managed_plugin_dependencies_are_present_before_start(self):
        with tempfile.TemporaryDirectory() as temp:
            managed = Path(temp)
            plugin = managed / "voice"
            plugin.mkdir()
            (plugin / "package.json").write_text(
                '{"dependencies":{"@deepseek-ai/schemastery":"^3","ws":"^8"}}', encoding="utf-8"
            )
            contract = self.contract(managed=str(managed))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.check_managed_plugin_dependencies(contract)
            for name in ("@deepseek-ai/schemastery", "ws"):
                (plugin / "node_modules" / name).mkdir(parents=True)
            dev.check_managed_plugin_dependencies(contract)
            (plugin / "node_modules" / "ws").rmdir()
            external = managed / "external"
            (external / "ws").mkdir(parents=True)
            dev.check_managed_plugin_dependencies(contract, str(external))

    def test_only_eval_mode_is_supported(self):
        self.assertEqual(dev.normalize_mode("eval"), "verification")
        self.assertEqual(dev.normalize_mode("verification"), "verification")
        for unsupported in ("dev", "authoring", "development"):
            with self.assertRaises(SystemExit):
                dev.normalize_mode(unsupported)

    def test_verification_template_exposes_no_grading_material(self):
        """被测目标会话不得挂载验收阈值、评估方法、测试预置或预期答案。"""
        template = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        rendered = dev.render_compose(
            template, mode="verification", name="probe", project="dsh-dev-probe", port=3081)
        self.assertNotIn("/work/reference\n", rendered)
        self.assertNotIn("/work/eval-input\n", rendered)
        self.assertNotIn("DSH_REFERENCE_HOST", rendered)
        self.assertNotIn("DSH_MANAGED_PATCH_OVERLAY", rendered)

    def test_analysis_workspace_is_a_read_only_run_without_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            repository = Path(temp)
            run = repository / (
                "evolution/experiments/EXP-probe-001/runs/"
                "run-00000000-0000-4000-8000-000000000000"
            )
            run.mkdir(parents=True)
            validated = dev.validate_analysis_workspace(str(run), repo=repository)
            rendered = dev.render_compose(
                (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8"),
                mode="verification", name="analysis", project="dsh-dev-analysis", port=3081,
                analysis_workspace=True,
            )
            self.assertEqual(validated, str(run))
            self.assertIn("    working_dir: /work/evaluation-run\n", rendered)
            self.assertIn("        target: /work/evaluation-run\n        read_only: true\n", rendered)
            self.assertIn("${DSH_EVALUATION_PATCH", rendered)
            analysis_patch = (ADAPTER / "evaluation-registry.patch.yml").read_text(encoding="utf-8")
            self.assertIn("- id: tool-fs\n  disabled: false", analysis_patch)
            self.assertIn("- id: tool-fs-search\n  disabled: false", analysis_patch)
            self.assertIn("- id: preset-evaluation-judge", analysis_patch)
            self.assertIn("- id: preset-scenario-analysis", analysis_patch)
            for value in (
                "${DSH_WORKSPACE_HOST", "${DSH_PRESETS_HOST", "${DSH_MANAGED_HOST",
                "${DSH_MANAGED_PATCH", "/work/harness/workspace", "/opt/dsh-presets",
                "/opt/dsh-managed",
            ):
                self.assertNotIn(value, rendered)
            with mock.patch.dict(os.environ, {}, clear=True):
                environment = dev.compose_env(
                    self.contract(), "verification", 3081, "analysis",
                    analysis_workspace=validated,
                )
            self.assertEqual(environment["DSH_ANALYSIS_WORKSPACE_HOST"], str(run))
            self.assertEqual(environment["DSH_EVAL_TARGET_PRESET"], "scenario-analysis")
            self.assertEqual(environment["DSH_EVALUATION_PATCH"], "/opt/dsh-adapter/evaluation-registry.patch.yml")
            registry = dev.resolve("EXP-security-operations-expert-007")
            self.assertEqual(registry["evaluation_patch"], environment["DSH_EVALUATION_PATCH"])
            self.assertEqual(dev.required_env_names(self.contract(), validated), ["DEEPSEEK_API_KEY"])
            for key in (
                "DSH_WORKSPACE_HOST", "DSH_PRESETS_HOST", "DSH_MANAGED_HOST", "DSH_MANAGED_PATCH",
            ):
                self.assertNotIn(key, environment)
            (run / "escape").symlink_to("/tmp")
            with self.assertRaises(SystemExit):
                dev.validate_analysis_workspace(str(run), repo=repository)

    def test_variant_run_analysis_and_source_help_are_available(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = "VAR-example-agent-001-r0123456789ab"
            experiment = root / "evolution/experiments" / identity
            run = experiment / "runs/run-00000000-0000-4000-8000-000000000000"
            run.mkdir(parents=True)
            self.assertEqual(dev.validate_analysis_workspace(str(run), repo=root), str(run))
            (experiment / "candidate").mkdir()
            (experiment / "candidate/harness.yaml").write_text("loadable_assets: {}\n")
            output = io.StringIO()
            with mock.patch.object(dev, "REPO", root), contextlib.redirect_stderr(output), self.assertRaises(SystemExit):
                dev.require_up_arguments(types.SimpleNamespace(source=None, mode="eval"))
            self.assertIn("experiment:" + identity, output.getvalue())

    def test_templates_declare_no_business_agent_identity(self):
        """通用启动器模板不得内联某个业务 Agent 的路径、preset 或 patch 名。"""
        text = (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8")
        self.assertNotIn("security-operations-expert", text)
        self.assertNotIn("EXP-security-operations-expert-001", text)

    def test_adapter_scripts_are_mounted_not_baked_into_the_image(self):
        """回归：脚本改动只需重启实例，不必重建镜像。"""
        dockerfile = (ADAPTER / "Dockerfile").read_text(encoding="utf-8")
        for name in ("verify-load.mjs", "tree-digest.mjs", "prepare-verification-home.mjs"):
            self.assertNotIn(f"/opt/dsh-adapter/{name}", dockerfile)
        self.assertIn("RUN mkdir -p /opt/dsh-adapter", dockerfile)
        rendered = dev.render_compose(
            (ADAPTER / "verification.compose.yaml").read_text(encoding="utf-8"),
            mode="verification", name="verification", project="dsh-dev-verification", port=3081)
        self.assertEqual(rendered.count("        target: /opt/dsh-adapter\n"), 2)
        self.assertNotIn("COPY --chown=node:node verify-load.mjs", rendered)

    def test_dsh_command_preserves_required_node_flag(self):
        """会话内 dsh 命令必须与主服务一样开放 Loader 所需的 Node internals。"""
        dockerfile = (ADAPTER / "Dockerfile").read_text(encoding="utf-8")
        launcher = (ADAPTER / "dsh-cli.sh").read_text(encoding="utf-8")
        self.assertIn("COPY --chmod=0755 dsh-cli.sh /usr/local/bin/dsh", dockerfile)
        self.assertEqual(
            launcher,
            '#!/bin/sh\nexec node --expose-internals /opt/dsh/apps/cli/lib/bin.js "$@"\n',
        )

    def test_verification_instance_has_no_development_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            dev.STATE_ROOT = Path(temp)
            target = dev.write_instance("secops-eval", mode="verification", contract=self.contract(),
                                        port=3085)
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["container_name"], "secops-eval")
            self.assertEqual(manifest["web_base_path"], "/assistant/")
            self.assertEqual(manifest["web_adapter_root"], str(ADAPTER.parent / "dsh-web"))
            self.assertEqual(dev.instance_base_url(manifest), "http://127.0.0.1:3085/assistant/")
            self.assertEqual(dev.instance_compose_env(manifest)["DSH_WEB_ADAPTER_HOST"],
                             str(ADAPTER.parent / "dsh-web"))
            self.assertEqual(dev.instance_base_url({"port": 3085}), "http://127.0.0.1:3085/")
            for key in ("dev_target_file", "patch_overlay", "cordis_trust_accepted"):
                self.assertNotIn(key, manifest)
            self.assertEqual(manifest["mount_modes"], {
                "workspace": "ro", "presets": "ro", "managed": "ro"})
            environment = dev.compose_env(self.contract(), "verification", 3085, "secops-eval")
            for key in ("DSH_DEV_TARGET_HOST", "DSH_MANAGED_PATCH_OVERLAY", "DSH_REFERENCE_HOST"):
                self.assertNotIn(key, environment)

    def test_optional_connections_are_forwarded_only_when_set(self):
        contract = self.contract(
            required_env_names=["DEEPSEEK_API_KEY"],
            optional_env_names=["POLICY_CONFIGURATION_MCP_URL", "EMERGENCY_ACTION_MCP_URL"],
        )
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(dev, "STATE_ROOT", Path(temp)), \
                mock.patch.dict(os.environ, {"POLICY_CONFIGURATION_MCP_URL": "http://policy"}, clear=True):
            self.assertEqual(dev.runtime_env_names(contract),
                             ["DEEPSEEK_API_KEY", "POLICY_CONFIGURATION_MCP_URL"])
            self.assertEqual(dev.runtime_env_names(contract, "/tmp/analysis"), ["DEEPSEEK_API_KEY"])
            target = dev.write_instance("optional-probe", mode="verification", contract=contract, port=3085)
            compose = (target / "compose.yaml").read_text(encoding="utf-8")
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertIn("      - POLICY_CONFIGURATION_MCP_URL\n", compose)
            self.assertNotIn("      - EMERGENCY_ACTION_MCP_URL\n", compose)
            self.assertEqual(manifest["required_env_names"], ["DEEPSEEK_API_KEY"])
            self.assertEqual(manifest["optional_env_names"], ["POLICY_CONFIGURATION_MCP_URL"])
            self.assertNotIn("http://policy", json.dumps(manifest))

    def test_inspection_token_is_forwarded_for_inspection_sources(self):
        for number in ("008", "009", "010", "011", "012"):
            source = f"experiment:EXP-security-operations-expert-{number}"
            contract = dev.resolve(source)
            with mock.patch.dict(os.environ, {"INSPECTION_MCP_TOKEN": "test-token"}):
                self.assertIn("INSPECTION_MCP_TOKEN", dev.runtime_env_names(contract))

    def test_target_preset_comes_from_selected_source(self):
        """目标是来源声明的业务 preset，与本次会话实际运行的 preset 分开。"""
        self.assertEqual(dev.target_preset(self.contract()), "security-operations-expert")
        self.assertEqual(dev.target_preset(self.contract(preset_id="second-harness")), "second-harness")
        with self.assertRaises(SystemExit):
            dev.target_preset(self.contract(preset_id=None))

    def test_session_and_target_preset_are_the_selected_source(self):
        contract = self.contract()
        self.assertEqual(dev.session_preset(contract, "verification"),
                         dev.target_preset(contract))

    def test_compose_env_injects_only_evaluation_assets(self):
        environment = dev.compose_env(self.contract(), "verification", 3082, "probe-eval")
        self.assertEqual(environment["DSH_ADAPTER_HOST"], str(ADAPTER))
        self.assertEqual(environment["DSH_WORKSPACE_HOST"], "/tmp/ws")
        for key in ("DSH_DEV_TARGET_HOST", "DSH_MANAGED_PATCH_OVERLAY", "DSH_REFERENCE_HOST"):
            self.assertNotIn(key, environment)

    def test_selected_profile_is_persisted_for_compose_lifecycle(self):
        contract = self.contract()
        contract["profile_manifest"] = "/tmp/selected-web-profile.package.json"
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(dev, "STATE_ROOT", Path(temp)):
            target = dev.write_instance("profile-probe", mode="verification", contract=contract, port=3082)
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["web_profile_manifest"], contract["profile_manifest"])
            self.assertEqual(dev.compose_env(contract, "verification", 3082, "profile-probe")
                             ["DSH_WEB_PROFILE_MANIFEST_HOST"], contract["profile_manifest"])
            self.assertEqual(dev.instance_compose_env(manifest)["DSH_WEB_PROFILE_MANIFEST_HOST"],
                             contract["profile_manifest"])

    def test_legacy_profile_projection_keeps_original_seed_for_up_and_lifecycle(self):
        contract = self.contract()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(dev, "STATE_ROOT", Path(temp) / "instances"):
            source = Path(temp) / "candidate" / "web-profile.package.json"
            source.parent.mkdir()
            source.write_text(json.dumps({"dsh": {"profile": {"bundles": [
                "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                "@deepseek-ai/dsh-experimental-schedule-bundle",
            ]}}}), encoding="utf-8")
            contract["profile_manifest"] = str(source)
            contract["managed"] = str(source.parent)
            managed_patch = source.parent / Path(contract["patch"]).name
            managed_patch.write_text("- insert:\n    - id: legacy-delegate\n"
                                     "      name: '@deepseek-ai/dsh-tool-subagent'\n"
                                     "      config:\n        persona: fixed-role\n", encoding="utf-8")
            original_patch = managed_patch.read_bytes()
            original = source.read_bytes()
            target = dev.write_instance("legacy-probe", mode="verification", contract=contract, port=3082)
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(managed_patch.read_bytes(), original_patch)
            self.assertNotEqual(manifest["web_profile_manifest"], str(source))
            for environment in (dev.compose_env(contract, "verification", 3082, "legacy-probe"),
                                dev.instance_compose_env(manifest)):
                self.assertEqual(environment["DSH_WEB_PROFILE_MANIFEST_HOST"], manifest["web_profile_manifest"])
                self.assertEqual(environment["DSH_WEB_PROFILE_SEED_DIR_HOST"], str(source.parent))
                self.assertEqual(environment["DSH_MANAGED_PATCH"], "/opt/dsh-profile-compat/managed.patch.yml")
                self.assertEqual(environment["DSH_RUNTIME_MANAGED_PATCH_HOST"],
                                 manifest["runtime_managed_patch_host"])
            self.assertIn("target: /opt/dsh-profile-compat/managed.patch.yml", (target / "compose.yaml").read_text())

    def test_plugin_dependencies_are_recorded_for_compose_lifecycle(self):
        contract = self.contract()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(dev, "STATE_ROOT", Path(temp)):
            node_modules = str(Path(temp) / "node_modules")
            target = dev.write_instance(
                "voice-probe", mode="verification", contract=contract, port=3082,
                plugin_node_modules=node_modules,
            )
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["mounts"]["plugin_node_modules"], node_modules)
            self.assertEqual(manifest["mount_modes"]["plugin_node_modules"], "ro")
            self.assertEqual(dev.compose_env(contract, "verification", 3082, "voice-probe",
                                              plugin_node_modules=node_modules)["DSH_PLUGIN_NODE_MODULES_HOST"],
                             node_modules)
            self.assertEqual(dev.instance_compose_env(manifest)["DSH_PLUGIN_NODE_MODULES_HOST"],
                             node_modules)

    def test_dry_run_delivers_workspace_path_and_cold_start_hint(self):
        """DSH Web 冷启动需要先在界面注册工作区；计划必须交付确切路径与步骤。"""
        args = types.SimpleNamespace(source="experiment:EXP-security-operations-expert-001",
                                     mode="verification", name="secops-eval", port=3085, dry_run=True)
        stdout = io.StringIO()
        selected = {"provider": "deepseek-official", "model": "deepseek-flash"}
        policy = dev._model_policy({"agent_id": "security-operations-expert", "allowed": [selected],
                                    "default": selected}, "security-operations-expert",
                                   source="business-config", manifest_sha256=None)
        with mock.patch.object(dev, "read_model_policy", return_value=policy), contextlib.redirect_stdout(stdout):
            dev.command_up(args)
        plan = json.loads(stdout.getvalue())
        self.assertEqual(plan["workspace_to_register"], "/work/harness/workspace")
        self.assertEqual(plan["container_name"], "secops-eval")
        self.assertIn("/work/harness/workspace", plan["web_cold_start"])
        self.assertIn("编辑路径", plan["web_cold_start"])
        self.assertEqual(plan["context_assets"], [])
        self.assertFalse(plan["grading_material_mounted"])
        # 计划可以出现环境变量**名称**（含 TOKEN 字样），但不得出现任何值。
        self.assertNotIn("token=", json.dumps(plan).lower())

    def test_lan_dry_run_records_profile_and_listener(self):
        args = types.SimpleNamespace(
            source="experiment:EXP-security-operations-expert-001",
            mode="verification", name="secops-lan", port=3154, dry_run=True,
            lan_access=True,
        )
        stdout = io.StringIO()
        selected = {"provider": "deepseek-official", "model": "deepseek-flash"}
        policy = dev._model_policy({"agent_id": "security-operations-expert", "allowed": [selected],
                                    "default": selected}, "security-operations-expert",
                                   source="business-config", manifest_sha256=None)
        with mock.patch.object(dev, "read_model_policy", return_value=policy), contextlib.redirect_stdout(stdout):
            dev.command_up(args)
        plan = json.loads(stdout.getvalue())
        self.assertEqual(plan["profile"], "web")
        self.assertTrue(plan["lan_access"])
        self.assertEqual(plan["listen_host"], "0.0.0.0")

class ExtractAuthUrlTest(unittest.TestCase):
    def test_extracts_matching_port(self):
        logs = "noise\n" + TOKEN + "dsh web: http://127.0.0.1:9999/?token=other\n"
        self.assertEqual(dev.extract_auth_url(logs, 3081), "http://127.0.0.1:3081/?token=secret-token-value")

    def test_ignores_lan_variant(self):
        logs = TOKEN + "dsh web: http://127.0.0.1:3081/?token=secret-token-value (LAN: http://10.0.0.5:3081/?token=secret-token-value)\n"
        self.assertEqual(dev.extract_auth_url(logs, 3081), "http://127.0.0.1:3081/?token=secret-token-value")

    def test_ambiguous_urls_return_none(self):
        logs = TOKEN + "dsh web: http://127.0.0.1:3081/?token=second-token\n"
        self.assertIsNone(dev.extract_auth_url(logs, 3081))

    def test_other_port_returns_none(self):
        self.assertIsNone(dev.extract_auth_url(TOKEN, 3099))

    def test_redaction_hides_token(self):
        redacted = dev.redact_secrets(
            TOKEN
            + "Authorization: Bearer bearer-secret\n"
            + '{"apiKey":"json-secret","password":"password-secret"} TOKEN=plain-secret\n'
        )
        self.assertNotIn("secret-token-value", redacted)
        self.assertNotIn("bearer-secret", redacted)
        self.assertNotIn("json-secret", redacted)
        self.assertNotIn("password-secret", redacted)
        self.assertNotIn("plain-secret", redacted)
        self.assertIn("token=<redacted>", redacted)
        self.assertIn("Bearer <redacted>", redacted)
        self.assertIn('"apiKey":"<redacted>"', redacted)


class InstanceStateTest(unittest.TestCase):
    def test_instance_manifest_has_no_token_and_records_mount_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dev.STATE_ROOT = root
            contract = {
                "source_id": "experiment:EXP-second-harness-002",
                "source_kind": "experiment",
                "agent_id": "second-harness",
                "workspace": "/tmp/ws",
                "presets": "/tmp/presets",
                "managed": "/tmp/managed",
                "preset_id": "second-harness",
                "patch": "/opt/dsh-managed/second.patch.yml",
                "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
                "required_env_names": ["DEEPSEEK_API_KEY"],
                "image": {"local_image_tag": IMAGE_TAG},
            }
            target = dev.write_instance(
                "second-verify", mode="verification", contract=contract, port=3081,
                lan_access=True,
            )
            manifest = json.loads((target / "instance.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["container_name"], "second-verify")
            self.assertEqual(manifest["mount_modes"], {"workspace": "ro", "presets": "ro", "managed": "ro"})
            self.assertEqual(manifest["purpose"], "eval")
            self.assertEqual(manifest["target_preset"], "second-harness")
            self.assertEqual(manifest["session_preset"], "second-harness")
            self.assertEqual(manifest["agent_id"], "second-harness")
            self.assertEqual(manifest["profile"], "web")
            self.assertTrue(manifest["lan_access"])
            self.assertFalse(manifest["unsafe_no_auth"])
            self.assertFalse(manifest["skip_testing_notice"])
            self.assertEqual(manifest["listen_host"], "0.0.0.0")
            # 被测目标会话不挂载任何判分材料。
            self.assertEqual(manifest["context_mounts"], [])
            self.assertNotIn("patch_overlay", manifest)
            self.assertNotIn("cordis_trust_accepted", manifest)
            self.assertNotIn("token", json.dumps(manifest).lower())
            compose = (target / "compose.yaml").read_text(encoding="utf-8")
            self.assertNotIn("token=", compose)
            self.assertIn("network_mode: host", compose)

    def test_instance_name_must_be_kebab(self):
        with self.assertRaises(SystemExit):
            dev.instance_dir("Bad_Name")

    def test_conflicting_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            dev.STATE_ROOT = Path(temp)
            contract = {
                "source_id": "experiment:EXP-security-operations-expert-001",
                "source_kind": "experiment",
                "agent_id": "security-operations-expert",
                "workspace": "/tmp/ws",
                "presets": "/tmp/presets",
                "managed": "/tmp/managed",
                "preset_id": "security-operations-expert",
                "patch": "/opt/dsh-managed/x.patch.yml",
                "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
                "required_env_names": [],
                "image": {"local_image_tag": IMAGE_TAG},
            }
            dev.write_instance("soe-verify", mode="verification", contract=contract, port=3081)
            other = dict(contract, source_id="experiment:EXP-second-harness-002")
            with self.assertRaises(SystemExit):
                dev.write_instance("soe-verify", mode="verification", contract=other, port=3081)


class ImageIdentityAndPsStateTest(unittest.TestCase):
    def test_batch_observation_groups_containers_and_volumes_with_two_queries(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            docker = root / "docker"
            docker.write_text('#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\n'
                'with Path(__file__).with_name("calls").open("a") as out: out.write(sys.argv[1] + "\\n")\n'
                'if sys.argv[1] == "ps":\n'
                ' for i in range(100): print(json.dumps({"Project": "project-" + str(i), "State": "running"}))\n'
                'else:\n'
                ' print(json.dumps({"name": "real-home", "project": "project-1", "volume": "project-1-home"}))\n'
                ' print(json.dumps({"name": "other", "project": "project-1", "volume": "data"}))\n', encoding="utf-8")
            docker.chmod(0o700)
            result = subprocess.run(["node", str(ADAPTER / "instance-observation.ts")],
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}"}, capture_output=True, text=True, check=True)
            observed = json.loads(result.stdout)
            self.assertEqual(len(observed["projects"]), 100)
            self.assertEqual(observed["homes"], {"project-1": "real-home"})
            self.assertEqual(sorted((root / "calls").read_text().splitlines()), ["ps", "volume"])

    def test_failed_batch_observation_reports_unknown_without_per_instance_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("one", "two"):
                target = root / name
                target.mkdir()
                (target / "instance.json").write_text(json.dumps({"name": name, "asset_root": str(dev.REPO)}), encoding="utf-8")
            with mock.patch.object(dev, "STATE_ROOT", root), mock.patch.object(dev, "run",
                    return_value=subprocess.CompletedProcess([], 0, stdout='{"projects":null,"homes":null}', stderr="")) as query:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    dev.command_ps(types.SimpleNamespace(all=True))
                self.assertEqual(query.call_count, 1)
            entries = json.loads(output.getvalue())["instances"]
            self.assertEqual([entry["state"] for entry in entries], ["unknown", "unknown"])
            self.assertTrue(all(entry["home_preserved"] is None for entry in entries))

    def test_ps_hides_non_running_instances_by_default(self):
        states = {"failed": "failed", "running": "running", "stopped": "stopped", "unknown": "unknown"}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in states:
                target = root / name
                target.mkdir()
                (target / "instance.json").write_text(json.dumps({"asset_root": str(dev.REPO)}), encoding="utf-8")

            def fake_entry(target, _manifest, _observation):
                return {"name": target.name, "state": states[target.name]}

            with mock.patch.object(dev, "STATE_ROOT", root), \
                    mock.patch.object(dev, "instance_entry", side_effect=fake_entry), \
                    mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout='{"projects":{},"homes":{}}', stderr="")):
                default_output = io.StringIO()
                with contextlib.redirect_stdout(default_output):
                    dev.command_ps(types.SimpleNamespace(all=False))
                all_output = io.StringIO()
                with contextlib.redirect_stdout(all_output):
                    dev.command_ps(types.SimpleNamespace(all=True))

        self.assertEqual(
            [item["name"] for item in json.loads(default_output.getvalue())["instances"]],
            ["running"],
        )
        self.assertEqual(
            {item["name"] for item in json.loads(all_output.getvalue())["instances"]},
            set(states),
        )

    def test_compose_output_normalizes_failure_and_unknown_states(self):
        failed = dev.compose_ps_containers(
            '{"ID":"failed","State":"exited","Status":"Exited (17) 1 second ago",'
            '"Service":"dsh"}'
        )
        restarting = dev.compose_ps_containers(
            '{"ID":"restarting","State":"restarting","Status":"Restarting",'
            '"Service":"dsh"}'
        )
        self.assertEqual(dev.normalized_instance_state(failed), "failed")
        self.assertEqual(dev.normalized_instance_state(restarting), "unknown")
        self.assertEqual(dev.normalized_instance_state([]), "absent")
        self.assertEqual(dev.normalized_instance_state([{"service": "home-init", "state": "exited"}]), "absent")
        self.assertEqual(dev.normalized_instance_state([{"service": "dsh", "state": "exited", "exit_code": 0}]), "stopped")
        self.assertEqual(dev.normalized_instance_state(None), "unknown")
        self.assertIsNone(dev.compose_ps_containers("not-json"))
        for state, exit_code, expected in [("created", None, "stopped"), ("running", 0, "running"),
                ("exited", 0, "stopped"), ("exited", 17, "failed"), ("dead", 0, "failed"),
                ("restarting", None, "unknown"), ("paused", None, "unknown"), ("removing", 0, "unknown"),
                ("restarting", 1, "unknown"), ("paused", 1, "unknown"), ("removing", 1, "unknown"),
                ("unexpected", 0, "unknown"), ("", None, "unknown")]:
            with self.subTest(state=state, exit_code=exit_code):
                containers = dev.compose_ps_containers(json.dumps({"State": state, "ExitCode": exit_code, "Service": "dsh"}))
                self.assertEqual(dev.normalized_instance_state(containers), expected)

    def test_validate_image_identity_returns_immutable_reference(self):
        fingerprint = "sha256:" + "2" * 64
        image_id = "sha256:" + "1" * 64
        contract = {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "image": {
                "local_image_tag": IMAGE_TAG,
                "build_fingerprint": fingerprint,
                "platform": "linux/amd64",
            },
        }
        metadata = {
            "Id": image_id,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Labels": {dev.IMAGE_LABEL_KEY: fingerprint}},
        }
        with mock.patch.object(
            dev, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(metadata), stderr=""
            )
        ):
            identity = dev.validate_image_identity(contract)
        self.assertEqual(identity["image_id"], image_id)
        self.assertEqual(identity["image_ref"], f"{contract['image']['local_image_tag']}@{image_id}")

    def test_validate_image_identity_accepts_arm64(self):
        fingerprint = "sha256:" + "2" * 64
        image_id = "sha256:" + "1" * 64
        contract = {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "image": {
                "local_image_tag": IMAGE_TAG,
                "build_fingerprint": fingerprint,
                "platform": "linux/arm64",
            },
        }
        metadata = {
            "Id": image_id,
            "Os": "linux",
            "Architecture": "arm64",
            "Config": {"Labels": {dev.IMAGE_LABEL_KEY: fingerprint}},
        }
        with mock.patch.object(
            dev, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(metadata), stderr=""
            )
        ):
            identity = dev.validate_image_identity(contract)
        self.assertEqual(identity["platform"], "linux/arm64")
        self.assertEqual(identity["image_ref"], f"{IMAGE_TAG}@{image_id}")

    def test_validate_image_identity_rejects_other_architecture(self):
        fingerprint = "sha256:" + "2" * 64
        contract = {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "image": {
                "local_image_tag": IMAGE_TAG,
                "build_fingerprint": fingerprint,
                "platform": "linux/arm64",
            },
        }
        metadata = {
            "Id": "sha256:" + "1" * 64,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Labels": {dev.IMAGE_LABEL_KEY: fingerprint}},
        }
        errors = io.StringIO()
        with mock.patch.object(
            dev, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(metadata), stderr=""
            )
        ), contextlib.redirect_stderr(errors), self.assertRaises(SystemExit):
            dev.validate_image_identity(contract)
        self.assertIn("期望 linux/arm64，实际 linux/amd64", errors.getvalue())

    def test_validate_image_identity_rejects_unlabelled_image(self):
        fingerprint = "sha256:" + "2" * 64
        metadata = {
            "Id": "sha256:" + "1" * 64,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Labels": {}},
        }
        contract = {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "image": {
                "local_image_tag": IMAGE_TAG,
                "build_fingerprint": fingerprint,
                "platform": "linux/amd64",
            },
        }
        errors = io.StringIO()
        with mock.patch.object(
            dev, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(metadata), stderr=""
            )
        ), contextlib.redirect_stderr(errors), self.assertRaises(SystemExit):
            dev.validate_image_identity(contract)
        self.assertIn("构建指纹不匹配", errors.getvalue())


class DownCommandTest(unittest.TestCase):
    """`down` 必须报告真实状态：命令失败、仍有容器运行或无法确认都不能输出 stopped: true。"""

    def setUp(self):
        isolate_registration_guard(self)
        self._temp = tempfile.TemporaryDirectory()
        dev.STATE_ROOT = Path(self._temp.name)
        dev.write_instance("soe-verify", mode="verification", contract={
            "source_id": "experiment:EXP-security-operations-expert-001",
            "source_kind": "experiment",
            "agent_id": "security-operations-expert",
            "workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": "/tmp/managed",
            "preset_id": "security-operations-expert",
            "patch": "/opt/dsh-managed/security-operations-expert.patch.yml",
            "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
            "required_env_names": [],
            "image": {"local_image_tag": IMAGE_TAG},
        }, port=3081)
        # 本组验证历史 named volume 生命周期；新 bind HOME 由独立用例覆盖。
        path = dev.STATE_ROOT / "soe-verify" / "instance.json"
        manifest = json.loads(path.read_text())
        manifest.pop("home_directory", None)
        path.write_text(json.dumps(manifest))
        (path.parent / "dsh-home/profiles/web").rmdir()
        (path.parent / "dsh-home/profiles").rmdir()
        (path.parent / "dsh-home").rmdir()

    def tearDown(self):
        self._temp.cleanup()

    def call(self, completed, containers, volume=None):
        volume = volume or subprocess.CompletedProcess([], 0, stdout="", stderr="")
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(dev, "run", side_effect=[
            completed,  # docker compose down
            containers,  # docker ps -a
            volume,  # docker volume ls
        ]), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                dev.command_down(types.SimpleNamespace(name="soe-verify"))
            except SystemExit as stop:
                return stop.code, stdout.getvalue(), stderr.getvalue()
        return 0, stdout.getvalue(), stderr.getvalue()

    def test_compose_down_failure_is_not_reported_as_stopped(self):
        """回归：命令退出码非零时不得输出 stopped: true。"""
        failure = subprocess.CompletedProcess([], 1, stdout="", stderr="permission denied")
        code, printed, errors = self.call(failure, subprocess.CompletedProcess([], 0, stdout="", stderr=""))
        self.assertNotEqual(code, 0)
        self.assertNotIn("stopped", printed)
        self.assertIn("停止 soe-verify 失败", errors)

    def test_surviving_container_is_reported_as_failure(self):
        ok = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        listings = subprocess.CompletedProcess(
            [], 0,
            stdout="abc123\trunning\tUp 2 minutes\tdsh-dev-soe-verify-dsh-1\tdsh\n", stderr="")
        code, printed, errors = self.call(ok, listings)
        self.assertNotEqual(code, 0)
        self.assertEqual(printed, "")
        self.assertIn('"stopped": false', errors)

    def test_unqueryable_state_is_reported_as_unknown(self):
        ok = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        unqueryable = subprocess.CompletedProcess([], 1, stdout="", stderr="daemon down")
        code, printed, errors = self.call(ok, unqueryable)
        self.assertNotEqual(code, 0)
        self.assertEqual(printed, "")
        self.assertIn('"stopped": "unknown"', errors)

    def test_confirmed_stop_reports_true_and_home_preservation(self):
        """回归：HOME 卷名由 Compose 标签解析，不能按 <project>-home 猜测。"""
        ok = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        preserved = subprocess.CompletedProcess(
            [], 0, stdout="dsh-dev-soe-verify_dsh-dev-soe-verify-home\n", stderr="")
        code, printed, _ = self.call(ok, empty, preserved)
        self.assertEqual(code, 0)
        self.assertIn('"stopped": true', printed)
        self.assertIn('"home_preserved": true', printed)
        self.assertIn("dsh-dev-soe-verify_dsh-dev-soe-verify-home", printed)

    def test_absent_home_volume_is_reported_as_false(self):
        ok = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        gone = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        code, printed, _ = self.call(ok, empty, gone)
        self.assertEqual(code, 0)
        self.assertIn('"home_preserved": false', printed)

    def test_instance_lifecycle_commands_inject_recorded_source_values(self):
        """回归：模板以 ${VAR:?} 声明必填变量，读取实例 Compose 也必须按实例状态注入。"""
        _, manifest = dev.load_instance("soe-verify")
        environment = dev.instance_compose_env(manifest)
        self.assertEqual(environment["DSH_IMAGE_TAG"], IMAGE_TAG)
        self.assertEqual(environment["DSH_ADAPTER_HOST"], str(ADAPTER))
        self.assertEqual(environment["DSH_MANAGED_PATCH"],
                         "/opt/dsh-managed/security-operations-expert.patch.yml")
        self.assertEqual(environment["DSH_WORKSPACE_HOST"], "/tmp/ws")
        self.assertNotIn("DSH_MANAGED_PATCH_OVERLAY", environment)


class DeleteCommandTest(unittest.TestCase):
    """`delete` 只能删除已停止实例登记，不能把失败或未知状态当作可清理。"""

    def setUp(self):
        isolate_registration_guard(self)
        self._temp = tempfile.TemporaryDirectory()
        dev.STATE_ROOT = Path(self._temp.name)
        dev.write_instance("delete-probe", mode="verification", contract={
            "source_id": "experiment:EXP-security-operations-expert-001",
            "source_kind": "experiment",
            "agent_id": "security-operations-expert",
            "workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": "/tmp/managed",
            "preset_id": "security-operations-expert",
            "patch": "/opt/dsh-managed/security-operations-expert.patch.yml",
            "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
            "required_env_names": [],
            "image": {"local_image_tag": IMAGE_TAG},
        }, port=3081)
        # 本组验证历史 named volume 生命周期；新 bind HOME 由独立用例覆盖。
        path = dev.STATE_ROOT / "delete-probe" / "instance.json"
        manifest = json.loads(path.read_text())
        manifest.pop("home_directory", None)
        path.write_text(json.dumps(manifest))
        (path.parent / "dsh-home/profiles/web").rmdir()
        (path.parent / "dsh-home/profiles").rmdir()
        (path.parent / "dsh-home").rmdir()

    def tearDown(self):
        self._temp.cleanup()

    def call(self, effects):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(dev, "run", side_effect=effects), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                dev.command_delete(types.SimpleNamespace(name="delete-probe"))
            except SystemExit as stop:
                return stop.code, stdout.getvalue(), stderr.getvalue()
        return 0, stdout.getvalue(), stderr.getvalue()

    def test_delete_removes_stopped_container_and_registration_but_keeps_home(self):
        stopped = subprocess.CompletedProcess(
            [], 0,
            stdout="abc\texited\tExited (0)\tdsh-dev-delete-probe-dsh-1\tdsh\n", stderr="")
        volume = subprocess.CompletedProcess([], 0, stdout="dsh-dev-delete-probe-home\n", stderr="")
        removed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        code, printed, _ = self.call([stopped, volume, removed, empty, volume])
        report = json.loads(printed)
        self.assertEqual(code, 0)
        self.assertTrue(report["deleted"])
        self.assertTrue(report["registration_deleted"])
        self.assertTrue(report["home_preserved_before"])
        self.assertTrue(report["home_preserved"])
        self.assertFalse((dev.STATE_ROOT / "delete-probe").exists())

    def test_delete_removes_stopped_registration_when_container_is_already_gone(self):
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        volume = subprocess.CompletedProcess([], 0, stdout="dsh-dev-delete-probe-home\n", stderr="")
        code, printed, _ = self.call([empty, volume, volume])
        self.assertEqual(code, 0)
        report = json.loads(printed)
        self.assertTrue(report["deleted"])
        self.assertEqual(report["state"], "absent")
        self.assertTrue(report["home_preserved"])
        self.assertFalse((dev.STATE_ROOT / "delete-probe").exists())

    def test_delete_keeps_registration_when_home_recheck_is_unknown(self):
        stopped = subprocess.CompletedProcess(
            [], 0,
            stdout="abc\texited\tExited (0)\tdsh-dev-delete-probe-dsh-1\tdsh\n", stderr="")
        volume = subprocess.CompletedProcess([], 0, stdout="dsh-dev-delete-probe-home\n", stderr="")
        removed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        unknown_volume = subprocess.CompletedProcess([], 1, stdout="", stderr="daemon down")
        code, printed, errors = self.call([stopped, volume, removed, empty, unknown_volume])
        self.assertNotEqual(code, 0)
        self.assertEqual(printed, "")
        self.assertIn('"deleted": "unknown"', errors)
        self.assertTrue((dev.STATE_ROOT / "delete-probe" / "instance.json").is_file())

    def test_delete_keeps_registration_when_home_is_lost_after_delete(self):
        stopped = subprocess.CompletedProcess(
            [], 0,
            stdout="abc\texited\tExited (0)\tdsh-dev-delete-probe-dsh-1\tdsh\n", stderr="")
        volume = subprocess.CompletedProcess([], 0, stdout="dsh-dev-delete-probe-home\n", stderr="")
        removed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        gone = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        code, printed, errors = self.call([stopped, volume, removed, empty, gone])
        self.assertNotEqual(code, 0)
        self.assertEqual(printed, "")
        self.assertIn('"deleted": false', errors)
        self.assertTrue((dev.STATE_ROOT / "delete-probe" / "instance.json").is_file())

    def test_running_failed_and_unknown_states_keep_registration(self):
        cases = [
            subprocess.CompletedProcess(
                [], 0, stdout="abc\trunning\tUp\tdsh-dev-delete-probe-dsh-1\tdsh\n", stderr=""),
            subprocess.CompletedProcess(
                [], 0, stdout="abc\texited\tExited (17)\tdsh-dev-delete-probe-dsh-1\tdsh\n", stderr=""),
            subprocess.CompletedProcess([], 1, stdout="", stderr="daemon down"),
        ]
        for completed in cases:
            with self.subTest(stdout=completed.stdout, returncode=completed.returncode):
                if not (dev.STATE_ROOT / "delete-probe").exists():
                    dev.write_instance("delete-probe", mode="verification", contract={
                        "source_id": "experiment:EXP-security-operations-expert-001",
                        "source_kind": "experiment",
                        "agent_id": "security-operations-expert",
                        "workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": "/tmp/managed",
                        "preset_id": "security-operations-expert",
                        "patch": "/opt/dsh-managed/security-operations-expert.patch.yml",
                        "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
                        "required_env_names": [],
                        "image": {"local_image_tag": IMAGE_TAG},
                    }, port=3081)
                code, printed, errors = self.call([completed])
                self.assertNotEqual(code, 0)
                self.assertEqual(printed, "")
                self.assertTrue((dev.STATE_ROOT / "delete-probe" / "instance.json").is_file())
                self.assertTrue("unknown" in errors or '"deleted": false' in errors)


class RuntimeEnvironmentRetentionTest(unittest.TestCase):
    """同来源重建保留运行配置；仅隔离 Docker 边界，不启动或检查真实容器。"""

    def setUp(self):
        isolate_registration_guard(self)

    @staticmethod
    def args(**values):
        return types.SimpleNamespace(**dict({
            "name": "environment-probe", "mode": "verification", "analysis_workspace": None,
            "replace": True, "port": 3312, "allow_missing_env": False, "dry_run": False,
            "lan_access": True, "unsafe_no_auth": True, "skip_testing_notice": True,
        }, **values))

    @staticmethod
    def contract():
        return dict(dev.resolve(), required_env_names=["DEEPSEEK_API_KEY"],
                    optional_env_names=["AI_PLATFORM_URL", "THREAT_ANALYSIS_MCP_TOKEN"])

    @staticmethod
    def current(contract, path=Path("/unused")):
        return path, {"source_id": contract["source_id"], "mode": "verification", "mounts": {}, "asset_root": str(dev.REPO)}

    @staticmethod
    def inspected_environment():
        return ["DEEPSEEK_API_KEY=previous-model-fixture", "AI_PLATFORM_URL=http://127.0.0.1:53001",
                "THREAT_ANALYSIS_MCP_TOKEN=previous-group-fixture", "UNDECLARED_VALUE=unrelated-fixture"]

    def test_same_source_recovers_stopped_container_declared_names_only_and_keeps_explicit_values(self):
        contract = self.contract()
        replies = [subprocess.CompletedProcess([], 0, "fixture-container\n", ""),
                   subprocess.CompletedProcess([], 0, json.dumps(self.inspected_environment()), "")]
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "explicit-model-fixture"}, clear=True), \
                mock.patch.object(dev, "run", side_effect=replies) as runner:
            inherited = dev.existing_runtime_environment(self.args(), contract, self.current(contract))
            self.assertEqual(inherited, {"AI_PLATFORM_URL": "http://127.0.0.1:53001",
                                         "THREAT_ANALYSIS_MCP_TOKEN": "previous-group-fixture"})
            self.assertIn("-a", runner.call_args_list[0].args[0])
            self.assertIn(f"label=com.docker.compose.project={dev.project_name('environment-probe')}",
                          runner.call_args_list[0].args[0])
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "explicit-model-fixture")
            self.assertNotIn("UNDECLARED_VALUE", os.environ)

    def test_explicit_empty_values_are_not_silently_restored(self):
        contract = self.contract()
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "", "AI_PLATFORM_URL": "", "THREAT_ANALYSIS_MCP_TOKEN": ""}, clear=True), \
                mock.patch.object(dev, "run") as runner, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(dev.existing_runtime_environment(self.args(), contract, self.current(contract)), {})
            with self.assertRaises(SystemExit):
                dev.check_environment(contract)
            runner.assert_not_called()

    def test_new_instance_and_different_source_never_borrow_existing_values(self):
        contract = self.contract()
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(dev, "run") as runner, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(dev.existing_runtime_environment(self.args(), contract, None), {})
            other = dict(contract, source_id="experiment:EXP-another-agent-001-r0123456789ab")
            with self.assertRaises(SystemExit):
                dev.existing_runtime_environment(self.args(), other, self.current(contract))
            runner.assert_not_called()

    def test_unavailable_or_ambiguous_container_fails_without_printing_values(self):
        contract = self.contract()
        cases = [
            [subprocess.CompletedProcess([], 1, "", "fixture-sensitive-detail")],
            [subprocess.CompletedProcess([], 0, "container-a\ncontainer-b\n", "")],
            [subprocess.CompletedProcess([], 0, "container-a\n", ""),
             subprocess.CompletedProcess([], 0, "fixture-sensitive-detail", "")],
        ]
        for replies in cases:
            stderr = io.StringIO()
            with self.subTest(replies=len(replies)), mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(dev, "run", side_effect=replies), contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit):
                    dev.existing_runtime_environment(self.args(), contract, self.current(contract))
            self.assertNotIn("fixture-sensitive-detail", stderr.getvalue())

    def test_replace_restores_before_preflight_and_only_keeps_names_in_state(self):
        contract = self.contract()
        image = {"image_tag": IMAGE_TAG, "image_id": "sha256:" + "1" * 64,
                 "image_ref": IMAGE_TAG + "@sha256:" + "1" * 64,
                 "image_build_fingerprint": "sha256:" + "2" * 64, "platform": "linux/amd64"}
        order, passed_environments = [], []

        def run(command, **options):
            if command[:3] == ["docker", "ps", "-a"]:
                return subprocess.CompletedProcess(command, 0, "fixture-container\n", "")
            if command[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(command, 0, json.dumps(self.inspected_environment()), "")
            if command[0] == "node":
                return subprocess.CompletedProcess(command, 0, command[-1] + "\n", "")
            passed_environments.append(options["env"])
            return subprocess.CompletedProcess(command, 0, "", "")

        def preflight(*_args):
            order.append("preflight")
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "explicit-model-fixture")
            self.assertEqual(os.environ["THREAT_ANALYSIS_MCP_TOKEN"], "previous-group-fixture")
            self.assertNotIn("UNDECLARED_VALUE", os.environ)

        stdout, stderr = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(dev, "STATE_ROOT", Path(directory)), \
                mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "explicit-model-fixture"}, clear=True), \
                mock.patch.object(dev, "prepare_up", return_value=(contract, self.current(contract))), \
                mock.patch.object(dev, "validate_image_identity", return_value=image), \
                mock.patch.object(dev, "preflight_new_instance", side_effect=preflight), \
                mock.patch.object(dev, "migrate_existing_instance", side_effect=lambda *_: order.append("stop")), \
                mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "run", side_effect=run), \
                mock.patch.object(dev, "wait_for_instance_listener", return_value=True), \
                mock.patch.object(dev, "wait_for_service", return_value=[{"name": "environment-probe", "service": "dsh", "state": "running"}]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            dev.command_up(self.args())
            self.assertEqual(order, ["preflight", "stop"])
            self.assertEqual(len(passed_environments), 2)
            self.assertTrue(all(value["DEEPSEEK_API_KEY"] == "explicit-model-fixture" and
                                value["THREAT_ANALYSIS_MCP_TOKEN"] == "previous-group-fixture"
                                for value in passed_environments))
            persisted = "\n".join(path.read_text() for path in (Path(directory) / "environment-probe").iterdir() if path.is_file())
            self.assertIn("THREAT_ANALYSIS_MCP_TOKEN", persisted)
            for marker in ["previous-model-fixture", "explicit-model-fixture", "previous-group-fixture", "unrelated-fixture"]:
                self.assertNotIn(marker, persisted + stdout.getvalue() + stderr.getvalue())
            self.assertNotIn("THREAT_ANALYSIS_MCP_TOKEN", os.environ)
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "explicit-model-fixture")

    def test_environment_inspection_failure_does_not_reach_stop_or_state_write(self):
        contract = self.contract()
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(dev, "prepare_up", return_value=(contract, self.current(contract))), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 1, "", "")), \
                mock.patch.object(dev, "preflight_new_instance") as preflight, \
                mock.patch.object(dev, "migrate_existing_instance") as stop, \
                mock.patch.object(dev, "write_instance") as write, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args())
            preflight.assert_not_called()
            stop.assert_not_called()
            write.assert_not_called()


class UpCommandStateTest(unittest.TestCase):
    """`up` 必须核对服务真的在运行，而不是只看 `docker compose up -d` 的退出码。"""

    def setUp(self):
        isolate_registration_guard(self)
        self._temp = tempfile.TemporaryDirectory()
        dev.STATE_ROOT = Path(self._temp.name)
        selected = {"provider": "deepseek-official", "model": "deepseek-flash"}
        policy = dev._model_policy({"agent_id": "security-operations-expert", "allowed": [selected],
                                    "default": selected}, "security-operations-expert",
                                   source="business-config", manifest_sha256=None)
        self._policy_reader = mock.patch.object(dev, "read_model_policy", return_value=policy)
        self._policy_reader.start()
        self._policy_check = mock.patch.object(dev, "assert_model_policy_current")
        self._policy_check.start()
        self._image_identity = mock.patch.object(dev, "validate_image_identity", return_value={
            "image_tag": IMAGE_TAG,
            "image_id": "sha256:" + "1" * 64,
            "image_ref": IMAGE_TAG + "@sha256:" + "1" * 64,
            "image_build_fingerprint": "sha256:" + "2" * 64,
            "platform": "linux/amd64",
        })
        self._image_identity.start()

    def tearDown(self):
        self._image_identity.stop()
        self._policy_check.stop()
        self._policy_reader.stop()
        self._temp.cleanup()

    def args(self, **overrides):
        base = dict(source="experiment:EXP-security-operations-expert-001",
                    mode="verification", name="up-probe", port=3212,
                    allow_missing_env=False, replace=False)
        base.update(overrides)
        return types.SimpleNamespace(**base)

    def test_up_reports_failure_when_dsh_service_is_not_running(self):
        exited = subprocess.CompletedProcess(
            [], 0,
            stdout="abc123\texited\tExited (1) 2 seconds ago\tdsh-dev-up-probe-dsh-1\tdsh\n", stderr="")
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "check_environment"), \
                mock.patch.object(dev, "compose_env", return_value={}), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")), \
                mock.patch.object(dev, "wait_for_instance_listener", return_value=True), \
                mock.patch.object(dev, "wait_for_service", return_value=[{
                    "id": "abc123", "state": "exited", "status": "Exited (1)",
                    "name": "up-probe", "service": "dsh"}]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args())
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn('"dsh_running": false', stderr.getvalue())
        self.assertIn("没有进入运行状态", stderr.getvalue())

    def test_up_reports_running_service(self):
        running = subprocess.CompletedProcess(
            [], 0,
            stdout="abc123\trunning\tUp 3 seconds\tdsh-dev-up-probe-dsh-1\tdsh\n"
                   "def456\texited\tExited (0) 3 seconds ago\tdsh-dev-up-probe-home-init-1\thome-init\n",
            stderr="")
        stdout = io.StringIO()
        with mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "check_environment"), \
                mock.patch.object(dev, "compose_env", return_value={}), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")), \
                mock.patch.object(dev, "wait_for_instance_listener", return_value=True), \
                mock.patch.object(dev, "wait_for_service", return_value=[
                    {"id": "abc123", "state": "running", "status": "Up 3 seconds",
                     "name": "up-probe", "service": "dsh"},
                    {"id": "def456", "state": "exited", "status": "Exited (0)",
                     "name": "dsh-dev-up-probe-home-init-1", "service": "home-init"}]), \
                contextlib.redirect_stdout(stdout):
            dev.command_up(self.args())
        report = json.loads(stdout.getvalue())
        self.assertIs(report["dsh_running"], True)
        self.assertEqual(report["container_name"], "up-probe")
        self.assertEqual(report["containers"][0]["name"], "up-probe")
        self.assertEqual([item["service"] for item in report["containers"]], ["dsh", "home-init"])

    def test_up_reports_unknown_when_state_cannot_be_queried(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "check_environment"), \
                mock.patch.object(dev, "compose_env", return_value={}), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")), \
                mock.patch.object(dev, "wait_for_service", return_value=None), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args())
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn('"dsh_running": "unknown"', stderr.getvalue())


class LegacyInstanceStateTest(unittest.TestCase):
    """旧版状态文件必须仍能停止、查询与迁移，不能把新版升级变成死循环。"""

    LEGACY_1_0 = {
        "schema_version": "1.0",
        "name": "legacy",
        "project": "dsh-dev-legacy",
        "source_id": "experiment:EXP-security-operations-expert-001",
        "source_kind": "experiment",
        "mode": "authoring",
        "purpose": "dev",
        "preset_default": "cordis",
        "port": 3301,
        "image_tag": IMAGE_TAG,
        "agent_id": "security-operations-expert",
        "mounts": {"workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": "/tmp/managed"},
        "context_mounts": [{"key": "reference", "host": "/tmp/reference", "container": "/work/reference", "mode": "ro"}],
        "mount_modes": {"workspace": "rw", "presets": "ro", "managed": "ro"},
        "patch_overlay": "/opt/dsh-managed/x.development.patch.yml",
        "cordis_trust_accepted": True,
        "required_env_names": [],
    }

    def setUp(self):
        isolate_registration_guard(self)
        self._temp = tempfile.TemporaryDirectory()
        dev.STATE_ROOT = Path(self._temp.name)
        self._repo = mock.patch.object(dev, "REPO", Path(self._temp.name))
        self._repo.start()
        target = dev.STATE_ROOT / "legacy"
        target.mkdir(parents=True)
        (target / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (target / "instance.json").write_text(
            json.dumps(self.LEGACY_1_0, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def tearDown(self):
        self._repo.stop()
        self._temp.cleanup()

    def test_legacy_state_builds_compose_env_without_guessing(self):
        """回归：旧状态缺少 adapter_root/managed_patch 时不报错，缺的字段交给 Compose 报。"""
        environment = dev.instance_compose_env(self.LEGACY_1_0)
        self.assertEqual(environment["DSH_IMAGE_TAG"], IMAGE_TAG)
        self.assertEqual(environment["DSH_ADAPTER_HOST"], str(ADAPTER))
        self.assertEqual(environment["DSH_WORKSPACE_HOST"], "/tmp/ws")
        self.assertEqual(environment["DSH_REFERENCE_HOST"], "/tmp/reference")
        # 记录里没有 managed_patch，就不猜一个路径出来。
        self.assertNotIn("DSH_MANAGED_PATCH", environment)

    def test_legacy_instance_can_be_stopped(self):
        """回归：旧状态实例必须能被 down 停掉，否则用户会卡在"拒绝旧状态 + 端口被占"。"""
        stopped = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        empty = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        volume = subprocess.CompletedProcess([], 0, stdout="dsh-dev-legacy-home\n", stderr="")
        stdout = io.StringIO()
        with mock.patch.object(dev, "run", side_effect=[stopped, empty, volume]), \
                contextlib.redirect_stdout(stdout):
            dev.command_down(types.SimpleNamespace(name="legacy"))
        report = json.loads(stdout.getvalue())
        self.assertTrue(report["stopped"])
        self.assertTrue(report["home_preserved"])

    def test_ps_marks_legacy_state_for_migration_and_keeps_listing(self):
        listed = subprocess.CompletedProcess([], 0, stdout=json.dumps({
            "projects": {"dsh-dev-legacy": [{"Name": "dsh-dev-legacy-dsh-1", "Service": "dsh", "State": "exited", "Status": "Exited (0)",
                "ConfigFiles": str(dev.STATE_ROOT / "legacy/compose.yaml"), "WorkingDir": str(dev.STATE_ROOT / "legacy")}]}, "homes": {},
        }), stderr="")
        stdout = io.StringIO()
        with mock.patch.object(dev, "run", return_value=listed), \
                contextlib.redirect_stdout(stdout):
            dev.command_ps(types.SimpleNamespace(all=True))
        instances = json.loads(stdout.getvalue())["instances"]
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0]["state_schema"], "1.0")
        self.assertTrue(instances[0]["needs_migration"])
        self.assertEqual(instances[0]["container_name"], "dsh-dev-legacy-dsh-1")

    def test_ps_reports_broken_record_without_aborting_the_list(self):
        (dev.STATE_ROOT / "broken").mkdir()
        (dev.STATE_ROOT / "broken" / "instance.json").write_text("{not json", encoding="utf-8")
        (dev.STATE_ROOT / "wrong-root").mkdir()
        (dev.STATE_ROOT / "wrong-root" / "instance.json").write_text("[]\n", encoding="utf-8")
        stopped = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        listed = subprocess.CompletedProcess([], 0, stdout="not running", stderr="")
        stdout = io.StringIO()
        with mock.patch.object(dev, "run", return_value=listed), \
                contextlib.redirect_stdout(stdout):
            dev.command_ps(types.SimpleNamespace(all=True))
        instances = {item["name"]: item for item in json.loads(stdout.getvalue())["instances"]}
        self.assertNotIn("broken", instances)
        self.assertNotIn("wrong-root", instances)
        self.assertEqual(json.loads(stdout.getvalue())["unowned_record_count"], 2)
        self.assertIn("legacy", instances)


class UpPortOwnershipTest(unittest.TestCase):
    """端口归属决定出路：本实例自身占用可重载，其他占用者只能换端口。"""

    def setUp(self):
        isolate_registration_guard(self)
        self._temp = tempfile.TemporaryDirectory()
        dev.STATE_ROOT = Path(self._temp.name)
        self._managed = Path(self._temp.name) / "managed"
        self._managed.mkdir()
        (self._managed / "security-operations-expert.patch.yml").write_text(
            "- id: agent-default-model\n  config:\n    provider: local-qwen\n    model: Qwen3.8-27B\n"
            "- id: llm-pi-ai\n  config:\n    providers:\n      local-qwen:\n"
            "        models:\n          - id: Qwen3.8-27B\n",
            encoding="utf-8",
        )
        # 本组只验证端口与重载顺序，使用已登记的实例模型，避免依赖数据根的模型设置。
        self._model_policy = dev._model_policy({
            "agent_id": "security-operations-expert",
            "allowed": [{"provider": "local-qwen", "model": "Qwen3.8-27B"}],
            "default": {"provider": "local-qwen", "model": "Qwen3.8-27B"},
        }, "security-operations-expert", source="business-config", manifest_sha256=None)
        self._policy_reader = mock.patch.object(dev, "read_model_policy", return_value=self._model_policy)
        self._policy_reader.start()
        self._policy_check = mock.patch.object(dev, "assert_model_policy_current")
        self._policy_check.start()
        self._image_identity = mock.patch.object(dev, "validate_image_identity", return_value={
            "image_tag": IMAGE_TAG,
            "image_id": "sha256:" + "1" * 64,
            "image_ref": IMAGE_TAG + "@sha256:" + "1" * 64,
            "image_build_fingerprint": "sha256:" + "2" * 64,
            "platform": "linux/amd64",
        })
        self._image_identity.start()

    def tearDown(self):
        self._image_identity.stop()
        self._policy_check.stop()
        self._policy_reader.stop()
        self._temp.cleanup()

    def contract(self):
        return {
            "source_id": "experiment:EXP-security-operations-expert-001",
            "source_kind": "experiment",
            "agent_id": "security-operations-expert",
            "preset_id": "security-operations-expert",
            "workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": str(self._managed),
            "patch": "/opt/dsh-managed/security-operations-expert.patch.yml",
            "required_env_names": [],
            "image": {"local_image_tag": IMAGE_TAG},
        }

    def args(self, **overrides):
        base = dict(source="experiment:EXP-security-operations-expert-001", mode="verification",
                    name="probe", port=3302, allow_missing_env=True,
                    replace=False)
        base.update(overrides)
        return types.SimpleNamespace(**base)

    def write_existing(self, name="probe", **overrides):
        dev.STATE_ROOT.mkdir(parents=True, exist_ok=True)
        target = dev.STATE_ROOT / name
        target.mkdir(exist_ok=True)
        manifest = dict(self.contract(), schema_version="1.2", name=name, asset_root=str(dev.REPO),
                        project=dev.project_name(name), mode="verification", purpose="eval",
                        target_preset="security-operations-expert", port=3302,
                        image_tag=IMAGE_TAG,
                        adapter_root=str(ADAPTER),
                        managed_patch="/opt/dsh-managed/security-operations-expert.patch.yml",
                        model_policy={"default": {"provider": "local-qwen", "model": "Qwen3.8-27B"}},
                        mounts={"workspace": "/tmp/ws", "presets": "/tmp/presets", "managed": "/tmp/managed"},
                        context_mounts=[], patch_overlay=None)
        manifest.update(overrides)
        (target / "instance.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_dry_run_generates_name_and_port_without_starting(self):
        args = self.args(name=None, port=None, dry_run=True)
        stdout = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "preflight_new_instance") as preflight, \
                mock.patch.object(dev, "write_instance") as writer, \
                mock.patch.object(dev, "run") as runner, \
                contextlib.redirect_stdout(stdout):
            dev.command_up(args)
        plan = json.loads(stdout.getvalue())
        self.assertEqual(plan["name"], "security-operations-expert-eval")
        self.assertEqual(plan["container_name"], "security-operations-expert-eval")
        self.assertEqual(plan["port"], 18500)
        self.assertEqual(plan["listen_host"], "0.0.0.0")
        for flag in ("lan_access", "unsafe_no_auth", "skip_testing_notice"):
            self.assertTrue(plan[flag])
        preflight.assert_not_called()
        writer.assert_not_called()
        runner.assert_not_called()

    def test_auto_port_skips_instance_records_and_listeners(self):
        self.write_existing(port=18500)
        with mock.patch.object(dev, "port_in_use", side_effect=lambda port: port == 18501):
            self.assertEqual(dev.first_available_port("new-probe"), 18502)

    def test_auto_port_stays_within_business_instance_range(self):
        with mock.patch.object(dev, "AUTO_PORT_START", 28998), mock.patch.object(dev, "AUTO_PORT_END", 28999), \
             mock.patch.object(dev, "reserved_instance_ports", return_value={28998}), \
             mock.patch.object(dev, "port_in_use", return_value=True):
            with self.assertRaises(SystemExit):
                dev.first_available_port("new-probe")

    def test_existing_default_name_reuses_recorded_port(self):
        name = "security-operations-expert-eval"
        self.write_existing(name=name, port=3090)
        args = self.args(name=None, port=None)
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "port_in_use") as probe:
            _, current = dev.prepare_up(args)
        self.assertIsNotNone(current)
        self.assertEqual(args.name, name)
        self.assertEqual(args.port, 3090)
        probe.assert_not_called()

    def test_pending_business_start_restores_recorded_modes_and_preserves_session_home(self):
        home = dev.STATE_ROOT / "probe/dsh-home"
        home.mkdir(parents=True)
        session = home / "session.v4.jsonl"
        session.write_text("retained-session-bytes", encoding="utf-8")
        self.write_existing(business_control={"runtime_generation": "generation", "access_mode": "anonymous", "identity_mode": "development"}, home_directory=str(home))
        helper = mock.Mock(return_value={"assetRoot": str(dev.REPO), "sourceDigest": "sha256:fixed", "development": True, "accessMode": "anonymous", "registered": False})
        with mock.patch.object(dev, "resolve", return_value=self.contract()), mock.patch.object(dev, "business_helper", helper):
            contract, current = dev.prepare_up(self.args(business_control="/fixture/launch.json"))
        self.assertIsNotNone(current)
        self.assertEqual(helper.call_args.args[1]["startupModes"], {"access_mode": "anonymous", "identity_mode": "development"})
        self.assertEqual(contract["business_control"]["access_mode"], "anonymous")
        self.assertEqual(contract["business_control"]["identity_mode"], "development")
        self.assertEqual(session.read_text(encoding="utf-8"), "retained-session-bytes")

    def test_legacy_unregistered_business_requires_explicit_modes_and_no_home_files(self):
        home = dev.STATE_ROOT / "probe/dsh-home/profiles/web"
        home.mkdir(parents=True)
        self.write_existing(business_control={"runtime_generation": "generation"}, home_directory=str(home.parents[1]))
        helper = mock.Mock(return_value={"assetRoot": str(dev.REPO), "sourceDigest": "sha256:fixed", "development": True, "accessMode": "anonymous", "registered": False})
        with mock.patch.object(dev, "resolve", return_value=self.contract()), mock.patch.object(dev, "business_helper", helper):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.prepare_up(self.args(business_control="/fixture/launch.json"))
            contract, _ = dev.prepare_up(self.args(business_control="/fixture/launch.json", business_access_mode="anonymous", business_identity_mode="development"))
            self.assertEqual(contract["business_control"]["access_mode"], "anonymous")
            retained = home / "retained-session.json"
            retained.write_text("do-not-expose-or-replace", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.prepare_up(self.args(business_control="/fixture/launch.json", business_access_mode="anonymous", business_identity_mode="development"))
            self.assertEqual(retained.read_text(encoding="utf-8"), "do-not-expose-or-replace")
            for kind in ("file", "symlink"):
                name = "invalid-home-" + kind
                invalid = dev.STATE_ROOT / name / "dsh-home"
                self.write_existing(name=name, business_control={"runtime_generation": "generation"}, home_directory=str(invalid))
                if kind == "file":
                    invalid.write_text("retained-home-file", encoding="utf-8")
                else:
                    invalid.symlink_to(self._managed, target_is_directory=True)
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    dev.prepare_up(self.args(name=name, business_control="/fixture/launch.json", business_access_mode="anonymous", business_identity_mode="development"))
                self.assertTrue(invalid.is_symlink() if kind == "symlink" else invalid.read_text(encoding="utf-8") == "retained-home-file")

    def test_direct_start_rejects_unprojected_business_default_before_port_selection(self):
        selected = {"provider": "xiaomi-token-plan-cn", "model": "MiMo-V2.6-Flash"}
        policy = dev._model_policy({"agent_id": "security-operations-expert", "allowed": [selected],
                                    "default": selected}, "security-operations-expert",
                                   source="business-config", manifest_sha256=None)
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "read_model_policy", return_value=policy), \
                mock.patch.object(dev, "port_in_use") as probe, \
                contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args(port=None))
        self.assertIn("--model-policy", error.getvalue())
        probe.assert_not_called()

    def test_existing_instance_without_registered_default_requires_explicit_selection(self):
        self.write_existing(model_policy=None)
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args())
        self.assertIn("未登记默认模型", error.getvalue())
        with mock.patch.object(dev, "resolve", return_value=self.contract()):
            contract, _ = dev.prepare_up(self.args(model_policy="/tmp/explicit-policy.json"))
        self.assertEqual(contract["model_policy"]["default"]["model"], "Qwen3.8-27B")
        without_default = dict(self._model_policy, default=None)
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "read_model_policy", return_value=without_default), \
                contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args(model_policy="/tmp/empty-policy.json"))
        self.assertIn("必须包含显式选择", error.getvalue())

    def test_platform_managed_instance_requires_current_policy_for_direct_restart(self):
        self.write_existing(model_policy={
            "source": "platform", "default": {"provider": "local-qwen", "model": "Qwen3.8-27B"}
        })
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args(replace=True))
        self.assertIn("请从平台实例管理启动", error.getvalue())
        with mock.patch.object(dev, "resolve", return_value=self.contract()):
            contract, _ = dev.prepare_up(self.args(replace=True, model_policy="/tmp/current-policy.json"))
        self.assertEqual(contract["model_policy"]["default"]["model"], "Qwen3.8-27B")

    def test_old_business_instances_apply_uniform_access_without_replace(self):
        for replace in (False, True):
            for old_flags in ({}, dict(lan_access=False, unsafe_no_auth=False, skip_testing_notice=False)):
                with self.subTest(replace=replace, old_flags=old_flags):
                    self.write_existing(**old_flags)
                    args = self.args(port=None, replace=replace, lan_access=False,
                                     unsafe_no_auth=False, skip_testing_notice=False)
                    with mock.patch.object(dev, "resolve", return_value=self.contract()):
                        _, current = dev.prepare_up(args)
                    self.assertIsNotNone(current)
                    self.assertEqual(args.port, 3302)
                    for flag in ("lan_access", "unsafe_no_auth", "skip_testing_notice"):
                        self.assertTrue(getattr(args, flag))
                    self.assertEqual(json.loads((current[0] / "instance.json").read_text()), current[1])

    def test_analysis_worker_keeps_internal_access_and_rejects_public_flags(self):
        workspace = "/tmp/analysis-run"
        with mock.patch.object(dev, "validate_analysis_workspace", return_value=workspace), \
                mock.patch.object(dev, "resolve", return_value=self.contract()):
            args = self.args(name="new-analysis", analysis_workspace=workspace)
            dev.prepare_up(args)
            for flag in ("lan_access", "unsafe_no_auth", "skip_testing_notice"):
                self.assertFalse(getattr(args, flag))
            for flag in ("lan_access", "unsafe_no_auth"):
                with self.subTest(flag=flag), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    dev.prepare_up(self.args(analysis_workspace=workspace, **{flag: True}))

    def test_auto_port_race_fails_without_silent_reselection(self):
        args = self.args(name="new-probe", port=None)
        stdout = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "port_in_use", side_effect=[False, True]), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "project_containers", return_value=[]), \
                mock.patch.object(dev, "running_instance_service", return_value=None), \
                mock.patch.object(dev, "write_instance") as writer, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                dev.command_up(args)
        self.assertEqual(args.port, 18500)
        self.assertEqual(stdout.getvalue(), "")
        writer.assert_not_called()

    def test_own_instance_holding_the_port_gets_an_actionable_error(self):
        self.write_existing()
        stderr = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "port_in_use", return_value=True), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "running_instance_service", return_value="dsh"), \
                mock.patch.object(dev, "write_instance") as writer, \
                contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args())
        message = stderr.getvalue()
        self.assertIn("--replace", message)
        self.assertIn("down", message)
        writer.assert_not_called()

    def test_other_holder_keeps_the_plain_port_error(self):
        stderr = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "port_in_use", return_value=True), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "project_containers", return_value=[]), \
                mock.patch.object(dev, "running_instance_service", return_value=None), \
                contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args())
        self.assertIn("已被占用", stderr.getvalue())

    def test_replace_rejects_mode_conflict_before_stopping(self):
        self.write_existing(mode="verification")
        stopper = mock.Mock()
        stderr = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "stop_instance", stopper), \
                mock.patch.object(dev, "preflight_new_instance") as preflight, \
                contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args(replace=True, mode="unsupported"))
        self.assertIn("来源/模式不同", stderr.getvalue())
        stopper.assert_not_called()
        preflight.assert_not_called()

    def test_replace_rejects_source_conflict_before_stopping(self):
        self.write_existing()
        other = dict(self.contract(), source_id="experiment:EXP-other-agent-001")
        stopper = mock.Mock()
        stderr = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=other), \
                mock.patch.object(dev, "stop_instance", stopper), \
                mock.patch.object(dev, "preflight_new_instance") as preflight, \
                contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args(replace=True, source="experiment:EXP-other-agent-001"))
        self.assertIn("来源/模式不同", stderr.getvalue())
        stopper.assert_not_called()
        preflight.assert_not_called()

    def test_replace_preflights_new_config_before_stopping(self):
        self.write_existing()
        order = []
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "preflight_new_instance", side_effect=lambda *_: order.append("preflight")), \
                mock.patch.object(dev, "migrate_existing_instance",
                                  side_effect=lambda *_: order.append("stop") or {"previous_state_schema": "1.2"}), \
                mock.patch.object(dev, "port_in_use", side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args(replace=True))
        self.assertEqual(order, ["preflight", "stop"])

    def test_replace_stops_own_instance_before_starting(self):
        self.write_existing()
        order = []
        stdout = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "migrate_existing_instance",
                                  side_effect=lambda *_: order.append("stop") or {
                                      "previous_state_schema": "1.2", "stop": {"stopped": True}}), \
                mock.patch.object(dev, "port_in_use", return_value=False), \
                mock.patch.object(dev, "preflight_new_instance"), \
                mock.patch.object(dev, "write_instance",
                                  side_effect=lambda *a, **k: order.append("write") or dev.STATE_ROOT / "probe"), \
                mock.patch.object(dev, "compose_env", return_value={}), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")), \
                mock.patch.object(dev, "wait_for_instance_listener", return_value=True), \
                mock.patch.object(dev, "wait_for_service", return_value=[{
                    "id": "abc", "state": "running", "status": "Up", "name": "x-dsh-1", "service": "dsh"}]), \
                contextlib.redirect_stdout(stdout):
            dev.command_up(self.args(replace=True))
        self.assertEqual(order, ["stop", "write"])
        report = json.loads(stdout.getvalue())
        self.assertEqual(report["replaced"], {
            "previous_state_schema": "1.2", "stop": {"stopped": True}})
        self.assertEqual(report["session_preset"], "security-operations-expert")
        self.assertEqual(report["target_preset"], "security-operations-expert")

    def test_replace_refuses_to_change_the_recorded_port(self):
        self.write_existing(port=3399)
        stderr = io.StringIO()
        with mock.patch.object(dev, "resolve", return_value=self.contract()), \
                mock.patch.object(dev, "stop_instance") as stopper, \
                contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                dev.command_up(self.args(replace=True, port=3302))
        self.assertIn("不得改端口", stderr.getvalue())
        stopper.assert_not_called()

    def test_replace_result_nests_stop_report(self):
        self.write_existing()
        stopped = {"name": "probe", "stopped": True, "home_preserved": True}
        with mock.patch.object(dev, "stop_instance", return_value=stopped):
            result = dev.migrate_existing_instance(self.args(replace=True), self.contract())
        self.assertEqual(result, {"previous_state_schema": "1.2", "stop": stopped})


class CliSurfaceTest(unittest.TestCase):
    def test_root_help_lists_init_and_not_plan(self):
        completed = subprocess.run(
            [sys.executable, str(ADAPTER / "dsh-dev"), "--help"],
            capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("init", completed.stdout)
        self.assertNotIn("  plan", completed.stdout)

    def test_source_help_lists_only_supported_selectors(self):
        completed = subprocess.run(
            [sys.executable, str(ADAPTER / "dsh-dev"), "up", "--help"],
            capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("experiment:<id>", completed.stdout)
        self.assertNotIn("snapshot:", completed.stdout)
        self.assertNotIn("authoring", completed.stdout)
        self.assertNotIn("verification", completed.stdout)

    def test_plan_command_is_removed(self):
        completed = subprocess.run(
            [sys.executable, str(ADAPTER / "dsh-dev"), "plan", "--help"],
            capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("invalid choice", completed.stderr)

    def test_missing_source_and_mode_list_registered_values(self):
        completed = subprocess.run(
            [sys.executable, str(ADAPTER / "dsh-dev"), "up", "--source", "--mode"],
            capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        self.assertIn("experiment:EXP-security-operations-expert-024-rad80a907c628", completed.stderr)
        self.assertIn("可用 --mode：eval", completed.stderr)

    def test_up_help_documents_replace(self):
        completed = subprocess.run(
            [sys.executable, str(ADAPTER / "dsh-dev"), "up", "--help"],
            capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--replace", completed.stdout)
        self.assertIn("--dry-run", completed.stdout)
        self.assertIn("--lan-access", completed.stdout)


class ImageBuildCommandTest(unittest.TestCase):
    def test_image_build_does_not_use_generic_command_timeout(self):
        with mock.patch.object(dev.shutil, "which", return_value="/bin/bash"), \
                mock.patch.object(dev, "run") as runner, \
                contextlib.redirect_stdout(io.StringIO()):
            dev.command_image_build(types.SimpleNamespace(source="EXP-test-001"))
        runner.assert_called_once_with(
            ["bash", str(ADAPTER / "build-image.sh"), "--source", "EXP-test-001"],
            check=True, capture=False, timeout=None)


class UrlCommandGuardTest(unittest.TestCase):
    """`url` 只在交互终端或显式 --non-interactive 下输出 Token URL。"""

    def setUp(self):
        isolate_registration_guard(self)

    def call(self, args, manifest=None):
        stdout = io.StringIO()
        with mock.patch.object(
            dev, "load_instance", return_value=(Path("/tmp"), manifest or {"port": 3081})
        ), \
                contextlib.redirect_stdout(stdout):
            dev.command_url(args)
        return stdout.getvalue()

    def test_non_tty_without_flag_fails_closed(self):
        with self.assertRaises(SystemExit):
            self.call(types.SimpleNamespace(name="soe-verify", non_interactive=False))

    def test_non_tty_with_flag_prints_only_current_url(self):
        logs = mock.Mock(stdout=TOKEN)
        with mock.patch.object(dev, "running_container", return_value=("cid", "2026-01-01T00:00:00Z")), \
                mock.patch.object(dev, "run", return_value=logs), \
                mock.patch.object(dev, "probe_url", return_value={"ok": True, "reason": "token(303)→cookie→root 200"}):
            printed = self.call(types.SimpleNamespace(name="soe-verify", non_interactive=True))
        self.assertIn("http://127.0.0.1:3081/?token=secret-token-value", printed)

    def test_prefixed_token_url_preserves_the_instance_base_path(self):
        logs = mock.Mock(stdout=TOKEN.replace("/?token=", "/assistant/?token="))
        with mock.patch.object(dev, "running_container", return_value=("cid", "started")), \
                mock.patch.object(dev, "run", return_value=logs), \
                mock.patch.object(dev, "probe_url", return_value={"ok": True}) as probe:
            printed = self.call(
                types.SimpleNamespace(name="soe-verify", non_interactive=True),
                {"port": 3081, "web_base_path": "/assistant/"},
            )
        expected = "http://127.0.0.1:3081/assistant/?token=secret-token-value"
        self.assertEqual(printed, expected + "\n")
        probe.assert_called_once_with(expected, 3081)
        self.assertIsNone(dev.extract_auth_url(TOKEN, 3081, "/assistant/"))

    def test_cold_start_waits_for_current_process_url(self):
        logs = [mock.Mock(stdout=""), mock.Mock(stdout=TOKEN)]
        with mock.patch.object(dev, "running_container", return_value=("cid", "2026-01-01T00:00:00Z")), \
                mock.patch.object(dev, "run", side_effect=logs), \
                mock.patch.object(dev, "probe_url", return_value={"ok": True, "reason": "token(303)→cookie→root 200"}), \
                mock.patch.object(dev.time, "sleep") as sleeper:
            printed = self.call(types.SimpleNamespace(name="soe-verify", non_interactive=True))
        self.assertIn("http://127.0.0.1:3081/?token=secret-token-value", printed)
        sleeper.assert_called_once_with(1.0)

    def test_lan_web_profile_uses_token_url(self):
        logs = mock.Mock(stdout=TOKEN)
        with mock.patch.object(dev, "running_container", return_value=("cid", "2026-01-01T00:00:00Z")), \
                mock.patch.object(dev, "run", return_value=logs), \
                mock.patch.object(dev, "probe_url", return_value={"ok": True, "reason": "token→cookie→root 200"}):
            printed = self.call(
                types.SimpleNamespace(name="soe-verify", non_interactive=True),
                {"port": 3081, "lan_access": True, "profile": "web"},
            )
        self.assertIn("?token=secret-token-value", printed)

    def test_legacy_password_profile_prints_non_secret_url_without_tty_flag(self):
        with mock.patch.object(dev, "running_container", return_value=("cid", "started")), \
                mock.patch.object(dev, "probe_login_url",
                                  return_value={"ok": True, "reason": "root 302→login 200"}):
            printed = self.call(
                types.SimpleNamespace(name="soe-verify", non_interactive=False),
                {"port": 3154, "lan_access": True, "profile": "web-lan"},
            )
        self.assertEqual(printed, "http://127.0.0.1:3154/\n")

    def test_no_auth_mode_prints_clean_url_without_tty_flag_or_log_token(self):
        with mock.patch.object(dev, "running_container", return_value=("cid", "started")), \
                mock.patch.object(dev, "probe_no_auth_url",
                                  return_value={"ok": True, "reason": "root 200"}), \
                mock.patch.object(dev, "run") as runner:
            printed = self.call(
                types.SimpleNamespace(name="soe-verify", non_interactive=False),
                {"port": 13181, "profile": "web", "unsafe_no_auth": True},
            )
        self.assertEqual(printed, "http://127.0.0.1:13181/\n")
        runner.assert_not_called()

    def test_prefixed_no_auth_mode_reports_and_probes_the_site_path(self):
        with mock.patch.object(dev, "running_container", return_value=("cid", "started")), \
                mock.patch.object(dev, "probe_no_auth_url", return_value={"ok": True}) as probe:
            printed = self.call(
                types.SimpleNamespace(name="soe-verify", non_interactive=False),
                {"port": 13181, "unsafe_no_auth": True, "web_base_path": "/assistant/"},
            )
        self.assertEqual(printed, "http://127.0.0.1:13181/assistant/\n")
        probe.assert_called_once_with(13181, "/assistant/")


class PortProbeTest(unittest.TestCase):
    def test_detects_open_and_closed_port(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            self.assertTrue(dev.port_in_use(port))
        self.assertFalse(dev.port_in_use(port))

    def test_detects_listener_outside_primary_loopback_address(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.2", 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertTrue(dev.port_in_use(port))
            with mock.patch.object(dev, "reserved_instance_ports", return_value=set()), \
                    mock.patch.object(dev, "AUTO_PORT_START", port), \
                    mock.patch.object(dev, "AUTO_PORT_END", 65535):
                self.assertGreater(dev.first_available_port("lan-probe"), port)

    def test_bind_errors_are_not_reported_as_an_available_port(self):
        with mock.patch.object(socket.socket, "bind", side_effect=PermissionError("test bind denied")):
            with self.assertRaises(PermissionError):
                dev.port_in_use(3081)


class ConcurrentStartupTest(unittest.TestCase):
    def test_separate_data_roots_serialize_selection_until_socket_is_owned(self):
        """独立进程执行真实 command_up；仅 Docker/来源边界替换为实际 TCP 监听。"""
        script = r'''
import contextlib, importlib.util, io, json, socket, sys, time, types
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock
adapter, directory, name, port = sys.argv[1:]
spec = importlib.util.spec_from_loader('startup_probe', SourceFileLoader('startup_probe', str(Path(adapter) / 'dsh-dev')))
dev = importlib.util.module_from_spec(spec); spec.loader.exec_module(dev)
base = Path(directory); dev.REPO = base / name; dev.REPO.mkdir()
dev.STATE_ROOT = dev.REPO / 'instances'
(dev.REPO / 'config').mkdir()
(dev.REPO / 'config/sites.json').write_text(json.dumps({'assistant':'/assistant/'}))
dev.STARTUP_LOCK = base / 'startup.lock'; dev.AUTO_PORT_START = int(port); dev.AUTO_PORT_END = int(port) + 1
contract = {'source_id':'experiment:EXP-fixture-001','source_kind':'experiment','agent_id':'fixture',
 'preset_id':'fixture','workspace':'/tmp/ws','presets':'/tmp/presets','managed':'/tmp/managed',
 'patch':'/opt/managed/fixture.patch.yml','required_env_names':[], 'image':{'local_image_tag':'fixture'}}
selected = {'provider':'deepseek-official','model':'deepseek-flash'}
policy = dev._model_policy({'agent_id':'fixture','allowed':[selected],'default':selected},
 'fixture',source='business-config',manifest_sha256=None)
listener = None
def write_instance(name, **kwargs):
 target = dev.STATE_ROOT / name; target.mkdir(parents=True)
 (target / 'instance.json').write_text(json.dumps({'port':kwargs['port']}))
 return target
def docker(command, **kwargs):
 global listener
 if 'up' in command:
  time.sleep(.25)
  listener = socket.socket(); listener.bind(('127.0.0.1', args.port)); listener.listen()
 return types.SimpleNamespace(returncode=0, stdout='', stderr='')
container = [{'id':name,'name':name,'service':'dsh','state':'running'}]
while not (base / 'go').exists(): time.sleep(.01)
args = types.SimpleNamespace(source='experiment:EXP-fixture-001', mode='verification', name=name,
 port=None, allow_missing_env=False, replace=False)
with mock.patch.object(dev, 'resolve', return_value=contract), \
 mock.patch.object(dev, 'read_model_policy', return_value=policy), mock.patch.object(dev, 'assert_model_policy_current'), \
 mock.patch.object(dev, 'require_unused_docker_name'), mock.patch.object(dev, 'require_docker_registration'), \
 mock.patch.object(dev, 'existing_runtime_environment', return_value={}), \
 mock.patch.object(dev, 'check_environment'), mock.patch.object(dev, 'preflight_new_instance'), \
 mock.patch.object(dev, 'migrate_existing_instance', return_value=None), \
 mock.patch.object(dev, 'validate_image_identity', return_value={'image_id':'sha256:'+'1'*64}), \
 mock.patch.object(dev, 'compose_env', return_value={}), mock.patch.object(dev, 'write_instance', side_effect=write_instance), \
 mock.patch.object(dev, 'run', side_effect=docker), mock.patch.object(dev, 'wait_for_service', return_value=container), \
 mock.patch.object(dev, 'load_instance', return_value=(dev.STATE_ROOT / name, {})), \
 mock.patch.object(dev, 'project_containers', return_value=container), \
 mock.patch.object(dev, 'container_owns_listener', side_effect=lambda *_: listener is not None), \
 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
 dev.command_up(args)
(base / (name + '.json')).write_text(json.dumps({'port':args.port, 'listener_owned': listener is not None}))
deadline = time.monotonic() + 5
while len(list(base.glob('*.json'))) < 2 and time.monotonic() < deadline: time.sleep(.02)
listener.close()
'''
        with tempfile.TemporaryDirectory() as directory, socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            start_port = probe.getsockname()[1]
            probe.close()
            processes = [subprocess.Popen([sys.executable, "-c", script, str(ADAPTER), directory, name, str(start_port)],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                         for name in ("first", "second")]
            try:
                (Path(directory) / "go").touch()
                for process in processes:
                    output, error = process.communicate(timeout=15)
                    self.assertEqual(process.returncode, 0, error + output)
                results = [json.loads((Path(directory) / (name + ".json")).read_text()) for name in ("first", "second")]
                self.assertEqual(len({result["port"] for result in results}), 2)
                self.assertTrue(all(result["listener_owned"] for result in results))
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()

    def test_startup_lock_timeout_is_bounded_and_releases_after_process_exit(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(dev, "STARTUP_LOCK", Path(directory) / "startup.lock"):
            script = 'import fcntl,os,sys,time; fd=os.open(sys.argv[1],os.O_RDONLY|os.O_CREAT,0o644); fcntl.flock(fd,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(20)'
            holder = subprocess.Popen([sys.executable, "-c", script, str(dev.STARTUP_LOCK)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(holder.stdout.readline().strip(), "locked")
                started = time.monotonic()
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    with dev.instance_startup_lock(timeout=.05):
                        self.fail("不应进入其它进程持有的启动区间")
                self.assertLess(time.monotonic() - started, 1)
            finally:
                holder.terminate(); holder.wait(timeout=3); holder.stdout.close()
            with dev.instance_startup_lock(timeout=.05):
                pass


class ListenerReadinessTest(unittest.TestCase):
    def test_native_socket_probe_reads_real_owned_descriptor(self):
        """Docker exec 边界替换为本进程命名空间中的 Node，其余探测脚本真实执行。"""
        def execute(command, **kwargs):
            return subprocess.run(command[3:], text=True, capture_output=True, timeout=5)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); listener.listen()
            port = listener.getsockname()[1]
            with mock.patch.object(dev, "run", side_effect=execute):
                self.assertTrue(dev.container_owns_listener("container", port))
                listener.close()
                self.assertFalse(dev.container_owns_listener("container", port))

    def test_foreign_http_service_is_not_ready_without_container_socket(self):
        running = [{"id":"ours", "service":"dsh", "state":"running"}]
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler) as server, \
                mock.patch.object(dev, "load_instance", return_value=(Path("/unused"), {})), \
                mock.patch.object(dev, "require_docker_registration"), \
                mock.patch.object(dev, "project_containers", return_value=running), \
                mock.patch.object(dev, "container_owns_listener", return_value=False) as owned:
            self.assertTrue(dev.port_in_use(server.server_port))
            self.assertFalse(dev.wait_for_instance_listener("ours", server.server_port, timeout=0))
            owned.assert_called_once_with("ours", server.server_port)

    def test_exit_after_listener_probe_is_not_delivered_as_running(self):
        with mock.patch.object(dev, "load_instance", return_value=(Path("/unused"), {})), \
                mock.patch.object(dev, "require_docker_registration"), \
                mock.patch.object(dev, "project_containers", side_effect=[
                    [{"id":"ours", "service":"dsh", "state":"running"}],
                    [{"id":"ours", "service":"dsh", "state":"exited"}]]), \
                mock.patch.object(dev, "container_owns_listener", return_value=True):
            self.assertFalse(dev.wait_for_instance_listener("ours", 3212, timeout=0))


class _AuthStubHandler(http.server.BaseHTTPRequestHandler):
    """模拟 DSH Web 认证入口：token 命中即 303 并下发会话 Cookie。"""

    cookie_value = "session-cookie"
    root_status = 200
    with_token_status = 303
    set_cookie = True
    paths = []

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 约定
        self.paths.append(self.path)
        if "token=" in self.path:
            self.send_response(self.with_token_status)
            if self.set_cookie:
                self.send_header("Set-Cookie", f"dsh-auth-probe={self.cookie_value}; Path=/; HttpOnly")
            self.send_header("Location", "/")
            self.end_headers()
            return
        self.send_response(self.root_status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<html>window.__DSH_BOOT__ = {}</html>")

    def log_message(self, *args):  # 静默测试输出
        return


class AuthUrlProbeTest(unittest.TestCase):
    def setUp(self):
        _AuthStubHandler.paths = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _AuthStubHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_token_redirect_sets_cookie_then_root_boots(self):
        """回归：urllib 默认跟随重定向会把 303 变成 200，必须仍判为通过。"""
        probe = dev.probe_url(f"http://127.0.0.1:{self.port}/?token=abc", self.port)
        self.assertTrue(probe["ok"], probe["reason"])

    def test_prefixed_token_probe_keeps_path_after_cookie_handshake(self):
        probe = dev.probe_url(f"http://127.0.0.1:{self.port}/assistant/?token=abc", self.port)
        self.assertTrue(probe["ok"], probe["reason"])
        self.assertEqual(_AuthStubHandler.paths, ["/assistant/?token=abc", "/assistant/"])

    def test_prefixed_no_auth_probe_keeps_the_site_path(self):
        self.assertTrue(dev.probe_no_auth_url(self.port, "/assistant/")["ok"])
        self.assertEqual(_AuthStubHandler.paths, ["/assistant/"])

    def test_loopback_probe_bypasses_environment_http_proxy(self):
        with mock.patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1",
                                          "HTTP_PROXY": "http://127.0.0.1:1",
                                          "no_proxy": "", "NO_PROXY": ""}):
            self.assertTrue(dev.probe_no_auth_url(self.port, "/assistant/")["ok"])
        self.assertEqual(_AuthStubHandler.paths, ["/assistant/"])

    def test_no_auth_probe_requires_direct_boot_without_cookie(self):
        self.assertTrue(dev.probe_no_auth_url(self.port)["ok"])
        _AuthStubHandler.root_status = 401
        try:
            self.assertFalse(dev.probe_no_auth_url(self.port)["ok"])
        finally:
            _AuthStubHandler.root_status = 200

    def test_missing_cookie_fails_closed(self):
        _AuthStubHandler.set_cookie = False
        try:
            probe = dev.probe_url(f"http://127.0.0.1:{self.port}/?token=abc", self.port)
        finally:
            _AuthStubHandler.set_cookie = True
        self.assertFalse(probe["ok"])
        self.assertIn("Cookie", probe["reason"])

    def test_root_without_boot_marker_fails(self):
        _AuthStubHandler.root_status = 401
        try:
            probe = dev.probe_url(f"http://127.0.0.1:{self.port}/?token=abc", self.port)
        finally:
            _AuthStubHandler.root_status = 200
        self.assertFalse(probe["ok"])
        self.assertIn("401", probe["reason"])


class _LoginGateStubHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 约定
        if self.path.startswith("/auth/login"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'<form action="/auth/login"><input name="username"></form>')
            return
        self.send_response(302)
        self.send_header("Location", "/auth/login?next=%2F")
        self.end_headers()

    def log_message(self, *args):
        return


class PasswordLoginProbeTest(unittest.TestCase):
    def test_unauthenticated_root_redirects_to_password_form(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _LoginGateStubHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            probe = dev.probe_login_url(server.server_address[1])
        finally:
            server.shutdown()
            server.server_close()
        self.assertTrue(probe["ok"], probe["reason"])


class BindHomeMigrationTests(unittest.TestCase):
    def setUp(self):
        isolate_registration_guard(self)

    def test_root_business_patch_is_private_and_owned_by_container_user(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)):
            contract = {
                "source_id": "experiment:EXP-example-agent-001-r0123456789ab", "source_kind": "experiment",
                "agent_id": "example-agent", "workspace": "/tmp/workspace", "presets": "/tmp/presets",
                "managed": "/tmp/managed", "preset_id": "example-agent", "patch": "/opt/dsh-managed/example.patch.yml",
                "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml", "required_env_names": [],
                "image": {"local_image_tag": IMAGE_TAG}, "business_control": {"config_file": "/tmp/business.json"},
            }
            business = {"compose": "", "patch": "{}", "localModelRoutes": {}, "registration": {}}
            with mock.patch.object(os, "geteuid", return_value=0), mock.patch.object(os, "chown") as chown, \
                 mock.patch.object(dev, "render_business_instance", return_value=business):
                target = dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            patch = target / "business.patch.yml"
            self.assertEqual(patch.stat().st_mode & 0o777, 0o600)
            self.assertEqual(chown.call_args_list[-1], mock.call(patch, 1000, 1000))

    def test_old_home_is_not_implicitly_replaced_by_empty_directory(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)):
            current = (Path(temporary) / "probe", {"name": "probe"})
            self.assertIsNone(dev.selected_home_directory("probe", current))
            with self.assertRaises(SystemExit):
                dev.selected_home_directory("probe", current, migrate_home=True)
            directory = current[0] / "dsh-home"
            directory.mkdir(parents=True)
            with self.assertRaises(SystemExit):
                dev.selected_home_directory("probe", current, migrate_home=True)
            (directory / "session-fixture.json").write_text('{}')
            self.assertEqual(dev.selected_home_directory("probe", current, migrate_home=True), str(directory))

    def test_new_instance_bind_home_survives_delete_and_can_be_registered_again(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(dev, "STATE_ROOT", Path(temporary)):
            contract = {
                "source_id": "experiment:EXP-example-agent-001-r0123456789ab", "source_kind": "experiment",
                "agent_id": "example-agent", "workspace": "/tmp/workspace", "presets": "/tmp/presets",
                "managed": "/tmp/managed", "preset_id": "example-agent", "patch": "/opt/dsh-managed/example.patch.yml",
                "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml", "required_env_names": [],
                "image": {"local_image_tag": IMAGE_TAG},
            }
            with mock.patch.object(os, "geteuid", return_value=0), mock.patch.object(os, "chown") as chown:
                target = dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            home = target / "dsh-home"
            self.assertEqual(chown.call_args_list, [mock.call(home / relative, 1000, 1000)
                                                   for relative in ("", "profiles", "profiles/web")])
            manifest = json.loads((target / "instance.json").read_text())
            directory = Path(manifest["home_directory"])
            # 子卷挂载之前父目录必须已由调用用户创建，避免 Docker 以 root 创建它。
            self.assertTrue((directory / "profiles").is_dir())
            self.assertEqual((directory / "profiles").stat().st_uid, directory.stat().st_uid)
            self.assertEqual((directory / "profiles/web").stat().st_uid, directory.stat().st_uid)
            original_mkdir = Path.mkdir
            def inaccessible_profile(path, *args, **kwargs):
                if path == directory / "profiles/web":
                    raise PermissionError("旧失败 HOME 的目录不可写")
                return original_mkdir(path, *args, **kwargs)
            errors = io.StringIO()
            with mock.patch.object(Path, "mkdir", inaccessible_profile), contextlib.redirect_stderr(errors):
                with self.assertRaises(SystemExit):
                    dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            self.assertIn("保留原数据并修复目录属主或写权限", errors.getvalue())
            self.assertEqual(json.loads((target / "instance.json").read_text()), manifest)
            (directory / "profiles/web").rmdir()
            (directory / "profiles").rmdir()
            external = Path(temporary) / "external"
            external.mkdir()
            (directory / "profiles").symlink_to(external, target_is_directory=True)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            self.assertFalse((external / "web").exists())
            self.assertTrue((directory / "profiles").is_symlink())
            (directory / "profiles").unlink()
            dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            session = directory / "session-fixture.json"
            session.write_text('{"fixture":true}')
            compose = (target / "compose.yaml").read_text()
            self.assertEqual(compose.count("source: ${DSH_HOME_HOST:"), 2)
            self.assertIn("HARNESS_SITES_CONFIG=/opt/harness-config/sites.json", compose)
            self.assertNotIn("  dsh-dev-probe-home:", compose)
            with mock.patch.object(dev, "project_containers", return_value=[]):
                report = dev.delete_instance("probe", manifest)
            self.assertTrue(report["home_preserved"])
            self.assertFalse((target / "instance.json").exists())
            self.assertEqual(session.read_text(), '{"fixture":true}')
            (target / "profile-compat").mkdir()
            (target / "profile-compat" / "web-profile.package.json").write_text("{}")
            self.assertIsNone(dev.existing_instance("probe"))
            dev.write_instance("probe", mode="verification", contract=contract, port=3081)
            self.assertEqual(session.read_text(), '{"fixture":true}')

class WorkspaceInstanceOwnershipTest(unittest.TestCase):
    """共享状态目录不能使一个工作区接管另一个工作区的同名实例。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="instance ownership ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "shared state"
        self.state.mkdir()
        (self.root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-selected"}))
        for key, value in (("REPO", self.root), ("STATE_ROOT", self.state)):
            patch = mock.patch.object(dev, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    def register(self, name, owner):
        manifest = {"name": name, "workspace_id": owner, "asset_root": str(self.root),
                    "source_id": "experiment:EXP-fixture-001", "mode": "verification", "mounts": {}}
        target = self.state / name
        target.mkdir()
        (target / "instance.json").write_text(json.dumps(manifest))
        return target, manifest

    def test_foreign_record_is_rejected_before_any_external_action(self):
        current = self.register("shared-name", "workspace-foreign")
        calls = [lambda: dev.load_instance("shared-name"), lambda: dev.existing_instance("shared-name"),
                 lambda: dev.validate_existing_identity("shared-name", current[1], current[1], "verification", None),
                 lambda: dev.command_down(types.SimpleNamespace(name="shared-name")),
                 lambda: dev.command_delete(types.SimpleNamespace(name="shared-name")),
                 lambda: dev.stop_instance("shared-name", current[1]),
                 lambda: dev.delete_instance("shared-name", current[1])]
        with mock.patch.object(dev, "run") as runner, contextlib.redirect_stderr(io.StringIO()):
            for invoke in calls:
                with self.subTest(invoke=invoke), self.assertRaises(SystemExit):
                    invoke()
            runner.assert_not_called()
        self.assertTrue((current[0] / "instance.json").is_file())

    def test_list_excludes_foreign_registration_and_keeps_owned(self):
        self.register("owned", "workspace-selected")
        self.register("foreign", "workspace-foreign")
        output = io.StringIO()
        with mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, '{"projects":{},"homes":{}}', "")), \
                contextlib.redirect_stdout(output):
            dev.command_ps(types.SimpleNamespace(all=True))
        self.assertEqual([value["name"] for value in json.loads(output.getvalue())["instances"]], ["owned"])

    def test_shared_state_omits_corrupt_unowned_records(self):
        self.register("owned", "workspace-selected")
        target = self.state / "foreign-broken"
        target.mkdir()
        (target / "instance.json").write_text("{not json")
        output = io.StringIO()
        with mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, '{"projects":{},"homes":{}}', "")), \
                contextlib.redirect_stdout(output):
            dev.command_ps(types.SimpleNamespace(all=True))
        value = json.loads(output.getvalue())
        self.assertEqual([item["name"] for item in value["instances"]], ["owned"])
        self.assertEqual(value["unowned_record_count"], 1)
        self.assertNotIn("foreign-broken", output.getvalue())

    def test_new_local_registration_cannot_reuse_global_docker_identity(self):
        occupied = "abc\trunning\tUp\tshared-name\tdsh\n"
        for project_output, name_output in ((occupied, ""), ("", "abc\n")):
            with self.subTest(project=bool(project_output)), \
                    mock.patch.object(dev, "run", side_effect=[subprocess.CompletedProcess([], 0, project_output, ""),
                                                               subprocess.CompletedProcess([], 0, name_output, "")]) as runner, \
                    mock.patch.object(dev, "write_instance") as write, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    dev._command_up(types.SimpleNamespace(name="shared-name"), {}, None)
                write.assert_not_called()
                self.assertTrue(all(call.args[0][:3] == ["docker", "ps", "-a"] for call in runner.call_args_list))
                self.assertFalse((self.state / "shared-name").exists())


class DockerRegistrationIdentityTest(unittest.TestCase):
    """A 停止后 B 复用全局名称时，A 的合法旧登记不能认领 B 的真实容器。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="docker registration ")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root, self.other = self.base / "workspace-a", self.base / "workspace-b"
        self.root.mkdir()
        self.state = self.root / ".local/instances"
        self.name = "shared-name"
        self.target = self.state / self.name
        self.target.mkdir(parents=True)
        self.managed = self.root / "candidate/dsh/managed"
        self.managed.mkdir(parents=True)
        (self.managed / "web-profile.seed.patch.yml").write_text("[]\n")
        (self.root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-a", "legacyRoots": []}))
        (self.target / "compose.yaml").write_text("services: {}\n")
        self.manifest = {"name": self.name, "workspace_id": "workspace-a", "asset_root": str(self.root),
                         "source_id": "experiment:EXP-fixture-001", "mode": "verification", "mounts": {"managed": str(self.managed)}}
        (self.target / "instance.json").write_text(json.dumps(self.manifest))
        for key, value in (("REPO", self.root), ("STATE_ROOT", self.state)):
            patch = mock.patch.object(dev, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def labels(target):
        return {"ConfigFiles": str(target / "compose.yaml"), "WorkingDir": str(target)}

    def test_stale_owned_registration_rejects_foreign_container_before_reads_or_mutations(self):
        # A 的登记仍合法，但 Docker 中的同名项目已经来自 B 的独立状态目录。
        metadata = self.labels(self.other / ".local/instances" / self.name)
        args = types.SimpleNamespace(name=self.name, dry_run=False, mode="verification", analysis_workspace=None,
                                     tail=20, non_interactive=True)
        contract = dict(self.manifest, required_env_names=["DEEPSEEK_API_KEY"], optional_env_names=[])
        current = (self.target, self.manifest)
        calls = [lambda: dev.stop_instance(self.name, self.manifest),
                 lambda: dev.delete_instance(self.name, self.manifest),
                 lambda: dev.command_down(args), lambda: dev.command_delete(args),
                 lambda: dev.command_logs(args), lambda: dev.command_url(args),
                 lambda: dev.command_mcp_promote(args),
                 lambda: dev.existing_runtime_environment(args, contract, current),
                 lambda: dev._command_up(args, contract, current)]
        for invoke in calls:
            with self.subTest(invoke=invoke), mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(dev, "resolve", return_value={"managed": str(self.managed)}), \
                    mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(metadata), "")) as runner, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                invoke()
            self.assertEqual(runner.call_count, 1)
            command = runner.call_args.args[0]
            self.assertEqual(command[:3], ["docker", "ps", "-a"])
            self.assertIn("com.docker.compose.project.config_files", command[-1])
            self.assertEqual(json.loads((self.target / "instance.json").read_text()), self.manifest)

    def test_matching_registration_can_stop_with_only_mocked_docker_boundary(self):
        home = self.target / "dsh-home"
        home.mkdir()
        manifest = dict(self.manifest, home_directory=str(home))
        responses = [subprocess.CompletedProcess([], 0, json.dumps(self.labels(self.target)), ""),
                     subprocess.CompletedProcess([], 0, "", ""), subprocess.CompletedProcess([], 0, "", "")]
        with mock.patch.object(dev, "run", side_effect=responses) as runner:
            report = dev.stop_instance(self.name, manifest)
        self.assertTrue(report["stopped"])
        self.assertTrue(report["home_preserved"])
        self.assertIn("down", runner.call_args_list[1].args[0])
        self.assertEqual(runner.call_count, 3)

    def test_empty_project_is_allowed_but_unknown_or_partial_identity_is_rejected(self):
        valid = self.labels(self.target)
        replies = [subprocess.CompletedProcess([], 1, "", "fixture-sensitive-detail"),
                   subprocess.CompletedProcess([], 0, "not-json", ""),
                   subprocess.CompletedProcess([], 0, "{}", ""),
                   subprocess.CompletedProcess([], 0, json.dumps(dict(valid, WorkingDir=str(self.other))), ""),
                   subprocess.CompletedProcess([], 0, json.dumps(valid) + "\n{}", "")]
        for response in replies:
            errors = io.StringIO()
            with self.subTest(response=response.stdout), mock.patch.object(dev, "run", return_value=response), \
                    contextlib.redirect_stderr(errors), self.assertRaises(SystemExit):
                dev.require_docker_registration(self.name, self.manifest)
            self.assertNotIn("fixture-sensitive-detail", errors.getvalue())
        with mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            self.assertIsNone(dev.require_docker_registration(self.name, self.manifest))

    def test_explicit_legacy_root_maps_same_registration_path_only(self):
        legacy = self.base / "old workspace"
        (self.root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-a", "legacyRoots": [str(legacy)]}))
        old_target = legacy / ".local/instances" / self.name
        self.assertTrue(dev.docker_registration_matches(self.name, [self.labels(old_target)]))
        self.assertFalse(dev.docker_registration_matches(self.name, [self.labels(legacy / ".local/instances/another-name")]))
        self.assertFalse(dev.docker_registration_matches(self.name, [self.labels(self.base / "old workspace-copy/.local/instances" / self.name)]))
        (self.root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-a", "legacyRoots": []}))
        self.assertFalse(dev.docker_registration_matches(self.name, [self.labels(old_target)]))

    def test_shared_external_state_matches_its_actual_compose_location(self):
        shared = self.base / "shared state"
        with mock.patch.object(dev, "STATE_ROOT", shared):
            self.assertTrue(dev.docker_registration_matches(self.name, [self.labels(shared / self.name)]))
            self.assertFalse(dev.docker_registration_matches(self.name, [self.labels(self.target)]))

    def test_batch_list_does_not_report_other_registration_container_as_running(self):
        foreign = dict(self.labels(self.other / ".local/instances" / self.name),
                       Name=self.name, Service="dsh", State="running", Status="Up")
        observation = {"projects": {dev.project_name(self.name): [foreign]}, "homes": {}}
        output = io.StringIO()
        with mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(observation), "")) as runner, \
                contextlib.redirect_stdout(output):
            dev.command_ps(types.SimpleNamespace(all=True))
        entry = json.loads(output.getvalue())["instances"][0]
        self.assertEqual(entry["state"], "unknown")
        self.assertEqual(entry["ps_query"], "unknown")
        self.assertIn("归属", entry["ps"])
        self.assertEqual(runner.call_count, 1)


if __name__ == "__main__":
    unittest.main()

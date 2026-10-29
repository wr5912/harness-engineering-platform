"""业务启动的 Python 接缝测试；实际渲染与权限决策由 TypeScript 测试覆盖。"""
import contextlib
import importlib.util
import io
import json
from importlib.machinery import SourceFileLoader
from pathlib import Path
import tempfile
import types
import unittest
import urllib.error
import subprocess
from unittest import mock

ADAPTER = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_loader("dsh_dev_business", SourceFileLoader("dsh_dev_business", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


class BusinessStartupTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / "instances"
        self.contract = {"source_id": "experiment:EXP-soc-001", "source_kind": "experiment", "agent_id": "soc", "preset_id": "soc",
                         "workspace": str(self.root / "workspace"), "presets": str(self.root / "presets"), "managed": str(self.root / "managed"),
                         "image": {"local_image_tag": "standard-image"}, "required_env_names": []}
        for target, value in [("REPO", self.root), ("STATE_ROOT", self.state), ("resolve", mock.Mock(return_value=self.contract)),
                              ("current_web_base_path", mock.Mock(return_value="/assistant/"))]:
            patch = mock.patch.object(dev, target, value); patch.start(); self.addCleanup(patch.stop)

    def args(self, **values):
        defaults = dict(source="experiment:EXP-soc-001", mode="verification", name="business-test", port=53191, analysis_workspace=None,
                        plugin_node_modules=None, lan_access=False, unsafe_no_auth=False, skip_testing_notice=False, trusted_host=None,
                        business_control=str(self.root / "launch.json"), dry_run=True, replace=False, migrate_home=False)
        defaults.update(values)
        return types.SimpleNamespace(**defaults)

    def helper(self):
        return mock.patch.object(dev, "business_helper", return_value={"assetRoot": str(self.root), "sourceDigest": "sha256:fixed"})

    def test_business_dry_run_preserves_tree_and_closes_direct_flags(self):
        args = self.args()
        policy = {"agent_id": "soc", "source": "platform", "default": {"provider": "fixture", "model": "fixture"},
                  "allowed": [], "sha256": "fixture", "manifest_sha256": None, "credential_refs": []}
        with self.helper(), mock.patch.object(dev, "read_model_policy", return_value=policy), \
             mock.patch.object(dev, "run") as commands, contextlib.redirect_stdout(io.StringIO()) as output:
            contract, current = dev.prepare_up(args)
            dev._command_up(args, contract, current)
        self.assertFalse(self.state.exists())
        self.assertFalse(args.lan_access)
        self.assertFalse(args.unsafe_no_auth)
        self.assertTrue(args.skip_testing_notice)
        commands.assert_not_called()
        plan = json.loads(output.getvalue())
        self.assertTrue(plan["business_control"]["scheduling_supported"])
        self.assertEqual(plan["network"], "private bridge (host port 127.0.0.1 only)")

    def test_business_rejects_unsafe_flags_and_existing_unmanaged_home(self):
        for changes in ({"unsafe_no_auth": True}, {"lan_access": True}, {"migrate_home": True}):
            with self.subTest(changes=changes), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.prepare_up(self.args(**changes))
        home = self.state / "business-test/dsh-home"
        home.mkdir(parents=True); (home / "old-session").write_text("preserve")
        with self.helper(), mock.patch.object(dev, "read_model_policy", return_value={"source": "platform", "default": None}), \
             contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args())
        self.assertIn("只有无需认证的开发调试实例可以复用保留的 HOME", error.getvalue())
        self.assertEqual((home / "old-session").read_text(), "preserve")

    def test_existing_registration_cannot_switch_business_boundary(self):
        for old_business, new_file in [(None, str(self.root / "launch.json")), ({"runtime_generation": "existing"}, None)]:
            manifest = {"port": 53191, **({"business_control": old_business} if old_business else {})}
            with mock.patch.object(dev, "existing_instance", return_value=(self.state, manifest)), \
                 mock.patch.object(dev, "validate_existing_identity"), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.prepare_up(self.args(business_control=new_file))

    def test_retained_home_only_reused_for_anonymous_development_without_writes(self):
        home = self.state / "business-test/dsh-home"
        home.mkdir(parents=True)
        session = home / "old-session"
        session.write_text("preserve")
        for development, access_mode in [(True, "anonymous"), (True, "authenticated"), (False, "anonymous"), (False, "authenticated")]:
            launch = {"assetRoot": str(self.root), "sourceDigest": "sha256:fixed", "development": development, "accessMode": access_mode}
            with self.subTest(development=development, access_mode=access_mode), \
                 mock.patch.object(dev, "business_helper", return_value=launch), \
                 mock.patch.object(dev, "read_model_policy", return_value={"source": "platform", "default": None}):
                if development and access_mode == "anonymous":
                    contract, current = dev.prepare_up(self.args())
                    self.assertIsNone(current)
                    self.assertTrue(contract["business_control"]["runtime_generation"])
                else:
                    with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
                        dev.prepare_up(self.args())
                    self.assertIn("只有无需认证的开发调试实例可以复用保留的 HOME", error.getvalue())
            self.assertEqual(session.read_text(), "preserve")
            self.assertEqual(list(home.parent.iterdir()), [home])
        home.rename(self.root / "original-home")
        home.symlink_to(self.root / "original-home", target_is_directory=True)
        with mock.patch.object(dev, "business_helper", return_value={**launch, "development": True, "accessMode": "anonymous"}), \
             mock.patch.object(dev, "read_model_policy", return_value={"source": "platform", "default": None}), \
             contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            dev.prepare_up(self.args())
        self.assertIn("只有无需认证的开发调试实例可以复用保留的 HOME", error.getvalue())

    def test_creation_policy_validates_retained_home_before_gateway_registration(self):
        home = self.state / "business-test/dsh-home"
        home.mkdir(parents=True)
        (home / "session").write_text("preserve")
        for identity, access in [("development", "anonymous"), ("development", "authenticated"), ("published", "anonymous")]:
            with self.subTest(identity=identity, access=access), self.helper(), \
                 mock.patch.object(dev, "read_model_policy", return_value={"source": "platform", "default": None}):
                args = self.args(business_access_mode=access, business_identity_mode=identity)
                if identity == "development" and access == "anonymous":
                    dev.prepare_up(args)
                else:
                    with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                        dev.prepare_up(args)
        self.assertEqual((home / "session").read_text(), "preserve")
        for changes in ({"business_control": None, "business_access_mode": "anonymous", "business_identity_mode": "development"},
                        {"business_access_mode": "anonymous"}, {"business_identity_mode": "development"}):
            with self.subTest(changes=changes), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dev.prepare_up(self.args(**changes))
        with mock.patch.object(dev, "existing_instance", return_value=(self.state, {})), \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dev.prepare_up(self.args(business_access_mode="anonymous", business_identity_mode="development"))

    def test_development_refreshes_source_and_preserves_runtime_generation(self):
        manifest = {"port": 53191, "business_control": {"runtime_generation": "existing", "source_digest": "sha256:old"}}
        policy = {"agent_id": "soc", "source": "platform", "default": {"provider": "fixture", "model": "fixture"}, "allowed": []}
        for development in (True, False):
            with self.subTest(development=development), \
                 mock.patch.object(dev, "existing_instance", return_value=(self.state, manifest)), \
                 mock.patch.object(dev, "validate_existing_identity"), \
                 mock.patch.object(dev, "read_model_policy", return_value=policy), \
                 mock.patch.object(dev, "business_helper", return_value={"assetRoot": str(self.root), "sourceDigest": "sha256:new", "development": development}):
                args = self.args(model_policy="policy.json", replace=True)
                if development:
                    contract, _ = dev.prepare_up(args)
                    self.assertEqual(contract["business_control"]["source_digest"], "sha256:new")
                    self.assertEqual(contract["business_control"]["runtime_generation"], "existing")
                else:
                    with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                        dev.prepare_up(args)

    def test_business_environment_uses_instance_patch_in_current_and_historical_operations(self):
        contract = {**self.contract, "patch": "managed.patch.yml", "evaluation_patch": "evaluation.patch.yml", "business_control": {"source_digest": "fixed"}}
        current = dev.compose_env(contract, "verification", 53191, "business-test")
        historical = dev.instance_compose_env({"name": "business-test", "business_control": {"runtime_generation": "fixed"}})
        expected = str(self.state / "business-test/business.patch.yml")
        self.assertEqual(current["DSH_BUSINESS_PATCH_HOST"], expected)
        self.assertEqual(historical["DSH_BUSINESS_PATCH_HOST"], expected)

    def test_business_url_returns_only_verified_gateway_entry_without_owner_log_lookup(self):
        manifest = {"agent_id": "soc", "business_control": {"runtime_generation": "fixed"}}
        output = io.StringIO()
        response = {"url": "http://business.localhost:53190/agents/soc/instances/business-test/", "accessMode": "authenticated"}
        denied = urllib.error.HTTPError("http://business.localhost:53190/agents/soc/instances/business-test/", 401, "Unauthorized", {}, None)
        with mock.patch.object(dev, "load_instance", return_value=(self.state, manifest)), \
             mock.patch.object(dev, "require_docker_registration"), mock.patch.object(dev, "running_container"), \
             mock.patch.object(dev, "business_command", return_value=response) as run, \
             mock.patch.object(dev.urllib.request, "build_opener") as build_opener, contextlib.redirect_stdout(output):
            build_opener.return_value.open.side_effect = denied
            dev.command_url(types.SimpleNamespace(name="business-test", non_interactive=False))
        self.assertEqual(output.getvalue().strip(), "http://business.localhost:53190/agents/soc/instances/business-test/")
        self.assertEqual(run.call_count, 1)
        self.assertIn("--entry", run.call_args.args[0])
        self.assertEqual(build_opener.return_value.open.call_args.args[0].headers["Accept"], "text/html")

    def test_anonymous_business_url_requires_successful_gateway_html_entry(self):
        url = "http://business.localhost:53190/agents/soc/instances/business-test/"
        manifest = {"agent_id": "soc", "business_control": {"runtime_generation": "fixed"}}
        command = {"url": url, "accessMode": "anonymous"}
        html = mock.MagicMock()
        html.__enter__.return_value.status = 200
        output = io.StringIO()
        with mock.patch.object(dev, "load_instance", return_value=(self.state, manifest)), \
             mock.patch.object(dev, "require_docker_registration"), mock.patch.object(dev, "running_container"), \
             mock.patch.object(dev, "business_command", return_value=command), \
             mock.patch.object(dev.urllib.request, "build_opener") as build_opener, contextlib.redirect_stdout(output):
            build_opener.return_value.open.return_value = html
            dev.command_url(types.SimpleNamespace(name="business-test", non_interactive=False))
        self.assertEqual(output.getvalue(), url + "\n")
        self.assertEqual(build_opener.return_value.open.call_args.args[0].headers["Accept"], "text/html")

    def test_business_url_never_exposes_gateway_link_when_mode_probe_disagrees(self):
        url = "http://business.localhost:53190/agents/soc/instances/business-test/"
        manifest = {"agent_id": "soc", "business_control": {"runtime_generation": "fixed"}}
        output = io.StringIO()
        for mode, status in [("anonymous", 401), ("authenticated", 200)]:
            response = {"url": url, "accessMode": mode}
            with self.subTest(mode=mode), mock.patch.object(dev, "load_instance", return_value=(self.state, manifest)), \
                 mock.patch.object(dev, "require_docker_registration"), mock.patch.object(dev, "running_container"), \
                 mock.patch.object(dev, "business_command", return_value=response), \
                 mock.patch.object(dev.urllib.request, "build_opener") as build_opener, \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                if status == 401:
                    build_opener.return_value.open.side_effect = urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)
                else:
                    html = mock.MagicMock()
                    html.__enter__.return_value.status = status
                    build_opener.return_value.open.return_value = html
                dev.command_url(types.SimpleNamespace(name="business-test", non_interactive=False))
        self.assertEqual(output.getvalue(), "")

    def test_business_url_reports_real_entry_error_without_node_warning(self):
        config = self.root / "config/business-access.json"
        config.parent.mkdir()
        config.write_text(json.dumps({"enabled": True, "gateway": {"instances": []}}))
        manifest = {"agent_id": "soc", "business_control": {"runtime_generation": "fixed"}}
        stderr = io.StringIO()
        with mock.patch.object(dev, "load_instance", return_value=(self.state, manifest)), \
             mock.patch.object(dev, "require_docker_registration"), mock.patch.object(dev, "running_container"), \
             mock.patch.object(dev.urllib.request, "build_opener") as opener, \
             contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            dev.command_url(types.SimpleNamespace(name="business-test", non_interactive=False))
        self.assertIn("实例未向业务网关开放", stderr.getvalue())
        self.assertNotIn("Warning", stderr.getvalue())
        self.assertNotIn("配置或来源文件解析失败", stderr.getvalue())
        opener.assert_not_called()

    def test_business_helper_reports_safe_specific_failure_category(self):
        error = "BUSINESS_STARTUP_ERROR:业务来源 MCP manager 声明冲突或配置无效\n"
        result = subprocess.CompletedProcess([], 1, "", "private-secret-value\n" + error)
        stderr = io.StringIO()
        with mock.patch.object(dev.subprocess, "run", return_value=result), contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            dev.business_helper(str(self.root / "launch.json"), {"compose": "services: {}"})
        self.assertIn("业务来源 MCP manager 声明冲突或配置无效", stderr.getvalue())
        self.assertNotIn("private-secret-value", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

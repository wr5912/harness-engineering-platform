"""启动器隔离测试；替换 DSH/pnpm 外部进程，保留真实 CLI、文件和端口路径。"""

import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import runpy
import http.cookiejar
import urllib.request
import urllib.parse
from unittest import mock


PLATFORM = Path(__file__).resolve().parent
VERSION = "0.2.1-rc.2"


class PlatformLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repository with spaces"
        shutil.copytree(PLATFORM, self.repo / "platform", ignore=shutil.ignore_patterns("plugin"))
        self.plugin = self.repo / "platform" / "plugin"
        self.plugin.mkdir(parents=True)
        shutil.copytree(PLATFORM / "plugin/assets", self.plugin / "assets")
        self.web = self.repo / "runtime" / "adapters" / "dsh-web"
        self.web.mkdir(parents=True)
        adapter = self.repo / "runtime/adapters/dsh-container"
        adapter.mkdir(parents=True)
        shutil.copyfile(PLATFORM.parent / "runtime/adapters/dsh-container/workspace_paths.py", adapter / "workspace_paths.py")
        self.assets = self.root / "data workspace with spaces"
        (self.assets / "config").mkdir(parents=True)
        (self.assets / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-test", "legacyRoots": []}))
        (self.assets / "config/sites.json").write_text(json.dumps({"assistant": "/assistant/", "platform": "/hep/"}))
        (self.assets / "config/sources.json").write_text('{"schema_version":"1.1","sources":{}}')
        (self.assets / "config/mcp-compositions.json").write_text('{"schema_version":"1.0","compositions":[]}')
        (self.assets / ".local/credentials").mkdir(parents=True)
        (self.assets / ".local/credentials/admin.json").write_text('{"username":"fixture","password":"fixture-password"}')
        subprocess.run([shutil.which("git"), "init", "--quiet", str(self.assets)], check=True)
        (self.plugin / "package.json").write_text(json.dumps({
            "name": "@ai-agent-harness/harness-platform", "peerDependencies": {
                "@deepseek-ai/dsh-client-connection": VERSION,
                "@deepseek-ai/cordis": "4.0.5",
            },
        }))
        (self.plugin / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for command in ("node", "git"):
            (self.bin / command).symlink_to(shutil.which(command))
        self.write_executable("ip", 'import os\nprint(os.environ.get("FAKE_ROUTE", \'[{"prefsrc":"127.0.0.1"}]\'))\n')
        self.trace = self.root / "dsh-trace.jsonl"
        self.pnpm_trace = self.root / "pnpm-trace.jsonl"
        self.write_executable("dsh", r'''
import json, os, pathlib, signal, sys, time
if sys.argv[1:] == ["--version"]:
    print(os.environ.get("FAKE_DSH_VERSION", "0.2.1-rc.2"))
else:
    if sys.argv.index("--patch") > sys.argv.index("--host"):
        print("error: unknown option '--patch'", file=sys.stderr)
        sys.exit(2)
    with open(os.environ["FAKE_DSH_TRACE"], "a") as handle:
        handle.write(json.dumps({"args": sys.argv[1:], "home": os.environ["DSH_HOME"],
                                 "repository": os.environ["HARNESS_ASSET_ROOT"],
                                 "runtime_entry": os.environ["HARNESS_DSH_ENTRY"]}) + "\n")
    if os.environ.get("FAKE_DSH_WELCOME"):
        patch = pathlib.Path(os.environ["DSH_HOME"]) / "profiles/harness-platform/cordis.patch.yml"
        if "ui-settings-general" not in patch.read_text():
            patch.write_text("- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 1\n")
    if os.environ.get("FAKE_DSH_STAY"):
        signal.signal(signal.SIGINT, lambda signum, frame: sys.exit(130))
        pathlib.Path(os.environ["FAKE_DSH_READY"]).touch()
        while True:
            time.sleep(0.05)
''')
        self.write_executable("pnpm", r'''
import json, os, pathlib, sys
with open(os.environ["FAKE_PNPM_TRACE"], "a") as handle:
    handle.write(json.dumps({"args": sys.argv[1:], "cwd": os.getcwd()}) + "\n")
if os.environ.get("FAKE_PNPM_FAIL"):
    sys.exit(1)
if sys.argv[1:] == ["run", "build"]:
    pathlib.Path("lib").mkdir(exist_ok=True)
    pathlib.Path("lib/index.js").write_text("export function apply() {}\n")
    pathlib.Path("lib/mcp-manager.js").write_text("export function apply() {}\n")
    pathlib.Path("lib/client.js").write_text("export function apply() {}\n")
    web = pathlib.Path("../../runtime/adapters/dsh-web/lib")
    web.mkdir(parents=True, exist_ok=True)
    (web / "platform-webserver.mjs").write_text("export default class WebServer {}\n")
''')
        self.env = {**os.environ, "PATH": str(self.bin), "HOME": str(self.root / "user"),
                    "XDG_STATE_HOME": str(self.root / "state"), "HARNESS_ASSET_ROOT": str(self.assets),
                    "DSH_HOME": str(self.root / "unrelated-dsh-home"),
                    "FAKE_DSH_TRACE": str(self.trace), "FAKE_PNPM_TRACE": str(self.pnpm_trace)}
        self.home = self.assets / ".local/platform-home"
        self.profile = self.home / "profiles" / "harness-platform"
        self.cwd = self.root / "unrelated-cwd"
        self.cwd.mkdir()
        self.launcher = self.repo / "platform" / "dsh-platform"

    def tearDown(self):
        self.temp.cleanup()

    def write_executable(self, name, code):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + code)
        path.chmod(0o755)

    def run_cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(self.launcher), *args], cwd=self.cwd,
                              env=env or self.env, capture_output=True, text=True, timeout=10)

    def prepare(self):
        result = self.run_cli("prepare")
        self.assertEqual(result.returncode, 0, result.stderr)

    def free_port(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return listener.getsockname()[1]

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.stat().st_mtime_ns, path.read_bytes())
                for path in self.root.rglob("*") if path.is_file()}

    def test_prepare_from_any_cwd_renders_absolute_plugin_and_preserves_home(self):
        session = self.home / "sessions" / "keep-session"
        session.parent.mkdir(parents=True)
        session.write_text("retained")
        self.prepare()
        calls = [json.loads(line) for line in self.pnpm_trace.read_text().splitlines()]
        self.assertEqual([call["args"] for call in calls],
                         [["install", "--frozen-lockfile"], ["run", "build"]])
        self.assertTrue(all(call["cwd"] == str(self.plugin) for call in calls))
        manifest = json.loads((self.profile / "package.json").read_text())
        self.assertEqual(manifest["dsh"]["profile"]["bundles"],
                         ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                          "@ai-agent-harness/harness-platform"])
        bundle = self.profile / "node_modules/@ai-agent-harness/harness-platform"
        self.assertTrue(bundle.is_symlink())
        self.assertEqual(bundle.resolve(), self.plugin)
        self.assertEqual(manifest["dsh"]["profile"]["patchReload"], "startup")
        patch = (self.profile / "harness-platform.patch.yml").read_text()
        self.assertIn(json.dumps(str(self.plugin / "lib" / "index.js")), patch)
        self.assertNotIn("{{HARNESS_PLATFORM_PLUGIN}}", patch)
        self.assertIn(json.dumps(str(self.assets / ".agents/skills")), patch)
        self.assertNotIn("management-skills", patch)
        self.assertNotIn(str(self.repo / "platform/skills"), patch)
        self.assertNotIn("{{HARNESS_PLATFORM_SKILLS}}", patch)
        self.assertIn(json.dumps(str(self.web / "lib/platform-webserver.mjs")), patch)
        self.assertNotIn("{{HARNESS_PLATFORM_WEBSERVER}}", patch)
        self.assertIn("inject: [webStartup]", patch)
        self.assertIn("- id: skill-filesystem\n  disabled: false\n  config:\n    includeDefaultRoots: false\n", patch)
        self.assertEqual((self.profile / "cordis.patch.yml").read_text(), "[]\n")
        self.prepare()
        self.assertEqual(session.read_text(), "retained")
        self.assertFalse(Path(self.env["DSH_HOME"]).exists())

    def test_model_credentials_only_enter_runtime_environment_with_explicit_values_first(self):
        credentials = self.assets / ".local/credentials/models.llm-api-key"
        credentials.parent.mkdir(parents=True, exist_ok=True)
        content = json.dumps({
            "DEEPSEEK_API_KEY": "fixture-file-key",
            "LOCAL_LLM_BASE_URL": "http://127.0.0.1:8000",
            "LOCAL_LLM_API_KEY": "fixture-local-key",
            "UNRELATED_VALUE": "must-not-enter-environment",
        })
        credentials.write_text(content)
        namespace = runpy.run_path(str(self.launcher))
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "fixture-explicit-key", "HARNESS_ASSET_ROOT": str(self.assets)}, clear=True):
            environment = namespace["runtime_environment"](self.home)
            self.assertEqual(dict(os.environ), {"DEEPSEEK_API_KEY": "fixture-explicit-key", "HARNESS_ASSET_ROOT": str(self.assets)})
        self.assertEqual(environment["DEEPSEEK_API_KEY"], "fixture-explicit-key")
        self.assertEqual(environment["LOCAL_LLM_BASE_URL"], "http://127.0.0.1:8000")
        self.assertEqual(environment["LOCAL_LLM_API_KEY"], "fixture-local-key")
        self.assertNotIn("UNRELATED_VALUE", environment)
        self.assertEqual(environment["HARNESS_ASSET_ROOT"], str(self.assets))
        self.assertEqual(credentials.read_text(), content)

    def test_native_mcp_identity_moves_with_home_without_changing_configuration(self):
        self.prepare()
        old_profile = self.root / "old home/profiles/harness-platform"
        bundle = old_profile / "node_modules/@ai-agent-harness/harness-platform"
        bundle.parent.mkdir(parents=True)
        bundle.symlink_to(self.plugin, target_is_directory=True)
        previous = (bundle / "lib/mcp-manager.js").as_uri().replace("%40", "@")
        expected = (self.profile / "node_modules/@ai-agent-harness/harness-platform/lib/mcp-manager.js").as_uri().replace("%40", "@")
        source = ("- id: ui-settings-general\n  name: stable-package-name\n  config:\n    welcomeNoticeVersion: 1\n"
                  "- id: mcp-session-manager\n  name: " + json.dumps(previous) + "\n"
                  "  config:\n    servers:\n      - id: fixture-api\n        apiKey: fixture-private-value\n"
                  "        specUrl: http://127.0.0.1:58001/openapi.json\n"
                  "    groups:\n      - id: fixture-group\n        members:\n          - serverId: fixture-api\n            names: [basic_status]\n"
                  "    sharedToken: '" + "0" * 64 + "'\n")
        patch = self.profile / "cordis.patch.yml"
        patch.write_text(source)
        blocked = self.run_cli("start", "--dry-run", "--port", str(self.free_port()))
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("旧 Profile 路径", blocked.stderr)
        self.assertEqual(patch.read_text(), source)
        self.assertNotIn("fixture-private-value", blocked.stderr)
        self.prepare()
        migrated = source.replace("  name: " + json.dumps(previous), "  name: " + json.dumps(expected))
        self.assertEqual(patch.read_text(), migrated)
        self.prepare()
        self.assertEqual(patch.read_text(), migrated)
        self.assertEqual(self.run_cli("start", "--dry-run", "--port", str(self.free_port())).returncode, 0)

    def test_native_mcp_identity_does_not_rewrite_an_unrelated_plugin(self):
        self.prepare()
        source = "- id: mcp-session-manager\n  name: file:///unrelated/plugin.js\n  config:\n    servers: []\n"
        patch = self.profile / "cordis.patch.yml"
        patch.write_text(source)
        result = self.run_cli("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不属于已知平台 bundle", result.stderr)
        self.assertEqual(patch.read_text(), source)

    def test_prepare_restores_data_and_program_elsewhere_preserving_native_settings(self):
        self.prepare()
        old_bundle = self.profile / "node_modules/@ai-agent-harness/harness-platform"
        previous = (old_bundle / "lib/mcp-manager.js").as_uri().replace("%40", "@")
        original = ("# 保留全部用户配置\n- id: mcp-session-manager\n  name: " + json.dumps(previous)
                    + "\n  config:\n    servers: [{id: retained, apiKey: fixture-private-value}]\n"
                    "    groups: [{id: retained-group}]\n- id: agent-default-model\n  config: {reasoningEffort: max}\n")
        (self.profile / "cordis.patch.yml").write_text(original)
        session = self.home / "sessions/retained-session"
        session.parent.mkdir(exist_ok=True)
        session.write_text("unchanged history")
        replacement = self.root / "replacement program"
        recovered = self.root / "recovered data"
        shutil.copytree(self.repo, replacement, symlinks=True)
        shutil.copytree(self.assets, recovered, symlinks=True)
        self.launcher = replacement / "platform/dsh-platform"
        self.env["HARNESS_ASSET_ROOT"] = str(recovered)
        recovered_profile = recovered / ".local/platform-home/profiles/harness-platform"
        expected = (recovered_profile / "node_modules/@ai-agent-harness/harness-platform/lib/mcp-manager.js").as_uri().replace("%40", "@")
        self.prepare()
        self.assertEqual((recovered_profile / "cordis.patch.yml").read_text(), original.replace(json.dumps(previous), json.dumps(expected)))
        self.assertEqual((recovered_profile / "node_modules/@ai-agent-harness/harness-platform").resolve(), replacement / "platform/plugin")
        patch = (recovered_profile / "harness-platform.patch.yml").read_text()
        self.assertIn(str(recovered / ".agents/skills"), patch)
        self.assertNotIn("management-skills", patch)
        self.assertFalse((recovered / ".local/build-cache/management-skills").exists())
        self.assertEqual((recovered / ".local/platform-home/sessions/retained-session").read_text(), "unchanged history")
        self.assertEqual((self.profile / "cordis.patch.yml").read_text(), original)
        self.assertEqual(old_bundle.resolve(), self.plugin)
        self.prepare()
        result = self.run_cli("start", "--dry-run", "--port", str(self.free_port()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["repository"], str(replacement))

    def test_generated_links_restore_after_old_program_removed_but_preserve_unknown_objects(self):
        namespace = runpy.run_path(str(self.launcher))
        target = self.root / "generated"
        source = self.plugin
        missing = self.root / "removed-program/platform/plugin"
        target.symlink_to(missing, target_is_directory=True)
        namespace["link_program_asset"](target, source, Path("platform/plugin"))
        self.assertEqual(target.resolve(), source)
        target.unlink()
        unknown = self.root / "unrelated"
        unknown.mkdir()
        target.symlink_to(unknown, target_is_directory=True)
        with self.assertRaises(namespace["PlatformError"]):
            namespace["link_program_asset"](target, source, Path("platform/plugin"))
        self.assertEqual(target.resolve(), unknown)
        target.unlink()
        target.mkdir()
        (target / "keep").write_text("retain")
        with self.assertRaises(namespace["PlatformError"]):
            namespace["link_program_asset"](target, source, Path("platform/plugin"))
        self.assertEqual((target / "keep").read_text(), "retain")

    def test_existing_unrelated_mcp_identity_is_rejected_before_bundle_relink(self):
        self.prepare()
        unrelated = self.root / "unrelated home/profiles/harness-platform/node_modules/@ai-agent-harness/harness-platform/lib"
        unrelated.mkdir(parents=True)
        (unrelated / "mcp-manager.js").write_text("unrelated")
        source = "- id: mcp-session-manager\n  name: " + json.dumps((unrelated / "mcp-manager.js").as_uri().replace("%40", "@")) + "\n  config: {servers: []}\n"
        patch = self.profile / "cordis.patch.yml"
        patch.write_text(source)
        result = self.run_cli("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("另一份程序", result.stderr)
        self.assertEqual(patch.read_text(), source)
        self.assertEqual((self.profile / "node_modules/@ai-agent-harness/harness-platform").resolve(), self.plugin)

    def test_native_mcp_multiline_yaml_name_preserves_current_patch_bytes(self):
        self.prepare()
        expected = (self.profile / "node_modules/@ai-agent-harness/harness-platform/lib/mcp-manager.js").as_uri().replace("%40", "@")
        # 原生 settings/update 的 YAML 序列化器将长双引号标量以反斜线折行。
        folded = '"' + expected[:60] + '\\\n    ' + expected[60:120] + '\\\n    ' + expected[120:] + '"'
        source = ("# 保留原生用户配置\n- id: mcp-session-manager\n  name: " + folded + " # 保留同行说明\n"
                  "  config:\n    sharedToken: fixture-private-value\n    groups: [{id: existing-group}]\n"
                  "- id: agent-default-model\n  config: {reasoningEffort: max}\n")
        patch = self.profile / "cordis.patch.yml"
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                original = source.replace("\n", newline).encode()
                patch.write_bytes(original)
                self.prepare()
                self.assertEqual(patch.read_bytes(), original)
                result = self.run_cli("start", "--dry-run", "--port", str(self.free_port()))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("fixture-private-value", result.stdout + result.stderr)

    def test_native_mcp_multiline_old_name_only_replaces_target_scalar(self):
        self.prepare()
        previous = (self.root / "old missing home/profiles/harness-platform/node_modules/@ai-agent-harness/harness-platform/lib/mcp-manager.js").as_uri().replace("%40", "@")
        expected = (self.profile / "node_modules/@ai-agent-harness/harness-platform/lib/mcp-manager.js").as_uri().replace("%40", "@")
        folded = '"' + previous[:70] + '\\\n    ' + previous[70:] + '"'
        source = ("- name: " + folded + " # 原路径\n  id: mcp-session-manager\n"
                  "  config:\n    servers: [{id: fixture-api, apiKey: fixture-private-value}]\n"
                  "    groups: [{id: fixture-group, members: [{serverId: fixture-api}]}]\n"
                  "- id: other-plugin\n  config: {name: preserved}\n")
        patch = self.profile / "cordis.patch.yml"
        patch.write_text(source)
        blocked = self.run_cli("start", "--dry-run", "--port", str(self.free_port()))
        self.assertIn("旧 Profile 路径", blocked.stderr)
        self.assertNotIn("fixture-private-value", blocked.stderr)
        self.prepare()
        self.assertEqual(patch.read_text(), source.replace(folded, json.dumps(expected), 1))
        self.assertEqual(self.run_cli("start", "--dry-run", "--port", str(self.free_port())).returncode, 0)

    def test_missing_yaml_dependency_does_not_block_bootstrap_check(self):
        with mock.patch.dict(sys.modules, {"yaml": None}):
            namespace = runpy.run_path(str(self.launcher))
            with mock.patch.dict(os.environ, self.env, clear=True):
                self.assertTrue(namespace["bootstrap_state"]()["ready"])
            with self.assertRaises(namespace["PlatformError"]) as error:
                namespace["normalized_mcp_patch"](self.profile)
            self.assertIn("Python 依赖 PyYAML", str(error.exception))

    def test_absent_model_credentials_preserve_launch_environment(self):
        namespace = runpy.run_path(str(self.launcher))
        with mock.patch.dict(os.environ, {"LOCAL_LLM_API_KEY": "fixture-explicit", "HARNESS_ASSET_ROOT": str(self.assets)}, clear=True):
            environment = namespace["runtime_environment"](self.home)
        self.assertEqual(environment, {
            "LOCAL_LLM_API_KEY": "fixture-explicit",
            "DSH_HOME": str(self.home), "HARNESS_ASSET_ROOT": str(self.assets),
            "HARNESS_PROGRAM_ROOT": str(self.repo), "HARNESS_PYTHON": sys.executable, "HARNESS_SITES_CONFIG": str(self.assets / "config/sites.json"),
        })

    def test_invalid_model_credentials_never_disclose_contents(self):
        credentials = self.assets / ".local/credentials/models.llm-api-key"
        credentials.parent.mkdir(parents=True, exist_ok=True)
        namespace = runpy.run_path(str(self.launcher))
        for content in ('{"DEEPSEEK_API_KEY": "fixture-sensitive"', '["fixture-sensitive"]', '{"DEEPSEEK_API_KEY": 123}'):
            with self.subTest(content=content):
                credentials.write_text(content)
                with mock.patch.dict(os.environ, {"HARNESS_ASSET_ROOT": str(self.assets)}, clear=True), self.assertRaises(namespace["PlatformError"]) as error:
                    namespace["runtime_environment"](self.home)
                self.assertNotIn("fixture-sensitive", str(error.exception))
                self.assertNotIn("123", str(error.exception))

    def test_dry_run_is_read_only_and_reports_runtime_contract(self):
        self.prepare()
        before = self.snapshot()
        port = self.free_port()
        result = self.run_cli("start", "--dry-run", "--port", str(port))
        self.assertEqual(result.returncode, 0, result.stderr)
        preview = json.loads(result.stdout)
        self.assertEqual(preview["repository"], str(self.repo))
        self.assertEqual(preview["home"], str(self.home))
        self.assertEqual(preview["profile"], str(self.profile))
        self.assertEqual(preview["plugin"], str(self.plugin / "lib" / "index.js"))
        self.assertEqual(preview["patch"], str(self.profile / "harness-platform.patch.yml"))
        self.assertEqual(preview["host"], "127.0.0.1")
        self.assertEqual(preview["port"], port)
        self.assertEqual(preview["base_url"], f"http://127.0.0.1:{port}/hep/")
        self.assertEqual(preview["webserver"], str(self.web / "lib/platform-webserver.mjs"))
        self.assertNotIn("--from-default-profile", preview["command"])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.trace.exists())

    def test_missing_workspace_dry_run_reports_browser_initialization_without_writes(self):
        missing = self.root / "missing data"
        result = self.run_cli("start", "--dry-run", env={**self.env, "HARNESS_ASSET_ROOT": str(missing)})
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["mode"], "initialization")
        self.assertTrue(value["base_url"].endswith("/hep/"))
        self.assertFalse(missing.exists())
        self.assertFalse(self.trace.exists())

    def test_browser_initialization_hands_selected_root_to_real_launcher_and_next_start(self):
        selected = self.root / "new selected data"
        port = self.free_port()
        log = self.root / "bootstrap.log"
        with log.open("w") as output:
            process = subprocess.Popen([sys.executable, str(self.launcher), "start", "--host", "127.0.0.1", "--port", str(port)],
                                       cwd=self.cwd, env={**self.env, "HARNESS_ASSET_ROOT": str(self.root / "missing")},
                                       stdout=output, stderr=output, text=True, start_new_session=True)
            try:
                deadline = time.monotonic() + 10
                access = None
                while time.monotonic() < deadline and process.poll() is None:
                    text = log.read_text()
                    paths = re.findall(r"文件：(.*/access-url)", text)
                    if paths and "初始化页面：" in text:
                        access = Path(paths[-1]).read_text().strip()
                        break
                    time.sleep(0.03)
                self.assertIsNotNone(access, log.read_text())
                self.assertNotIn("?bootstrap=", log.read_text())
                origin = f"http://127.0.0.1:{port}"
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                with opener.open(access, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                def request(endpoint, value):
                    req = urllib.request.Request(origin + "/hep/bootstrap/" + endpoint, data=json.dumps(value).encode(),
                                                 headers={"Content-Type": "application/json", "Origin": origin})
                    with opener.open(req, timeout=20) as response:
                        return json.load(response)
                payload = {"action": "new", "root": str(selected)}
                preview = request("preview", payload)
                self.assertTrue(preview["canApply"])
                result = request("apply", {**payload, "previewRevision": preview["revision"], "account": {"username": "new-user", "password": "new-fixture-private"}})
                self.assertTrue(result["ok"])
                process.wait(timeout=15)
                self.assertEqual(process.returncode, 0, log.read_text())
                self.assertNotIn("new-fixture-private", log.read_text())
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
        trace = json.loads(self.trace.read_text().splitlines()[-1])
        self.assertEqual(trace["repository"], str(selected))
        self.assertEqual(trace["home"], str(selected / ".local/platform-home"))
        later_env = dict(self.env)
        del later_env["HARNESS_ASSET_ROOT"]
        later = self.run_cli("start", "--dry-run", "--port", str(self.free_port()), env=later_env)
        self.assertEqual(later.returncode, 0, later.stderr)
        self.assertEqual(json.loads(later.stdout)["asset_root"], str(selected))

    def test_dry_run_does_not_create_unprepared_home(self):
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("缺少插件构建产物", result.stderr)
        self.assertFalse(self.home.exists())

    def test_foreign_bundle_is_preserved_and_stale_link_blocks_start(self):
        self.prepare()
        bundle = self.profile / "node_modules/@ai-agent-harness/harness-platform"
        bundle.unlink()
        bundle.mkdir()
        (bundle / "keep").write_text("foreign")
        result = self.run_cli("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((bundle / "keep").read_text(), "foreign")
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bundle 未关联", result.stderr)
        self.assertFalse(self.trace.exists())

    def test_missing_dsh_and_incompatible_version_fail_before_preparation(self):
        (self.bin / "dsh").unlink()
        result = self.run_cli("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("没有全局 dsh", result.stderr)
        self.assertFalse(self.home.exists())
        self.write_executable("dsh", 'print("0.3.0")\n')
        result = self.run_cli("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不兼容", result.stderr)
        self.assertFalse(self.home.exists())
        self.assertFalse(self.pnpm_trace.exists())

    def test_missing_client_or_stale_profile_fails_without_start(self):
        self.prepare()
        (self.plugin / "lib" / "client.js").unlink()
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("client.js", result.stderr)
        self.prepare()
        (self.profile / "harness-platform.patch.yml").write_text("[]\n")
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("与仓库模板不一致", result.stderr)
        self.assertFalse(self.trace.exists())

    def test_build_failure_keeps_existing_profile(self):
        self.prepare()
        before = (self.profile / "harness-platform.patch.yml").read_bytes()
        (self.repo / "platform" / "profile" / "cordis.patch.yml").write_text("[]\n")
        result = self.run_cli("prepare", env={**self.env, "FAKE_PNPM_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.profile / "harness-platform.patch.yml").read_bytes(), before)

    def test_missing_web_adapter_blocks_start(self):
        self.prepare()
        (self.web / "lib/platform-webserver.mjs").unlink()
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Web 基址适配构建产物", result.stderr)
        self.assertFalse(self.trace.exists())

    def test_port_conflict_fails_and_does_not_select_another_port(self):
        self.prepare()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            result = self.run_cli("start", "--port", str(port))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"127.0.0.1:{port}", result.stderr)
        self.assertFalse(self.trace.exists())

    def test_foreground_interrupt_and_restart_reuse_home(self):
        self.prepare()
        session = self.home / "sessions" / "keep-session"
        session.parent.mkdir(parents=True)
        session.write_text("retained")
        for attempt in range(2):
            ready = self.root / f"ready-{attempt}"
            env = {**self.env, "FAKE_DSH_STAY": "1", "FAKE_DSH_READY": str(ready),
                   "FAKE_DSH_WELCOME": "1"}
            process = subprocess.Popen(
                [sys.executable, str(self.launcher), "start", "--port", str(self.free_port())],
                cwd=self.cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "替身 DSH 未启动")
                native_patch = (self.profile / "cordis.patch.yml").read_bytes()
                self.assertIn(b"welcomeNoticeVersion", native_patch)
                process.send_signal(signal.SIGINT)
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 130)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            self.assertEqual(session.read_text(), "retained")
            preview = self.run_cli("start", "--dry-run", "--port", str(self.free_port()))
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.prepare()
            self.assertEqual((self.profile / "cordis.patch.yml").read_bytes(), native_patch)
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call["home"], str(self.home))
            self.assertEqual(call["repository"], str(self.assets))
            self.assertEqual(call["runtime_entry"], str((self.bin / "dsh").resolve()))
            self.assertEqual(call["args"][:6], ["--profile", "harness-platform", "--patch",
                             str(self.profile / "harness-platform.patch.yml"), "--host", "127.0.0.1"])
            self.assertEqual(call["args"][-1], "--no-open")

    def test_stopped_server_time_wait_does_not_block_restart(self):
        self.prepare()
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port)) as client:
                connection, _ = listener.accept()
                connection.close()
                self.assertEqual(client.recv(1), b"")
        result = self.run_cli("start", "--dry-run", "--port", str(port))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_state_location_and_invalid_ports(self):
        env = self.env.copy()
        del env["XDG_STATE_HOME"]
        result = self.run_cli("prepare", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        default_home = self.assets / ".local/platform-home"
        self.assertTrue((default_home / "profiles" / "harness-platform" / "package.json").is_file())
        for port in ("0", "65536", "invalid"):
            result = self.run_cli("start", "--port", port)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("1 至 65535", result.stderr)

    def test_default_route_and_explicit_host_use_same_address_everywhere(self):
        self.prepare()
        env = {**self.env, "FAKE_ROUTE": '[{"prefsrc":"127.0.0.2"}]'}
        result = self.run_cli("start", "--dry-run", "--port", str(self.free_port()), env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        preview = json.loads(result.stdout)
        self.assertEqual(preview["host"], "127.0.0.2")
        self.assertEqual(preview["command"][preview["command"].index("--host") + 1], "127.0.0.2")
        (self.bin / "ip").unlink()
        result = self.run_cli("start", "--host", "127.0.0.1", "--dry-run", "--port", str(self.free_port()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["host"], "127.0.0.1")
        result = self.run_cli("start", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--host", result.stderr)

    def test_invalid_route_and_wildcard_hosts_fail_without_launch(self):
        self.prepare()
        for route in ('[]', 'invalid', '[{}]', '[{"prefsrc":"0.0.0.0"}]'):
            result = self.run_cli("start", "--dry-run", env={**self.env, "FAKE_ROUTE": route})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--host", result.stderr)
        for host in ("0.0.0.0", "::", "localhost", "bad", "224.0.0.1", "255.255.255.255"):
            result = self.run_cli("start", "--host", host)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("IPv4", result.stderr)
        self.assertFalse(self.trace.exists())


if __name__ == "__main__":
    unittest.main()

"""SDK 模式的来源生成和 CLI 分流；运行行为另由真实标准容器验证。"""
import contextlib
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ADAPTER = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_loader("dsh_sdk_dev", SourceFileLoader("dsh_sdk_dev", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


class SdkModeTest(unittest.TestCase):
    def test_sdk_creation_keeps_version_identity_and_selects_native_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = dev.create_harness("sdk-example", repo=root, profile="sdk")
            candidate = root / "evolution/experiments" / result["experiment_id"] / "candidate"
            contract = dev.resolve(result["source_id"], repo=root)
            self.assertEqual(contract["profile"], "sdk")
            self.assertTrue(contract["profile_manifest"].endswith("sdk-profile.package.json"))
            self.assertIn("@deepseek-ai/dsh-sdk-client", (candidate / "sdk/example.ts").read_text())
            self.assertTrue((candidate / "sdk/README.md").is_file())
            self.assertNotIn("{{cwd}}", (candidate / "dsh/presets/sdk-example/agent.cordis.yml").read_text())

    def test_web_remains_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = dev.create_harness("web-example", repo=root)
            self.assertEqual(dev.resolve(result["source_id"], repo=root)["profile"], "web")

    def test_sdk_runner_rejects_web_before_inspecting_or_starting_containers(self):
        with mock.patch.object(dev, "resolve", return_value={"profile": "web"}), mock.patch.object(dev, "run") as execute:
            with self.assertRaises(SystemExit):
                dev.command_sdk_run(types.SimpleNamespace(source="experiment:example"))
            execute.assert_not_called()

    def test_sdk_url_has_no_http_entry_and_requires_no_running_process(self):
        with mock.patch.object(dev, "load_instance", return_value=(Path("/unused"), {"profile": "sdk"})), mock.patch.object(dev, "require_docker_registration") as inspect:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                dev.command_url(types.SimpleNamespace(name="sdk-example"))
            self.assertIsNone(json.loads(output.getvalue())["url"])
            inspect.assert_not_called()

    def test_invalid_session_id_fails_before_docker_or_state_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps({"input": "test", "session_id": 17}))
            with mock.patch.object(dev, "resolve", return_value={"profile": "sdk"}), mock.patch.object(dev, "existing_instance") as inspect:
                with self.assertRaises(SystemExit):
                    dev.command_sdk_run(types.SimpleNamespace(source="experiment:example", instance="sdk-example", input_file=str(path)))
                inspect.assert_not_called()

    def test_existing_sdk_instance_missing_home_never_creates_an_empty_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            input_file = target / "input.json"
            input_file.write_text(json.dumps({"input": "continue"}))
            manifest = {"profile": "sdk", "home_directory": str(target / "dsh-home")}
            with mock.patch.object(dev, "resolve", return_value={"profile": "sdk"}), \
                 mock.patch.object(dev, "instance_dir", return_value=target), \
                 mock.patch.object(dev, "existing_instance", return_value=(target, manifest)), \
                 mock.patch.object(dev, "validate_existing_identity"), \
                 mock.patch.object(dev, "require_docker_registration") as inspect, \
                 mock.patch.object(dev.subprocess, "Popen") as launch:
                with self.assertRaises(SystemExit):
                    dev.command_sdk_run(types.SimpleNamespace(source="experiment:example", instance="sdk-example", input_file=str(input_file)))
                inspect.assert_not_called()
                launch.assert_not_called()
                self.assertFalse((target / "dsh-home").exists())

    def test_existing_sdk_instance_must_keep_its_registered_plain_home(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            input_file = target / "input.json"
            input_file.write_text(json.dumps({"input": "continue"}))
            actual = target / "actual-home"
            actual.mkdir()
            (target / "dsh-home").symlink_to(actual, target_is_directory=True)
            for recorded in (str(target / "dsh-home"), str(actual), None):
                with self.subTest(recorded=recorded), \
                     mock.patch.object(dev, "resolve", return_value={"profile": "sdk"}), \
                     mock.patch.object(dev, "instance_dir", return_value=target), \
                     mock.patch.object(dev, "existing_instance", return_value=(target, {"profile": "sdk", "home_directory": recorded})), \
                     mock.patch.object(dev, "validate_existing_identity"), \
                     mock.patch.object(dev, "require_docker_registration") as inspect:
                    with self.assertRaises(SystemExit):
                        dev.command_sdk_run(types.SimpleNamespace(source="experiment:example", instance="sdk-example", input_file=str(input_file)))
                    inspect.assert_not_called()

    def test_stop_marker_prevents_source_resolution_and_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "stop-requested"
            marker.touch()
            output = io.StringIO()
            with mock.patch.dict(dev.os.environ, {"HARNESS_SDK_STOP_FILE": str(marker)}), \
                 mock.patch.object(dev, "resolve") as resolve, contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit):
                    dev.command_sdk_run(types.SimpleNamespace(instance="sdk-example"))
                resolve.assert_not_called()
                receipt = json.loads(output.getvalue())
                self.assertEqual(receipt["status"], "stopped")
                self.assertFalse(receipt["runtime_started"])

    def test_cancel_during_preparation_preserves_completed_instance_and_never_starts_node(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            home = target / "dsh-home"; home.mkdir()
            path = target / "input.json"; path.write_text(json.dumps({"input": "test"}))
            marker = target / "stop-requested"
            manifest = {"profile": "sdk", "home_directory": str(home), "sdk_operation_id": "old-operation", "status": "completed"}
            recorded = target / "instance.json"; recorded.write_text(json.dumps(manifest))
            original = recorded.read_bytes()
            contract = {"profile": "sdk", "agent_id": "sdk-example"}
            def preparing(_contract):
                marker.touch()
                return {"image_id": "fixture-image"}
            with mock.patch.dict(dev.os.environ, {"HARNESS_SDK_STOP_FILE": str(marker)}), \
                 mock.patch.object(dev, "resolve", return_value=contract), \
                 mock.patch.object(dev, "instance_dir", return_value=target), \
                 mock.patch.object(dev, "existing_instance", return_value=(target, manifest)), \
                 mock.patch.object(dev, "validate_existing_identity"), \
                 mock.patch.object(dev, "require_docker_registration"), \
                 mock.patch.object(dev, "running_dsh_image_id", return_value=(None, False)), \
                 mock.patch.object(dev, "read_model_policy", return_value={}), \
                 mock.patch.object(dev, "assert_direct_model_available"), \
                 mock.patch.object(dev, "check_environment"), \
                 mock.patch.object(dev, "validate_image_identity", side_effect=preparing), \
                 mock.patch.object(dev.subprocess, "Popen") as launch, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    dev.command_sdk_run(types.SimpleNamespace(source="experiment:example", instance="sdk-example", input_file=str(path)))
                launch.assert_not_called()
                self.assertEqual(recorded.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()

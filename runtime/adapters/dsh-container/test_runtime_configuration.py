"""配置挂载和运行装载错误的回归；Docker 仅作为外部边界替换。"""
import contextlib
import importlib.util
import io
import json
import subprocess
import types
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

ADAPTER = Path(__file__).resolve().parent
spec = importlib.util.spec_from_loader("runtime_configuration", SourceFileLoader("runtime_configuration", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


class RuntimeConfigurationTest(unittest.TestCase):
    def test_mount_preparation_uses_the_actual_existing_home_owner(self):
        with mock.patch.object(dev, "runtime_user", return_value={"DSH_RUNTIME_UID": "1012", "DSH_RUNTIME_GID": "1013"}) as user, \
                mock.patch.object(dev, "business_command", return_value={}) as prepare:
            dev.prepare_runtime_configuration({"business_control": {}}, (Path('/state'), {"home_directory": "/existing/home"}))
        user.assert_called_once_with('/existing/home')
        self.assertEqual(prepare.call_args.args[1], {"sitesFile": str(dev.sites_config(dev.REPO)), "uid": 1012, "gid": 1013, "business": False})

    def test_local_load_failure_reports_exact_file_without_overwriting_last_receipt(self):
        previous = {"asset_load": {"digest": "previous-success"}}
        receipt = {"ok": False, "nonce": "current", "error": "EACCES: permission denied, open '/opt/harness-config/sites.json'"}
        errors = io.StringIO()
        with mock.patch.object(dev, "load_instance", return_value=(Path('/state'), previous)), \
                mock.patch.object(dev, "observe_generation", return_value={"running": True, "id": "container"}), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(receipt), "")), \
                mock.patch.object(dev.time, "sleep") as sleep, contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit):
                dev.verify_load_receipt("fixture", {}, {"nonce": "current"})
        self.assertIn("EACCES", errors.getvalue())
        self.assertIn("/opt/harness-config/sites.json", errors.getvalue())
        sleep.assert_not_called()
        self.assertEqual(previous["asset_load"], {"digest": "previous-success"})

    def test_creation_stops_failed_local_runtime_and_never_prints_success(self):
        contract = {"agent_id": "fixture", "preset_id": "fixture"}
        args = types.SimpleNamespace(name="fixture", mode="verification", port=18500, dry_run=False, analysis_workspace=None)
        stdout = io.StringIO()
        patches = {
            "require_unused_docker_name": None, "check_environment": None, "validate_image_identity": {"image_id": "locked"},
            "assert_asset_dependencies": None, "preflight_new_instance": None, "prepare_runtime_configuration": None,
            "migrate_existing_instance": None, "port_in_use": False, "write_instance": Path('/state'), "compose_env": {},
            "prepare_load_expectation": {"nonce": "current"}, "run": None,
            "wait_for_service": [{"service": "dsh", "state": "running", "name": "fixture"}],
            "wait_for_instance_listener": True, "load_instance": (Path('/state'), {}),
        }
        with contextlib.ExitStack() as stack:
            for key, value in patches.items():
                stack.enter_context(mock.patch.object(dev, key, return_value=value))
            stop = stack.enter_context(mock.patch.object(dev, "stop_instance"))
            stack.enter_context(mock.patch.object(dev, "verify_load_receipt", side_effect=SystemExit(1)))
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            with self.assertRaises(SystemExit):
                dev._command_up(args, contract, None)
            stop.assert_called_once_with("fixture", {})
        self.assertEqual(stdout.getvalue(), "")


if __name__ == '__main__':
    unittest.main()

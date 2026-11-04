"""只替换 Docker/来源边界，不启动实例、不访问真实数据。"""
import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import types
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

ADAPTER = Path(__file__).resolve().parent
spec = importlib.util.spec_from_loader("reload_dev", SourceFileLoader("reload_dev", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)
ASSET = "sha256:" + "a" * 64
GENERATION = "sha256:" + "b" * 64


class InstanceReloadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        repository = mock.patch.object(dev, "REPO", root)
        repository.start()
        self.addCleanup(repository.stop)
        state = mock.patch.object(dev, "STATE_ROOT", root)
        state.start()
        self.addCleanup(state.stop)
        self.target = root / "exact-one"
        self.target.mkdir()
        self.manifest = {"name": "exact-one", "asset_root": str(root), "source_id": "experiment:EXP-fixture-001",
                         "source_ref": "fixed-ref", "mode": "eval", "port": 23001,
                         "home_directory": "/existing/home", "home_volume": "existing-volume",
                         "trusted_host": "example.test", "lan_access": False, "unsafe_no_auth": False,
                         "skip_testing_notice": True, "session_preset": "fixture",
                         "mounts": {"plugin_node_modules": "/existing/node_modules"},
                         "model_policy": {"default": {"provider": "registered", "model": "same-model"}},
                         "business_control": {"launch_config_file": "/existing/business.json",
                                              "access_mode": "anonymous", "identity_mode": "development",
                                              "runtime_generation": "same-gateway-identity"},
                         "asset_load": {"digest": "previous-success", "loaded_at": "previous-time"}}
        self.save()
        self.generation = {"id": "exact-container", "started_at": "new-process-time", "running": True}
        self.status = {"current_digest": ASSET, "generation_digest": GENERATION, "status": "unknown"}

    def save(self):
        (self.target / "instance.json").write_text(json.dumps(self.manifest))

    def args(self, **overrides):
        return types.SimpleNamespace(**{**dict(name="exact-one", dry_run=False, model_policy="/projection.json",
            expected_asset_digest=ASSET, expected_generation_digest=GENERATION), **overrides})

    def test_stopped_instance_rejected_before_source_resolution_or_launch(self):
        with mock.patch.object(dev, "observe_generation", return_value={**self.generation, "running": False}), \
                mock.patch.object(dev, "asset_contract") as source, mock.patch.object(dev, "command_up") as up:
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                dev.reload_one(self.args())
            source.assert_not_called()
            up.assert_not_called()

    def test_reload_reuses_exact_registered_parameters_and_lifecycle(self):
        with mock.patch.object(dev, "reload_snapshot", return_value=({}, self.manifest, self.status)), \
                mock.patch.object(dev, "command_up") as up:
            dev.reload_one(self.args())
            launch = up.call_args.args[0]
        for key in ("name", "source_ref", "mode", "port", "trusted_host", "lan_access", "unsafe_no_auth", "skip_testing_notice"):
            self.assertEqual(getattr(launch, key), self.manifest[key])
        self.assertEqual(launch.source, self.manifest["source_id"])
        self.assertEqual(launch.plugin_node_modules, "/existing/node_modules")
        self.assertEqual(launch.business_control, "/existing/business.json")
        self.assertIsNone(launch.business_access_mode)
        self.assertIsNone(launch.business_identity_mode)
        self.assertTrue(launch.replace)
        self.assertFalse(launch.migrate_home)
        self.assertFalse(launch.allow_missing_env)
        self.assertEqual(launch.model_policy, "/projection.json")
        self.assertEqual(launch.reload_manifest, self.manifest)

    def test_reload_snapshot_bypasses_status_cache_for_cas(self):
        with mock.patch.object(dev, "observe_generation", return_value=self.generation), \
                mock.patch.object(dev, "asset_contract", return_value={}), \
                mock.patch.object(dev, "asset_command", return_value=self.status) as assets:
            dev.reload_snapshot("exact-one")
        self.assertIs(assets.call_args.kwargs["cache"], False)

    def test_cas_conflict_blocks_lifecycle_before_preparation(self):
        for status in ({**self.status, "current_digest": "sha256:" + "c" * 64},
                       {**self.status, "generation_digest": "sha256:" + "d" * 64}):
            args = self.args(reload_manifest=self.manifest, source=self.manifest["source_id"], mode="eval",
                             analysis_workspace=None)
            with mock.patch.object(dev, "reload_snapshot", return_value=({}, self.manifest, status)), \
                    mock.patch.object(dev, "model_policy_start_lock", return_value=contextlib.nullcontext()), \
                    mock.patch.object(dev, "instance_startup_lock", return_value=contextlib.nullcontext()), \
                    mock.patch.object(dev, "prepare_up") as prepare, mock.patch.object(dev, "stop_instance") as stop:
                with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                    dev.command_up(args)
                prepare.assert_not_called()
                stop.assert_not_called()

    def test_batch_partial_failure_preserves_receipts_and_does_not_replay(self):
        def reload(args):
            if args.name == "failed":
                dev.fail("装载尚未核验")
            print(json.dumps({"name": args.name, "asset_status": {"status": "current"}}))
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(dev, "reload_one", side_effect=reload) as execute, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit):
                dev.command_reload(self.args(name=["exact-one", "failed"], expected_asset_digest=[ASSET, ASSET],
                                             expected_generation_digest=[GENERATION, GENERATION]))
        result = json.loads(output.getvalue())
        self.assertTrue(result["partial_success"])
        self.assertEqual([item["ok"] for item in result["items"]], [True, False])
        self.assertIn("尚未核验", result["items"][1]["error"])
        self.assertEqual(execute.call_count, 2)

    def test_verified_receipt_requires_matching_bytes_process_source_and_preset(self):
        files = [{"path": "/opt/source.js", "sha256": "e" * 64}]
        expected = {"nonce": "new-nonce", "source_id": self.manifest["source_id"], "digest": ASSET,
                    "preset_id": "fixture", "files": files, "source_files": files, "configuration_digest": ASSET}
        receipt = {**{key: value for key, value in expected.items() if key != "files"}, "ok": True,
                   "files_digest": "sha256:" + hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest(),
                   "pid": 123, "loaded_at": "new-loaded-time"}
        def assets(operation, *_args, **_kwargs):
            return files if operation == "applied" else {"digest": ASSET}
        with mock.patch.object(dev, "observe_generation", return_value=self.generation), \
                mock.patch.object(dev, "asset_contract", return_value={}), \
                mock.patch.object(dev, "asset_command", side_effect=assets), \
                mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(receipt), "")):
            status = dev.verify_load_receipt("exact-one", {}, expected)
        self.assertEqual(status["status"], "current")
        saved = json.loads((self.target / "instance.json").read_text())
        self.assertEqual(saved["asset_load"]["container_id"], "exact-container")
        self.assertEqual(saved["asset_load"]["verification"], "runtime-observer")
        self.assertEqual(saved["asset_load"]["source_files"], files)
        self.assertEqual(saved["asset_load"]["configuration_digest"], ASSET)
        self.assertEqual(saved["asset_reload_attempt"]["status"], "verified")
        for broken in ({**receipt, "nonce": "old-nonce"}, {**receipt, "files_digest": "invalid"}):
            self.save()
            with mock.patch.object(dev, "observe_generation", return_value=self.generation), \
                    mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(broken), "")), \
                    mock.patch.object(dev.time, "sleep"), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    dev.verify_load_receipt("exact-one", {}, expected)
            self.assertEqual(json.loads((self.target / "instance.json").read_text())["asset_load"], self.manifest["asset_load"])

    def test_mid_reload_source_change_cannot_produce_success(self):
        with mock.patch.object(dev, "asset_contract", return_value={}), \
                mock.patch.object(dev, "asset_command", return_value={"digest": "changed"}), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                dev.assert_reload_source({"reload_manifest": self.manifest, "reload_source_digest": ASSET})
        self.assertEqual(json.loads((self.target / "instance.json").read_text())["asset_load"]["digest"], "previous-success")

    def test_failure_after_stop_keeps_last_receipt_and_marks_unknown(self):
        def fail_after_stop(*_):
            dev.record_reload_attempt("exact-one", "running", "正在重载")
            dev.fail("装载尚未核验")
        args = self.args(source=self.manifest["source_id"], mode="eval", analysis_workspace=None,
                         reload_manifest=self.manifest)
        with mock.patch.object(dev, "assert_reload_cas"), \
                mock.patch.object(dev, "model_policy_start_lock", return_value=contextlib.nullcontext()), \
                mock.patch.object(dev, "instance_startup_lock", return_value=contextlib.nullcontext()), \
                mock.patch.object(dev, "prepare_up", return_value=({}, (self.target, self.manifest))), \
                mock.patch.object(dev, "existing_runtime_environment", return_value={}), \
                mock.patch.object(dev, "_command_up", side_effect=fail_after_stop), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                dev.command_up(args)
        saved = json.loads((self.target / "instance.json").read_text())
        self.assertEqual(saved["asset_load"], self.manifest["asset_load"])
        self.assertEqual(saved["asset_reload_attempt"]["status"], "unknown")


if __name__ == "__main__":
    unittest.main()

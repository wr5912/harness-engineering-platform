"""程序与数据分离后的路径、来源与旧 fixture 兼容合同。"""

import json
import os
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from workspace_paths import asset_root, instance_belongs_to_workspace, instances_root, source_catalog, sites_config, workspace_id


class WorkspacePathsTests(unittest.TestCase):
    def test_variant_legacy_registration_is_bound_to_its_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "workspace.json").write_text('{"schemaVersion":1,"id":"workspace-fixture"}')
            identity = "VAR-example-agent-001-r0123456789ab"
            candidate = root / "evolution/experiments" / identity / "candidate"
            manifest = {"source_id": "experiment:" + identity,
                        "mounts": {"workspace": str(candidate / "dsh/workspace")}}
            self.assertTrue(instance_belongs_to_workspace(root, manifest))
            manifest["mounts"]["managed"] = str(root / "another-candidate")
            self.assertFalse(instance_belongs_to_workspace(root, manifest))
            manifest["mounts"].pop("managed")
            manifest["source_id"] = "experiment:VAR-example--agent-001-r0123456789ab"
            self.assertFalse(instance_belongs_to_workspace(root, manifest))

    def test_first_agent_can_be_created_in_empty_external_workspace(self):
        adapter = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "workspace.json").write_text('{"schemaVersion":1,"id":"workspace-fixture"}')
            (root / "config").mkdir()
            (root / "config/sources.json").write_text('{"schema_version":"1.1","sources":{}}')
            created = subprocess.run([sys.executable, str(adapter / "dsh-dev"), "--repo", str(root),
                                      "init", "workspace-fixture"], capture_output=True, text=True, check=True)
            identity = json.loads(created.stdout)
            resolved = subprocess.run([sys.executable, str(adapter / "source_contract.py"), "--repo", str(root),
                                       "--source", identity["source_id"]], capture_output=True, text=True, check=True)
            contract = json.loads(resolved.stdout)
            self.assertEqual(contract["asset_root"], str(root))
            self.assertEqual(contract["runtime_lock"], str(adapter / "source.lock.json"))
            self.assertTrue((root / "agents/workspace-fixture/manifest.yaml").is_file())
            self.assertFalse((root / "runtime").exists())
            self.assertFalse((root / ".agents").exists())

    def test_initialized_workspace_never_falls_back_to_legacy_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = root / "runtime/adapters/dsh-container/sources.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{}')
            self.assertEqual(source_catalog(root), legacy)
            (root / "workspace.json").write_text(json.dumps({"schemaVersion": 1, "id": "workspace-test"}))
            self.assertEqual(source_catalog(root), root / "config/sources.json")
            self.assertEqual(workspace_id(root), "workspace-test")

    def test_sites_configuration_stays_in_selected_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(sites_config(root), root / "config/sites.json")
            legacy = root / "runtime/adapters/dsh-web/sites.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"platform":"/hep/","assistant":"/assistant/"}')
            self.assertEqual(sites_config(root), legacy)
            (root / "workspace.json").write_text('{"schemaVersion":1,"id":"workspace-test"}')
            self.assertEqual(sites_config(root), root / "config/sites.json")

    def test_instance_overrides_and_default_use_one_data_workspace(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(temporary)
            self.assertEqual(instances_root(root), root / ".local/instances")
            os.environ["XDG_STATE_HOME"] = str(root / "isolated")
            self.assertEqual(instances_root(root), root / "isolated/dsh-dev")
            os.environ["HARNESS_INSTANCE_STATE_ROOT"] = str(root / "specific")
            self.assertEqual(instances_root(root), root / "specific")
            os.environ["HARNESS_ASSET_ROOT"] = str(root)
            self.assertEqual(asset_root(), root)

    def test_default_data_root_does_not_depend_on_working_directory(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home}, clear=True):
            self.assertEqual(asset_root(), Path.home() / "harness-engineering-platform-data")

    def test_deployment_locator_selects_data_root_and_explicit_environment_has_priority(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {"HOME": temporary}, clear=True):
            locator = Path(temporary) / ".config/harness-engineering-platform/workspace.json"
            locator.parent.mkdir(parents=True)
            selected = Path(temporary) / "selected data"
            locator.write_text(json.dumps({"assetRoot": str(selected)}))
            self.assertEqual(asset_root(), selected)
            explicit = Path(temporary) / "explicit"
            os.environ["HARNESS_ASSET_ROOT"] = str(explicit)
            self.assertEqual(asset_root(), explicit)

    def test_instance_state_overrides_expand_home_and_anchor_relative_paths_to_assets(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(temporary) / "user data"
            home = Path(temporary) / "home"
            os.environ["HOME"] = str(home)
            for value, expected in [("~", home), ("~/private state", home / "private state"),
                                    ("state/instances", root / "state/instances")]:
                os.environ["HARNESS_INSTANCE_STATE_ROOT"] = value
                self.assertEqual(instances_root(root), expected)
            del os.environ["HARNESS_INSTANCE_STATE_ROOT"]
            os.environ["XDG_STATE_HOME"] = "state"
            self.assertEqual(instances_root(root), root / "state/dsh-dev")
            os.environ["XDG_STATE_HOME"] = "~/state"
            self.assertEqual(instances_root(root), home / "state/dsh-dev")
            os.environ["HARNESS_INSTANCE_STATE_ROOT"] = "~another-user/state"
            with self.assertRaisesRegex(ValueError, "仅支持当前用户"):
                instances_root(root)

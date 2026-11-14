"""原生 Harness 没有工作区 .env 时仍可启动，只挂载实际存在的文件。"""

import importlib.util
import contextlib
import io
from importlib.machinery import SourceFileLoader
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
import yaml


ADAPTER = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_loader("native_compose", SourceFileLoader("native_compose", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


class NativeComposeTest(unittest.TestCase):
    def test_deleted_instance_can_reuse_home_and_asset_cache(self):
        with TemporaryDirectory() as directory:
            target = Path(directory)
            home = target / "dsh-home"
            home.mkdir()
            session = home / "session.json"
            session.write_text('{"session":"preserved"}')
            cache = target / "asset-file-cache.json"
            cache.write_text('{"files":[]}')
            (target / "instance.json").write_text('{}')
            (target / "compose.yaml").write_text('services: {}')
            manifest = {"home_directory": str(home), "project": "dsh-dev-native"}
            with mock.patch.object(dev, "instance_dir", return_value=target), \
                 mock.patch.object(dev, "require_docker_registration"), \
                 mock.patch.object(dev, "project_containers", return_value=[]):
                self.assertTrue(dev.delete_instance("native", manifest)["deleted"])
                self.assertIsNone(dev.existing_instance("native"))
                self.assertEqual(session.read_text(), '{"session":"preserved"}')
                self.assertEqual(cache.read_text(), '{"files":[]}')
                (target / "unknown-registration").touch()
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    dev.existing_instance("native")

    def test_only_existing_workspace_environment_is_masked(self):
        template = (ADAPTER / "verification.compose.yaml").read_text()
        for exists in (False, True):
            for analysis in (False, True):
                with self.subTest(exists=exists, analysis=analysis):
                    rendered = dev.render_compose(template, mode="verification", name="native", project="dsh-dev-native",
                                                  port=3081, workspace_env=exists, analysis_workspace=analysis)
                    compose = yaml.safe_load(rendered)
                    mounts = compose["services"]["dsh"]["volumes"]
                    targets = [mount.get("target") for mount in mounts if isinstance(mount, dict)]
                    self.assertEqual("/work/harness/workspace/.env" in targets, exists and not analysis)
                    self.assertIn("/var/lib/dsh/.env", targets)
                    self.assertIn("HOME=/var/lib/dsh", compose["services"]["dsh"]["environment"])


if __name__ == "__main__":
    unittest.main()

"""迁移来源的真实 Node 投影、持久项目副本与 Compose 装载合同。"""

import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


ADAPTER = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_loader("dsh_dev_harness_runtime", SourceFileLoader("dsh_dev_harness_runtime", str(ADAPTER / "dsh-dev")))
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


class HarnessRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.candidate = self.root / "candidate"
        self.target = self.root / "instance"
        self.target.mkdir()
        self.original_model = {"provider": "source", "model": "original", "reasoningEffort": "high"}
        self.selected_model = {"provider": "replacement", "model": "selected", "reasoningEffort": "off"}
        self.child_model = {"provider": "review", "model": "independent"}
        self.write("dsh/workspace/AGENTS.md", "固定角色正文")
        self.write("dsh/workspace/project/source.ts", "export const total = 1\n")
        self.write("dsh/presets/main/agent.cordis.yml", "[]\n")
        self.write("dsh/presets/reviewer/agent.cordis.yml", "[]\n")
        self.write("harness.yaml", json.dumps({
            "loadable_assets": {"preset_id": "main", "preset_file": "main/agent.cordis.yml"},
            "model_bindings": {"main": self.original_model, "presets": {"reviewer": self.child_model}},
            "role_instructions": {"main": "dsh/workspace/AGENTS.md"},
            "project_workspace": {"path": "dsh/workspace/project"},
        }))
        module = ADAPTER.parents[2] / "platform/plugin/src/models/harness-runtime.ts"
        result = subprocess.run([dev.NODE_EXECUTABLE, "--input-type=module", "-e", "import{readFileSync}from'node:fs';import{parseHarnessRuntime}from" + json.dumps(module.as_uri()) + ";console.log(JSON.stringify(parseHarnessRuntime(readFileSync(process.argv[1],'utf8'))))", str(self.candidate / "harness.yaml")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.runtime = json.loads(result.stdout)
        self.contract = {"candidate_source_root": str(self.candidate), "harness_runtime": self.runtime,
                         "model_policy": {"default": self.selected_model}}

    def write(self, path, content):
        target = self.candidate / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def test_real_node_projection_uses_explicit_main_keeps_child_and_preserves_project_edits(self):
        seed = self.candidate / "dsh/workspace/project/source.ts"
        seed.chmod(0o444)
        projected = dev.prepare_harness_projection(self.contract, self.target)
        config = json.loads((self.target / "harness-runtime.json").read_text())
        self.assertEqual(config["model_bindings"]["main"], self.selected_model)
        self.assertEqual(config["model_bindings"]["presets"]["reviewer"], self.child_model)
        self.assertEqual(self.runtime["model_bindings"]["main"], self.original_model)
        main = (self.target / "runtime-presets/main/agent.cordis.yml").read_text()
        self.assertIn("replacement", main)
        self.assertIn("/opt/harness-candidate/dsh/workspace/AGENTS.md", main)
        project = Path(projected["project_workspace_host"])
        self.assertTrue(os.access(project / "source.ts", os.W_OK))
        (project / "source.ts").write_text("export const total = 2\n")
        dev.prepare_harness_projection(self.contract, self.target)
        self.assertEqual((project / "source.ts").read_text(), "export const total = 2\n")
        self.assertEqual(seed.read_text(), "export const total = 1\n")

    def test_project_dependency_mounts_follow_project_cwd_without_mutating_receipt(self):
        original = {"source": "/prepared/modules", "target": "/work/harness/workspace/project/node_modules", "read_only": True}
        self.contract["asset_dependencies"] = {"mounts": [original]}
        mounts = dev.asset_dependency_mounts(self.contract)
        self.assertEqual(mounts, [original, {**original, "target": "/work/project/node_modules"}])
        self.assertEqual(self.contract["asset_dependencies"]["mounts"], [original])
        rendered = dev.render_compose((ADAPTER / "verification.compose.yaml").read_text(), mode="verification", name="migrated-role", project=dev.project_name("migrated-role"), port=18501, harness_runtime=True, project_workspace=True, dependency_mounts=mounts)
        self.assertIn("working_dir: /work/project", rendered)
        self.assertIn("DSH_PERMISSION_MODE=workspace-write", rendered)
        self.assertIn("target: /opt/harness-candidate\n        read_only: true", rendered)
        self.assertIn("target: /work/project\n        read_only: false", rendered)
        self.assertIn('target: "/work/project/node_modules"', rendered)
        legacy = dev.render_compose((ADAPTER / "verification.compose.yaml").read_text(), mode="verification", name="legacy-role", project=dev.project_name("legacy-role"), port=18502)
        self.assertIn("working_dir: /work/harness/workspace", legacy)
        self.assertIn("DSH_PERMISSION_MODE=read-only", legacy)
        self.assertNotIn("target: /work/project", legacy)

    def test_native_catalog_default_effort_projects_without_changing_source_binding(self):
        effective_child = {**self.child_model, "reasoningEffort": "off"}
        self.contract["model_policy"]["resolved_model_bindings"] = {
            "main": self.selected_model, "presets": {"reviewer": effective_child},
        }
        dev.prepare_harness_projection(self.contract, self.target)
        config = json.loads((self.target / "harness-runtime.json").read_text())
        self.assertEqual(config["model_bindings"]["presets"]["reviewer"], effective_child)
        self.assertEqual(self.runtime["model_bindings"]["presets"]["reviewer"], self.child_model)
        self.assertRegex((self.target / "runtime-presets/reviewer/agent.cordis.yml").read_text(), r"reasoningEffort: ['\"]?off['\"]?")

    def test_preserved_project_cannot_be_adopted_by_different_source(self):
        projected = dev.prepare_harness_projection(self.contract, self.target)
        project = Path(projected["project_workspace_host"])
        (project / "source.ts").write_text("operator edit\n")
        other = {**self.contract, "candidate_source_root": str(self.root / "other-candidate")}
        with self.assertRaises(SystemExit):
            dev.assert_project_workspace_origin(other, self.target)
        with self.assertRaises(SystemExit):
            dev.assert_project_workspace_origin({}, self.target)
        self.assertEqual((project / "source.ts").read_text(), "operator edit\n")
        (self.target / "project-workspace-source.json").unlink()
        with self.assertRaises(SystemExit):
            dev.assert_project_workspace_origin(self.contract, self.target)

    def test_interrupted_project_copy_does_not_publish_partial_workspace(self):
        def interrupted(source, destination):
            destination.mkdir()
            (destination / "partial.ts").write_text("partial\n")
            raise OSError("interrupted copy")
        with mock.patch.object(dev.shutil, "copytree", side_effect=interrupted):
            with self.assertRaises(OSError):
                dev.prepare_harness_projection(self.contract, self.target)
        self.assertFalse((self.target / "project-workspace").exists())
        self.assertFalse((self.target / "project-workspace.pending").exists())
        self.assertTrue((self.target / "project-workspace-source.json").is_file())
        dev.prepare_harness_projection(self.contract, self.target)
        self.assertEqual((self.target / "project-workspace/source.ts").read_text(), "export const total = 1\n")

    def test_node_dependency_probe_runs_without_bundling_or_type_transform(self):
        result = subprocess.run([dev.NODE_EXECUTABLE, str(ADAPTER / "harness-runtime.mts"),
                                 "--dependencies", str(self.root), "EXP-sample-001-r0123456789ab"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "pending")
        self.assertNotIn("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", result.stderr)

    def test_project_only_legacy_instance_uses_volume_home_without_key_error(self):
        manifest = {"name": "legacy", "project_workspace_host": str(self.target / "project-workspace")}
        with mock.patch.object(dev, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")):
            self.assertEqual(dev.home_volume(manifest), (dev.project_name("legacy") + "-home", False))


if __name__ == "__main__":
    unittest.main()

"""镜像身份只包含本次构建的实际 Web 输出。"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import source_contract


class ImageInputsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="runtime-image-inputs-")
        self.addCleanup(self.directory.cleanup)
        self.program = Path(self.directory.name) / "program"
        self.adapter = self.program / "runtime/adapters/dsh-container"
        for name in source_contract.image_build_input_digests():
            if name.startswith("web/"):
                relative = "runtime/adapters/dsh-web/lib/" + name.removeprefix("web/")
            elif name.startswith("standalone/"):
                relative = "platform/plugin/lib/" + name.removeprefix("standalone/")
            else:
                relative = "runtime/adapters/dsh-container/" + name
            target = self.program / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_contract.ADAPTER.parents[2] / relative, target)
        self.web = self.program / "runtime/adapters/dsh-web/lib"

    def inputs(self):
        return source_contract.image_build_input_digests(lock_path=self.adapter / "source.lock.json", adapter=self.adapter)

    def test_obsolete_chunks_do_not_change_identity_but_active_outputs_do(self):
        original = self.inputs()
        (self.web / "chunk-OBSOLETE.mjs").write_text("old process artifact")
        self.assertEqual(original, self.inputs())
        (self.web / "container-webserver.mjs").write_text("changed active adapter")
        self.assertNotEqual(original, self.inputs())

    def test_missing_output_reports_its_exact_path(self):
        path = self.web / "container-webserver.mjs"
        path.unlink()
        with self.assertRaisesRegex(ValueError, str(path)):
            self.inputs()

    def test_invalid_or_missing_manifest_reports_its_exact_path(self):
        path = self.web / "build.outputs.json"
        for value in ({"schemaVersion": 1, "files": ["../outside.mjs"]}, {"schemaVersion": 1, "files": ["a.mjs", "a.mjs"]}, {}):
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, str(path)):
                self.inputs()
        path.unlink()
        with self.assertRaisesRegex(ValueError, str(path)):
            self.inputs()


if __name__ == "__main__":
    unittest.main()

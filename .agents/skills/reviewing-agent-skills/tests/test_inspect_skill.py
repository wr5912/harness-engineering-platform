"""Run: python3 -m unittest discover -s reviewing-agent-skills/tests -v"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect_skill.py"
spec = importlib.util.spec_from_file_location("skill_inspector", SCRIPT)
inspector = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(inspector)


class InspectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "sample-skill"
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, s):
        (self.root / "SKILL.md").write_text(s, encoding="utf-8")

    def test_valid_skill(self):
        self.put("---\nname: sample-skill\ndescription: >-\n  Reviews an existing agent skill when an author asks for a focused,\n  evidence-backed adversarial review with precise suggestions.\n---\n# Instructions\nReview it.\n")
        result = inspector.inspect(self.root)
        self.assertEqual([], [x for x in result["findings"] if x["level"] == "ERROR"])

    def test_missing_metadata(self):
        self.put("# No frontmatter\nReview a skill.\n")
        self.assertIn("META-001", [x["id"] for x in inspector.inspect(self.root)["findings"]])

    def test_bad_name(self):
        self.put("---\nname: Bad--Name\ndescription: test\n---\nReview skill.\n")
        self.assertIn("META-002", [x["id"] for x in inspector.inspect(self.root)["findings"]])

    def test_missing_resource(self):
        self.put("---\nname: sample-skill\ndescription: A useful skill to review other skills in local projects.\n---\nRead `references/missing.md` now.\n")
        self.assertIn("RES-002", [x["id"] for x in inspector.inspect(self.root)["findings"]])

    def test_mcp_name_is_only_review_signal(self):
        self.put("---\nname: sample-skill\ndescription: Reviews the robustness of a real agent skill with tools.\n---\nCall mcp__legacy__get_config when this stable tool exists.\n")
        results = inspector.inspect(self.root)["findings"]
        self.assertIn("MCP-001", [x["id"] for x in results])
        self.assertFalse([x for x in results if x["id"] == "MCP-001" and x["level"] == "ERROR"])

    def test_does_not_run_script(self):
        self.put("---\nname: sample-skill\ndescription: Reviews other skills based on static inspection only.\n---\nReview it.\n")
        script = self.root / "scripts" / "not-to-be-run.py"
        script.parent.mkdir()
        marker = self.root / "side_effect"
        script.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('BAD')\n", encoding="utf-8")
        inspector.inspect(self.root, include_references=True)
        self.assertFalse(marker.exists())

    def test_own_skill_does_not_have_structural_errors(self):
        own = Path(__file__).resolve().parents[1]
        result = inspector.inspect(own)
        self.assertEqual([], [x for x in result["findings"] if x["level"] == "ERROR"])



class PackageClosureTests(unittest.TestCase):
    def test_bare_sibling_private_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "example"
            other = Path(temporary) / "other"
            root.mkdir()
            other.mkdir()
            (other / "SKILL.md").write_text("# Public entry")
            (root / "SKILL.md").write_text("---\nname: example\ndescription: Reviews package closure when an existing skill needs auditing.\n---\nRead `other/references/private.md`.\n[Handoff](../other/SKILL.md)\n")
            results = inspector.inspect(root, include_references=True)["findings"]
            private = [f for f in results if f["id"] == "PKG-004"]
            self.assertEqual(len(private), 1)
            self.assertIn("other/references/private.md", private[0]["message"])

    def test_nested_missing_and_private_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "example"
            (root / "references").mkdir(parents=True)
            (root / "SKILL.md").write_text("---\nname: example\ndescription: Reviews package closure when an existing skill needs auditing.\n---\n[Method](references/method.md)\n")
            (root / "references/method.md").write_text("[Missing](missing.md)\n[Private](../../other/references/method.md)\n[Handoff](../../other/SKILL.md)\n")
            results = inspector.inspect(root, include_references=True)["findings"]
            self.assertTrue(any(f["id"] == "PKG-003" and f["file"] == "references/method.md" for f in results))
            self.assertTrue(any(f["id"] == "PKG-004" for f in results))
            self.assertFalse(any(f["level"] == "ERROR" and "Handoff" in f["message"] for f in results))

    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "example"
            root.mkdir()
            (root / "SKILL.md").write_text("---\nname: example\ndescription: Reviews package closure when an existing skill needs auditing.\n---\nReview.\n")
            (root / "outside").symlink_to(Path(temporary))
            results = inspector.inspect(root, include_references=True)["findings"]
            self.assertTrue(any(f["id"] == "PKG-001" for f in results))


if __name__ == "__main__":
    unittest.main()

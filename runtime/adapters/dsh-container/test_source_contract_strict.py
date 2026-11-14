"""当前运行合同不兼容旧 Experiment/Candidate 来源。"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_contract


class StrictSourceContractTest(unittest.TestCase):
    def test_legacy_selectors_are_rejected_before_filesystem_lookup(self):
        for selector in ("experiment:EXP-example-001", "EXP-example-001", "candidate:old"):
            with self.subTest(selector=selector):
                with self.assertRaises(ValueError):
                    source_contract.resolve(selector, repo=Path("/does/not/exist"))

    def test_instance_desired_source_rejects_legacy_manifest(self):
        with self.assertRaisesRegex(ValueError, "incompatible legacy source"):
            source_contract.instance_desired_source({"source_id": "experiment:EXP-example-001"})

    def test_business_source_does_not_fallback_to_data_or_sibling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agents/example/evaluation.md").parent.mkdir(parents=True)
            (root / "agents/example/evaluation.md").write_text("# stale data\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("HARNESS_BUSINESS_AGENTS_ROOT", None)
                result = source_contract._agent_asset_roots(root, "example")
            self.assertIsNone(result["reference_root"])
            self.assertIsNone(result["business_root"])


if __name__ == "__main__":
    unittest.main()

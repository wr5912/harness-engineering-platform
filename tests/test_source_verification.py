from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "source_verification_validator", ROOT / "runtime/research/validate_experiment.py"
)
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def verification(*, implementation: bool, fixture: bool) -> dict:
    names = ["candidate", "workspace", "presets", "managed"]
    if implementation:
        names.append("evaluation_implementation")
    if fixture:
        names.append("mcp_fixture")
    return {"status": "matched", "reason": None, "checks": [
        {"component": name, "status": "matched", "expected_sha256": "a" * 64,
         "actual_sha256": "a" * 64} for name in names
    ]}


class SourceVerificationTests(unittest.TestCase):
    def test_only_locked_optional_components_are_accepted(self) -> None:
        for implementation in (False, True):
            for fixture in (False, True):
                with self.subTest(implementation=implementation, fixture=fixture):
                    value = verification(implementation=implementation, fixture=fixture)
                    self.assertTrue(VALIDATOR.valid_source_verification(value, implementation, fixture))
                    self.assertFalse(VALIDATOR.valid_source_verification(value, implementation, not fixture))

    def test_locked_fixture_cannot_be_replaced_or_duplicated(self) -> None:
        original = verification(implementation=True, fixture=True)
        for component in ("workspace", "arbitrary_fixture"):
            with self.subTest(component=component):
                value = copy.deepcopy(original)
                value["checks"][-1]["component"] = component
                self.assertFalse(VALIDATOR.valid_source_verification(value, True, True))

    def test_changed_fixture_requires_changed_aggregate(self) -> None:
        value = verification(implementation=True, fixture=True)
        value["checks"][-1].update(status="changed", actual_sha256="b" * 64)
        self.assertFalse(VALIDATOR.valid_source_verification(value, True, True))
        value.update(status="changed", reason="source-changed")
        self.assertTrue(VALIDATOR.valid_source_verification(value, True, True))

    def test_unavailable_fixture_keeps_failure_reason(self) -> None:
        value = verification(implementation=True, fixture=True)
        value["checks"][-1].update(status="unavailable", actual_sha256=None, error_type="FileNotFoundError")
        value.update(status="unavailable", reason="source-unavailable")
        self.assertTrue(VALIDATOR.valid_source_verification(value, True, True))
        del value["checks"][-1]["error_type"]
        self.assertFalse(VALIDATOR.valid_source_verification(value, True, True))

    def test_fixture_digest_and_check_fields_remain_strict(self) -> None:
        for updates in ({"actual_sha256": "bad"}, {"unexpected": True}, {"status": "ignored"}):
            with self.subTest(updates=updates):
                value = verification(implementation=True, fixture=True)
                value["checks"][-1].update(updates)
                self.assertFalse(VALIDATOR.valid_source_verification(value, True, True))


if __name__ == "__main__":
    unittest.main()

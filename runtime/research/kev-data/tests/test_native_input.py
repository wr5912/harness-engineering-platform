"""Synthetic rendering regressions and optional pinned native API comparison."""
from copy import deepcopy
import importlib.util
import os
from pathlib import Path
import unittest

import native_input


class NativeInputTests(unittest.TestCase):
    def test_rendered_collisions_and_option_semantics_are_distinguished(self):
        left = {"type": "choice", "instructions": {"task": "choose"},
                "criteria": {"read": {"reason": "known file"}, "search": "unknown path"}}
        right = deepcopy(left)
        right["instructions"] = "task: choose"
        right["criteria"] = {"search": "unknown path", "read": "reason: known file"}
        self.assertEqual(native_input.state_key({"request": "same"}), native_input.state_key("request: same"))
        self.assertEqual(native_input.question_key({"request": "same"}, left),
                         native_input.question_key("request: same", right))
        score = {"type": "score", "instructions": "Severity", "criteria": ["low", "high"]}
        changed = {**score, "criteria": ["high", "low"]}
        self.assertNotEqual(native_input.question_key("same", score), native_input.question_key("same", changed))

    def test_integrity_hash_preserves_physical_input_order(self):
        record = {"state": {"z": "first", "a": "second"}, "questions": {"route": {
            "type": "choice", "instructions": "Choose", "criteria": {"z": "first", "a": "second"}, "label": "z"}}}
        changed = deepcopy(record)
        changed["state"] = dict(reversed(list(changed["state"].items())))
        self.assertNotEqual(native_input.record_key(record), native_input.record_key(changed))
        changed = deepcopy(record)
        changed["questions"]["route"]["criteria"] = {"a": "second", "z": "first"}
        self.assertNotEqual(native_input.record_key(record), native_input.record_key(changed))
        self.assertEqual(native_input.question_key(record["state"], record["questions"]["route"]),
                         native_input.question_key(changed["state"], changed["questions"]["route"]))

    @unittest.skipUnless(os.environ.get("KEV_UPSTREAM_ROOT"), "Set KEV_UPSTREAM_ROOT to the verified pinned Kev source")
    def test_actual_native_render_and_request_mapping(self):
        root = Path(os.environ["KEV_UPSTREAM_ROOT"])
        spec = importlib.util.spec_from_file_location("kev_render_identity_reference", root / "kev/api.py")
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        states = [None, False, True, 0, 1.5, "人工合成", [None, True, {"z": "first", "a": [1, 2]}],
                  {"z": "first", "nested": {"a": "second", "values": [False, "text"]}}]
        questions = [
            {"type": "choice", "instructions": {"task": "choose"},
             "criteria": {"z": {"reason": "first"}, "a": None, "empty": ""}},
            {"type": "noul", "instructions": ["ready", "now"], "criteria": {"false": "missing", "true": {"why": "ready"}}},
            {"type": "noul"},
            {"type": "score", "instructions": None, "criteria": ["low", {"level": "high"}, 4]},
        ]
        for state in states:
            self.assertEqual(native_input.render(state), api.render(state))
            for question in questions:
                request = api.SystemOneRequest.model_validate({"state": state, "questions": {"q": question}})
                actual, metadata = api.to_record(request)
                form = native_input._question_form(question, canonical_choices=False)
                self.assertEqual(actual["state"], native_input.render(state))
                self.assertEqual(actual["questions"][0]["instr"], form["instructions"])
                self.assertEqual(actual["questions"][0]["options"], [text for _, text in form["options"]])
                self.assertEqual(metadata[0]["keys"], [key for key, _ in form["options"]])


if __name__ == "__main__":
    unittest.main()

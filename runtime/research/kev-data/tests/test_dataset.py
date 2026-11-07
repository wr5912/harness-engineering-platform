"""Manually authored synthetic unit tests; no records come from the user's trace."""
from copy import deepcopy
import json
import math
import unittest

from dataset import (
    BLOCKED_STATE_FIELDS, IR_SCHEMA, audit_partitions, compile_records, split_records, label_key,
)


def example(number, *, session=None, source_group=None, status="verified"):
    suffix = str(number)
    return {
        "schema_version": IR_SCHEMA,
        "sample_id": "synthetic/sample-" + suffix,
        "decision_site_id": "synthetic.next-action",
        "contract_version": "synthetic-contract/v1",
        "state": {"request": "人工合成测试输入 " + suffix,
                  "previous_step": {"status": "PARTIAL", "businessSummary": "已检查一部分候选"}},
        "question": {
            "type": "choice", "instructions": "人工合成：选择下一步。",
            "criteria": {"search": "搜索未知位置", "read": "读取已知文件"},
        },
        "observed_action": {"tool": "search"},
        "label": {
            "status": status, "value": "search" if status != "unlabeled" else None,
            "source": "synthetic-human-review" if status != "unlabeled" else "",
            "evidence_refs": [{"kind": "review", "line": 20, "seq": 20}] if status != "unlabeled" else [],
        },
        "provenance": {
            "trace_sha256": "a" * 64,
            "session_id": session or "synthetic/session-" + suffix,
            "source_group_id": source_group or "synthetic/source-" + suffix,
            "state_evidence_refs": [{"kind": "user/message", "line": 1, "seq": 1}],
            "candidate_evidence_refs": [{"kind": "contract", "contract_version": "synthetic-contract/v1"}],
            "decision_seq": 10, "decision_line": 10,
            "state_builder_version": "synthetic-state/v1",
            "candidate_builder_version": "synthetic-candidates/v1",
        },
        "implementation": "model",
    }


def compile_ok(rows, **kwargs):
    compiled, quarantine, report = compile_records(rows, **kwargs)
    if quarantine:
        raise AssertionError(json.dumps(quarantine, ensure_ascii=False, indent=2))
    return compiled


class CompilerTests(unittest.TestCase):
    def test_typed_questions_preserve_hard_labels_soft_keys_and_ai_review_metadata(self):
        rows = []
        for index, (question, value, target) in enumerate((
            ({"type": "choice", "instructions": "选择字面选项", "criteria": {"false": "字面字符串", "0": "字面零"}}, "false", {"false": 3, "0": 1}),
            ({"type": "noul", "instructions": "事实是否成立", "criteria": {"false": "不成立", "true": "成立"}}, False, {"false": 3, "true": 1}),
            ({"type": "score", "instructions": "按原顺序评分", "criteria": ["low", "high"]}, 0, {"0": 3, "1": 1}),
        )):
            row = example(index)
            row["question"] = question
            row["label"].update(value=value, source="synthetic-ai-functional-review", target=target,
                                target_semantics="synthetic reviewer weights, not calibrated confidence")
            row["review"] = {"scope": "functional_ai_labels", "business_effect": "inconclusive"}
            rows.append(row)
        compiled = compile_ok(rows)
        for original, result in zip(rows, compiled):
            question = next(iter(result["questions"].values()))
            self.assertIs(type(question["label"]), type(original["label"]["value"]))
            self.assertEqual(question["label"], original["label"]["value"])
            self.assertEqual(question["target"][label_key(question, question["label"])], .75)
            self.assertEqual(result["_meta"]["ir_extra"]["review"], original["review"])
            self.assertNotIn("review", result["state"])
        self.assertTrue(audit_partitions({"train": compiled})["ok"])
        bare = example("bare-bool")
        bare["question"] = {"type": "noul", "instructions": "成立吗"}
        bare["label"]["value"] = True
        self.assertIs(next(iter(compile_ok([bare])[0]["questions"].values()))["label"], True)

    def test_typed_labels_reject_boolean_integer_and_string_substitutions(self):
        cases = (
            ({"type": "choice", "instructions": "选择", "criteria": {"false": "否", "0": "零"}}, [False, 0, True]),
            ({"type": "noul", "instructions": "成立吗"}, [0, 1, "false", "true"]),
            ({"type": "score", "instructions": "评分", "criteria": ["low", "high"]}, [False, True, 0.0, "0", -1, 2]),
        )
        for question, values in cases:
            for value in values:
                with self.subTest(kind=question["type"], value=value):
                    row = example(1)
                    row.update(question=question)
                    row["label"]["value"] = value
                    compiled, quarantine, _ = compile_records([row])
                    self.assertFalse(compiled)
                    self.assertIn("invalid_hard_label", quarantine[0]["reason_codes"])

    def test_typed_criteria_validation_and_soft_target_keys(self):
        for criteria in (["no", "yes"], {"yes": "成立"}, {"false": []}):
            row = example(1)
            row["question"] = {"type": "noul", "instructions": "成立吗", "criteria": criteria}
            row["label"]["value"] = False
            self.assertIn("invalid_criteria", compile_records([row])[1][0]["reason_codes"])
        for criteria in ({"low": "低", "high": "高"}, ["only"], ["low", ""], ["low", 1]):
            row = example(1)
            row["question"] = {"type": "score", "instructions": "评分", "criteria": criteria}
            row["label"]["value"] = 0
            self.assertIn("invalid_criteria", compile_records([row])[1][0]["reason_codes"])
        row = example(1)
        row["question"] = {"type": "noul", "instructions": "成立吗"}
        row["label"].update(value=False, target={"0": 1}, target_semantics="invalid boolean key")
        self.assertIn("unknown_target_key", compile_records([row])[1][0]["reason_codes"])
        row["label"].update(target={"false": 1, "true": 3})
        _, quarantine, report = compile_records([row])
        self.assertFalse(quarantine)
        self.assertTrue(any(w["code"] == "hard_soft_disagreement" for w in report["warnings"]))

    def test_typed_audit_rechecks_metadata_label_types(self):
        row = example(1)
        row["question"] = {"type": "noul", "instructions": "成立吗"}
        row["label"]["value"] = False
        compiled = compile_ok([row])[0]
        # False == 0 in Python; metadata must still reject the wrong JSON type.
        compiled["_meta"]["label"]["value"] = 0
        self.assertTrue(any(e["code"] == "invalid_hard_label" for e in audit_partitions({"train": [compiled]})["errors"]))

    def test_typed_verified_conflicts_remain_quarantined(self):
        for kind, criteria, first, second in (("noul", None, False, True), ("score", ["low", "high"], 0, 1)):
            with self.subTest(kind=kind):
                left, right = example("left"), example("right")
                left["question"] = {"type": kind, "instructions": "合成复核题"}
                if criteria is not None:
                    left["question"]["criteria"] = criteria
                left["label"]["value"] = first
                right["state"], right["question"] = deepcopy(left["state"]), deepcopy(left["question"])
                right["label"]["value"] = second
                compiled, quarantine, report = compile_records([left, right])
                self.assertFalse(compiled)
                self.assertEqual(len(quarantine), 2)
                self.assertEqual(len(report["verified_label_conflicts"]), 1)

    def test_unlabeled_observed_action_never_becomes_gold(self):
        compiled, quarantine, report = compile_records([example(1, status="unlabeled")])
        self.assertEqual(compiled, [])
        self.assertIn("label_unlabeled", quarantine[0]["reason_codes"])
        self.assertEqual(report["status"], "blocked")

    def test_metadata_isolated_and_future_label_evidence_allowed(self):
        original = example(1)
        frozen = deepcopy(original)
        result = compile_ok([original])[0]
        self.assertEqual(original, frozen)
        self.assertEqual(result["state"], original["state"])
        self.assertEqual(result["_meta"]["variant"], "clean")
        self.assertEqual(result["_meta"]["label"]["evidence_refs"][0]["seq"], 20)
        self.assertNotIn("observed_action", result["state"])
        self.assertNotIn("provenance", result["state"])
        self.assertEqual(set(result["questions"]["synthetic.next-action"]), {"type", "instructions", "criteria", "label", "src"})

    def test_soft_requires_hard_label_and_explicit_semantics(self):
        row = example(1)
        row["label"].update(value=None, target={"search": .8, "read": .2}, target_semantics="reviewer distribution")
        compiled, quarantine, _ = compile_records([row])
        self.assertFalse(compiled)
        self.assertIn("invalid_hard_label", quarantine[0]["reason_codes"])
        row["label"]["value"] = "search"
        del row["label"]["target_semantics"]
        self.assertIn("missing_target_semantics", compile_records([row])[1][0]["reason_codes"])

    def test_soft_normalizes_by_name_and_rejects_invalid_weights(self):
        row = example(1)
        row["question"]["criteria"] = {"read": "读文件", "search": "搜索"}
        row["label"].update(target={"search": 3, "read": 1}, target_semantics="reviewer distribution")
        result = compile_ok([row])[0]
        self.assertEqual(result["questions"]["synthetic.next-action"]["target"], {"read": .25, "search": .75})
        for bad in (math.nan, math.inf, True, -1):
            with self.subTest(weight=bad):
                broken = deepcopy(row)
                broken["label"]["target"]["read"] = bad
                compiled, quarantine, _ = compile_records([broken])
                self.assertFalse(compiled)
                self.assertTrue(quarantine)
                # Even quarantined NaN/Infinity can be persisted as strict JSON.
                json.dumps(quarantine, allow_nan=False)
        unknown = deepcopy(row)
        unknown["label"]["target"]["future_tool"] = 1
        self.assertIn("unknown_target_key", compile_records([unknown])[1][0]["reason_codes"])

    def test_future_or_same_seq_visible_evidence_is_rejected(self):
        for field in ("state_evidence_refs", "candidate_evidence_refs"):
            for seq in (10, 11):
                with self.subTest(field=field, seq=seq):
                    row = example(1)
                    row["provenance"][field] = [{"line": 11, "seq": seq}]
                    compiled, quarantine, _ = compile_records([row])
                    self.assertFalse(compiled)
                    self.assertIn("future_visible_evidence", quarantine[0]["reason_codes"])
        row = example(1)
        row["provenance"]["state_evidence_refs"][0]["seq"] = True
        self.assertIn("invalid_evidence_seq", compile_records([row])[1][0]["reason_codes"])

    def test_eight_reserved_path_categories_not_business_values(self):
        for category, fields in BLOCKED_STATE_FIELDS.items():
            with self.subTest(category=category):
                row = example(1)
                row["state"][fields[0]] = "reserved-field-test"
                self.assertIn("input_leakage", compile_records([row])[1][0]["reason_codes"])
        row = example(1)
        row["state"]["previous_step"].update(label="业务标签", outcome="PARTIAL", reward=1.0, result={"businessSummary": "合法的过去观察"})
        row["state"]["label"] = "业务对象字段，需由contract确认"
        row["state"]["request"] = "The text may mention observed_action, annotation_note or the word search."
        compiled, quarantine, report = compile_records([row])
        self.assertEqual(len(compiled), 1)
        self.assertFalse(quarantine)
        self.assertTrue(any(w["code"] == "ambiguous_business_field" for w in report["warnings"]))

    def test_weak_and_code_are_explicit_opt_in(self):
        weak = example(1, status="weak")
        self.assertFalse(compile_records([weak])[0])
        compiled = compile_ok([weak], allow_weak_train=True)
        self.assertTrue(compiled[0]["_meta"]["training_only"])
        self.assertFalse(compiled[0]["_meta"]["gold_eligible"])
        code = example(2)
        code["implementation"] = "code"
        self.assertFalse(compile_records([code])[0])
        self.assertEqual(len(compile_ok([code], include_code=True)), 1)

    def test_duplicate_ids_and_malformed_status_are_quarantined(self):
        compiled, quarantine, _ = compile_records([example(1), example(1)])
        self.assertFalse(compiled)
        self.assertEqual(len(quarantine), 2)
        self.assertTrue(all("duplicate_sample_id" in row["reason_codes"] for row in quarantine))
        row = example(1)
        row["label"]["status"] = []
        row["implementation"] = []
        self.assertFalse(compile_records([row])[0])

    def test_verified_input_conflict_quarantines_verified_and_fails_audit(self):
        left, right, weak = example("left"), example("right"), example("weak", status="weak")
        right["state"] = deepcopy(left["state"])
        right["question"]["criteria"] = dict(reversed(list(right["question"]["criteria"].items())))
        right["label"]["value"] = "read"
        weak["state"] = deepcopy(left["state"])
        weak["label"]["value"] = "read"
        compiled, quarantine, report = compile_records(
            [left, right, weak, example("unrelated")], allow_weak_train=True,
        )
        self.assertEqual({r["_meta"]["id"] for r in compiled},
                         {"synthetic/sample-weak", "synthetic/sample-unrelated"})
        self.assertEqual({r["sample_id"] for r in quarantine},
                         {"synthetic/sample-left", "synthetic/sample-right"})
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["quarantine_by_reason"]["conflicting_verified_labels"], 2)
        conflict = report["verified_label_conflicts"][0]
        self.assertEqual(set(conflict["verified_label_ids"]), {"read", "search"})
        self.assertEqual(set(conflict["related_verified_ids"]),
                         {"synthetic/sample-left", "synthetic/sample-right"})
        self.assertEqual(quarantine[0]["record"]["sample_id"], quarantine[0]["sample_id"])
        # Compile separately to exercise auditing of previously exported, conflicting gold.
        imported = compile_ok([left]) + compile_ok([right])
        audit = audit_partitions({"train": imported})
        self.assertFalse(audit["ok"])
        self.assertTrue(any(e["code"] == "conflicting_verified_labels" for e in audit["errors"]))
        blocked, _, conflict_report = compile_records([left, right])
        self.assertFalse(blocked)
        self.assertEqual(conflict_report["status"], "blocked")

    def test_weak_input_disagreement_remains_warning_only(self):
        for statuses in (("weak", "weak"), ("verified", "weak")):
            with self.subTest(statuses=statuses):
                left = example("left", status=statuses[0])
                right = example("right", status=statuses[1])
                right["state"] = deepcopy(left["state"])
                right["label"]["value"] = "read"
                compiled, quarantine, report = compile_records([left, right], allow_weak_train=True)
                self.assertEqual(len(compiled), 2)
                self.assertFalse(quarantine)
                self.assertFalse(report["verified_label_conflicts"])
                self.assertTrue(any(w["code"] == "conflicting_input_labels" for w in report["warnings"]))
                audit = audit_partitions({"train": compiled})
                self.assertTrue(audit["ok"])
                self.assertTrue(any(w["code"] == "conflicting_input_labels" for w in audit["warnings"]))


class GroupingTests(unittest.TestCase):
    def test_mixed_type_statistics_keep_questions_and_zero_false_labels_distinct(self):
        rows = []
        for index in range(5):
            for kind, criteria, value in (("choice", {"false": "字面否", "0": "字面零"}, "false"),
                                          ("noul", {"false": "不成立", "true": "成立"}, False),
                                          ("score", ["low", "high"], 0)):
                row = example(f"{index}-{kind}", session=f"synthetic/session-{index}", source_group=f"synthetic/source-{index}")
                row["state"] = {"request": f"synthetic independent task {index}"}
                row["decision_site_id"] = "same-site-name"
                row["question"] = {"type": kind, "instructions": "合成混合题型", "criteria": criteria}
                row["label"]["value"] = value
                rows.append(row)
        parts, manifest = split_records(compile_ok(rows), {"train": .2, "development": .2, "calibration": .4, "test": .2})
        self.assertEqual(manifest["status"], "ready")
        self.assertEqual(manifest["partition_groups"]["calibration"], 2)
        self.assertTrue(audit_partitions(parts)["ok"])
        self.assertEqual(len(manifest["question_definitions"]), 3)
        for name, counts in manifest["partition_labels"].items():
            by_type = {manifest["question_definitions"][key]["type"]: values for key, values in counts.items()}
            size = manifest["partition_groups"][name]
            self.assertEqual(by_type, {"choice": {"false": size}, "noul": {"false": size}, "score": {"0": size}})
        json.dumps(manifest, allow_nan=False)
        self.assertNotIn("missing_label_coverage", manifest)

    def test_missing_label_coverage_is_scoped_to_each_question(self):
        rows = []
        for index in range(4):
            row = example(index)
            row["decision_site_id"] = f"site-{index % 2}"
            row["question"] = {"type": "noul", "instructions": "合成二值题"}
            row["label"]["value"] = False
            rows.append(row)
        _, manifest = split_records(compile_ok(rows))
        self.assertTrue(manifest["missing_label_coverage"])
        for missing in manifest["missing_label_coverage"].values():
            self.assertEqual(list(missing.values()), [["false"]])

    def test_native_rendered_collision_cannot_cross_partitions_or_hide_conflict(self):
        left, right = example("object"), example("string")
        left["state"], right["state"] = {"request": "same synthetic task"}, "request: same synthetic task"
        rows = compile_ok([left, right])
        audit = audit_partitions({"train": [rows[0]], "test": [rows[1]]})
        self.assertFalse(audit["ok"])
        self.assertTrue(any(item["relation"] == "rendered_question" for item in audit["overlaps"]))
        right["label"]["value"] = "read"
        compiled, quarantine, report = compile_records([left, right])
        self.assertEqual(compiled, [])
        self.assertEqual(len(quarantine), 2)
        self.assertEqual(len(report["verified_label_conflicts"]), 1)

    def test_reordering_object_fields_cannot_pass_the_existing_canonical_hash(self):
        row = compile_ok([example("ordered")])[0]
        row["state"] = dict(reversed(list(row["state"].items())))
        audit = audit_partitions({"train": [row]})
        self.assertTrue(any(issue["code"] == "native_input_hash_mismatch" for issue in audit["errors"]))
        self.assertFalse(any(issue["code"] == "input_hash_mismatch" for issue in audit["errors"]))

    def test_one_session_cannot_fake_four_independent_partitions(self):
        rows = compile_ok([example(i, session="only-session") for i in range(6)])
        parts, manifest = split_records(rows)
        self.assertEqual(manifest["status"], "blocked")
        self.assertEqual(manifest["independent_groups"], 1)
        self.assertIn("insufficient_independent_groups", manifest["blocked_reasons"])
        self.assertTrue(all(not records for records in parts.values()))

    def test_connected_source_session_and_duplicate_input_stay_together(self):
        a = example("a", source_group="shared-source")
        b = example("b", source_group="shared-source", session="shared-session")
        c = example("c", session="shared-session")
        d = example("d")
        d["state"] = deepcopy(a["state"])
        d["decision_site_id"] = "another-site-with-identical-model-input"
        rows = compile_ok([a, b, c, d, *[example(i) for i in range(10, 14)]])
        before = deepcopy(rows)
        parts, manifest = split_records(rows)
        self.assertEqual(rows, before)
        self.assertEqual(manifest["status"], "ready")
        self.assertEqual(manifest["independent_groups"], 5)
        where = {r["_meta"]["id"]: name for name, records in parts.items() for r in records}
        self.assertEqual(len({where["synthetic/sample-" + key] for key in "abcd"}), 1)
        self.assertTrue(audit_partitions(parts)["ok"])
        # Input ordering must not affect the deterministic group allocation.
        parts2, manifest2 = split_records(list(reversed(rows)))
        self.assertEqual(manifest["group_partition"], manifest2["group_partition"])

    def test_weak_connected_group_is_train_only(self):
        weak = example("weak", status="weak", source_group="mixed-source")
        trusted = example("trusted", source_group="mixed-source")
        rows = compile_ok([weak, trusted, *[example(i) for i in range(3)]], allow_weak_train=True)
        parts, manifest = split_records(rows)
        self.assertEqual(manifest["status"], "ready")
        train_ids = {r["_meta"]["id"] for r in parts["train"]}
        self.assertIn("synthetic/sample-weak", train_ids)
        self.assertIn("synthetic/sample-trusted", train_ids)
        self.assertTrue(audit_partitions(parts)["ok"])

    def test_not_enough_gold_groups_is_blocked(self):
        rows = compile_ok([example(i, status="weak" if i < 3 else "verified") for i in range(4)], allow_weak_train=True)
        parts, manifest = split_records(rows)
        self.assertEqual(manifest["status"], "blocked")
        self.assertIn("insufficient_gold_groups_for_heldout_partitions", manifest["blocked_reasons"])
        self.assertTrue(all(not records for records in parts.values()))

    def test_audit_detects_cross_partition_session_input_id_and_weak_labels(self):
        a = example(1, session="shared")
        b = example(2, session="shared")
        rows = compile_ok([a, b])
        report = audit_partitions({"train": [rows[0]], "test": [rows[1]]})
        self.assertFalse(report["ok"])
        self.assertTrue(any(o["relation"] == "session" for o in report["overlaps"]))
        report = audit_partitions({"train": [rows[0]], "test": [deepcopy(rows[0])]})
        self.assertTrue(any(e["code"] == "duplicate_sample_id" for e in report["errors"]))
        weak = compile_ok([example(3, status="weak")], allow_weak_train=True)[0]
        report = audit_partitions({"test": [weak]})
        self.assertTrue(any(e["code"] == "non_gold_in_evaluation" for e in report["errors"]))

    def test_audit_detects_nonfinite_and_stale_inputs(self):
        row = compile_ok([example(1)])[0]
        row["state"]["unrecorded_change"] = "changed"
        self.assertTrue(any(e["code"] == "input_hash_mismatch" for e in audit_partitions({"train": [row]})["errors"]))
        row = compile_ok([example(1)])[0]
        row["questions"]["synthetic.next-action"]["target"] = {"search": math.nan}
        self.assertTrue(any(e["code"] == "nonfinite_number" for e in audit_partitions({"train": [row]})["errors"]))


if __name__ == "__main__":
    unittest.main()

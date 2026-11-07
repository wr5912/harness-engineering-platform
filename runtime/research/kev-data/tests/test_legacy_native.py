import os
"""Synthetic records only: no copied user data, private trace, or model training."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import legacy_native as native


def record(i, *, group=None):
    return {
        "state": {"request": f"人工合成任务 {i}", "previous": {"status": "PARTIAL"}},
        "questions": {
            "route": {"type": "choice", "instructions": "人工合成：选择路由。",
                      "criteria": {"search": "搜索", "read": "读取"}, "label": "search", "src": "synthetic"},
            "ready": {"type": "noul", "instructions": "人工合成：是否已就绪？", "label": False},
            "level": {"type": "score", "instructions": "人工合成：选择等级。", "criteria": ["低", "中", "高"], "label": 1},
        },
        "_meta": {"id": f"synthetic-{i}", "group_id": group or f"synthetic-group-{i}",
                  "source": "synthetic-native-fixture", "variant": "original", "annotation_certainty": "low",
                  "provenance": {"generation_batch": "synthetic-test"}, "legacy": {"keep": "existing namespace"}},
    }


def write_rows(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False, allow_nan=False) + "\n" for r in rows), encoding="utf-8")


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def original_id(row):
    return row["_meta"]["legacy"]["original_meta"]["id"]


def training_planner():
    path = Path(os.environ["HARNESS_ASSET_ROOT"]) / ".agents/skills/kev-training/scripts/training_plan.py"
    spec = importlib.util.spec_from_file_location("_synthetic_legacy_training_plan", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verified_reviews(source, rows):
    entries, errors = native._entries(source.read_bytes())
    assert not errors
    reviews = [native._template(e, hashlib.sha256(source.read_bytes()).hexdigest()) for e in entries]
    for review, row in zip(reviews, rows):
        for qid, q in review["questions"].items():
            q.update(status="verified", label=deepcopy(row["questions"][qid]["label"]),
                     review_method="human", reviewer="synthetic-reviewer", source="synthetic-fixture-spec/v1",
                     basis="与人工合成测试合同逐项核对，满足此分支的全部前提。", evidence_refs=["synthetic-spec#case-" + review["record_id"]])
    return reviews


class LegacyNativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "input.jsonl"
        self.review_file = self.root / "reviewed.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, rows=None):
        rows = [record(i) for i in range(8)] if rows is None else rows
        write_rows(self.source, rows)
        reviews = verified_reviews(self.source, rows)
        return rows, reviews

    def build(self, reviews, *, suffix="built", **kwargs):
        write_rows(self.review_file, reviews)
        out = self.root / suffix
        report = native.build_directory(self.source, self.review_file, out, **kwargs)
        return out, report

    def exported(self, out):
        return [row for name in native.PARTITIONS for row in read_rows(out / (name + ".jsonl"))]

    def test_inspect_is_native_compatible_but_never_promotes_certainty(self):
        rows, reviews = self.prepare()
        before = self.source.read_bytes()
        report = native.inspect_file(self.source, self.root / "inspect")
        self.assertEqual(report["native_valid_records"], 8)
        self.assertEqual(set(report["question_types"]), {"choice", "noul", "score"})
        todo = read_rows(self.root / "inspect/reviews.todo.jsonl")
        self.assertTrue(all(q["status"] == "unreviewed" and q["label"] is None for r in todo for q in r["questions"].values()))
        self.assertEqual(before, self.source.read_bytes())
        self.assertIn("真实复核", (self.root / "inspect/report.md").read_text())
        out, blocked = self.build(todo)
        self.assertEqual(blocked["status"], "blocked")
        self.assertFalse((out / "train.jsonl").exists())
        self.assertEqual(blocked["quarantined_records"], 8)

    def test_all_three_types_roundtrip_with_original_metadata_and_rule_review(self):
        rows, reviews = self.prepare()
        original = self.source.read_bytes()
        q = reviews[0]["questions"]["route"]
        q.update(review_method="rule", reviewer=None, rule_id="synthetic-exact-route", rule_version="v1")
        reviews[1]["questions"]["route"]["label"] = "read"
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready", report["errors"])
        audited = native.audit_directory(out)
        self.assertTrue(audited["ok"], audited)
        self.assertTrue(all(report["partition_records"][p] > 0 for p in native.PARTITIONS))
        by_id = {original_id(r): r for r in self.exported(out)}
        for old in rows:
            new = by_id[old["_meta"]["id"]]
            self.assertEqual(new["state"], old["state"])
            self.assertEqual(new["_meta"]["legacy"]["original_meta"], old["_meta"])
            self.assertEqual(new["_meta"]["source"], old["_meta"]["source"])
            self.assertEqual(new["_meta"]["provenance"], old["_meta"]["provenance"])
            self.assertEqual(new["_meta"]["variant"], "clean")
            self.assertEqual(new["_meta"]["legacy"]["original_meta"]["variant"], "original")
            self.assertEqual(new["_meta"]["legacy"]["variant_scope"], "derived-reviewed-export")
            self.assertEqual(new["_meta"]["id"], new["_meta"]["legacy"]["record_id"])
            self.assertNotEqual(new["_meta"]["id"], old["_meta"]["id"])
            self.assertNotIn("session_id", new["_meta"])
            for qid, question in old["questions"].items():
                self.assertEqual({k: v for k, v in new["questions"][qid].items() if k != "label"},
                                 {k: v for k, v in question.items() if k != "label"})
        self.assertEqual(original, (out / "source.jsonl").read_bytes())
        self.assertEqual(original, self.source.read_bytes())
        self.assertEqual(by_id["synthetic-1"]["questions"]["route"]["label"], "read")

    def test_strict_json_and_soft_bool_numeric_gaps(self):
        for text in ('{"x":1,"x":2}', '{"x":{"a":1,"a":2}}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}'):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    native._strict_loads(text)
        for value in (True, float("inf"), -1, 10 ** 400):
            row = record(0)
            row["questions"]["route"]["target"] = {"search": value, "read": 1}
            self.assertTrue(native.check_native_record(row))
        row = record(0)
        row["questions"]["level"]["label"] = True
        self.assertTrue(native.check_native_record(row))

    def test_soft_review_is_explicit_and_semantic(self):
        rows, reviews = self.prepare()
        rows[0]["questions"]["route"]["target"] = {"search": 3, "read": 1}
        write_rows(self.source, rows)
        reviews = verified_reviews(self.source, rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready")
        row = next(r for r in self.exported(out) if original_id(r) == "synthetic-0")
        self.assertNotIn("target", row["questions"]["route"])
        q = reviews[0]["questions"]["route"]
        q.update(target={"search": 3, "read": 1}, target_semantics="人工合成：四次独立标注的频数，非接受集合。")
        out, report = self.build(reviews, suffix="soft")
        row = next(r for r in self.exported(out) if original_id(r) == "synthetic-0")
        self.assertEqual(row["questions"]["route"]["target"], {"search": .75, "read": .25})
        q["target_semantics"] = None
        out, report = self.build(reviews, suffix="no-semantics")
        self.assertEqual(report["quarantined_records"], 1)
        self.assertIn("missing_target_semantics", {x["code"] for x in read_rows(out / "quarantine.jsonl")[0]["reasons"]})

    def test_review_must_bind_source_bytes_line_and_canonical_record(self):
        rows, reviews = self.prepare()
        for field, value in (("record_sha256", "a" * 64), ("source_sha256", "b" * 64), ("source_line", True)):
            altered = deepcopy(reviews)
            altered[0][field] = value
            out, report = self.build(altered, suffix="wrong-" + field)
            self.assertEqual(report["status"], "blocked")
            self.assertIn("review_binding_mismatch", {e["code"] for e in report["errors"]})
        self.source.write_bytes(self.source.read_bytes() + b"\n")
        out, report = self.build(reviews, suffix="changed-bytes")
        self.assertEqual(report["status"], "blocked")

    def test_excluded_bridge_cannot_break_transitive_source_group(self):
        rows = [record(i) for i in range(9)]
        rows[0]["_meta"]["group_id"] = "bridge-left"
        rows[1]["_meta"].update(group_id="bridge-left", session_id="bridge-session")
        rows[2]["_meta"].update(group_id="bridge-right", session_id="bridge-session")
        rows, reviews = self.prepare(rows)
        reviews[1]["questions"]["route"].update(status="ambiguous", label=None)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready", report["errors"])
        by_id = {original_id(r): r for r in self.exported(out)}
        self.assertNotIn("synthetic-1", by_id)
        left, right = by_id["synthetic-0"]["_meta"], by_id["synthetic-2"]["_meta"]
        self.assertEqual(left["group_id"], right["group_id"])
        self.assertEqual(left["split"], right["split"])
        self.assertTrue(native.audit_directory(out)["ok"])

    def test_multi_question_packages_and_qid_variants_stay_together(self):
        rows = [record(i) for i in range(8)]
        rows[1]["state"] = deepcopy(rows[0]["state"])
        rows[1]["questions"] = {"renamed": deepcopy(rows[0]["questions"]["route"])}
        rows[2]["state"] = deepcopy(rows[0]["state"])
        rows[2]["questions"] = {"different": {"type": "noul", "instructions": "另一道题。", "label": True}}
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready")
        selected = [r for r in self.exported(out) if original_id(r) in {"synthetic-0", "synthetic-1", "synthetic-2"}]
        self.assertEqual(len({r["_meta"]["split"] for r in selected}), 1)
        self.assertEqual(len({r["_meta"]["group_id"] for r in selected}), 1)

    def test_conflicting_verified_partial_question_inputs_block(self):
        rows = [record(i) for i in range(8)]
        rows[1]["state"] = deepcopy(rows[0]["state"])
        rows[1]["questions"] = {"other_qid": deepcopy(rows[0]["questions"]["route"])}
        rows, reviews = self.prepare(rows)
        reviews[1]["questions"]["other_qid"]["label"] = "read"
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "blocked")
        self.assertIn("conflicting_verified_labels", {e["code"] for e in report["errors"]})
        self.assertFalse((out / "train.jsonl").exists())

    def test_original_splits_are_preserved_and_conflict_blocks_even_excluded_bridge(self):
        rows = [record(i) for i in range(8)]
        for i, name in enumerate(native.PARTITIONS):
            rows[i]["_meta"]["split"] = name
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready")
        by_id = {original_id(r): r for r in self.exported(out)}
        for i, name in enumerate(native.PARTITIONS):
            self.assertEqual(by_id[f"synthetic-{i}"]["_meta"]["split"], name)
        rows[1]["_meta"]["group_id"] = rows[0]["_meta"]["group_id"]
        rows, reviews = self.prepare(rows)
        reviews[1]["questions"]["route"]["status"] = "invalid"
        out, report = self.build(reviews, suffix="split-conflict")
        self.assertEqual(report["status"], "blocked")
        self.assertIn("existing_split_conflict", {e["code"] for e in report["errors"]})

    def test_generated_record_ids_do_not_fake_independent_sources(self):
        rows = [record(i) for i in range(8)]
        for row in rows:
            del row["_meta"]
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "blocked")
        for i, review in enumerate(reviews):
            review["grouping"].update(family_id=f"synthetic-independent-family-{i}",
                                      basis="人工合成夹具明确定义的独立任务。", evidence_refs=[f"synthetic-fixture#family-{i}"])
        out, report = self.build(reviews, suffix="with-real-mapping")
        self.assertEqual(report["status"], "ready", report["errors"])
        self.assertTrue(all(r["_meta"]["legacy"]["id_generated"] for r in self.exported(out)))
        self.assertTrue(all("source" not in r["_meta"] and "provenance" not in r["_meta"] for r in self.exported(out)))

    def test_model_suggestion_or_bare_certainty_is_not_verified(self):
        rows, reviews = self.prepare()
        reviews[0]["questions"]["route"]["review_method"] = "model_suggestion"
        reviews[1]["questions"]["route"]["basis"] = "高确定性"
        reviews[2]["questions"]["route"].update(review_method="rule", rule_id=None, rule_version=None)
        out, report = self.build(reviews)
        self.assertEqual(report["quarantined_records"], 3)
        ids = {original_id(r) for r in self.exported(out)}
        self.assertFalse(ids & {"synthetic-0", "synthetic-1", "synthetic-2"})

    def test_audit_replays_even_when_tampered_file_hash_and_report_are_rebound(self):
        rows, reviews = self.prepare()
        out, report = self.build(reviews)
        train = read_rows(out / "train.jsonl")
        train[0]["questions"]["route"]["label"] = "read"
        write_rows(out / "train.jsonl", train)
        manifest_path = out / "split-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["train"]["sha256"] = hashlib.sha256((out / "train.jsonl").read_bytes()).hexdigest()
        native._write_json(manifest_path, manifest)
        native._write_json(out / "report.json", {**manifest, "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()})
        audit = native.audit_directory(out)
        self.assertFalse(audit["ok"])
        self.assertIn("partition_replay_mismatch", {e["code"] for e in audit["errors"]})

    def test_audit_distinguishes_json_boolean_from_equal_python_integer(self):
        rows = [record(i) for i in range(8)]
        for row in rows:
            row["state"]["numeric_count"] = 1
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        train = read_rows(out / "train.jsonl")
        train[0]["state"]["numeric_count"] = True
        write_rows(out / "train.jsonl", train)
        manifest_path = out / "split-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["train"]["sha256"] = hashlib.sha256((out / "train.jsonl").read_bytes()).hexdigest()
        native._write_json(manifest_path, manifest)
        native._write_json(out / "report.json", {**manifest, "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()})
        audit = native.audit_directory(out)
        self.assertFalse(audit["ok"])
        self.assertIn("partition_replay_mismatch", {e["code"] for e in audit["errors"]})

    def test_human_review_queue_is_capped_and_prioritizes_existing_flags(self):
        rows = [record(i) for i in range(40)]
        for row in rows:
            row["_meta"]["annotation_certainty"] = "高"
        rows[-1]["_meta"]["annotation_certainty"] = "低"
        rows[-1]["_meta"]["difficulty"] = "uncertain"
        rows[-2]["_meta"]["difficulty"] = "uncertain"
        rows[-2]["_meta"]["uncertain"] = True
        rows[0]["_meta"]["difficulty"] = "low"  # Low difficulty is not low certainty.
        self.prepare(rows)
        report = native.inspect_file(self.source, self.root / "queue-inspect")
        text = (self.root / "queue-inspect/review-queue.md").read_text()
        self.assertEqual(report["priority_review_records"], 2)
        self.assertEqual(report["preview_records"], 30)
        self.assertEqual(text.count("## 原文件第 "), 30)
        self.assertLess(text.index("## 原文件第 39 行"), text.index("## 原文件第 1 行"))
        self.assertLess(text.index("## 原文件第 40 行"), text.index("## 原文件第 1 行"))
        self.assertIn("不是错标率", text)
        self.assertNotIn("接入引用", text)
        self.assertNotIn("legacy-", text)
        self.assertIn("输入状态摘录", text)
        self.assertIn("原标签", text)
        report_text = (self.root / "queue-inspect/report.md").read_text()
        self.assertIn("原生格式检查通过，标签尚未复核", report_text)
        for term in ("unreviewed", "hard label", "verified", "tokenizer", "trace/session/provenance"):
            self.assertNotIn(term, report_text)
        self.assertEqual(len(read_rows(self.root / "queue-inspect/reviews.todo.jsonl")), 40)

    def test_shared_root_leakage_policy_quarantines_without_cleaning_source(self):
        for field in ("gold_label", "future_tool_result"):
            with self.subTest(field=field):
                rows = [record(i) for i in range(8)]
                for row in rows:
                    row["state"][field] = "synthetic-supervision-or-future-value"
                rows, reviews = self.prepare(rows)
                before = self.source.read_bytes()
                inspected = native.inspect_file(self.source, self.root / ("inspect-" + field))
                self.assertEqual(inspected["native_valid_records"], 8)
                self.assertIn("input_leakage", {issue["code"] for issue in inspected["errors"]})
                out, report = self.build(reviews, suffix=field)
                self.assertEqual(report["status"], "blocked")
                self.assertEqual(report["quarantined_records"], 8)
                self.assertEqual(report["quarantine_by_reason"]["input_leakage"], 8)
                self.assertTrue(all(field in row["record"]["state"] for row in read_rows(out / "quarantine.jsonl")))
                self.assertEqual(before, self.source.read_bytes())
                self.assertEqual(before, (out / "source.jsonl").read_bytes())

    def test_review_queue_reuses_definitions_and_renders_readable_inputs(self):
        rows, reviews = self.prepare()
        before = self.source.read_bytes()
        native.inspect_file(self.source, self.root / "readable-queue")
        text = (self.root / "readable-queue/review-queue.md").read_text()
        self.assertEqual(text.count("人工合成：选择路由。"), 1)
        self.assertEqual(text.count("人工合成：是否已就绪？"), 1)
        self.assertEqual(text.count("人工合成：选择等级。"), 1)
        self.assertEqual(text.count("候选名称：search、read。"), 1)
        self.assertIn("用户输入指令：人工合成任务 0", text)
        self.assertIn("此前状态：status: PARTIAL", text)
        self.assertNotIn('\\{"request"', text)
        self.assertIn("否（false）", text)
        self.assertIn("1（中）", text)
        self.assertIn("首次定位：原文件第 1 行，原题 route", text)
        self.assertEqual(text.count("## 原文件第 "), 8)
        self.assertEqual(before, self.source.read_bytes())
        self.assertEqual(len(read_rows(self.root / "readable-queue/reviews.todo.jsonl")), 8)

    def test_old_export_with_reserved_input_fields_fails_audit_and_training_entry(self):
        rows = [record(i) for i in range(8)]
        for row in rows:
            row["state"].update(gold_label="search", future_tool_result="synthetic future")
        rows, reviews = self.prepare(rows)
        # Reproduce an artifact emitted by the prior implementation's missing
        # input-boundary check. Only synthetic fixtures use this test patch.
        with patch.object(native, "_input_findings", return_value=([], [])):
            out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready")
        audit = native.audit_directory(out)
        self.assertFalse(audit["ok"])
        self.assertIn("input_leakage", {issue["code"] for issue in audit["errors"]})
        with self.assertRaisesRegex(ValueError, "legacy_native_audit_failed"):
            training_planner().inspect_dataset(out, "legacy-native")

    def test_nested_business_fields_and_text_mentions_are_not_root_leaks(self):
        rows = [record(i) for i in range(8)]
        for row in rows:
            row["state"]["business"] = {"status": "PARTIAL", "result": "already visible", "label": "business label"}
            row["state"]["request"] += " 用户文本提到 gold_label 和 future_tool_result。"
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready", report["errors"])
        self.assertTrue(native.audit_directory(out)["ok"])

    def test_invalid_or_repeated_legacy_ids_become_unique_consumer_ids(self):
        for value in (None, 12, "same-id"):
            with self.subTest(original_id=value):
                rows = [record(i) for i in range(8)]
                for row in rows:
                    row["_meta"]["id"] = value
                rows, reviews = self.prepare(rows)
                out, report = self.build(reviews, suffix="old-id-" + str(value))
                self.assertEqual(report["status"], "ready", report["errors"])
                exported = self.exported(out)
                ids = [row["_meta"]["id"] for row in exported]
                self.assertTrue(all(isinstance(key, str) and key for key in ids))
                self.assertEqual(len(ids), len(set(ids)))
                self.assertTrue(all(original_id(row) == value for row in exported))
                self.assertTrue(native.audit_directory(out)["ok"])
                inspected = training_planner().inspect_dataset(out, "legacy-native")
                self.assertEqual(inspected["kind"], "legacy-native")

    def test_render_equivalent_state_cannot_cross_existing_splits(self):
        rows = [record(i) for i in range(8)]
        rows[0]["state"] = {"request": "same"}
        rows[1]["state"] = "request: same"
        rows[0]["_meta"]["split"], rows[1]["_meta"]["split"] = "train", "test"
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "blocked")
        self.assertIn("existing_split_conflict", {issue["code"] for issue in report["errors"]})

    def test_render_equivalent_instructions_expose_verified_label_conflict(self):
        rows = [record(i) for i in range(8)]
        rows[1]["state"] = deepcopy(rows[0]["state"])
        rows[0]["questions"]["route"]["instructions"] = {"task": "route"}
        rows[1]["questions"]["route"]["instructions"] = "task: route"
        rows, reviews = self.prepare(rows)
        reviews[1]["questions"]["route"]["label"] = "read"
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(any(issue["code"] == "conflicting_verified_labels" and issue["identity_kind"] == "native-render"
                            for issue in report["errors"]))

    def test_export_preserves_object_order_and_rebound_reordering_fails_audit(self):
        rows = [record(i) for i in range(8)]
        for i, row in enumerate(rows):
            row["state"] = {"z-request": f"synthetic-{i}", "a-details": {"last": 2, "first": 1}}
            row["questions"]["route"]["criteria"] = {"z-route": "搜索", "a-route": "读取"}
            row["questions"]["route"]["label"] = "z-route"
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "ready")
        for row in self.exported(out):
            self.assertEqual(list(row["state"]), ["z-request", "a-details"])
            self.assertEqual(list(row["state"]["a-details"]), ["last", "first"])
            self.assertEqual(list(row["questions"]["route"]["criteria"]), ["z-route", "a-route"])
        self.assertTrue(native.audit_directory(out)["ok"])
        train = read_rows(out / "train.jsonl")
        train[0]["state"] = dict(reversed(list(train[0]["state"].items())))
        native._write_jsonl(out / "train.jsonl", train)
        manifest_path = out / "split-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["train"]["sha256"] = hashlib.sha256((out / "train.jsonl").read_bytes()).hexdigest()
        native._write_json(manifest_path, manifest)
        native._write_json(out / "report.json", {**manifest, "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()})
        audit = native.audit_directory(out)
        self.assertFalse(audit["ok"])
        self.assertIn("partition_replay_mismatch", {issue["code"] for issue in audit["errors"]})

    def test_minimum_groups_not_records_and_existing_all_train_cannot_be_resplit(self):
        rows = [record(i, group="only-source") for i in range(8)]
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["eligible_groups"], 1)
        rows = [record(i) for i in range(8)]
        for row in rows:
            row["_meta"]["split"] = "train"
        rows, reviews = self.prepare(rows)
        out, report = self.build(reviews, suffix="all-train")
        self.assertEqual(report["status"], "blocked")

    def test_cli_default_chinese_json_opt_in_and_fresh_directory(self):
        self.prepare()
        script = Path(native.__file__)
        cli = subprocess.run([sys.executable, str(script), "inspect", "--input", str(self.source), "--out", str(self.root / "cli")], capture_output=True, text=True)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertIn("原生格式检查通过，标签尚未复核", cli.stdout)
        self.assertFalse(cli.stdout.lstrip().startswith("{"))
        cli = subprocess.run([sys.executable, str(script), "inspect", "--input", str(self.source), "--out", str(self.root / "cli-json"), "--json"], capture_output=True, text=True)
        self.assertEqual(json.loads(cli.stdout)["status"], "needs_review")
        with self.assertRaises(FileExistsError):
            native.inspect_file(self.source, self.root / "cli")
        self.assertFalse(native.audit_directory(self.root / "absent")["ok"])


if __name__ == "__main__":
    unittest.main()

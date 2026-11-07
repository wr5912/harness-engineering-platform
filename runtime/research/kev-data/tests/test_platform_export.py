"""人工合成的离线回执测试；不读取用户轨迹，不执行训练或平台写入。"""
import ast
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import platform_export as bridge


STAMP = "2026-10-26T00:00:00.000Z"


def fixture_row(number, partition="train"):
    """构造有显式 synthetic 身份的手写夹具，不代表真实人工标注。"""
    trace_hash = bridge.sha("synthetic-trace-" + str(number))
    run = f"run-{number:08x}-1111-4111-8111-111111111111"
    path = f"evolution/experiments/EXP-synthetic-001/runs/{run}/evidence/U-ONE/trace.jsonl"
    cutoff = {"path": path, "line": 10, "seq": 9, "session_log": f"synthetic-session-{number}.jsonl",
              "event_id": "event-9", "source_sha256": trace_hash, "line_sha256": bridge.sha("synthetic-line")}
    files = [{"path": name, "source_sha256": bridge.sha("synthetic-" + name)} for name in bridge.HARNESS_PATHS]
    skill_hash = files[1]["source_sha256"]
    model = {"provider": "synthetic", "model": "fixture"}
    extractor = {"session_id": "synthetic-extractor", "model": model, "skill": "decision-sample-extraction",
                 "skill_path": bridge.HARNESS_PATHS[1], "skill_sha256": skill_hash, "format": "decision-dataset-v2",
                 "harness_sources": {"files": files, "sha256": bridge.sha(bridge.js_json(files)),
                                     "skill_path": bridge.HARNESS_PATHS[1], "skill_sha256": skill_hash}}
    question = {"type": "choice", "instructions": "合成问题：下一步？", "criteria": {"read": "读取", "stop": "停止"}}
    target = {"label": "read", "basis": "人工合成测试依据。", "status": "reviewed", "decision_time_reviewed": True,
              "reviewed_at": STAMP, "provenance": {"kind": "model_suggestion", "session_id": extractor["session_id"],
                "model": model, "skill_sha256": skill_hash, "calibration": "uncalibrated"}}
    row = {"schema_version": 2, "state": {"messages": [{"role": "user", "content": f"合成任务 {number}"}], "available_tools": []},
           "workflow": "合成流程", "task": {"id": "synthetic-task", "semantics": "recommended_decision"},
           "questions": {"route": question}, "targets": {"route": target},
           "_meta": {"id": f"decision-{number:032x}", "dataset_id": f"decision-dataset-{number:08x}-2222-4222-8222-222222222222",
               "source_bundle_sha256": bridge.sha("synthetic-bundle-" + str(number)), "source": "dsh_run", "variant": "clean", "run_id": run,
               "trace_path": path, "trace_sha256": trace_hash, "decision_id": f"decision-synthetic-{number}",
               "cutoff": cutoff, "context_mode": "actual_request",
               "evidence_refs": [{**cutoff, "line": 3, "seq": 2}], "observed_action": {"name": "read"},
               "outcome_refs": [{**cutoff, "line": 11, "seq": 10}], "limitations": ["synthetic fixture"],
               "split": partition, "extractor": extractor}}
    row["_meta"]["source_group_id"] = bridge.source_group(row)
    row["_meta"]["group_id"] = "synthetic-group-" + str(number)
    row["_meta"]["group_history"] = [row["_meta"]["source_group_id"], row["_meta"]["group_id"]]
    refresh_hash(row)
    return row


def refresh_hash(row):
    row["_meta"]["content_sha256"] = bridge.content_hash(row)
    row["_meta"]["source_record_content_sha256"] = bridge.content_hash(row)


def ai_review(row, fragments=False):
    meta = row["_meta"]
    proof = {"schema_version": 1, "session_id": "synthetic-reviewer", "dataset_id": meta["dataset_id"],
             "record_id": meta["id"], "run_id": meta["run_id"], "path": meta["trace_path"],
             "trace_sha256": meta["trace_sha256"], "source_bundle_sha256": meta["source_bundle_sha256"],
             "state_sha256": bridge.sha(bridge.js_json(row["state"])),
             "read_method": "datasets/source-fragments" if fragments else "datasets/read",
             "receipt_refs": [{"call_id": "synthetic-source-read", "call_seq": 2, "result_seq": 3}]}
    if fragments:
        proof.update(content_sha256=bridge.sha("synthetic-complete-document"), source_identity_sha256=bridge.sha("synthetic-source-identity"))
    return {"kind": "ai_delegated", "session_id": "synthetic-reviewer",
            "model": {"provider": "synthetic", "model": "reviewer", "reasoningEffort": None},
            "reviewed_at": STAMP, "purpose": "functional_validation", "input_evidence": proof}


def envelope(number, partition, rows):
    mode = bridge.MODES[partition]
    dataset_id = f"decision-dataset-{number:08x}-2222-4222-8222-222222222222"
    eligible = [{"record_id": row["_meta"]["id"], "legacy": False, "eligible_questions": list(row["questions"]),
                 "reasons": [], "question_reasons": {name: [] for name in row["questions"]},
                 "export_modes": ["candidates", mode]} for row in rows]
    counts = {name: 0 for name in ["candidates", *bridge.MODES.values()]}
    counts.update(candidates=len(rows), **{mode: len(rows)})
    return {"dataset_id": dataset_id, "read_sha256": bridge.sha("synthetic-read-" + str(number)), "mode": mode,
            "export": {"filename": f"{dataset_id}-reviewed-{mode}.jsonl", "schema_version": 2,
                "count": len(rows), "question_count": sum(len(row["questions"]) for row in rows), "omitted_question_count": 0,
                "blocked": [], "eligibility": {"counts": counts, "records": eligible, "blocked": []},
                "content": "\n".join(json.dumps(row, ensure_ascii=False, allow_nan=False) for row in rows) + "\n"}}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-platform-bridge-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rows = {name: [fixture_row(index + 1, name)] for index, name in enumerate(bridge.PARTITIONS)}
        self.manifest = self.root / "exports.json"
        self.output = self.root / "result"

    def save(self):
        manifest = {"schema_version": bridge.SCHEMA, "partitions": {}}
        for number, partition in enumerate(bridge.PARTITIONS, 1):
            wrapper = envelope(number, partition, self.rows[partition])
            path = self.root / (partition + ".json")
            path.write_text(json.dumps(wrapper, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            manifest["partitions"][partition] = [{"path": path.name, "sha256": bridge.sha(path.read_bytes()),
                "dataset_id": wrapper["dataset_id"], "read_sha256": wrapper["read_sha256"]}]
        self.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return manifest

    def rewrite_wrapper(self, partition, mutate, repin=True):
        path = self.root / (partition + ".json")
        wrapper = json.loads(path.read_text())
        mutate(wrapper)
        path.write_text(json.dumps(wrapper, ensure_ascii=False) + "\n", encoding="utf-8")
        if repin:
            manifest = json.loads(self.manifest.read_text())
            manifest["partitions"][partition][0]["sha256"] = bridge.sha(path.read_bytes())
            self.manifest.write_text(json.dumps(manifest), encoding="utf-8")

    def run_bridge(self, expected=None, output=None):
        output = output or self.output
        report = bridge.convert(self.manifest, output)
        if expected:
            self.assertTrue(report["blocked"], report)
            self.assertEqual(report["errors"][0]["code"], expected, report["errors"])
            self.assertEqual(sorted(path.name for path in output.iterdir()), ["platform-bridge-report.json", "report.md"])
        else:
            self.assertFalse(report["blocked"], report["errors"])
        return report

    def test_four_native_partitions_preserve_ids_review_and_inputs_deterministically(self):
        self.save()
        before = {path: path.read_bytes() for path in self.root.glob("*.json")}
        report = self.run_bridge()
        for name, source in self.rows.items():
            native = json.loads((self.output / (name + ".jsonl")).read_text())
            original = source[0]
            self.assertEqual(set(native), {"state", "questions", "_meta"})
            self.assertEqual(native["state"], original["state"])
            self.assertEqual(bridge._native_input.record_key(native), bridge._native_input.record_key(original))
            for key in ["id", "source_group_id", "group_history", "split"]:
                self.assertEqual(native["_meta"][key], original["_meta"][key])
            self.assertEqual(native["_meta"]["group_id"], native["_meta"]["bridge_group_id"])
            self.assertEqual(native["_meta"]["platform"]["original_group_id"], original["_meta"]["group_id"])
            self.assertEqual(native["_meta"]["variant"], "clean")
            self.assertEqual(native["_meta"]["platform"]["targets"], original["targets"])
            self.assertNotIn("target", native["questions"]["route"])
            self.assertEqual(report["files"][name]["sha256"], bridge.sha((self.output / (name + ".jsonl")).read_bytes()))
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        again = self.root / "repeat"
        self.run_bridge(output=again)
        self.assertEqual({path.name: path.read_bytes() for path in self.output.iterdir()}, {path.name: path.read_bytes() for path in again.iterdir()})
        manifest = json.loads((self.output / "split-manifest.json").read_text())
        self.assertTrue(report["ok"])
        self.assertEqual(manifest["files"], report["files"])
        self.assertEqual(manifest["input_manifest_sha256"], report["input_manifest_sha256"])
        self.assertEqual(manifest["source_receipts"], report["receipts"])
        self.assertEqual(manifest["partition_records"], {name: 1 for name in bridge.PARTITIONS})
        self.assertEqual(manifest["allocation"], "preserved_platform_splits")

    def test_skill_context_sources_survive_bridge_without_changing_task_groups(self):
        for partition, rows in self.rows.items():
            row = rows[0]
            original_group = row['_meta']['source_group_id']
            row['state']['messages'][0]['source'] = {'kind': 'user'}
            row['state']['messages'].insert(0, {'role': 'user', 'source': {'kind': 'skill-catalog', 'form': 'catalog'},
                'content': 'Synthetic skill catalog: ' + partition})
            row['state']['messages'].append({'role': 'tool', 'source': {'kind': 'tool', 'callId': 'skill-load'},
                'content': '<skill_content>SYNTHETIC_SKILL_BODY</skill_content>'})
            self.assertEqual(bridge.source_group(row), original_group)
            refresh_hash(row)
        self.save(); self.run_bridge()
        for partition, rows in self.rows.items():
            native = json.loads((self.output / (partition + '.jsonl')).read_text())
            self.assertEqual(native['state'], rows[0]['state'])
            self.assertEqual(native['_meta']['source_group_id'], rows[0]['_meta']['source_group_id'])

    def test_invalid_or_private_message_sources_block(self):
        for index, source in enumerate([None, {}, {'kind': ''}, {'kind': 'model', 'replayState': {'private': True}}]):
            with self.subTest(source=source):
                self.rows['train'] = [fixture_row(1)]
                self.rows['train'][0]['state']['messages'][0]['source'] = source
                refresh_hash(self.rows['train'][0]); self.save()
                self.run_bridge('input_target_leakage', self.root / f'source-{index}')

    def test_suggested_unassigned_and_missing_decision_review_block(self):
        for name, change, code in [
            ("suggested", lambda row: row["targets"]["route"].update(status="suggested"), "unreviewed_target"),
            ("unassigned", lambda row: row["_meta"].update(split="unassigned"), "split_mismatch"),
            ("not_reviewed", lambda row: row["targets"]["route"].update(decision_time_reviewed=False), "unreviewed_target"),
        ]:
            with self.subTest(name=name):
                self.rows["train"] = [fixture_row(1)]
                change(self.rows["train"][0]); self.save()
                self.run_bridge(code, self.root / name)

    def test_reviewed_model_suggestion_stays_uncalibrated_in_every_partition(self):
        self.save(); self.run_bridge()
        for name in bridge.PARTITIONS:
            row = json.loads((self.output / (name + ".jsonl")).read_text())
            target = row["_meta"]["platform"]["targets"]["route"]
            self.assertEqual(target["status"], "reviewed")
            self.assertEqual(target["provenance"]["kind"], "model_suggestion")
            self.assertEqual(target["provenance"]["calibration"], "uncalibrated")
            self.assertNotIn("label_status", row["_meta"])

    def test_ai_delegated_review_and_annotation_preserved_without_human_or_gold(self):
        for number, rows in enumerate(self.rows.values()):
            review = ai_review(rows[0], fragments=number % 2 == 1)
            target = rows[0]["targets"]["route"]
            target["review"] = deepcopy(review)
            target["provenance"] = {"kind": "ai_annotation", "annotated_at": STAMP,
                "session_id": review["session_id"], "model": deepcopy(review["model"]),
                "purpose": review["purpose"], "origin": deepcopy(target["provenance"])}
        self.save(); self.run_bridge()
        for name in bridge.PARTITIONS:
            row = json.loads((self.output / (name + ".jsonl")).read_text())
            target = row["_meta"]["platform"]["targets"]["route"]
            self.assertEqual(target, self.rows[name][0]["targets"]["route"])
            self.assertEqual(target["review"], self.rows[name][0]["targets"]["route"]["review"])
            self.assertEqual(target["provenance"]["kind"], "ai_annotation")
            self.assertEqual(target["provenance"]["origin"]["calibration"], "uncalibrated")

    def test_ai_review_rejects_missing_actor_wrong_purpose_and_changed_time(self):
        for patch in [{"session_id": ""}, {"model": {}}, {"purpose": "gold"}, {"kind": "human"}, {"reviewed_at": "2026-10-28T00:00:00.000Z"}]:
            with self.subTest(patch=patch):
                target = fixture_row(1)["targets"]["route"]
                target["review"] = {"kind": "ai_delegated", "session_id": "synthetic-reviewer",
                    "model": {"provider": "synthetic", "model": "reviewer"}, "reviewed_at": STAMP,
                    "purpose": "functional_validation", **patch}
                with self.assertRaises(bridge.BridgeError) as error:
                    bridge.validate_review(target)
                self.assertEqual(error.exception.code, "invalid_ai_review")

    def test_ai_review_requires_complete_input_proof_and_exact_binding(self):
        for patch in [None, {"session_id": "forged"}, {"dataset_id": "forged"}, {"record_id": "forged"},
                      {"run_id": "forged"}, {"path": "forged"}, {"trace_sha256": "f" * 64},
                      {"source_bundle_sha256": "f" * 64}, {"state_sha256": "f" * 64},
                      {"receipt_refs": []}, {"receipt_refs": [{"call_id": "synthetic", "call_seq": 3, "result_seq": 3}]},
                      {"receipt_refs": [{"call_id": "synthetic", "call_seq": True, "result_seq": 3}]},
                      {"receipt_refs": [{"call_id": "synthetic", "call_seq": 1, "result_seq": 3}] * 2},
                      {"read_method": "datasets/source-fragments"}]:
            with self.subTest(patch=patch):
                row = fixture_row(1)
                row["targets"]["route"]["review"] = ai_review(row)
                if patch is None:
                    del row["targets"]["route"]["review"]["input_evidence"]
                else:
                    row["targets"]["route"]["review"]["input_evidence"].update(patch)
                with self.assertRaises(bridge.BridgeError) as error:
                    bridge.validate_row(row, "train")
                self.assertIn(error.exception.code, {"invalid_review_input", "review_input_mismatch"})

    def test_ai_review_batch_binding_matches_enclosing_export_receipt(self):
        row = self.rows["train"][0]
        row["targets"]["route"]["review"] = ai_review(row)
        self.save()
        def swap_batch(wrapper):
            current = json.loads(wrapper["export"]["content"])
            current["_meta"]["dataset_id"] = "decision-dataset-ffffffff-2222-4222-8222-222222222222"
            current["targets"]["route"]["review"]["input_evidence"]["dataset_id"] = current["_meta"]["dataset_id"]
            wrapper["export"]["content"] = json.dumps(current)
        self.rewrite_wrapper("train", swap_batch)
        self.run_bridge("receipt_identity_mismatch")

    def test_native_message_sources_preserve_delegation_and_context_without_role_rewrite(self):
        for rows in self.rows.values():
            row = rows[0]
            user = deepcopy(row["state"]["messages"][0])
            row["state"]["messages"][0]["source"] = {"kind": "subagent", "senderSessionId": "synthetic-parent", "delegationCallId": "synthetic-call"}
            row["state"]["messages"].append({"role": "user", "content": "合成运行上下文", "source": {"kind": "context", "form": "notice"}})
            row["state"]["messages"].append(user)
            refresh_hash(row)
        self.save(); self.run_bridge()
        for partition in bridge.PARTITIONS:
            native = json.loads((self.output / (partition + ".jsonl")).read_text())
            self.assertEqual(native["state"], self.rows[partition][0]["state"])
            self.assertEqual(native["state"]["messages"][0]["source"]["kind"], "subagent")
            self.assertEqual(native["state"]["messages"][1]["source"]["kind"], "context")

    def test_message_source_rejects_replay_and_supervision_fields(self):
        for source in [{}, {"kind": "model", "replayState": {"private": "hidden"}}, {"kind": "context", "label": "read"}]:
            with self.subTest(source=source):
                row = fixture_row(1)
                row["state"]["messages"][0]["source"] = source
                refresh_hash(row)
                with self.assertRaises(bridge.BridgeError) as error:
                    bridge.validate_row(row, "train")
                self.assertEqual(error.exception.code, "input_target_leakage")

    def test_transitive_group_history_and_run_session_links_block_cross_split(self):
        for relation in ["history", "run", "session"]:
            with self.subTest(relation=relation):
                self.rows = {name: [fixture_row(index + 1, name)] for index, name in enumerate(bridge.PARTITIONS)}
                train, development, calibration = [self.rows[name][0] for name in ("train", "development", "calibration")]
                if relation == "history":
                    train["_meta"]["group_history"].append("old-A")
                    calibration["_meta"]["group_history"] += ["old-A", "old-B"]
                    development["_meta"]["group_history"].append("old-B")
                elif relation == "run":
                    development["_meta"]["run_id"] = train["_meta"]["run_id"]
                else:
                    development["_meta"]["cutoff"]["session_log"] = train["_meta"]["cutoff"]["session_log"]
                    for ref in development["_meta"]["evidence_refs"]:
                        ref["session_log"] = train["_meta"]["cutoff"]["session_log"]
                self.save(); self.run_bridge("cross_partition_group", self.root / relation)

    def test_duplicate_identity_and_canonical_state_cannot_create_independence(self):
        self.rows["development"][0]["_meta"]["id"] = self.rows["train"][0]["_meta"]["id"]
        self.save(); self.run_bridge("duplicate_record_id")
        self.rows["development"] = [fixture_row(2, "development")]
        row = self.rows["development"][0]
        row["state"] = deepcopy(self.rows["train"][0]["state"])
        row["_meta"]["source_group_id"] = bridge.source_group(row)
        row["_meta"]["group_history"].append(row["_meta"]["source_group_id"])
        refresh_hash(row); self.save()
        self.run_bridge("cross_partition_group", self.root / "canonical")

    def test_state_and_question_supervision_leakage_and_future_refs_block(self):
        changes = [
            (lambda row: row["state"].update(targets=row["targets"]), "input_target_leakage"),
            (lambda row: row["questions"]["route"].update(label="read"), "input_target_leakage"),
            (lambda row: row["state"]["messages"][0].update(provenance={"label": "read"}), "input_target_leakage"),
            (lambda row: row["_meta"]["evidence_refs"][0].update(line=11, seq=10), "future_visible_evidence"),
        ]
        for index, (change, code) in enumerate(changes):
            with self.subTest(index=index):
                self.rows["train"] = [fixture_row(1)]
                change(self.rows["train"][0]); refresh_hash(self.rows["train"][0]); self.save()
                self.run_bridge(code, self.root / f"leak-{index}")

    def test_native_rendered_message_collision_cannot_cross_partitions(self):
        train, development = self.rows["train"][0], self.rows["development"][0]
        train["state"]["messages"] = [{"role": "user", "content": "synthetic payload\n    name: fixture"}]
        development["state"]["messages"] = [{"role": "user", "content": "synthetic payload", "name": "fixture"}]
        for row in (train, development):
            row["_meta"]["source_group_id"] = bridge.source_group(row)
            row["_meta"]["group_history"].append(row["_meta"]["source_group_id"])
            refresh_hash(row)
        self.assertNotEqual(train["_meta"]["source_group_id"], development["_meta"]["source_group_id"])
        self.assertNotEqual(bridge.content_hash(train), bridge.content_hash(development))
        self.assertEqual(bridge._native_input.render(train["state"]), bridge._native_input.render(development["state"]))
        self.save()
        self.run_bridge("cross_partition_group")

    def test_conflicting_reviewed_answers_do_not_enter_the_same_training_partition(self):
        original = self.rows["train"][0]
        duplicate = deepcopy(original)
        duplicate["_meta"]["id"] = f"decision-{5:032x}"
        duplicate["_meta"]["decision_id"] = "decision-synthetic-5"
        duplicate["questions"]["route"]["criteria"] = dict(reversed(list(duplicate["questions"]["route"]["criteria"].items())))
        duplicate["targets"]["route"]["label"] = "stop"
        refresh_hash(duplicate)
        self.rows["train"].append(duplicate)
        self.save()
        self.run_bridge("conflicting_reviewed_labels")
        self.assertEqual(duplicate["targets"]["route"]["provenance"]["kind"], "model_suggestion")

    def test_business_labels_inside_past_message_content_are_preserved(self):
        row = self.rows["train"][0]
        row["state"]["messages"].append({"role": "tool", "content": {"label": "业务标签", "outcome": "PARTIAL", "result": {"count": 2}}})
        refresh_hash(row); self.save(); self.run_bridge()
        native = json.loads((self.output / "train.jsonl").read_text())
        self.assertEqual(native["state"], row["state"])

    def add_soft_types(self):
        row = self.rows["train"][0]
        row["questions"]["enough"] = {"type": "noul", "instructions": "当前输入足够吗？"}
        row["questions"]["priority"] = {"type": "score", "instructions": "优先程度？", "criteria": ["低", "高"]}
        row["targets"]["route"]["probabilities"] = {"read": 0.5, "stop": 0.5}
        row["targets"]["enough"] = {**deepcopy(row["targets"]["route"]), "label": False, "probabilities": {"false": 0.7, "true": 0.3}}
        row["targets"]["priority"] = {**deepcopy(row["targets"]["route"]), "label": 1, "probabilities": {"0": 0.1, "1": 0.9}}
        refresh_hash(row)

    def test_all_soft_types_keep_exact_probabilities_and_typed_labels(self):
        self.add_soft_types(); self.save(); self.run_bridge()
        native = json.loads((self.output / "train.jsonl").read_text())
        for name, target in self.rows["train"][0]["targets"].items():
            self.assertEqual(native["questions"][name]["target"], target["probabilities"])
            self.assertEqual(type(native["questions"][name]["label"]), type(target["label"]))
        for index, probabilities in enumerate([{"read": 1.0}, {"read": 0.2, "stop": 0.9}, {"read": True, "stop": 0.0}]):
            self.rows["train"][0]["targets"]["route"]["probabilities"] = probabilities
            self.save(); self.run_bridge("invalid_probabilities", self.root / f"soft-{index}")

    def test_receipt_file_hash_read_identity_and_extractor_tampering_block(self):
        self.save()
        with (self.root / "train.json").open("a") as handle:
            handle.write(" ")
        self.run_bridge("file_hash_mismatch")
        self.save()
        self.rewrite_wrapper("train", lambda wrapper: wrapper.update(read_sha256="f" * 64))
        self.run_bridge("receipt_identity_mismatch", self.root / "read-id")
        self.rows["train"][0]["_meta"]["extractor"]["skill_sha256"] = "f" * 64
        self.save(); self.run_bridge("harness_hash_mismatch", self.root / "extractor")

    def test_source_projection_and_eligibility_tampering_block(self):
        self.rows["train"][0]["state"]["messages"][0]["content"] = "篡改输入"
        self.save(); self.run_bridge("content_hash_mismatch")
        self.rows["train"] = [fixture_row(1)]; self.save()
        self.rewrite_wrapper("train", lambda wrapper: wrapper["export"]["eligibility"]["records"][0].update(eligible_questions=[]))
        self.run_bridge("eligibility_mismatch", self.root / "eligibility")
        self.save()
        self.rewrite_wrapper("train", lambda wrapper: wrapper["export"].update(blocked=[{"record_id": "synthetic", "reasons": ["未复核"]}]))
        self.run_bridge("blocked_export", self.root / "blocked")

    def test_observed_action_semantics_preserved_and_unsupported_type_stops(self):
        row = self.rows["train"][0]
        row["task"]["semantics"] = "observed_action"
        row["targets"]["route"]["provenance"] = {"kind": "observed_action", "run_id": row["_meta"]["run_id"],
            "decision_id": row["_meta"]["decision_id"], "trace_sha256": row["_meta"]["trace_sha256"], "ref": deepcopy(row["_meta"]["cutoff"])}
        refresh_hash(row); self.save(); self.run_bridge()
        row["targets"]["route"]["label"] = "stop"
        self.save(); self.run_bridge("observed_action_mismatch", self.root / "action")
        self.rows["train"] = [fixture_row(1)]
        self.rows["train"][0]["questions"]["route"]["type"] = "free_text"
        refresh_hash(self.rows["train"][0]); self.save()
        self.run_bridge("unsupported_question_type", self.root / "unsupported")

    def test_cli_requires_all_partitions_and_retains_blocked_report(self):
        manifest = self.save()
        manifest["partitions"]["test"] = []
        self.manifest.write_text(json.dumps(manifest))
        result = subprocess.run([sys.executable, str(Path(bridge.__file__)), str(self.manifest), "--out", str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('当前不能继续', result.stdout)
        self.assertIn('empty_partition', result.stdout)
        self.assertTrue(json.loads((self.output / 'platform-bridge-report.json').read_text())["blocked"])
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), ["platform-bridge-report.json", "report.md"])
        existing = (self.output / "platform-bridge-report.json").read_bytes()
        existing_readable = (self.output / "report.md").read_bytes()
        with self.assertRaisesRegex(bridge.BridgeError, "输出目录"):
            bridge.convert(self.manifest, self.output)
        self.assertEqual(existing, (self.output / "platform-bridge-report.json").read_bytes())
        self.assertEqual(existing_readable, (self.output / "report.md").read_bytes())

    def test_default_and_json_cli_keep_identical_native_data(self):
        self.save()
        command = [sys.executable, str(Path(bridge.__file__)), str(self.manifest), '--out']
        human = subprocess.run(command + [str(self.output)], capture_output=True, text=True, timeout=15)
        machine_out = self.root / 'json-output'
        machine = subprocess.run(command + [str(machine_out), '--json'], capture_output=True, text=True, timeout=15)
        self.assertEqual(human.returncode, 0, human.stdout + human.stderr)
        self.assertEqual(machine.returncode, 0, machine.stdout + machine.stderr)
        self.assertIn('还需复核', human.stdout)
        self.assertIn('转换 4 条记录、4 道题', human.stdout)
        self.assertIn('编码长度尚未检查，训练尚未执行', human.stdout)
        self.assertNotIn(self.rows['train'][0]['_meta']['trace_sha256'], human.stdout)
        payload = json.loads(machine.stdout)
        self.assertEqual(payload['status'], 'ready')
        self.assertFalse(payload['blocked'])
        self.assertEqual(payload['errors'], [])
        for name in [*(partition + '.jsonl' for partition in bridge.PARTITIONS), 'split-manifest.json', 'platform-bridge-report.json', 'report.md']:
            self.assertEqual((self.output / name).read_bytes(), (machine_out / name).read_bytes(), name)
        native = json.loads((machine_out / 'train.jsonl').read_text())
        self.assertEqual(native['_meta']['platform']['targets'], self.rows['train'][0]['targets'])
        report = (machine_out / 'report.md').read_text()
        self.assertIn('模型建议及未校准等原始状态保持原样', report)
        self.assertNotIn('](http', report)

    def test_invalid_json_and_missing_file_keep_diagnostics_without_traceback(self):
        command = [sys.executable, str(Path(bridge.__file__)), str(self.manifest), '--out']
        self.manifest.write_text('{broken}\n', encoding='utf-8')
        broken = subprocess.run(command + [str(self.output)], capture_output=True, text=True, timeout=15)
        self.assertEqual(broken.returncode, 1)
        self.assertIn('当前不能继续', broken.stdout)
        self.assertNotIn('Traceback', broken.stdout + broken.stderr)
        report = json.loads((self.output / 'platform-bridge-report.json').read_text())
        self.assertEqual(report['errors'][0]['code'], 'invalid_input')
        self.assertIn(report['errors'][0]['message'], (self.output / 'report.md').read_text())
        self.manifest.unlink()
        missing_out = self.root / 'missing-input'
        missing = subprocess.run(command + [str(missing_out), '--json'], capture_output=True, text=True, timeout=15)
        self.assertEqual(missing.returncode, 1)
        payload = json.loads(missing.stdout)
        self.assertEqual(payload['errors'][0]['code'], 'io_error')
        self.assertTrue((missing_out / 'report.md').is_file())

    def test_cli_existing_output_keeps_all_previous_results(self):
        self.save()
        self.run_bridge()
        before = {path.name:path.read_bytes() for path in self.output.iterdir()}
        result = subprocess.run([sys.executable, str(Path(bridge.__file__)), str(self.manifest), '--out', str(self.output)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn('当前不能继续', result.stdout)
        self.assertIn('output_not_empty', result.stdout)
        self.assertIn('未保存新的可读报告', result.stdout)
        self.assertEqual(before, {path.name:path.read_bytes() for path in self.output.iterdir()})

    def test_multiple_export_files_keep_rows_and_question_mapping(self):
        manifest = self.save()
        wrapper = envelope(5, "train", [fixture_row(5)])
        path = self.root / "second-train.json"
        path.write_text(json.dumps(wrapper, ensure_ascii=False), encoding="utf-8")
        manifest["partitions"]["train"].append({"path": path.name, "sha256": bridge.sha(path.read_bytes()),
            "dataset_id": wrapper["dataset_id"], "read_sha256": wrapper["read_sha256"]})
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        report = self.run_bridge()
        self.assertEqual(report["records"], 5)
        self.assertEqual(report["files"]["train"]["records"], 2)
        mappings = [item for item in report["mappings"] if item["partition"] == "train"]
        self.assertEqual([item["output_line"] for item in mappings], [1, 2])
        self.assertEqual([item["record_id"] for item in mappings], [f"decision-{1:032x}", f"decision-{5:032x}"])
        self.assertTrue(all(item["questions"] == ["route"] for item in mappings))

    def test_native_calibration_groups_preserve_transitive_platform_links(self):
        """KEV 原生只读取 group_id；同分区的历史关联也必须进入同一个校准折。"""
        row = fixture_row(5, "calibration")
        row["_meta"]["group_history"].append(self.rows["calibration"][0]["_meta"]["group_id"])
        manifest = self.save()
        wrapper = envelope(5, "calibration", [row])
        path = self.root / "second-calibration.json"
        path.write_text(json.dumps(wrapper, ensure_ascii=False), encoding="utf-8")
        manifest["partitions"]["calibration"].append({"path": path.name, "sha256": bridge.sha(path.read_bytes()),
            "dataset_id": wrapper["dataset_id"], "read_sha256": wrapper["read_sha256"]})
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        report = self.run_bridge()
        native = [json.loads(line) for line in (self.output / "calibration.jsonl").read_text().splitlines()]
        self.assertEqual(len(native), 2)
        self.assertNotEqual(native[0]["_meta"]["platform"]["original_group_id"], native[1]["_meta"]["platform"]["original_group_id"])
        self.assertEqual(native[0]["_meta"]["group_id"], native[1]["_meta"]["group_id"])
        self.assertEqual(native[0]["_meta"]["group_id"], native[1]["_meta"]["bridge_group_id"])
        self.assertEqual(native[1]["_meta"]["group_history"], row["_meta"]["group_history"])
        mappings = [item for item in report["mappings"] if item["partition"] == "calibration"]
        self.assertEqual([item["original_group_id"] for item in mappings],
            [item["_meta"]["platform"]["original_group_id"] for item in native])
        output_manifest = json.loads((self.output / "split-manifest.json").read_text())
        self.assertEqual(output_manifest["partition_groups"]["calibration"], 1)
        self.assertEqual(output_manifest["group_members"][native[0]["_meta"]["group_id"]], sorted(item["_meta"]["id"] for item in native))

    def test_platform_receipts_to_training_plan_cli_preserves_partitions_and_blocks_tampering(self):
        """执行两段真实 CLI，元数据均为合成夹具；只生成交接卡，不启动训练。"""
        manifest = self.save()
        extra = fixture_row(5, "calibration")
        wrapper = envelope(5, "calibration", [extra])
        path = self.root / "second-calibration.json"
        path.write_text(json.dumps(wrapper, ensure_ascii=False), encoding="utf-8")
        manifest["partitions"]["calibration"].append({"path": path.name, "sha256": bridge.sha(path.read_bytes()),
            "dataset_id": wrapper["dataset_id"], "read_sha256": wrapper["read_sha256"]})
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        source_bytes = {path: path.read_bytes() for path in self.root.glob("*.json")}
        converted = subprocess.run([sys.executable, str(Path(bridge.__file__)), str(self.manifest), "--out", str(self.output)],
            capture_output=True, text=True)
        self.assertEqual(converted.returncode, 0, converted.stdout + converted.stderr)
        self.assertEqual(source_bytes, {path: path.read_bytes() for path in source_bytes})
        metadata = self.root / "synthetic-training-config.json"
        metadata.write_text(json.dumps({"base_revision": "b" * 40, "args": {
            "base": "synthetic/base", "base_revision": "b" * 40, "lora": 16, "head_dim": 256,
            "option_isolation": 0, "special_embeddings": 0, "lora_targets": "all", "weights_dtype": "fp32", "full_ft": 0}}))
        request = {"schema_version": "kev-training-request/v1", "intent": "prepare_training",
            "source": {"agent_id": "synthetic-agent", "parent_experiment_id": "EXP-synthetic-001", "parent_ref": "git:" + "a" * 40,
                "source_run_ids": [rows[0]["_meta"]["run_id"] for rows in self.rows.values()] + [extra["_meta"]["run_id"]]},
            "dataset": {"kind": "platform-v2", "directory": str(self.output)},
            "checkpoint": {"init_from": "synthetic/checkpoint@" + "c" * 40, "training_config_path": str(metadata),
                "training_config_sha256": bridge.sha(metadata.read_bytes())},
            "environment": {"kev_root": str(self.root / "synthetic-kev"), "run_root": str(self.root / "synthetic-unstarted-job")},
            "training": {"calibration_folds": 2}}
        request_path = self.root / "synthetic-request.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")
        planner = Path(os.environ["HARNESS_ASSET_ROOT"]) / ".agents/skills/kev-training/scripts/training_plan.py"
        command = [sys.executable, str(planner), "prepare", "--request", str(request_path), "--out"]
        handoff = self.root / "handoff"
        prepared = subprocess.run(command + [str(handoff)], capture_output=True, text=True)
        self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
        plan = json.loads((handoff / "training-plan.json").read_text())
        self.assertEqual(plan["dataset"]["kind"], "platform-v2")
        self.assertEqual(plan["dataset"]["files"]["calibration"]["groups"], 2)
        self.assertEqual(plan["dataset"]["audit"]["sha256"], bridge.sha((self.output / "platform-bridge-report.json").read_bytes()))
        for partition, item in plan["dataset"]["files"].items():
            self.assertEqual(item["sha256"], bridge.sha((self.output / (partition + ".jsonl")).read_bytes()))
        self.assertIn(str(self.output / "train.jsonl"), plan["commands"]["train"]["argv"])
        self.assertIn(str(self.output / "test.jsonl"), plan["commands"]["final-test"]["argv"])
        self.assertNotIn(str(self.output / "test.jsonl"), plan["commands"]["train"]["argv"])
        self.assertEqual(plan["execution"]["training"], "not_run")
        self.assertEqual(plan["execution"]["calibration"], "not_run")
        self.assertFalse(Path(request["environment"]["run_root"]).exists())
        self.assertEqual(json.loads((handoff / "stage-status.json").read_text())["status"], "requires_review")
        changed = self.output / "train.jsonl"
        changed.write_bytes(changed.read_bytes() + b"\n")
        blocked = self.root / "blocked-handoff"
        result = subprocess.run(command + [str(blocked)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("platform_bridge_file_changed", (blocked / "stage-status.json").read_text())
        self.assertFalse((blocked / "training-plan.json").exists())

    @unittest.skipUnless(os.environ.get("KEV_UPSTREAM_ROOT"), "设置 KEV_UPSTREAM_ROOT 可核对固定上游的实际函数")
    def test_actual_upstream_loader_and_materializer(self):
        """执行上游原函数；跳过与此测试无关的 Hugging Face 数据集导入。"""
        self.add_soft_types(); self.save(); self.run_bridge()
        root = Path(os.environ["KEV_UPSTREAM_ROOT"])
        spec = importlib.util.spec_from_file_location("kev_contract_api", root / "kev/api.py")
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        source = ast.parse((root / "kev/data.py").read_text())
        functions = [item for item in source.body if isinstance(item, ast.FunctionDef) and item.name in {"load_records", "api_request", "materialize"}]
        namespace = {"Path": Path, "json": json, "hashlib": hashlib, "SystemOneRequest": api.SystemOneRequest, "to_record": api.to_record}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(root / "kev/data.py"), "exec"), namespace)
        for partition in bridge.PARTITIONS:
            rows = namespace["load_records"](self.output / (partition + ".jsonl"))
            for row in rows:
                request = namespace["api_request"](row)
                self.assertEqual(set(request), {"state", "questions"})
                self.assertTrue(all(set(question) <= {"type", "instructions", "criteria"} for question in request["questions"].values()))
                materialized = namespace["materialize"](row)
                self.assertEqual(len(materialized["questions"]), len(row["questions"]))
                if partition == "train":
                    self.assertEqual([question["label"] for question in materialized["questions"]], [0, 0, 1])
                    self.assertEqual(materialized["questions"][1]["target"], [0.7, 0.3])


if __name__ == "__main__":
    unittest.main()

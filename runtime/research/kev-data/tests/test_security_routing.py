"""Synthetic routing boundaries and leakage invariants; no private source rows."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from dataset import compile_records
from security_routing import (
    CONTRACT_PATH, CONTRACT_VERSION, INPUT_BUILDER_VERSION, PROFILE,
    build_routing_input, contract_definition,
)
from trace_adapter import audit_rows, build_sample, extract, parse_trace


def rows(*, request="请研判这个人工合成的告警。", background=None, seeded=False, framework_messages=None):
    events = deepcopy(framework_messages or [])
    if background is not None:
        events.append({"type": "user/message", "data": {"role": "user",
            "source": {"kind": "user"}, "content": [{"type": "text", "text": background}]},
            "surfaceOp": "append"})
    events.extend([
        {"type": "user/message", "data": {"role": "user", "source": {"kind": "user"},
            "content": [{"type": "text", "text": request}]}, "surfaceOp": "append"},
        {"type": "request/header", "data": {"header": {"config": {"model": "synthetic-model"},
            "tools": [{"name": "synthetic_lookup", "description": "Artificial fixture operation", "parameters": {"type": "object"}}]}}},
        {"type": "assistant/message", "data": {"turn": 1, "step": 1, "message": {
            "role": "assistant", "source": {"kind": "model"}, "content": [{"type": "tool-call",
                "id": "fixture-call", "name": "synthetic_lookup", "arguments": "{}"}]}}, "surfaceOp": "append"},
        {"type": "tool/call", "data": {"turn": 1, "step": 1, "callId": "fixture-call", "name": "synthetic_lookup", "arguments": "{}"}},
        {"type": "tool/result", "data": {"turn": 1, "step": 1, "message": {"role": "tool",
            "source": {"kind": "tool", "callId": "fixture-call"}, "toolCallId": "fixture-call",
            "content": [{"type": "text", "text": '{"status":"COMPLETE","synthetic_result":"benign"}'}],
            "isError": False}}, "surfaceOp": "append"},
        {"type": "assistant/message", "data": {"turn": 1, "step": 2, "message": {"role": "assistant",
            "source": {"kind": "model"}, "content": [{"type": "text", "text": "Artificial result."}]}}, "surfaceOp": "append"},
    ])
    call_index = next(i for i, event in enumerate(events) if event["type"] == "tool/call")
    next(event for event in events if event["type"] == "tool/result")["sourceEventSeqs"] = [call_index]
    return wrap(events, seeded=seeded)


def wrap(events, *, seeded=False):
    header = {"type": "session", "version": 4, "id": "synthetic-routing-session", "isSeeded": seeded}
    return [{"line": 1, "session_log": "synthetic.v4.jsonl", "event": header}] + [
        {"line": i + 2, "session_log": "synthetic.v4.jsonl", "event": dict(event, seq=i)}
        for i, event in enumerate(events)
    ]


def first_sample(source=None):
    snapshot = audit_rows(source if source is not None else rows())["snapshots"][0]
    sample, problem = build_sample(snapshot, PROFILE)
    if problem is not None:
        raise AssertionError(problem)
    return sample


def framework_message(event_type, source_kind, text):
    message = {"role": event_type.split("/")[0], "source": {"kind": source_kind},
               "content": [{"type": "text", "text": text}]}
    return {"type": event_type, "data": message if event_type == "user/message" else {"message": message},
            "surfaceOp": "append"}


class SecurityRoutingTests(unittest.TestCase):
    def test_initial_first_response_produces_unlabeled_agent_route(self):
        sample = first_sample()
        self.assertEqual(sample["decision_site_id"], "agent_route")
        self.assertEqual(sample["contract_version"], CONTRACT_VERSION)
        self.assertEqual(list(sample["question"]["criteria"]), [
            "威胁研判", "响应处置", "策略生成", "安全巡检", "故障排查", "知识问答", "报告生成", "其他（兜底）",
        ])
        self.assertEqual(sample["state"]["用户输入指令"], "请研判这个人工合成的告警。")
        self.assertEqual(sample["state"]["背景信息"], [])
        self.assertEqual(sample["label"], {"status": "unlabeled", "value": None, "source": "", "evidence_refs": []})
        self.assertIsNone(sample["observed_candidate"])
        self.assertIsNone(sample["review"]["rule_suggestion"])
        self.assertEqual(sample["candidate_bindings"], {})
        self.assertEqual(sample["review"]["token_budget_status"], "requires_actual_encoding_preflight")
        self.assertEqual(sample["provenance"]["state_builder_version"], INPUT_BUILDER_VERSION)

    def test_polling_and_result_response_are_not_new_route_tasks(self):
        samples, skipped = extract(audit_rows(rows()), PROFILE)
        self.assertEqual(len(samples), 1)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]["reason"], "not_initial_routing_boundary")
        self.assertEqual(skipped[0]["disposition"], "skip")

    def test_new_user_turn_without_proven_route_trigger_is_skipped(self):
        source = rows()
        events = [item["event"] for item in source[1:]]
        events.extend([
            {"type": "turn/start", "data": {"turn": 2}},
            {"type": "user/message", "data": {"role": "user", "source": {"kind": "user"},
                "content": [{"type": "text", "text": "合成的后续用户消息。"}]}, "surfaceOp": "append"},
            {"type": "assistant/message", "data": {"turn": 2, "step": 1, "message": {"role": "assistant",
                "source": {"kind": "model"}, "content": [{"type": "text", "text": "合成响应。"}]}}, "surfaceOp": "append"},
        ])
        sample, reason = build_sample(audit_rows(wrap(events))["snapshots"][-1], PROFILE)
        self.assertIsNone(sample)
        self.assertEqual(reason["reason"], "not_initial_routing_boundary")

    def test_compacted_surface_cannot_hide_already_taken_actions(self):
        source = rows()
        events = [item["event"] for item in source[1:]]
        events.insert(5, {"type": "user/message", "data": {"role": "user", "source": {"kind": "user"},
            "content": [{"type": "text", "text": "合成的替换消息。"}]},
            "surfaceOp": {"op": "replace", "startSeq": 0, "endSeq": 4}, "sourceEventSeqs": [0, 2, 4]})
        snap = audit_rows(wrap(events))["snapshots"][-1]
        self.assertEqual(len(snap["surface"]), 1)
        self.assertEqual(snap["prefix_context"]["prior_model_response_count"], 1)
        self.assertEqual(build_sample(snap, PROFILE)[1]["reason"], "not_initial_routing_boundary")

    def test_current_action_and_future_final_outcomes_do_not_change_input(self):
        source = rows()
        changed = deepcopy(source)
        for row in changed:
            event = row["event"]
            if event["type"] == "assistant/message":
                content = event["data"]["message"]["content"][0]
                if content["type"] == "tool-call":
                    content["arguments"] = '{"current_action_change":"synthetic"}'
                else:
                    content["text"] = "A completely different future conclusion."
            elif event["type"] == "tool/call":
                event["data"]["arguments"] = '{"current_action_change":"synthetic"}'
            elif event["type"] == "tool/result":
                event["data"]["message"]["content"][0]["text"] = '{"status":"FAILED","synthetic_result":"malicious"}'
        left, right = first_sample(source), first_sample(changed)
        self.assertEqual((left["state"], left["question"]), (right["state"], right["question"]))
        self.assertNotEqual(left["observed_action"], right["observed_action"])
        self.assertIsNone(right["observed_candidate"])
        self.assertIsNone(right["label"]["value"])

    def test_prior_visible_background_is_preserved_with_real_refs(self):
        before = first_sample(rows(background="合成背景甲：仅有人工模拟证据。"))
        after = first_sample(rows(background="合成背景乙：可见事实已改变。"))
        self.assertNotEqual(before["state"], after["state"])
        self.assertEqual(before["question"], after["question"])
        self.assertEqual(before["state"]["背景信息"], ["合成背景甲：仅有人工模拟证据。"])
        refs = before["provenance"]["state_evidence_refs"]
        self.assertEqual([ref["seq"] for ref in refs], [1, 0])
        self.assertTrue(all(ref["seq"] < before["provenance"]["decision_seq"] for ref in refs))

    def test_large_framework_prefix_is_auditable_but_not_business_input(self):
        framework = [
            framework_message("system/message", "system", "人工合成的系统说明。" * 3000),
            framework_message("developer/message", "agent-instructions", "人工合成的框架指令。" * 3000),
            *[framework_message("user/message", "runtime-context", "注入的人工合成运行说明。") for _ in range(18)],
            framework_message("user/message", "skill-catalog", "人工合成的可用技能目录。"),
        ]
        snap = audit_rows(rows(framework_messages=framework))["snapshots"][0]
        original = deepcopy(snap)
        with_framework, problem = build_sample(snap, PROFILE)
        self.assertIsNone(problem)
        without_framework = first_sample()
        self.assertEqual((with_framework["state"], with_framework["question"]),
                         (without_framework["state"], without_framework["question"]))
        self.assertEqual(snap, original)
        self.assertEqual(len(snap["surface"]), len(framework) + 1)
        self.assertEqual(with_framework["provenance"]["visible_event_seqs"], snap["visible_event_seqs"])
        self.assertEqual(with_framework["provenance"]["prefix_digest"], snap["prefix_digest"])
        self.assertEqual(with_framework["review"]["excluded_framework_message_count"], len(framework))
        self.assertEqual(len(with_framework["provenance"]["excluded_context_evidence_refs"]), len(framework))
        self.assertEqual([ref["seq"] for ref in with_framework["provenance"]["state_evidence_refs"]], [len(framework)])

    def test_framework_content_change_does_not_change_supervised_business_task(self):
        before = rows(framework_messages=[framework_message("developer/message", "agent-instructions", "合成框架说明甲。")])
        after = rows(framework_messages=[framework_message("developer/message", "agent-instructions", "不同的合成框架说明乙。")])
        left, right = first_sample(before), first_sample(after)
        self.assertEqual((left["state"], left["question"]), (right["state"], right["question"]))
        self.assertNotEqual(left["provenance"]["prefix_digest"], right["provenance"]["prefix_digest"])
        self.assertIsNone(left["label"]["value"])
        self.assertIsNone(right["label"]["value"])

    def test_excluded_context_cannot_silently_resolve_a_missing_user_referent(self):
        source = rows(request="继续刚才那个。", framework_messages=[
            framework_message("user/message", "runtime-context", "仅在注入上下文中出现的人工合成业务解释。"),
        ])
        sample = first_sample(source)
        self.assertEqual(sample["state"], {"用户输入指令": "继续刚才那个。", "背景信息": []})
        self.assertEqual(sample["review"]["context_sufficiency"], "requires_review")
        self.assertEqual(sample["review"]["business_context_sources"], "actual_user_messages_only")
        self.assertIsNone(sample["label"]["value"])

    def test_missing_referent_context_stays_for_review_not_other(self):
        sample = first_sample(rows(request="继续刚才那个。"))
        self.assertEqual(sample["state"]["背景信息"], [])
        self.assertEqual(sample["review"]["context_sufficiency"], "requires_review")
        self.assertFalse(sample["review"]["missing_context_is_other"])
        self.assertIsNone(sample["label"]["value"])
        self.assertIsNone(sample["observed_candidate"])

    def test_missing_actual_user_message_requires_review(self):
        source = rows()
        source[1]["event"]["data"]["source"]["kind"] = "runtime-context"
        sample, reason = build_sample(audit_rows(source)["snapshots"][0], PROFILE)
        self.assertIsNone(sample)
        self.assertEqual(reason["reason"], "missing_actual_user_message")
        self.assertEqual(reason["disposition"], "requires_review")

    def test_empty_request_is_not_silently_other(self):
        sample, reason = build_sample(audit_rows(rows(request="  \n"))["snapshots"][0], PROFILE)
        self.assertIsNone(sample)
        self.assertEqual(reason["reason"], "empty_user_request")

    def test_tool_rename_never_creates_agent_bindings(self):
        source = rows()
        changed = deepcopy(source)
        for row in changed:
            event = row["event"]
            if event["type"] == "request/header":
                event["data"]["header"]["tools"][0]["name"] = "unrelated_new_tool"
            elif event["type"] == "tool/call":
                event["data"]["name"] = "unrelated_new_tool"
            elif event["type"] == "assistant/message":
                block = event["data"]["message"]["content"][0]
                if block["type"] == "tool-call":
                    block["name"] = "unrelated_new_tool"
        before, after = first_sample(source), first_sample(changed)
        self.assertEqual((before["state"], before["question"]), (after["state"], after["question"]))
        self.assertEqual(after["candidate_bindings"], {})
        self.assertEqual(after["provenance"]["candidate_evidence_refs"], before["provenance"]["candidate_evidence_refs"])
        self.assertFalse(after["review"]["deployment_ready"])

    def test_shared_builder_is_pure_and_matches_offline_input(self):
        snap = audit_rows(rows(background="人工合成的可见背景。"))["snapshots"][0]
        before = deepcopy(snap)
        projection, reason = build_routing_input(snap["surface"], snap["request_header"],
            decision_seq=snap["decision_seq"], prefix_context=snap["prefix_context"])
        self.assertIsNone(reason)
        self.assertEqual(snap, before)
        sample = build_sample(snap, PROFILE)[0]
        self.assertEqual(projection["state"], sample["state"])
        self.assertEqual(projection["question"], sample["question"])
        projection["question"]["criteria"].clear()
        self.assertEqual(len(build_sample(snap, PROFILE)[0]["question"]["criteria"]), 8)

    def test_missing_boundary_counts_cannot_be_inferred_from_short_surface(self):
        snap = audit_rows(rows())["snapshots"][0]
        del snap["prefix_context"]
        self.assertEqual(build_sample(snap, PROFILE)[1]["reason"], "missing_routing_boundary_evidence")

    def test_seeded_or_parent_session_is_not_claimed_initial(self):
        self.assertEqual(build_sample(audit_rows(rows(seeded=True))["snapshots"][0], PROFILE)[1]["reason"],
                         "inherited_context_not_verified")
        source = rows()
        source[0]["event"]["parentSession"] = "synthetic-parent"
        self.assertEqual(build_sample(audit_rows(source)["snapshots"][0], PROFILE)[1]["reason"],
                         "inherited_context_not_verified")

    def test_scope_overflow_is_rejected_without_truncation(self):
        maximum = contract_definition()["input_projection"]["max_total_text_characters"]
        snap = audit_rows(rows(request="人工" * maximum))["snapshots"][0]
        original = deepcopy(snap)
        sample, reason = build_sample(snap, PROFILE)
        self.assertIsNone(sample)
        self.assertEqual(reason["reason"], "routing_projection_scope_exceeded")
        self.assertEqual(reason["limit"], "max_total_text_characters")
        self.assertEqual(snap, original)

    def test_nontext_context_is_not_silently_dropped(self):
        source = rows()
        source[1]["event"]["data"]["content"].append({"type": "tool-addition", "toolName": "fixture-only"})
        sample, reason = build_sample(audit_rows(source)["snapshots"][0], PROFILE)
        self.assertIsNone(sample)
        self.assertEqual(reason["reason"], "unsupported_routing_context")

    def test_framework_nontext_blocks_stay_outside_business_state(self):
        framework = framework_message("developer/message", "runtime-context", "人工合成框架消息。")
        framework["data"]["message"]["content"].append({"type": "tool-addition", "toolName": "fixture-only"})
        sample = first_sample(rows(framework_messages=[framework]))
        self.assertEqual(sample["state"], first_sample()["state"])
        self.assertEqual(sample["review"]["excluded_framework_message_count"], 1)

    def test_candidate_evidence_is_actual_versioned_static_contract(self):
        ref = first_sample()["provenance"]["candidate_evidence_refs"][0]
        self.assertEqual(ref["kind"], "contract")
        self.assertEqual(ref["contract_sha256"], hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest())
        self.assertEqual(ref["contract_version"], json.loads(CONTRACT_PATH.read_text())["contract_version"])
        self.assertNotIn("label", contract_definition()["question"])

    def test_compile_requires_review_and_preserves_agent_route_after_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "synthetic.v4.jsonl"
            source.write_text("\n".join(json.dumps({"session_log": row["session_log"], "event": row["event"]})
                                       for row in rows()) + "\n", encoding="utf-8")
            sample = build_sample(parse_trace(source)["snapshots"][0], PROFILE)[0]
        compiled, quarantine, _ = compile_records([sample])
        self.assertFalse(compiled)
        self.assertIn("label_unlabeled", quarantine[0]["reason_codes"])
        sample["label"] = {"status": "verified", "value": "威胁研判", "source": "synthetic-human-review",
                           "evidence_refs": [{"kind": "review", "note": "Manually reviewed synthetic fixture."}]}
        compiled, quarantine, _ = compile_records([sample])
        self.assertFalse(quarantine)
        self.assertEqual(list(compiled[0]["questions"]), ["agent_route"])
        sample["provenance"]["candidate_evidence_refs"][0]["contract_sha256"] = "not-a-hash"
        compiled, quarantine, _ = compile_records([sample])
        self.assertFalse(compiled)
        self.assertIn("invalid_contract_sha256", quarantine[0]["reason_codes"])

    def test_parse_error_keeps_source_path_line_and_original_exception(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "synthetic-invalid.jsonl"
            source.write_text(json.dumps(rows()[0]["event"]) + "\n{invalid\n", encoding="utf-8")
            with self.assertRaises(ValueError) as caught:
                parse_trace(source)
            self.assertIn(f"{source}:2:", str(caught.exception))
            self.assertIsInstance(caught.exception.__cause__, json.JSONDecodeError)


if __name__ == "__main__":
    unittest.main()

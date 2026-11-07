#!/usr/bin/env python3
"""Bounded, prefix-only eight-class intent routing; no runtime Agent bindings.

``build_routing_input`` is the shared offline/runtime input constructor. It never
accepts the current response, a label, or later outcomes. Loading the versioned
static contract is the module's only I/O; constructing inputs is a pure function.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path


PROFILE = "cybersecurity-routing-v1"
INPUT_BUILDER_VERSION = "security-routing-input/v1"
CONTRACT_PATH = Path(__file__).resolve().parent / "assets" / "security-routing-contract.json"
_CONTRACT_BYTES = CONTRACT_PATH.read_bytes()
_CONTRACT = json.loads(_CONTRACT_BYTES)
CONTRACT_VERSION = _CONTRACT["contract_version"]
CONTRACT_SHA256 = hashlib.sha256(_CONTRACT_BYTES).hexdigest()
QUESTION_ID = _CONTRACT["decision_site_id"]


def _stable(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_stable(value).encode("utf-8")).hexdigest()


def contract_definition():
    """Return a detached copy; callers cannot alter the fixed input contract."""
    return copy.deepcopy(_CONTRACT)


def _problem(reason, *, disposition="requires_review", **details):
    return None, {"reason": reason, "disposition": disposition, **details}


def _event_ref(node):
    return {"kind": "event", "line": node["line"], "seq": node["seq"],
            "pointer": "/data/content" if node["event_type"] == "user/message" else "/data/message/content"}


def _text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list) or any(
        not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str)
        for block in content
    ):
        return None
    return "\n".join(block["text"] for block in content)


def build_routing_input(surface, request_header, *, decision_seq, prefix_context):
    """Build input from a complete, pre-decision visible prefix, or explain refusal.

    Args are the adapter's ``snap.surface``, ``snap.request_header``,
    ``snap.decision_seq`` and ``snap.prefix_context``. A runtime integration must
    obtain the equivalent fields from its trusted, complete session prefix;
    zero counts cannot be inferred from a compacted surface. The returned
    ``state`` and ``question`` are the only model input. Evidence and ``review``
    remain outside it. Only actual user messages supply business input; framework
    messages stay in the untouched audit surface. Character/message limits apply
    to the selected business messages, not the full audit prefix, and are not
    token counts. No mutation, summarization, truncation or label inference.
    """
    if not isinstance(prefix_context, dict):
        return _problem("missing_routing_boundary_evidence")
    count_fields = ("prior_model_response_count", "prior_assistant_message_count", "prior_tool_activity_count")
    if any(type(prefix_context.get(key)) is not int or prefix_context[key] < 0 for key in count_fields):
        return _problem("invalid_routing_boundary_evidence")
    if prefix_context.get("session_has_inherited_context") is not False:
        return _problem("inherited_context_not_verified")
    if any(prefix_context[key] for key in count_fields):
        return _problem("not_initial_routing_boundary", disposition="skip")
    if type(decision_seq) is not int or decision_seq < 0:
        return _problem("invalid_routing_decision_seq")
    if not isinstance(request_header, dict) or not isinstance(request_header.get("tools"), list):
        return _problem("missing_routing_request_header")
    if not isinstance(surface, list):
        return _problem("invalid_routing_surface")
    limits = _CONTRACT["input_projection"]
    actual_users = []
    excluded_refs = []
    seen = set()
    total_chars = 0
    for node in surface:
        if not isinstance(node, dict) or not isinstance(node.get("message"), dict):
            return _problem("invalid_routing_surface_node")
        seq = node.get("seq")
        if type(seq) is not int or seq < 0 or seq >= decision_seq or seq in seen or type(node.get("line")) is not int:
            return _problem("invalid_routing_prefix_evidence")
        seen.add(seq)
        typ = node.get("event_type")
        if typ in {"assistant/message", "tool/result"}:
            return _problem("not_initial_routing_boundary", disposition="skip")
        if typ not in {"system/message", "developer/message", "user/message"}:
            return _problem("unsupported_routing_message_type")
        message = node["message"]
        source = message.get("source", {})
        if not isinstance(source, dict):
            return _problem("unsupported_routing_context")
        if typ != "user/message" or source.get("kind") != "user":
            excluded_refs.append(_event_ref(node))
            continue
        content = _text(message)
        if content is None:
            return _problem("unsupported_routing_context")
        total_chars += len(content)
        actual_users.append((node, content))
    if len(actual_users) > limits["max_business_messages"]:
        return _problem("routing_projection_scope_exceeded", limit="max_business_messages",
                        observed=len(actual_users), maximum=limits["max_business_messages"])
    if total_chars > limits["max_total_text_characters"]:
        return _problem("routing_projection_scope_exceeded", limit="max_total_text_characters",
                        observed=total_chars, maximum=limits["max_total_text_characters"])
    if not actual_users:
        return _problem("missing_actual_user_message")
    user, request = max(actual_users, key=lambda item: item[0]["seq"])
    latest_seq = prefix_context.get("latest_actual_user_seq")
    if type(latest_seq) is not int or latest_seq != user["seq"]:
        return _problem("latest_actual_user_not_visible")
    if not request.strip():
        return _problem("empty_user_request")

    background = []
    state_refs = [_event_ref(user)]
    for node, content in actual_users:
        if node["seq"] == user["seq"]:
            continue
        background.append(content)
        state_refs.append(_event_ref(node))
    return {
        "state": {"用户输入指令": request, "背景信息": background},
        "question": copy.deepcopy(_CONTRACT["question"]),
        "state_evidence_refs": state_refs,
        "excluded_context_evidence_refs": excluded_refs,
        "candidate_evidence_refs": [{
            "kind": "contract", "contract_version": CONTRACT_VERSION,
            "path": "assets/security-routing-contract.json", "contract_sha256": CONTRACT_SHA256,
        }],
        "review": {
            "status": "requires_review",
            "routing_boundary": "initial_first_model_response",
            "task_scope": "offline_business_intent_classification",
            "context_sufficiency": "requires_review",
            "visible_background_count": len(background),
            "excluded_framework_message_count": len(excluded_refs),
            "business_context_sources": "actual_user_messages_only",
            "missing_context_is_other": False,
            "multi_task_priority": "explicit_user_priority_only; otherwise review",
            "rule_suggestion": None,
            "observed_candidate_in_options": None,
            "parameter_generation_replaced": False,
            "candidate_bindings_status": "unconfigured",
            "needs_runtime_contract_validation": True,
            "deployment_ready": False,
            "token_budget_status": "requires_actual_encoding_preflight",
        },
    }, None


def build_sample(snap):
    """Attach historical output as supervision only after constructing input."""
    if snap.get("blocking_issues"):
        return None, {"decision_line": snap.get("decision_line"), "reason": "trace_integrity",
                      "disposition": "requires_review", "issues": copy.deepcopy(snap["blocking_issues"])}
    projection, problem = build_routing_input(
        snap.get("surface"), snap.get("request_header"), decision_seq=snap.get("decision_seq"),
        prefix_context=snap.get("prefix_context"),
    )
    if problem is not None:
        return None, {"decision_line": snap.get("decision_line"), **problem}
    sample_id = "dsh-" + _digest({"session": snap["session_id"], "turn": snap["turn"],
        "step": snap["step"], "seq": snap["decision_seq"], "site": QUESTION_ID,
        "contract_version": CONTRACT_VERSION})[:24]
    sample = {
        "schema_version": "kev-decision-ir/v1", "sample_id": sample_id,
        "decision_site_id": QUESTION_ID, "contract_version": CONTRACT_VERSION,
        "implementation": "model", "state": projection["state"], "question": projection["question"],
        "candidate_bindings": {},
        "observed_action": copy.deepcopy(snap.get("observed_action", {})), "observed_candidate": None,
        "label": {"status": "unlabeled", "value": None, "source": "", "evidence_refs": []},
        "provenance": {
            "trace_sha256": snap.get("trace_sha256"), "session_id": snap["session_id"],
            "session_log": snap["session_log"], "source_group_id": snap["session_id"],
            "turn": snap["turn"], "step": snap["step"], "decision_seq": snap["decision_seq"],
            "decision_line": snap["decision_line"], "visible_event_seqs": copy.deepcopy(snap["visible_event_seqs"]),
            "state_evidence_refs": projection["state_evidence_refs"],
            "excluded_context_evidence_refs": projection["excluded_context_evidence_refs"],
            "candidate_evidence_refs": projection["candidate_evidence_refs"],
            "state_builder_version": INPUT_BUILDER_VERSION,
            "candidate_builder_version": CONTRACT_VERSION + "/static",
            "prefix_digest": snap["prefix_digest"], "visibility": snap["visibility"],
            "routing_boundary_evidence": copy.deepcopy(snap["prefix_context"]),
        },
        "review": projection["review"],
    }
    return sample, None

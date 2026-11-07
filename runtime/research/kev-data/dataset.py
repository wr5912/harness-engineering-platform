"""Compile reviewed decision IR into Kev JSONL-shaped records, then split and audit.

Standard library only. No network, tokenization, model loading, training, or file I/O.
All functions return new data and leave caller-owned records unchanged.

Compatibility reference: jaredpalmer/kev commit
2074cc44256200bb37540103fa4572901faa10f3.

compile_records accepts the kev-decision-ir/v1 typed decision IR.
split_records and audit_partitions accept compiled records produced by this module.
Weak labels are opt-in for training and never eligible for held-out gold partitions.
Token lengths must be checked separately using the chosen checkpoint tokenizer.
"""
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import re


_native_spec = importlib.util.spec_from_file_location("kev_pipeline_native_input", Path(__file__).with_name("native_input.py"))
_native_input = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(_native_input)


IR_SCHEMA = "kev-decision-ir/v1"
KEV_SOURCE_COMMIT = "2074cc44256200bb37540103fa4572901faa10f3"
DEFAULT_FRACTIONS = {"train": 0.70, "calibration": 0.10, "development": 0.10, "test": 0.10}
KEV_DEFAULT_TRAINING_CONTEXT = {
    "max_state": 384,
    "max_state_plus_question_branch": 1024,
    "max_packed_record": 2048,
}
RECOMMENDED_CLOSED_SET_AUGMENTATION = {
    "p_none": 0.0, "p_none_distract": 0.0, "p_distract": 0.0, "p_none_pair": 0.0,
    "choice_option_permutation": "retained by Kev",
}

# Eight categories, with explicit state-root paths only. A business object's
# nested label/outcome/reward/status/result field is NOT a hard leakage finding.
# Text values are never searched for these words or compared with the label.
BLOCKED_STATE_FIELDS = {
    "supervision": ("verified_target", "gold_label", "gold_answer", "ground_truth"),
    "soft_supervision": ("soft_target", "target_distribution", "teacher_target"),
    "observed_action": ("observed_action", "observed_choice", "executed_target"),
    "annotation": ("annotation_note", "annotation_certainty", "label_status",
                   "label_source", "label_evidence_refs"),
    "future_outcome": ("future_outcome", "post_decision_outcome", "final_task_success", "final_reward"),
    "future_observation": ("future_tool_result", "post_decision_result", "future_events", "post_action_state"),
    "provenance": ("_meta", "provenance", "state_evidence_refs", "candidate_evidence_refs"),
    "partition_identity": ("split", "dataset_split", "sample_id", "group_id",
                           "source_group_id", "trace_sha256"),
}
AMBIGUOUS_STATE_FIELDS = ("label", "labels", "target", "outcome", "reward")
_SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")


def _issue(code, path, message, **extra):
    return {"code": code, "path": path, "message": message, **extra}


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _integer(value, minimum=0):
    return type(value) is int and value >= minimum


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _json_errors(value, path="$", ancestors=None):
    """Reject nonstandard JSON numbers, non-string object keys, and Python objects."""
    ancestors = set() if ancestors is None else ancestors
    if value is None or isinstance(value, (str, bool)) or type(value) is int:
        return []
    if isinstance(value, float):
        return [] if math.isfinite(value) else [_issue("nonfinite_number", path, "JSON numbers must be finite")]
    if not isinstance(value, (dict, list)):
        return [_issue("non_json_type", path, f"Unsupported JSON value type: {type(value).__name__}")]
    if id(value) in ancestors:
        return [_issue("cyclic_value", path, "JSON data cannot contain cycles")]
    ancestors.add(id(value))
    errors = []
    items = value.items() if isinstance(value, dict) else enumerate(value)
    for key, child in items:
        child_path = f"{path}.{key}" if isinstance(value, dict) else f"{path}[{key}]"
        if isinstance(value, dict) and not isinstance(key, str):
            errors.append(_issue("non_string_json_key", child_path, "JSON object keys must be strings"))
        errors.extend(_json_errors(child, child_path, ancestors))
    ancestors.remove(id(value))
    return errors


def _json_safe(value, ancestors=None):
    """Keep rejected inputs reviewable in strict JSON, including rejected NaN/Infinity."""
    ancestors = set() if ancestors is None else ancestors
    if value is None or isinstance(value, (str, bool)) or type(value) is int:
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else {"$invalid_number": repr(value)}
    if not isinstance(value, (dict, list)):
        return {"$unsupported_type": type(value).__name__, "$repr": repr(value)}
    if id(value) in ancestors:
        return {"$cycle": True}
    ancestors.add(id(value))
    if isinstance(value, dict):
        result = {str(k): _json_safe(v, ancestors) for k, v in value.items()}
    else:
        result = [_json_safe(v, ancestors) for v in value]
    ancestors.remove(id(value))
    return result


def _input_leaks(state):
    errors, warnings = [], []
    if not isinstance(state, dict):
        return errors, warnings
    for category, fields in BLOCKED_STATE_FIELDS.items():
        for name in fields:
            if name in state:
                errors.append(_issue(
                    "input_leakage", f"state.{name}",
                    "A reserved supervision/audit/future field is inside model-visible state",
                    category=category,
                ))
    for name in AMBIGUOUS_STATE_FIELDS:
        if name in state:
            warnings.append(_issue(
                "ambiguous_business_field", f"state.{name}",
                "This business field is allowed; its pre-decision meaning must be justified by the decision contract",
            ))
    return errors, warnings


def _validate_state(state, errors, warnings):
    if not isinstance(state, (str, dict)) or not state or (isinstance(state, str) and not state.strip()):
        errors.append(_issue("invalid_state", "state", "state must be a non-empty string or JSON object"))
    leaks, notices = _input_leaks(state)
    errors.extend(leaks)
    warnings.extend(notices)


def _validate_question(question, errors, path="question", compiled=False):
    if not isinstance(question, dict):
        errors.append(_issue("invalid_question", path, "A question object is required"))
        return []
    allowed = {"type", "instructions", "criteria"}
    if compiled:
        allowed |= {"label", "target", "src"}
    extra = set(question) - allowed
    if extra:
        errors.append(_issue("unknown_question_fields", path, f"Unsupported question fields: {sorted(map(str, extra))}"))
    if not _text(question.get("instructions")):
        errors.append(_issue("invalid_instructions", f"{path}.instructions", "instructions must be a non-empty string"))
    kind, criteria = question.get("type"), question.get("criteria")
    if kind == "choice":
        if not isinstance(criteria, dict) or not 1 <= len(criteria) <= 255:
            errors.append(_issue("invalid_criteria", f"{path}.criteria", "choice criteria must contain 1..255 candidate names"))
            return []
        for key, description in criteria.items():
            if not _text(key):
                errors.append(_issue("invalid_candidate_id", f"{path}.criteria", "Candidate IDs must be non-empty strings"))
            if description is not None and not isinstance(description, str):
                errors.append(_issue("invalid_candidate_description", f"{path}.criteria.{key}", "Candidate descriptions must be strings or null"))
    elif kind == "noul":
        if criteria is not None and (not isinstance(criteria, dict) or set(criteria) - {"false", "true"}
                                     or any(value is not None and not isinstance(value, str) for value in criteria.values())):
            errors.append(_issue("invalid_criteria", f"{path}.criteria", "noul criteria may only describe false/true with strings or null"))
    elif kind == "score":
        if not isinstance(criteria, list) or not 2 <= len(criteria) <= 255 or not all(_text(value) for value in criteria):
            errors.append(_issue("invalid_criteria", f"{path}.criteria", "score criteria must contain 2..255 ordered non-empty level descriptions"))
            return []
    else:
        errors.append(_issue("unsupported_question_type", f"{path}.type", "Expected choice, noul or score"))
        return []
    return question_keys(question)


def question_keys(question):
    """原生概率键；score 的等级顺序不排序，noul 始终为 false/true。"""
    kind, criteria = question.get("type"), question.get("criteria")
    if kind == "choice" and isinstance(criteria, dict):
        return list(criteria)
    if kind == "noul":
        return ["false", "true"]
    if kind == "score" and isinstance(criteria, list):
        return [str(index) for index in range(len(criteria))]
    return []


def label_key(question, value):
    """校验硬标签的 JSON 类型并返回 KEV 概率键，不把 bool 当成整数。"""
    kind = question.get("type")
    if kind == "choice" and isinstance(value, str) and value in question_keys(question):
        return value
    if kind == "noul" and type(value) is bool:
        return "true" if value else "false"
    if kind == "score" and type(value) is int and 0 <= value < len(question_keys(question)):
        return str(value)
    raise ValueError("Hard label must match the question type and current candidates/levels")


def _normalise_target(target, keys, errors, path):
    if not isinstance(target, dict) or not target:
        errors.append(_issue("invalid_soft_target", path, "target must be a non-empty map of candidate names to weights"))
        return None
    if set(target) - set(keys):
        errors.append(_issue("unknown_target_key", path, "Every target key must be one of the current candidates"))
        return None
    weights = {}
    for key in keys:
        value = target.get(key, 0.0)
        if type(value) not in (int, float):
            errors.append(_issue("invalid_target_weight", f"{path}.{key}", "Target weights must be real numbers, excluding booleans"))
            continue
        try:
            value = float(value)
        except (OverflowError, ValueError):
            value = math.inf
        if not math.isfinite(value) or value < 0:
            errors.append(_issue("invalid_target_weight", f"{path}.{key}", "Target weights must be finite and nonnegative"))
        else:
            weights[key] = value
    if len(weights) != len(keys):
        return None
    try:
        total = math.fsum(weights.values())
    except OverflowError:
        total = math.inf
    if not math.isfinite(total) or total <= 0:
        errors.append(_issue("invalid_target_total", path, "Target total mass must be finite and strictly positive"))
        return None
    return {key: value / total for key, value in weights.items()}


def _validate_provenance(provenance, contract_version, errors):
    if not isinstance(provenance, dict):
        errors.append(_issue("invalid_provenance", "provenance", "A provenance object is required"))
        return
    for name in ("session_id", "source_group_id", "state_builder_version", "candidate_builder_version"):
        if not _text(provenance.get(name)):
            errors.append(_issue("missing_provenance", f"provenance.{name}", f"{name} must be non-empty"))
    trace_sha = provenance.get("trace_sha256")
    if not isinstance(trace_sha, str) or not _SHA256.fullmatch(trace_sha):
        errors.append(_issue("invalid_trace_sha256", "provenance.trace_sha256", "trace_sha256 must be a 64-digit hexadecimal SHA-256"))
    decision_seq, decision_line = provenance.get("decision_seq"), provenance.get("decision_line")
    if not _integer(decision_seq):
        errors.append(_issue("invalid_decision_seq", "provenance.decision_seq", "decision_seq must be a nonnegative integer, excluding bool"))
    if not _integer(decision_line, 1):
        errors.append(_issue("invalid_decision_line", "provenance.decision_line", "decision_line must be a positive 1-based line number"))
    for name in ("state_evidence_refs", "candidate_evidence_refs"):
        refs = provenance.get(name)
        if not isinstance(refs, list) or not refs:
            errors.append(_issue("missing_visible_evidence", f"provenance.{name}", "Non-empty visible-input evidence references are required"))
            continue
        for i, ref in enumerate(refs):
            path = f"provenance.{name}[{i}]"
            if not isinstance(ref, dict):
                errors.append(_issue("invalid_evidence_ref", path, "An evidence reference must be an object"))
                continue
            if ref.get("kind", "event") == "contract":
                if name != "candidate_evidence_refs":
                    errors.append(_issue("invalid_contract_evidence", path, "Static contract references are only allowed for candidates"))
                if not _text(ref.get("contract_version")):
                    errors.append(_issue("invalid_contract_evidence", path, "A static candidate reference requires contract_version"))
                elif ref["contract_version"] != contract_version:
                    errors.append(_issue("contract_version_mismatch", path, "Candidate contract_version must match the record contract_version"))
                if "contract_sha256" in ref and (not isinstance(ref["contract_sha256"], str) or not _SHA256.fullmatch(ref["contract_sha256"])):
                    errors.append(_issue("invalid_contract_sha256", path, "contract_sha256 must be a 64-digit hexadecimal SHA-256"))
                continue
            if not _text(ref.get("kind", "event")):
                errors.append(_issue("unsupported_evidence_kind", path, "Evidence kind, when supplied, must be a non-empty string"))
                continue
            # A DSH event-type string may occupy kind; every non-contract ref is
            # still subject to the same event seq/session/trace checks.
            seq = ref.get("seq")
            if not _integer(seq):
                errors.append(_issue("invalid_evidence_seq", f"{path}.seq", "Event evidence requires an integer seq, excluding bool"))
            elif _integer(decision_seq) and seq >= decision_seq:
                errors.append(_issue("future_visible_evidence", f"{path}.seq", "Model-visible event evidence must have seq strictly below decision_seq"))
            if not _integer(ref.get("line"), 1):
                errors.append(_issue("invalid_evidence_line", f"{path}.line", "Event evidence requires a positive source line number"))
            if "session_id" in ref and ref["session_id"] != provenance.get("session_id"):
                errors.append(_issue("cross_session_seq", path, "Event seq order cannot be compared across different sessions"))
            if "trace_sha256" in ref and ref["trace_sha256"] != trace_sha:
                errors.append(_issue("cross_trace_evidence", path, "A trace evidence reference must identify this provenance trace"))


def _validate_label(label, question, allow_weak, errors, warnings):
    if not isinstance(label, dict):
        errors.append(_issue("missing_label", "label", "A label object is required; observed_action is never a substitute"))
        return None, False
    status = label.get("status")
    statuses = {"unlabeled", "weak", "verified", "ambiguous", "invalid"}
    if not isinstance(status, str) or status not in statuses:
        errors.append(_issue("invalid_label_status", "label.status", "Unknown label status"))
    elif status in {"unlabeled", "ambiguous", "invalid"}:
        errors.append(_issue(f"label_{status}", "label.status", "This label status is not eligible for training export"))
    elif status == "weak" and not allow_weak:
        errors.append(_issue("weak_label_not_enabled", "label.status", "Weak labels require explicit allow_weak_train=True"))
    eligible = status == "verified" or status == "weak" and allow_weak
    normalised = None
    if eligible:
        value = label.get("value")
        try:
            hard_key = label_key(question, value)
        except ValueError:
            hard_key = None
            errors.append(_issue("invalid_hard_label", "label.value", "A valid typed hard label is required even when a soft target is supplied"))
        if not _text(label.get("source")):
            errors.append(_issue("missing_label_source", "label.source", "An explicit label source is required"))
        evidence = label.get("evidence_refs")
        if not isinstance(evidence, list) or not evidence or any(
            not (_text(ref) or isinstance(ref, dict) and bool(ref)) for ref in evidence
        ):
            errors.append(_issue("missing_label_evidence", "label.evidence_refs", "Non-empty label evidence references are required"))
        # Outcome evidence may be later than decision_seq. It is kept only in _meta.
        if "target" in label:
            normalised = _normalise_target(label["target"], question_keys(question), errors, "label.target")
            if not _text(label.get("target_semantics")):
                errors.append(_issue("missing_target_semantics", "label.target_semantics", "A soft target requires an explicit meaning/source description"))
            if normalised is not None and hard_key in normalised and normalised[hard_key] < max(normalised.values()):
                warnings.append(_issue(
                    "hard_soft_disagreement", "label.target",
                    "The hard gold label differs from a soft-target mode; retain only when that disagreement is intentional and reviewed",
                ))
        elif label.get("target_semantics"):
            warnings.append(_issue("unused_target_semantics", "label.target_semantics", "No soft target is present"))
    return normalised, status == "weak"


def _model_input(record):
    questions = record.get("questions", {})
    # qid, src, label and target are not model-visible. Sorting question forms
    # makes candidate-order and question-ID variants one conservative duplicate group.
    forms = [{key: question.get(key) for key in ("type", "instructions", "criteria")}
             for question in questions.values()]
    return {"state": record.get("state"), "questions": sorted(forms, key=_canonical)}


def _group_keys(record):
    meta = record["_meta"]
    prov = meta["provenance"]
    input_value = _model_input(record)
    return (
        ("source_group", prov["source_group_id"]),
        ("session", prov["session_id"]),
        ("model_input", _digest(input_value)),
        ("rendered_state", _native_input.state_key(record["state"])),
        *[("rendered_question", _native_input.question_key(record["state"], question))
          for question in record["questions"].values()],
        ("task_state_question", _digest({
            "decision_site_id": meta["decision_site_id"],
            "contract_version": meta["contract_version"],
            "input": input_value,
        })),
    )


def _label_disagreements(records):
    """Separate contradictory verified gold from disagreements involving weak labels."""
    # Preserve the previous conservative JSON relation, and join inputs which
    # render identically. This also handles object/string question descriptions.
    records = list(records)
    union, seen = _UnionFind(len(records)), {}
    for index, record in enumerate(records):
        question = next(iter(record["questions"].values()))
        keys = (("canonical", _digest(_model_input(record))),
                ("rendered", _native_input.question_key(record["state"], question)))
        for key in keys:
            if key in seen:
                union.union(index, seen[key])
            else:
                seen[key] = index
    by_input = defaultdict(list)
    for index, record in enumerate(records):
        by_input[union.find(index)].append(record)
    verified_conflicts, weak_disagreements = [], []
    for _, members in sorted(by_input.items()):
        input_hash = _digest(sorted({_digest(_model_input(record)) for record in members}))
        verified, weak = defaultdict(list), defaultdict(list)
        for record in members:
            question = next(iter(record["questions"].values()))
            label = label_key(question, question["label"])
            destination = verified if record["_meta"]["label_status"] == "verified" else weak
            destination[label].append(record["_meta"]["id"])
        detail = {
            "input_sha256": input_hash,
            "input_identity_scope": "canonical-or-native-rendered-task-closure",
            "verified_label_ids": {label: sorted(ids) for label, ids in sorted(verified.items())},
            "weak_label_ids": {label: sorted(ids) for label, ids in sorted(weak.items())},
            "related_verified_ids": sorted(sample_id for ids in verified.values() for sample_id in ids),
        }
        if len(verified) > 1:
            verified_conflicts.append(detail)
        elif len(set(verified) | set(weak)) > 1:
            weak_disagreements.append(detail)
    return verified_conflicts, weak_disagreements


def compile_records(records, allow_weak_train=False, *, include_code=False):
    """Return (compiled_records, quarantine, report) from typed decision IR.

    verified labels need a valid hard value, source, and evidence. Weak labels are
    optional and marked train-only. code implementations are excluded by default.
    Unknown, ambiguous, rejected, and unreviewed labels are never auto-promoted.
    """
    if type(allow_weak_train) is not bool or type(include_code) is not bool:
        raise TypeError("allow_weak_train and include_code must be explicit booleans")
    records = list(records)
    ids = Counter(r.get("sample_id") for r in records if isinstance(r, dict) and _text(r.get("sample_id")))
    compiled, quarantine, notices = [], [], []
    reasons, statuses = Counter(), Counter()
    for index, record in enumerate(records):
        errors = _json_errors(record)
        warnings = []
        if not isinstance(record, dict):
            errors.append(_issue("invalid_record", "$", "An IR record must be an object"))
        else:
            if record.get("schema_version") != IR_SCHEMA:
                errors.append(_issue("wrong_ir_schema", "schema_version", f"Expected {IR_SCHEMA}"))
            for name in ("sample_id", "decision_site_id", "contract_version"):
                if not _text(record.get(name)):
                    errors.append(_issue("missing_ir_identity", name, f"{name} must be non-empty"))
            if _text(record.get("sample_id")) and ids[record["sample_id"]] > 1:
                errors.append(_issue("duplicate_sample_id", "sample_id", "All records with a duplicate sample_id are quarantined"))
            implementation = record.get("implementation")
            if not isinstance(implementation, str) or implementation not in {"model", "code", "hybrid"}:
                errors.append(_issue("invalid_implementation", "implementation", "Expected model, code, or hybrid"))
            elif implementation == "code" and not include_code:
                errors.append(_issue("code_site_excluded", "implementation", "Code-only decision sites are excluded unless include_code=True"))
            _validate_state(record.get("state"), errors, warnings)
            _validate_question(record.get("question"), errors)
            _validate_provenance(record.get("provenance"), record.get("contract_version"), errors)
            label = record.get("label")
            statuses[str(label.get("status")) if isinstance(label, dict) else "missing"] += 1
            target, train_only = _validate_label(label, record.get("question") if isinstance(record.get("question"), dict) else {}, allow_weak_train, errors, warnings)
        if errors:
            reasons.update(set(error["code"] for error in errors))
            quarantine.append({
                "input_index": index,
                "sample_id": record.get("sample_id") if isinstance(record, dict) else None,
                "reason_codes": sorted({error["code"] for error in errors}),
                "reasons": errors, "warnings": warnings, "record": _json_safe(record),
            })
            continue
        question = deepcopy(record["question"])
        question["label"] = label["value"]
        question["src"] = record["decision_site_id"]
        if target is not None:
            question["target"] = target
        meta = {
            "id": record["sample_id"], "group_id": record["provenance"]["source_group_id"],
            "source": "dsh-trace", "variant": "clean", "ir_schema_version": IR_SCHEMA,
            "decision_site_id": record["decision_site_id"], "contract_version": record["contract_version"],
            "implementation": record["implementation"], "label_status": label["status"],
            "label": deepcopy(label), "observed_action": deepcopy(record.get("observed_action")),
            "provenance": deepcopy(record["provenance"]), "training_only": train_only,
            "gold_eligible": not train_only,
            "input_hash_algorithm": "sha256/canonical-json-sort-keys-utf8-no-ascii/v1",
        }
        known = {"schema_version", "sample_id", "decision_site_id", "contract_version", "state",
                 "question", "observed_action", "label", "provenance", "implementation"}
        extra = {key: deepcopy(value) for key, value in record.items() if key not in known}
        if extra:
            meta["ir_extra"] = extra
        result = {"state": deepcopy(record["state"]),
                  "questions": {record["decision_site_id"]: question}, "_meta": meta}
        meta["input_sha256"] = _digest(_model_input(result))
        meta["native_input_sha256"] = _native_input.record_key(result)
        meta["native_input_hash_algorithm"] = _native_input.IDENTITY_VERSION
        compiled.append(result)
        notices.extend({"sample_id": meta["id"], **warning} for warning in warnings)
    verified_conflicts, weak_disagreements = _label_disagreements(compiled)
    if verified_conflicts:
        original_by_id = {
            row["sample_id"]: (index, row) for index, row in enumerate(records)
            if isinstance(row, dict) and _text(row.get("sample_id"))
        }
        excluded_ids = set()
        for conflict in verified_conflicts:
            for sample_id in conflict["related_verified_ids"]:
                index, original = original_by_id[sample_id]
                finding = _issue(
                    "conflicting_verified_labels", "label.value",
                    "Canonical or native-rendered input has contradictory verified hard labels; adjudication or an explicit multi-answer contract is required",
                    **conflict,
                )
                quarantine.append({
                    "input_index": index, "sample_id": sample_id,
                    "reason_codes": ["conflicting_verified_labels"], "reasons": [finding],
                    "warnings": [], "record": _json_safe(original),
                })
                excluded_ids.add(sample_id)
                reasons["conflicting_verified_labels"] += 1
        compiled = [row for row in compiled if row["_meta"]["id"] not in excluded_ids]
        quarantine.sort(key=lambda row: row["input_index"])
    for disagreement in weak_disagreements:
        notices.append(_issue(
            "conflicting_input_labels", "label.value",
            "An identical-input disagreement involves weak labels; it is not treated as a contradiction between verified gold labels",
            **disagreement,
        ))
    report = {
        "status": "blocked" if not compiled else "partial" if quarantine else "ready",
        "schema_version": IR_SCHEMA, "kev_source_commit": KEV_SOURCE_COMMIT,
        "input_records": len(records), "compiled_records": len(compiled), "quarantined_records": len(quarantine),
        "input_label_statuses": dict(statuses), "quarantine_by_reason": dict(reasons),
        "verified_records": sum(r["_meta"]["label_status"] == "verified" for r in compiled),
        "weak_train_only_records": sum(r["_meta"]["training_only"] for r in compiled),
        "soft_target_records": sum("target" in q for r in compiled for q in r["questions"].values()),
        "verified_label_conflicts": verified_conflicts,
        "allow_weak_train": bool(allow_weak_train), "include_code": bool(include_code), "warnings": notices,
        "token_budget": {"status": "not_checked", "default_context": deepcopy(KEV_DEFAULT_TRAINING_CONTEXT),
                         "required_action": "Run the chosen tokenizer through Kev strict encode/fits before training; character counts are not token counts"},
        "recommended_closed_set_augmentation": deepcopy(RECOMMENDED_CLOSED_SET_AUGMENTATION),
        "limitations": [
            "A verified status is an external review claim; this module does not establish semantic truth from the trace.",
            "Evidence seq checks verify supplied references, not whether the rendered state actually derives only from those references.",
            "No model quality, calibration quality, candidate recall, or token length has been measured.",
        ],
    }
    return compiled, quarantine, report


def _validate_compiled(record):
    errors, warnings = _json_errors(record), []
    if not isinstance(record, dict):
        return errors + [_issue("invalid_compiled_record", "$", "Compiled record must be an object")], warnings
    _validate_state(record.get("state"), errors, warnings)
    questions, meta = record.get("questions"), record.get("_meta")
    if not isinstance(questions, dict) or len(questions) != 1:
        errors.append(_issue("invalid_compiled_questions", "questions", "This compiler emits exactly one decision question per record"))
    else:
        for qid, question in questions.items():
            if not _text(qid):
                errors.append(_issue("invalid_question_id", "questions", "Question IDs must be non-empty strings"))
            keys = _validate_question(question, errors, f"questions.{qid}", compiled=True)
            if isinstance(question, dict):
                try:
                    label_key(question, question.get("label"))
                except ValueError:
                    errors.append(_issue("invalid_hard_label", f"questions.{qid}.label", "Hard label must match the current question type"))
                if not _text(question.get("src")):
                    errors.append(_issue("missing_question_source", f"questions.{qid}.src", "A stable decision-site src is required"))
                if "target" in question:
                    _normalise_target(question["target"], keys, errors, f"questions.{qid}.target")
    if not isinstance(meta, dict):
        errors.append(_issue("missing_compiled_metadata", "_meta", "Compiler provenance metadata is required"))
        return errors, warnings
    for name in ("id", "group_id", "decision_site_id", "contract_version"):
        if not _text(meta.get(name)):
            errors.append(_issue("missing_compiled_identity", f"_meta.{name}", f"{name} must be non-empty"))
    if meta.get("source") != "dsh-trace" or meta.get("variant") != "clean":
        errors.append(_issue("invalid_metric_metadata", "_meta", "Expected source=dsh-trace and variant=clean; other variants can disappear from Kev gold metrics"))
    if not isinstance(meta.get("label_status"), str) or meta.get("label_status") not in {"verified", "weak"}:
        errors.append(_issue("unreviewed_compiled_label", "_meta.label_status", "Only verified or explicitly enabled weak labels are exportable"))
    if meta.get("label_status") == "weak" and meta.get("training_only") is not True:
        errors.append(_issue("weak_not_train_only", "_meta.training_only", "Weak labels must remain train-only"))
    _validate_provenance(meta.get("provenance"), meta.get("contract_version"), errors)
    if isinstance(questions, dict) and len(questions) == 1 and isinstance(meta.get("label"), dict):
        question = next(iter(questions.values()))
        target, _ = _validate_label(meta["label"], question if isinstance(question, dict) else {}, True, errors, warnings)
        if meta["label"].get("status") != meta.get("label_status"):
            errors.append(_issue("label_status_mismatch", "_meta.label_status", "Compiled label status differs from its audited label object"))
        if isinstance(question, dict):
            if meta["label"].get("value") != question.get("label"):
                errors.append(_issue("label_metadata_mismatch", "_meta.label.value", "Compiled label no longer matches audited hard label"))
            if (target is None) != ("target" not in question):
                errors.append(_issue("target_metadata_mismatch", "_meta.label.target", "Compiled soft-target presence differs from audited label"))
            elif target is not None and question.get("target") != target:
                errors.append(_issue("target_metadata_mismatch", "_meta.label.target", "Compiled target must equal normalized audited weights"))
    else:
        errors.append(_issue("missing_audited_label", "_meta.label", "The original reviewed label object is required"))
    if not errors:
        expected = _digest(_model_input(record))
        if meta.get("input_sha256") != expected:
            errors.append(_issue("input_hash_mismatch", "_meta.input_sha256", "Input changed after compilation or hash protocol differs"))
        if (meta.get("native_input_hash_algorithm") != _native_input.IDENTITY_VERSION
                or meta.get("native_input_sha256") != _native_input.record_key(record)):
            errors.append(_issue("native_input_hash_mismatch", "_meta.native_input_sha256",
                                 "Rendered input or its physical order changed after compilation"))
    return errors, warnings


def audit_partitions(partitions, *, required_partitions=()):
    """Audit compiled partitions without inferring leakage from text-value coincidences.

    Checks IDs, declared/effective groups, sessions, canonical and native-rendered inputs,
    explicit reserved input paths, numeric finiteness, supervision, and seq cuts.
    All non-train partitions require verified hard labels, including soft-target rows.
    """
    if not isinstance(partitions, dict):
        raise TypeError("partitions must be a mapping from partition name to record lists")
    errors, warnings = [], []
    for name in required_partitions:
        if name not in partitions:
            errors.append(_issue("missing_partition", name, "A required physical partition is missing"))
        elif isinstance(partitions[name], list) and not partitions[name]:
            errors.append(_issue("empty_partition", name, "A required physical partition has no records"))
    identity_locations = defaultdict(list)
    relation_locations = defaultdict(lambda: defaultdict(list))
    counts, valid_records = {}, []
    for name, records in partitions.items():
        if not isinstance(records, list):
            errors.append(_issue("invalid_partition", str(name), "A partition must be a list"))
            continue
        counts[name] = len(records)
        for index, record in enumerate(records):
            local_errors, local_warnings = _validate_compiled(record)
            location = {"partition": name, "index": index,
                        "id": record.get("_meta", {}).get("id") if isinstance(record, dict) and isinstance(record.get("_meta"), dict) else None}
            errors.extend({**finding, **location} for finding in local_errors)
            warnings.extend({**finding, **location} for finding in local_warnings)
            if local_errors:
                continue
            meta = record["_meta"]
            identity_locations[meta["id"]].append(location)
            if name != "train" and (meta["label_status"] != "verified" or meta.get("training_only")):
                errors.append(_issue("non_gold_in_evaluation", "_meta.label_status", "Only verified hard-label gold may enter a non-train partition", **location))
            relations = [("effective_group", meta["group_id"]), *_group_keys(record)]
            for relation, key in relations:
                relation_locations[(relation, key)][name].append(meta["id"])
            valid_records.append(record)
    overlaps = []
    for sample_id, locations in identity_locations.items():
        if len(locations) > 1:
            errors.append(_issue("duplicate_sample_id", "_meta.id", "A sample ID occurs more than once", id=sample_id, locations=locations))
    for (relation, key), locations in sorted(relation_locations.items()):
        if len(locations) > 1:
            finding = {"relation": relation, "key": key, "partitions": dict(locations)}
            overlaps.append(finding)
            errors.append(_issue("cross_partition_overlap", relation, "A connected-group constraint crosses partitions", **finding))
    verified_conflicts, weak_disagreements = _label_disagreements(valid_records)
    for conflict in verified_conflicts:
        errors.append(_issue(
            "conflicting_verified_labels", "questions",
            "Canonical or native-rendered input has contradictory verified hard labels; this typed contract requires one reviewed answer",
            **conflict,
        ))
    for disagreement in weak_disagreements:
        warnings.append(_issue(
            "conflicting_input_labels", "questions",
            "An identical-input disagreement involves weak labels; it is not treated as a contradiction between verified gold labels",
            **disagreement,
        ))
    checked = sum(counts.values())
    return {
        "status": "failed" if errors else "ok" if checked else "blocked",
        "ok": not errors and checked > 0, "records": checked, "partition_counts": counts,
        "errors": errors, "warnings": warnings, "overlaps": overlaps,
        "leakage_scope": "Eight explicit state-root reserved-field categories; no text-value matches and no blanket rejection of nested business labels/outcomes/results",
        "token_budget": "not_checked",
    }


class _UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, item):
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left, right):
        left, right = self.find(left), self.find(right)
        if left != right:
            self.parent[right] = left


def _question_labels(records):
    """按职责和问题定义统计；不同题型的 false、0 及字符串同名标签不合并。"""
    definitions, counts = {}, defaultdict(Counter)
    for record in records:
        meta = record["_meta"]
        for question in record["questions"].values():
            definition = {"decision_site_id": meta["decision_site_id"], "contract_version": meta["contract_version"],
                          **{key: deepcopy(question.get(key)) for key in ("type", "instructions", "criteria")}}
            key = "question/" + _digest(definition)
            definitions[key] = definition
            counts[key][label_key(question, question["label"])] += 1
    return definitions, {key: dict(value) for key, value in sorted(counts.items())}


def split_records(records, fractions=None, seed=20261026):
    """Return (partitions, manifest), preserving connected provenance/input groups.

    Splitting is blocked with empty partitions if fewer than four independent
    components exist, if any positive-fraction partition cannot be populated, or
    if compiled input fails validation. Existing _meta.split is not trusted as a
    filter: physical partition lists are returned, and only train should be trained.
    Weak-label components are forced wholly into train.
    """
    records = list(records)
    fractions = deepcopy(DEFAULT_FRACTIONS if fractions is None else fractions)
    manifest = {
        "status": "blocked", "seed": _json_safe(seed), "requested_fractions": _json_safe(fractions),
        "input_records": len(records), "minimum_independent_groups": 4,
        "grouping": ["same source_group_id", "same session_id",
                     "same canonical model input (ignoring label, metadata, qid and candidate key order)",
                     "same native-rendered state or task (choice order is not an independent sample)",
                     "same canonical task/state/question", "transitive closure of all preceding relations"],
        "warnings": [
            "Group-preserving approximate allocation is not a guarantee of class coverage, statistical power, or production representativeness.",
            "No token budgets, model accuracy, calibration quality, or end-to-end behavior are verified by splitting.",
        ],
    }
    if not isinstance(fractions, dict) or not fractions:
        manifest["blocked_reasons"] = ["invalid_fractions"]
        return {}, manifest
    partitions = {name: [] for name in fractions}
    if type(seed) is not int:
        manifest["blocked_reasons"] = ["invalid_seed"]
        return partitions, manifest
    if (any(not _text(name) or type(value) not in (int, float) or value < 0 or value > 1 or not math.isfinite(value)
            for name, value in fractions.items())
            or not math.isclose(sum(fractions.values()), 1.0, rel_tol=0.0, abs_tol=1e-9)):
        manifest["blocked_reasons"] = ["invalid_fractions"]
        return partitions, manifest
    active = [name for name, value in fractions.items() if value > 0]
    validation = audit_partitions({"train": records})
    if not validation["ok"]:
        manifest["blocked_reasons"] = ["no_records" if not records else "invalid_compiled_records"]
        manifest["validation"] = validation
        return partitions, manifest
    uf, first = _UnionFind(len(records)), {}
    for index, record in enumerate(records):
        for key in _group_keys(record):
            if key in first:
                uf.union(index, first[key])
            else:
                first[key] = index
    components = defaultdict(list)
    for index, record in enumerate(records):
        components[uf.find(index)].append(record)
    groups = []
    for members in components.values():
        ids = sorted(r["_meta"]["id"] for r in members)
        groups.append({
            "id": "dsh-component/" + _digest(ids),
            "members": sorted(members, key=lambda r: r["_meta"]["id"]),
            "training_only": any(r["_meta"].get("training_only") or r["_meta"]["label_status"] == "weak" for r in members),
        })
    manifest["independent_groups"] = len(groups)
    manifest["group_members"] = {g["id"]: [r["_meta"]["id"] for r in g["members"]] for g in sorted(groups, key=lambda g:g["id"])}
    forced = [g for g in groups if g["training_only"]]
    free = [g for g in groups if not g["training_only"]]
    blocked = []
    if len(groups) < 4:
        blocked.append("insufficient_independent_groups")
    if len(groups) < len(active):
        blocked.append("cannot_populate_all_nonzero_partitions")
    if forced and fractions.get("train", 0) <= 0:
        blocked.append("train_only_group_without_train_partition")
    required_free_partitions = len(active) - (1 if forced and "train" in active else 0)
    if len(free) < required_free_partitions:
        blocked.append("insufficient_gold_groups_for_heldout_partitions")
    if blocked:
        manifest["blocked_reasons"] = sorted(set(blocked))
        manifest["train_only_groups"] = len(forced)
        manifest["gold_only_groups"] = len(free)
        manifest["note"] = "Compiled data remain available, but no independent train/calibration/development/test split is claimed."
        return partitions, manifest
    rng = random.Random(seed)
    free.sort(key=lambda g: g["id"])
    rng.shuffle(free)
    free.sort(key=lambda g: -len(g["members"]))  # Stable shuffle breaks equal-size ties reproducibly.
    assignment = {name: [] for name in fractions}
    if forced:
        assignment["train"].extend(sorted(forced, key=lambda g:g["id"]))
    assigned_n = {name: sum(len(g["members"]) for g in gs) for name, gs in assignment.items()}
    target_n = {name: fractions[name] * len(records) for name in active}
    tie_order = list(active)
    rng.shuffle(tie_order)
    for index, group in enumerate(free):
        empty = [name for name in active if not assignment[name]]
        remaining = len(free) - index
        eligible = empty if remaining == len(empty) else active
        chosen = max(eligible, key=lambda name: (target_n[name] - assigned_n[name], -tie_order.index(name)))
        assignment[chosen].append(group)
        assigned_n[chosen] += len(group["members"])
    if any(not assignment[name] for name in active):
        manifest["blocked_reasons"] = ["cannot_populate_all_nonzero_partitions"]
        return partitions, manifest
    for name, assigned in assignment.items():
        for group in sorted(assigned, key=lambda g:g["id"]):
            for record in group["members"]:
                cloned = deepcopy(record)
                cloned["_meta"]["group_id"] = group["id"]
                cloned["_meta"]["split"] = name
                partitions[name].append(cloned)
    audit = audit_partitions(partitions)
    if not audit["ok"]:
        manifest["blocked_reasons"] = ["post_split_audit_failed"]
        manifest["audit"] = audit
        return {name: [] for name in fractions}, manifest
    definitions, all_labels = _question_labels(records)
    partition_labels = {name: _question_labels(rows)[1] for name, rows in partitions.items()}
    manifest.update(
        status="ready", blocked_reasons=[], train_only_groups=len(forced), gold_only_groups=len(free),
        partition_records={name: len(rows) for name, rows in partitions.items()},
        partition_groups={name: len(groups_) for name, groups_ in assignment.items()},
        achieved_fractions={name: len(rows)/len(records) for name, rows in partitions.items()},
        label_statistics_version="question-native-label/v1", question_definitions=definitions,
        partition_labels=partition_labels,
        group_partition={g["id"]: name for name, gs in assignment.items() for g in gs},
        audit=audit,
    )
    missing = {}
    for name in active:
        absent = {key: sorted(set(labels) - set(partition_labels[name].get(key, {})))
                  for key, labels in all_labels.items()
                  if set(labels) - set(partition_labels[name].get(key, {}))}
        if absent:
            missing[name] = absent
    if missing:
        manifest["missing_label_coverage"] = missing
        manifest["warnings"].append("Some partitions do not contain every label; do not interpret their metrics as complete class coverage.")
    return partitions, manifest

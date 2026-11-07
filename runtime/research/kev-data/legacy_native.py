#!/usr/bin/env python3
"""Inspect, independently review, split and replay-audit existing native Kev JSONL.

Standard library only. Native records are not converted into invented DSH traces.
The vendored loader checks syntax; explicit independent review supplies labels.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import sys


PARTITIONS = ("train", "development", "calibration", "test")
DEFAULT_FRACTIONS = dict(zip(PARTITIONS, (0.7, 0.1, 0.1, 0.1)))
REVIEW_SCHEMA = "kev-legacy-native-review/v1"
MANIFEST_SCHEMA = "kev-legacy-native-split/v1"
RECORD_SCHEMA = "kev-legacy-native-record/v1"
KEV_SOURCE_COMMIT = "2074cc44256200bb37540103fa4572901faa10f3"
STATUSES = {"unreviewed", "verified", "ambiguous", "invalid", "unlabeled"}
GROUP_FIELDS = {
    "group_id": "group", "source_group_id": "group",
    "family_id": "family", "task_family_id": "family", "source_family_id": "family",
    "session_id": "session",
}
LIMITATIONS = [
    "verified 是复核者的可追溯主张；脚本不证明标签语义正确，也不认证复核者身份。",
    "连通分组只覆盖已声明的 group/family/session、相同状态和逐题输入；未声明的同源关系仍须人工核对。",
    "未测 tokenizer 长度、模型效果、校准效果；格式与审计通过不代表训练完成。",
    "本路径不创建 DSH trace/session/provenance；原有来源字段只是原始声明。",
]
_LOADER = None
_CORE = None
_NATIVE_INPUT = None


def _issue(code, message, **details):
    return {"code": code, "message": message, **details}


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _digest(value):
    return _sha(_canonical(value).encode("utf-8"))


def _same_json(left, right):
    # Python equality considers True == 1 == 1.0; audit requires exact JSON types.
    return _canonical(left) == _canonical(right)


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("JSON 对象含重复键: " + repr(key))
        result[key] = value
    return result


def _nonfinite(value):
    raise ValueError("JSON 不允许非有限数字: " + value)


def _strict_loads(text):
    value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_nonfinite)
    # json.loads('1e999') produces inf without invoking parse_constant.
    _canonical(value)
    return value


def _read_jsonl(data, name):
    rows, errors = [], []
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return [], [_issue("invalid_utf8", "文件不是合法 UTF-8。", file=name)]
    for line, text in enumerate(lines, 1):
        if not text.strip():
            continue
        try:
            rows.append((line, _strict_loads(text)))
        except (ValueError, TypeError, RecursionError) as error:
            errors.append(_issue("invalid_json", str(error), file=name, line=line))
    if not rows and not errors:
        errors.append(_issue("empty_input", "文件没有 JSONL 记录。", file=name))
    return rows, errors


def _loader():
    global _LOADER
    if _LOADER is None:
        path = Path(__file__).resolve().parent / "upstream/split_data.py"
        spec = importlib.util.spec_from_file_location("_kev_native_check", path)
        _LOADER = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_LOADER)
    return _LOADER


def _input_findings(record):
    """Use the shared root-field leakage policy without narrowing native state types."""
    global _CORE
    if _CORE is None:
        path = Path(__file__).resolve().with_name("dataset.py")
        spec = importlib.util.spec_from_file_location("_kev_legacy_core", path)
        _CORE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_CORE)
    if not isinstance(record, dict):
        return [], []
    errors, warnings = _CORE._input_leaks(record.get("state"))
    return (
        [{**finding, "message": "模型可见状态的顶层含有保留的监督、审计或后续信息字段；保留原文并隔离，不能直接训练。"} for finding in errors],
        [{**finding, "message": "该业务字段可以保留，但须依据业务合同核对它在决策前已可见的含义。"} for finding in warnings],
    )


def _native_input():
    global _NATIVE_INPUT
    if _NATIVE_INPUT is None:
        path = Path(__file__).resolve().with_name("native_input.py")
        spec = importlib.util.spec_from_file_location("_kev_legacy_native_input", path)
        _NATIVE_INPUT = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_NATIVE_INPUT)
    return _NATIVE_INPUT


def _target(target, question):
    """Validate native nonnegative weights and return explicit probabilities."""
    kind, criteria = question.get("type"), question.get("criteria")
    keys = (["false", "true"] if kind == "noul" else list(criteria)
            if kind == "choice" and isinstance(criteria, dict) else
            [str(i) for i in range(len(criteria))] if kind == "score" and isinstance(criteria, list) else [])
    if not isinstance(target, dict) or not target or set(target) - set(keys):
        raise ValueError("soft target 必须是非空选项权重映射，且不得含未知选项。")
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in target.values()):
        raise ValueError("soft target 权重须有限非负，bool 不能冒充数字。")
    try:
        total = math.fsum(target.values())
    except (OverflowError, ValueError):
        total = math.inf
    if not math.isfinite(total) or total <= 0:
        raise ValueError("soft target 总权重须有限且大于零。")
    return {key: target.get(key, 0) / total for key in keys}


def check_native_record(record):
    """Reuse official check_record, then close its bool/finite-number loopholes."""
    problems = []
    try:
        problems.extend(_loader().check_record(record))
    except (TypeError, ValueError, OverflowError) as error:
        problems.append("原生检查器拒绝该结构: " + str(error))
    if isinstance(record, dict):
        qs = record.get("questions")
        for qid, q in qs.items() if isinstance(qs, dict) else []:
            if not isinstance(q, dict):
                continue
            kind, label = q.get("type"), q.get("label")
            if kind == "choice" and not isinstance(label, str):
                problems.append(f"question {qid!r}: choice label 必须是字符串。")
            if kind == "score" and type(label) is not int:
                problems.append(f"question {qid!r}: score label 必须是整数且不能是 bool。")
            if kind == "noul" and type(label) is not bool:
                problems.append(f"question {qid!r}: noul label 必须是 bool。")
            if q.get("target") is not None:
                try:
                    _target(q["target"], q)
                except (ValueError, OverflowError) as error:
                    problems.append(f"question {qid!r}: {error}")
    return problems


def _entries(data):
    rows, errors = _read_jsonl(data, "source.jsonl")
    source_sha = _sha(data)
    entries = []
    for line, record in rows:
        digest = _digest(record)
        input_errors, input_warnings = _input_findings(record)
        entries.append({"line": line, "record": record, "record_sha256": digest,
                        "record_id": "legacy-" + _digest([source_sha, line, digest])[:24],
                        "problems": check_native_record(record),
                        "input_errors": input_errors, "input_warnings": input_warnings})
    return entries, errors


def _template(entry, source_sha):
    record = entry["record"]
    qs = record.get("questions", {}) if isinstance(record, dict) else {}
    return {
        "schema_version": REVIEW_SCHEMA, "source_sha256": source_sha,
        "source_line": entry["line"], "record_sha256": entry["record_sha256"], "record_id": entry["record_id"],
        "grouping": {"family_id": None, "session_id": None, "basis": None, "evidence_refs": []},
        "questions": {qid: {"status": "unreviewed", "label": None, "source": None,
                            "reviewer": None, "review_method": None, "rule_id": None, "rule_version": None,
                            "basis": None, "evidence_refs": [],
                            "target": None, "target_semantics": None,
                            "original_label": deepcopy(q.get("label")),
                            "original_target": deepcopy(q.get("target"))}
                      for qid, q in qs.items() if isinstance(q, dict)} if isinstance(qs, dict) else {},
    }


def _refs(value, required=False):
    return isinstance(value, list) and (not required or bool(value)) and all(
        _text(ref) or isinstance(ref, dict) and bool(ref) for ref in value)


def _reviews(data, entries, source_sha):
    rows, errors = _read_jsonl(data, "reviews.jsonl")
    by_id, bound = {e["record_id"]: e for e in entries}, {}
    for line, review in rows:
        if not isinstance(review, dict) or not isinstance(review.get("record_id"), str):
            errors.append(_issue("invalid_review", "复核行必须有 record_id。", line=line))
            continue
        key = review["record_id"]
        if key not in by_id or key in bound:
            errors.append(_issue("unbound_or_duplicate_review", "复核身份未知或重复。", line=line, record_id=key))
            continue
        entry = by_id[key]
        expected = {"schema_version": REVIEW_SCHEMA, "source_sha256": source_sha,
                    "source_line": entry["line"], "record_sha256": entry["record_sha256"]}
        if any(type(review.get(k)) is not type(v) or review.get(k) != v for k, v in expected.items()):
            errors.append(_issue("review_binding_mismatch", "复核未绑定当前原文件及当前记录。", line=line, record_id=key))
            continue
        grouping = review.get("grouping", {})
        if not isinstance(grouping, dict) or any(
            grouping.get(k) is not None and not _text(grouping[k]) for k in ("family_id", "session_id")
        ):
            errors.append(_issue("invalid_review_grouping", "复核来源映射无效。", record_id=key))
            continue
        if any(grouping.get(k) for k in ("family_id", "session_id")) and (
            not _text(grouping.get("basis")) or not _refs(grouping.get("evidence_refs"), required=True)
        ):
            errors.append(_issue("unsupported_review_grouping", "新增 family/session 映射须有真实依据和证据引用。", record_id=key))
            continue
        bound[key] = review
    return bound, errors


def _containers(record):
    if not isinstance(record, dict):
        return []
    containers = [record]
    meta = record.get("_meta")
    if isinstance(meta, dict):
        containers.append(meta)
    return containers + [c["provenance"] for c in containers if isinstance(c.get("provenance"), dict)]


def _declared_keys(record):
    return [(category, _canonical(c[field])) for c in _containers(record)
            for field, category in GROUP_FIELDS.items()
            if _text(c.get(field)) or type(c.get(field)) is int]


def _question_input(record, question):
    return _digest({"state": record.get("state"),
                    "question": {k: question.get(k) for k in ("type", "instructions", "criteria")}})


def _groups(entries, reviews):
    """Connect all source rows BEFORE any label/status exclusion, including bridges."""
    parent = list(range(len(entries)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen = {}
    for i, entry in enumerate(entries):
        record = entry["record"]
        keys = _declared_keys(record)
        grouping = reviews.get(entry["record_id"], {}).get("grouping", {})
        keys.extend((GROUP_FIELDS[k], _canonical(grouping[k])) for k in ("family_id", "session_id") if grouping.get(k))
        if isinstance(record, dict) and "state" in record:
            # Conservative official normalization connects even differing question packages.
            keys.append(("state", _loader().state_key(record["state"])))
            keys.append(("rendered_state", _native_input().state_key(record["state"])))
            qs = record.get("questions")
            if isinstance(qs, dict):
                for q in qs.values():
                    if isinstance(q, dict):
                        keys.append(("question_input", _question_input(record, q)))
                        try:
                            keys.append(("rendered_question_input", _native_input().question_key(record["state"], q)))
                        except (TypeError, ValueError, KeyError):
                            # A malformed question is quarantined; other source
                            # edges from this original row still participate.
                            pass
        for key in keys:
            if key in seen:
                parent[find(i)] = find(seen[key])
            else:
                seen[key] = i
    members = defaultdict(list)
    for i, entry in enumerate(entries):
        members[find(i)].append(entry)
    group_of, details, errors = {}, {}, []
    for group in members.values():
        gid = "legacy-group-" + _digest(sorted(e["record_id"] for e in group))[:24]
        splits = set()
        for entry in group:
            group_of[entry["record_id"]] = gid
            for c in _containers(entry["record"]):
                if c.get("split") is not None:
                    split = c["split"]
                    if not isinstance(split, str) or split not in PARTITIONS:
                        errors.append(_issue("unknown_existing_split", "已有 split 不能猜测重映射；请先明确来源切分语义。", line=entry["line"]))
                    else:
                        splits.add(split)
        if len(splits) > 1:
            errors.append(_issue("existing_split_conflict", "同源闭包横跨已有分区，禁止静默重切。", group_id=gid, splits=sorted(splits)))
        details[gid] = {"source_records": len(group), "record_ids": [e["record_id"] for e in group],
                        "existing_split": next(iter(splits)) if len(splits) == 1 else None}
    return group_of, details, errors


def _review_record(entry, review):
    record = entry["record"]
    reasons = deepcopy(entry["input_errors"]) + [_issue("invalid_native_record", p) for p in entry["problems"]]
    if reasons:
        return None, reasons
    if review is None:
        return None, [_issue("unreviewed", "该记录尚无绑定复核。")]
    questions = review.get("questions")
    if not isinstance(questions, dict) or set(questions) != set(record["questions"]):
        return None, [_issue("review_question_mismatch", "每个原题须有独立复核，不能增加或省略题目。")]
    if not _declared_keys(record) and not any(review.get("grouping", {}).get(k) for k in ("family_id", "session_id")):
        reasons.append(_issue("missing_source_group", "缺少真实来源组；请补来源家族或会话对应关系及依据，不能把逐行新编号当作独立来源。"))
    result = deepcopy(record)
    for qid, q in result["questions"].items():
        r = questions[qid]
        if not isinstance(r, dict) or not isinstance(r.get("status"), str) or r["status"] not in STATUSES:
            reasons.append(_issue("invalid_review_status", "复核状态无效。", question=qid))
            continue
        if r["status"] != "verified":
            reasons.append(_issue("label_" + r["status"], "该题尚无可确认的复核标签，整行隔离。", question=qid))
            continue
        method_ok = (r.get("review_method") == "human" and _text(r.get("reviewer"))) or (
            r.get("review_method") == "rule" and _text(r.get("rule_id")) and _text(r.get("rule_version")))
        if not method_ok or not all(_text(r.get(k)) for k in ("source", "basis")) or not _refs(r.get("evidence_refs"), required=True):
            reasons.append(_issue("missing_review_evidence", "复核通过须有实际人员或有标识和版本的独立规则，并提供标签来源、理由和非空证据引用。", question=qid))
        if str(r.get("basis", "")).strip().casefold() in {"high", "low", "medium", "高", "低", "中", "高确定性", "低确定性", "high certainty", "low certainty", "high confidence", "low confidence"}:
            reasons.append(_issue("certainty_is_not_evidence", "旧确定性高低不是标签正确性的复核依据。", question=qid))
        q["label"] = deepcopy(r.get("label"))
        q.pop("target", None)  # Never inherit the old soft label without explicit review.
        if r.get("target") is not None:
            try:
                q["target"] = _target(r["target"], q)
            except (ValueError, OverflowError) as error:
                reasons.append(_issue("invalid_review_target", str(error), question=qid))
            if not _text(r.get("target_semantics")):
                reasons.append(_issue("missing_target_semantics", "复核概率分布须说明概率来源与语义。", question=qid))
    reasons.extend(_issue("invalid_reviewed_label", p) for p in check_native_record(result))
    return (None if reasons else result), reasons


def _fractions(value):
    try:
        values = [float(x) for x in value.split(",")] if isinstance(value, str) else [value[k] for k in PARTITIONS]
    except (ValueError, TypeError, KeyError):
        raise ValueError("fractions 顺序为 train,development,calibration,test，例如 0.7,0.1,0.1,0.1。") from None
    if len(values) != 4 or any(type(x) not in (int, float) or not math.isfinite(x) or x <= 0 for x in values) or not math.isclose(sum(values), 1, abs_tol=1e-9, rel_tol=0):
        raise ValueError("四分区比例须有限、均大于零且总和为 1。")
    return dict(zip(PARTITIONS, values))


def _prepare(source, review_bytes, seed, fractions):
    if type(seed) is not int:
        raise ValueError("seed 必须是整数，不能是 bool。")
    fractions = _fractions(fractions)
    source_sha, reviews_sha = _sha(source), _sha(review_bytes)
    entries, errors = _entries(source)
    reviews, review_errors = _reviews(review_bytes, entries, source_sha)
    errors.extend(review_errors)
    group_of, group_details, group_errors = _groups(entries, reviews)
    errors.extend(group_errors)
    eligible, quarantine, statuses = [], [], Counter()
    for entry in entries:
        review = reviews.get(entry["record_id"])
        qs = review.get("questions") if review else None
        if isinstance(qs, dict):
            statuses.update(str(q.get("status", "invalid")) for q in qs.values() if isinstance(q, dict))
        else:
            original_qs = entry["record"].get("questions", {}) if isinstance(entry["record"], dict) else {}
            statuses["unreviewed"] += len(original_qs) if isinstance(original_qs, dict) else 0
        result, reasons = _review_record(entry, review)
        if reasons:
            quarantine.append({"record_id": entry["record_id"], "source_line": entry["line"],
                               "record_sha256": entry["record_sha256"], "group_id": group_of[entry["record_id"]],
                               "reasons": reasons, "record": entry["record"], "review": review})
        else:
            eligible.append((entry, result, review))
    conflicts = defaultdict(lambda: defaultdict(list))
    for entry, result, review in eligible:
        for qid, q in result["questions"].items():
            for kind, key in (("canonical", _question_input(result, q)),
                              ("native-render", _native_input().question_key(result["state"], q))):
                conflicts[(kind, key)][_canonical(q["label"])].append({"record_id": entry["record_id"], "question": qid})
    errors.extend(_issue("conflicting_verified_labels", "相同逐题模型输入的已复核标签互相冲突，须先裁决。", input_sha256=key, identity_kind=kind, labels=dict(labels))
                  for (kind, key), labels in conflicts.items() if len(labels) > 1)
    grouped = defaultdict(list)
    for item in eligible:
        grouped[group_of[item[0]["record_id"]]].append(item)
    assignment = {gid: group_details[gid]["existing_split"] for gid in grouped if group_details[gid]["existing_split"]}
    free = sorted(set(grouped) - set(assignment))
    rng = random.Random(seed)
    rng.shuffle(free)
    free.sort(key=lambda gid: -len(grouped[gid]))
    missing = set(PARTITIONS) - set(assignment.values())
    if len(grouped) < 4 or len(free) < len(missing):
        errors.append(_issue("insufficient_independent_groups", "需要至少四个复核合格、保留真实来源边界且能填满四分区的来源组。", eligible_groups=len(grouped), missing_partitions=sorted(missing)))
    if not errors:
        counts = Counter()
        for gid, name in assignment.items():
            counts[name] += len(grouped[gid])
        tie_order = list(PARTITIONS)
        rng.shuffle(tie_order)
        for i, gid in enumerate(free):
            empty = [name for name in PARTITIONS if not counts[name]]
            choices = empty if len(free) - i == len(empty) else PARTITIONS
            name = max(choices, key=lambda n: (fractions[n] * len(eligible) - counts[n], -tie_order.index(n)))
            assignment[gid] = name
            counts[name] += len(grouped[gid])
    partitions = {name: [] for name in PARTITIONS}
    if not errors:
        for entry, result, review in eligible:
            gid = group_of[entry["record_id"]]
            meta = deepcopy(result["_meta"]) if isinstance(result.get("_meta"), dict) else {}
            original_meta = deepcopy(result.get("_meta"))
            # Training consumers require unique, nonempty string IDs even when
            # historical native metadata used missing, numeric or repeated IDs.
            meta["id"] = entry["record_id"]
            # Kev's gold metrics select clean rows. This describes the reviewed
            # derived export; the source's original variant remains in the snapshot.
            meta.update(group_id=gid, split=assignment[gid], variant="clean")
            meta["legacy"] = {
                "schema_version": RECORD_SCHEMA, "record_id": entry["record_id"],
                "source_sha256": source_sha, "source_line": entry["line"], "record_sha256": entry["record_sha256"],
                "reviews_sha256": reviews_sha, "review_status": "verified", "review": deepcopy(review),
                "original_meta_present": "_meta" in result, "original_meta": original_meta, "id_generated": True,
                "variant_scope": "derived-reviewed-export",
            }
            result["_meta"] = meta
            partitions[assignment[gid]].append(result)
    warnings = [_issue("review_claim_only", LIMITATIONS[0]), _issue("undeclared_ancestry", LIMITATIONS[1])]
    warnings.extend({**finding, "line": entry["line"], "record_id": entry["record_id"]}
                    for entry in entries for finding in entry["input_warnings"])
    if assignment:
        warnings.append(_issue("existing_splits_preserved", "已有明确 split 固定保留；仅未分配组按目标比例分配。", fixed_groups=sum(bool(group_details[g]["existing_split"]) for g in grouped)))
    report = {
        "schema_version": MANIFEST_SCHEMA, "source_format": "legacy-native", "status": "blocked" if errors else "ready",
        "source_sha256": source_sha, "reviews_sha256": reviews_sha, "seed": seed, "fractions": fractions,
        "kev_source_commit": KEV_SOURCE_COMMIT,
        "input_records": len(entries), "eligible_records": len(eligible), "quarantined_records": len(quarantine),
        "exported_records": sum(map(len, partitions.values())), "source_groups": len(group_details),
        "eligible_groups": len(grouped), "review_question_statuses": dict(statuses),
        "partition_records": {name: len(rows) for name, rows in partitions.items()},
        "partition_groups": {name: len({r["_meta"]["group_id"] for r in rows}) for name, rows in partitions.items()},
        "partition_question_types": {name: dict(Counter(q["type"] for r in rows for q in r["questions"].values())) for name, rows in partitions.items()},
        "quarantine_by_reason": dict(Counter(reason["code"] for item in quarantine for reason in item["reasons"])),
        "group_partition": assignment if not errors else {}, "groups": group_details,
        "errors": errors, "warnings": warnings, "limitations": LIMITATIONS,
        "token_budget": {"status": "not_checked"},
    }
    return partitions, quarantine, report


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _jsonl_bytes(rows):
    # Canonical sorting is only a hash protocol. Native rendering observes the
    # insertion order of state/instruction objects, so exports must retain it.
    return "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
                   for row in rows).encode("utf-8")


def _write_jsonl(path, rows):
    path.write_bytes(_jsonl_bytes(rows))


def _fresh(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=False)
    return path


def _markdown(report, stage):
    ready = report.get("ok", report.get("status") == "ready")
    heading = {"inspect": "既有原生 Kev 数据检查", "build": "既有原生 Kev 数据构建", "audit": "既有原生 Kev 数据审计"}[stage]
    conclusion = "本阶段检查通过。" if ready else "本阶段检查未通过，不能进入训练交接。"
    if stage == "inspect":
        format_ok = report["input_records"] > 0 and report["native_valid_records"] == report["input_records"] and not any(
            item["code"] in {"invalid_utf8", "invalid_json", "empty_input"} for item in report["errors"])
        conclusion = "原生格式检查通过，标签尚未复核。" if format_ok else "原生格式检查发现问题，标签尚未复核。"
    lines = ["# " + heading, "", "结论：" + conclusion, ""]
    if stage == "inspect":
        lines += [f"读取 {report['input_records']} 条记录；原生格式检查通过 {report['native_valid_records']} 条。每道题均保留待复核记录。", "",
                  f"原有低确定性、不确定或歧义标记共 {report['priority_review_records']} 条，同一记录只计一次；中确定性标记 {report['medium_certainty_records']} 条。这些标记只用于安排复核顺序，不是错标率，也不转换成训练权重。", "",
                  f"先读 `review-queue.md`：预览最多 30 条，本次展示 {report['preview_records']} 条。完整数据在原文件，完整绑定模板在 `reviews.todo.jsonl`。", "",
                  "下一步：逐题完成有人员或独立规则依据的真实复核，填写复核记录。原标签、原确定性和模型建议都不能替代这次复核。", ""]
    elif stage == "build":
        lines += [f"原输入 {report['input_records']} 条，复核合格 {report['eligible_records']} 条，隔离 {report['quarantined_records']} 条，实际导出 {report['exported_records']} 条。", ""]
    if "partition_records" in report:
        lines += ["| 分区 | 记录 | 来源组 |", "| --- | ---: | ---: |"]
        names = dict(zip(PARTITIONS, ("训练", "开发", "校准", "测试")))
        lines += [f"| {names[name]} | {report['partition_records'].get(name, 0)} | {report.get('partition_groups', {}).get(name, 0)} |" for name in PARTITIONS]
        lines.append("")
    for key, title in (("errors", "阻塞项"), ("warnings", "审查提示")):
        issues = [item for item in report.get(key, [])
                  if item["code"] not in {"review_claim_only", "undeclared_ancestry", "unreviewed_labels"}]
        if issues:
            lines += ["## " + title, ""]
            for item in issues[:20]:
                message = item["message"]
                if item["code"] == "existing_splits_preserved":
                    message = "已有分区保持不变；仅未分配的来源组按设定比例分配。"
                elif item["code"] in {"invalid_native_record", "invalid_partition_record"}:
                    message = "记录结构不符合原生格式要求；具体字段与原始检查信息见机器报告。"
                elif item["code"] == "invalid_json":
                    message = "该行不能按严格数据格式读取，详见机器报告中的解析原因。"
                elif item["code"] == "audit_unreadable_or_invalid":
                    message = "无法读取或校验数据目录，详见机器报告中的文件位置和原因。"
                location = (f"原文件第 {item['line']} 行；" if "line" in item else "")
                if item.get("path"):
                    location += "字段 `" + item["path"] + "`；"
                lines += [f"- {location}{message}（技术码：`{item['code']}`）"]
            if len(issues) > 20:
                lines.append(f"- 另有 {len(issues) - 20} 项；完整明细见 report.json。")
            lines.append("")
    lines += ["## 当前说明", "",
              "- 复核结论需要实际人员或独立规则提供依据。脚本检查结构与记录绑定，不认证身份，也不代替业务判断。",
              "- 来源组依据已有记录建立；未声明的同源关系仍须核对，工具不会补造缺失来源。",
              "- 尚未用选定模型的分词器检查长度，也未运行训练或测量模型、校准效果。"]
    lines += ["", "文件绑定、逐行问题与完整计数见 `report.json`；原文件保持不变。", ""]
    return "\n".join(lines)


def _review_signals(record):
    low, medium = [], []
    for c in _containers(record):
        for key in ("annotation_certainty", "certainty", "label_status", "difficulty"):
            value = c.get(key)
            if isinstance(value, str):
                value = value.strip().casefold()
                name = {"annotation_certainty": "原标注确定性", "certainty": "原标注确定性",
                        "label_status": "原标签状态", "difficulty": "原难度标记"}[key]
                if value in {"uncertain", "ambiguous", "不确定", "模糊"}:
                    low.append(name + "为不确定或有歧义")
                elif key != "difficulty" and value in {"low", "低", "低确定性"}:
                    low.append(name + "为低")
                elif key != "difficulty" and value in {"medium", "中", "中确定性"}:
                    medium.append(name + "为中")
        for key in ("uncertain", "ambiguous"):
            if c.get(key) is True:
                low.append("原记录标记为不确定或有歧义")
    return list(dict.fromkeys(low)), list(dict.fromkeys(medium))


def _preview(value, limit=220):
    text = value if isinstance(value, str) else _canonical(value)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit] + "…（仅预览截短，原数据未改）"
    # Render source text as text, not as Markdown instructions or HTML.
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    for char in "\\`*_{}[]()#+!|":
        text = text.replace(char, "\\" + char)
    return text


def _state_preview(state):
    """Readable display only; keep the machine record and its field order intact."""
    names = {"request": "用户输入指令", "query": "用户输入指令", "user_input": "用户输入指令",
             "prompt": "用户输入指令", "instructions": "用户输入指令", "instruction": "用户输入指令",
             "context": "背景信息", "background": "背景信息", "background_info": "背景信息",
             "previous": "此前状态", "previous_step": "此前状态"}
    if not isinstance(state, dict):
        return ["- 输入：" + _preview(_native_input().render(state), 320)]
    return ["- " + _preview(names.get(key, key), 80) + "：" + _preview(_native_input().render(value), 320)
            for key, value in state.items()]


def _original_label_preview(question):
    label, kind = question.get("label"), question.get("type")
    if kind == "noul" and type(label) is bool:
        return "是（true）" if label else "否（false）"
    criteria = question.get("criteria")
    if kind == "score" and type(label) is int and isinstance(criteria, list) and 0 <= label < len(criteria):
        return str(label) + "（" + _preview(_native_input().render(criteria[label]), 100) + "）"
    return _preview(label, 100)


def _review_queue(entries, source_name):
    ranked = []
    for entry in entries:
        low, medium = _review_signals(entry["record"])
        priority = 0 if low or entry["problems"] or entry["input_errors"] else 1 if medium else 2
        reasons = low or (["模型输入含保留的监督或后续信息字段"] if entry["input_errors"] else
                         ["原生结构检查有问题"] if entry["problems"] else medium) or ["普通未复核记录，补足预览"]
        ranked.append((priority, entry["line"], entry, reasons))
    selected = sorted(ranked, key=lambda item: item[:2])[:30]
    lines = ["# 待复核记录预览", "", f"原文件：{_preview(source_name)}。仅展示前 {len(selected)} 条（最多 30 条）；完整记录在原文件和 `reviews.todo.jsonl`。", "",
             "排序只使用原有确定性、难度或未定标记，以及格式和输入边界检查结果；这些是复核线索，不是错标率。此预览不提供新答案，不把确定性换算为权重。原始数据和题目未截断，下面摘录仅供定位。", ""]
    definitions, question_refs = {}, {}
    for _, _, entry, _ in selected:
        record = entry["record"]
        qs = record.get("questions") if isinstance(record, dict) else None
        for qid, q in list(qs.items())[:5] if isinstance(qs, dict) else []:
            if not isinstance(q, dict):
                continue
            form = _jsonl_bytes([{key: q.get(key) for key in ("type", "instructions", "criteria")}])
            if form not in definitions:
                definitions[form] = {"ref": "题目" + str(len(definitions) + 1), "line": entry["line"], "qid": qid, "question": q}
            question_refs[(entry["line"], qid)] = definitions[form]["ref"]
    if definitions:
        lines += ["## 题目说明", "", "相同定义只列一次。下列短引用仅用于本预览；可按原文件行号和原题名称定位完整题干及选项说明。", ""]
    for definition in definitions.values():
        q, qid = definition["question"], definition["qid"]
        kind = {"choice": "选择题", "noul": "判断题", "score": "评分题"}.get(q.get("type"), "题型待检查") if isinstance(q.get("type"), str) else "题型待检查"
        lines += [f"### {definition['ref']} · {kind}", "",
                  f"首次定位：原文件第 {definition['line']} 行，原题 {_preview(qid, 80)}。", "",
                  "题干摘录：" + _preview(_native_input().render(q.get("instructions")), 420), ""]
        criteria = q.get("criteria")
        if q.get("type") == "choice" and isinstance(criteria, dict):
            lines += ["候选名称：" + "、".join(_preview(name, 100) for name in criteria) + "。", ""]
        elif q.get("type") == "noul":
            lines += ["判断选项：否（false）、是（true）；逐行保留原布尔标签。", ""]
        elif q.get("type") == "score" and isinstance(criteria, list):
            lines += ["有序等级（原索引从 0 起）：" + "；".join(f"{index}：{_preview(_native_input().render(value), 100)}" for index, value in enumerate(criteria)) + "。", ""]
    for _, _, entry, reasons in selected:
        record = entry["record"]
        lines += [f"## 原文件第 {entry['line']} 行", "",
                  "优先理由：" + "；".join(_preview(reason) for reason in reasons) + "。", ""]
        if not isinstance(record, dict):
            lines += ["原记录摘录：" + _preview(record), ""]
            continue
        lines += ["输入状态摘录：", ""] + _state_preview(record.get("state")) + [""]
        qs = record.get("questions")
        if isinstance(qs, dict):
            for qid, q in list(qs.items())[:5]:
                if isinstance(q, dict):
                    ref = question_refs[(entry["line"], qid)]
                    lines += [f"- 原标签（{ref}，原题 {_preview(qid, 80)}）：{_original_label_preview(q)}"]
            if len(qs) > 5:
                lines += [f"- 本记录另有 {len(qs) - 5} 题，见原文件和完整模板。"]
            lines.append("")
    return "\n".join(lines), len(selected)


def inspect_file(input_path, out):
    source = Path(input_path).read_bytes()
    entries, errors = _entries(source)
    group_of, details, group_errors = _groups(entries, {})
    source_sha = _sha(source)
    types, certainties = Counter(), Counter()
    findings = []
    for entry in entries:
        record = entry["record"]
        if isinstance(record, dict):
            qs = record.get("questions")
            types.update(str(q.get("type")) for q in qs.values() if isinstance(q, dict)) if isinstance(qs, dict) else None
            for c in _containers(record):
                for key in ("certainty", "annotation_certainty"):
                    if key in c:
                        certainties[c[key] if isinstance(c[key], str) else _canonical(c[key])] += 1
        findings.extend(_issue("invalid_native_record", p, line=entry["line"], record_id=entry["record_id"]) for p in entry["problems"])
        findings.extend({**finding, "line": entry["line"], "record_id": entry["record_id"]}
                        for finding in entry["input_errors"])
    queue, preview_count = _review_queue(entries, Path(input_path).name)
    report = {
        "schema_version": "kev-legacy-native-inspect/v1", "source_format": "legacy-native", "status": "needs_review",
        "source_sha256": source_sha, "source_filename": Path(input_path).name, "kev_source_commit": KEV_SOURCE_COMMIT,
        "input_records": len(entries), "native_valid_records": sum(not e["problems"] for e in entries),
        "question_types": dict(types), "original_certainty_claims": dict(certainties), "source_groups": len(details),
        "priority_review_records": sum(bool(_review_signals(e["record"])[0]) for e in entries),
        "medium_certainty_records": sum(bool(_review_signals(e["record"])[1]) for e in entries),
        "preview_records": preview_count,
        "unreviewed_questions": sum(types.values()), "errors": errors + findings + group_errors,
        "warnings": [_issue("unreviewed_labels", "所有原标签仅保留为历史声明，尚未完成独立复核。")]
                    + [{**finding, "line": entry["line"], "record_id": entry["record_id"]}
                       for entry in entries for finding in entry["input_warnings"]],
        "limitations": LIMITATIONS, "token_budget": {"status": "not_checked"},
    }
    if report["errors"]:
        report["status"] = "blocked"
    root = _fresh(out)
    _write_jsonl(root / "reviews.todo.jsonl", [_template(e, source_sha) for e in entries])
    _write_json(root / "report.json", report)
    (root / "report.md").write_text(_markdown(report, "inspect"), encoding="utf-8")
    (root / "review-queue.md").write_text(queue, encoding="utf-8")
    return report


def build_directory(input_path, reviews_path, out, *, seed=0, fractions=DEFAULT_FRACTIONS):
    source, reviews = Path(input_path).read_bytes(), Path(reviews_path).read_bytes()
    partitions, quarantine, report = _prepare(source, reviews, seed, fractions)
    root = _fresh(out)
    (root / "source.jsonl").write_bytes(source)
    (root / "reviews.jsonl").write_bytes(reviews)
    _write_jsonl(root / "quarantine.jsonl", quarantine)
    files = {}
    if report["status"] == "ready":
        for name, rows in partitions.items():
            path = root / (name + ".jsonl")
            _write_jsonl(path, rows)
            files[name] = {"path": path.name, "sha256": _sha(path.read_bytes()), "records": len(rows),
                           "questions": sum(len(r["questions"]) for r in rows), "groups": report["partition_groups"][name]}
    report["files"] = files
    report["source"] = {"path": "source.jsonl", "sha256": _sha(source), "filename": Path(input_path).name}
    report["reviews"] = {"path": "reviews.jsonl", "sha256": _sha(reviews)}
    report["quarantine"] = {"path": "quarantine.jsonl", "sha256": _sha((root / "quarantine.jsonl").read_bytes()), "records": len(quarantine)}
    _write_json(root / "split-manifest.json", report)
    report = {**report, "manifest_sha256": _sha((root / "split-manifest.json").read_bytes())}
    _write_json(root / "report.json", report)
    (root / "report.md").write_text(_markdown(report, "build"), encoding="utf-8")
    return report


def audit_directory(root):
    """Replay snapshots and reviews; never accept report.ok or manifest.status alone.

    Return a JSON-safe dict with ok/errors/warnings, hashes and four-partition counts.
    Invalid/missing data yields ok=False rather than authorizing a training handoff.
    """
    root = Path(root)
    result = {"schema_version": "kev-legacy-native-audit/v1", "kind": "legacy-native", "ok": False,
              "errors": [], "warnings": [], "partition_records": {}, "partition_groups": {}}
    errors = result["errors"]
    try:
        manifest_bytes = (root / "split-manifest.json").read_bytes()
        manifest = _strict_loads(manifest_bytes.decode("utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schema_version") != MANIFEST_SCHEMA or manifest.get("source_format") != "legacy-native" or manifest.get("status") != "ready":
            raise ValueError("需要 ready 的 legacy-native split-manifest.json。")
        result["manifest_sha256"] = _sha(manifest_bytes)
        source = (root / "source.jsonl").read_bytes()
        reviews = (root / "reviews.jsonl").read_bytes()
        result.update(source_sha256=_sha(source), reviews_sha256=_sha(reviews))
        for key, data in (("source", source), ("reviews", reviews)):
            info = manifest.get(key)
            if not isinstance(info, dict) or info.get("path") != key + ".jsonl" or info.get("sha256") != _sha(data) or manifest.get(key + "_sha256") != _sha(data):
                errors.append(_issue("snapshot_hash_mismatch", "原输入或复核快照与 manifest 不一致。", file=key))
        expected, quarantine, replay = _prepare(source, reviews, manifest.get("seed"), manifest.get("fractions"))
        errors.extend(replay["errors"])
        result["warnings"] = replay["warnings"]
        for key in ("input_records", "eligible_records", "quarantined_records", "exported_records", "source_groups", "eligible_groups", "partition_records", "partition_groups", "partition_question_types", "quarantine_by_reason", "group_partition", "groups", "review_question_statuses"):
            if not _same_json(manifest.get(key), replay[key]):
                errors.append(_issue("manifest_replay_mismatch", "manifest 计数或分组与原输入复算不符。", field=key))
        files = manifest.get("files")
        if not isinstance(files, dict) or set(files) != set(PARTITIONS):
            raise ValueError("manifest.files 必须精确声明四个物理分区。")
        group_locations = defaultdict(set)
        for name in PARTITIONS:
            info = files[name]
            if not isinstance(info, dict) or info.get("path") != name + ".jsonl":
                raise ValueError("分区路径必须是目录内固定文件名。")
            data = (root / (name + ".jsonl")).read_bytes()
            indexed, parse_errors = _read_jsonl(data, name + ".jsonl")
            errors.extend(parse_errors)
            rows = [r for _, r in indexed]
            if info.get("sha256") != _sha(data):
                errors.append(_issue("partition_hash_mismatch", "分区字节 hash 不符。", partition=name))
            if data != _jsonl_bytes(expected[name]):
                errors.append(_issue("partition_replay_mismatch", "分区内容与源文件、真实复核和完整来源闭包重放不符。", partition=name))
            valid_groups, questions = set(), 0
            for line, row in indexed:
                errors.extend(_issue("invalid_partition_record", p, partition=name, line=line) for p in check_native_record(row))
                input_errors, _ = _input_findings(row)
                errors.extend({**finding, "partition": name, "line": line} for finding in input_errors)
                meta = row.get("_meta") if isinstance(row, dict) else None
                if not isinstance(meta, dict) or not _text(meta.get("group_id")) or meta.get("split") != name:
                    errors.append(_issue("invalid_partition_metadata", "分区/group_id 元数据缺失或不符。", partition=name, line=line))
                    continue
                valid_groups.add(meta["group_id"])
                group_locations[meta["group_id"]].add(name)
                qs = row.get("questions")
                questions += len(qs) if isinstance(qs, dict) else 0
                legacy = meta.get("legacy")
                if not isinstance(legacy, dict) or legacy.get("schema_version") != RECORD_SCHEMA or legacy.get("review_status") != "verified":
                    errors.append(_issue("missing_review_snapshot", "导出记录未携带 verified 复核快照。", partition=name, line=line))
            result["partition_records"][name] = len(rows)
            result["partition_groups"][name] = len(valid_groups)
            for field, count in (("records", len(rows)), ("questions", questions), ("groups", len(valid_groups))):
                if not _same_json(info.get(field), count):
                    errors.append(_issue("partition_count_mismatch", "分区实际计数与 manifest 不符。", partition=name, field=field))
        errors.extend(_issue("cross_partition_group", "相同闭包来源组跨分区。", group_id=gid, partitions=sorted(names)) for gid, names in group_locations.items() if len(names) > 1)
        qbytes = (root / "quarantine.jsonl").read_bytes()
        qindexed, qerrors = ([], []) if not qbytes.strip() else _read_jsonl(qbytes, "quarantine.jsonl")
        errors.extend(qerrors)
        qrows = [r for _, r in qindexed]
        qinfo = manifest.get("quarantine", {})
        if not isinstance(qinfo, dict) or qinfo.get("path") != "quarantine.jsonl" or qinfo.get("sha256") != _sha(qbytes) or not _same_json(qinfo.get("records"), len(quarantine)) or qbytes != _jsonl_bytes(quarantine):
            errors.append(_issue("quarantine_replay_mismatch", "隔离记录未与原输入完整对应。"))
        report = _strict_loads((root / "report.json").read_text(encoding="utf-8"))
        if not isinstance(report, dict) or report.get("manifest_sha256") != result["manifest_sha256"] or any(not _same_json(report.get(k), v) for k, v in manifest.items()):
            errors.append(_issue("report_binding_mismatch", "机器报告未绑定当前 manifest。"))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        errors.append(_issue("audit_unreadable_or_invalid", str(error)))
    result["ok"] = not errors and all(result["partition_records"].get(name, 0) > 0 for name in PARTITIONS)
    result["status"] = "ok" if result["ok"] else "blocked"
    result["limitations"] = LIMITATIONS
    result["token_budget"] = {"status": "not_checked"}
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="既有原生 Kev JSONL：检查 → 独立复核 → 四分区构建 → 重放审计。")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect", "build", "audit"):
        p = commands.add_parser(name)
        p.add_argument("--json", action="store_true", help="stdout 输出完整机器 JSON；默认输出简短中文摘要。")
        if name == "audit":
            p.add_argument("--dataset-dir", required=True)
            p.add_argument("--out", help="可选新目录，保存审计 report.json/report.md。")
        else:
            p.add_argument("--input", required=True)
            p.add_argument("--out", required=True, help="必须是不存在的新目录。")
        if name == "build":
            p.add_argument("--reviews", required=True)
            p.add_argument("--seed", type=int, default=0)
            p.add_argument("--fractions", default="0.7,0.1,0.1,0.1", help="train,development,calibration,test 四个正比例。")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            report = inspect_file(args.input, args.out)
            success = not report["errors"]
        elif args.command == "build":
            report = build_directory(args.input, args.reviews, args.out, seed=args.seed, fractions=args.fractions)
            success = report["status"] == "ready"
        else:
            report = audit_directory(args.dataset_dir)
            success = report["ok"]
            if args.out:
                root = _fresh(args.out)
                _write_json(root / "report.json", report)
                (root / "report.md").write_text(_markdown(report, "audit"), encoding="utf-8")
        if args.json:
            print(json.dumps(report, ensure_ascii=False, allow_nan=False))
        else:
            print({"inspect": "原生格式检查通过，标签尚未复核。" if success else "数据检查发现问题，标签尚未复核。", "build": "四分区构建通过。" if success else "构建阻塞；未生成可训练四分区。", "audit": "重放审计通过。" if success else "审计未通过。"}[args.command])
            if "input_records" in report:
                print(f"原输入 {report['input_records']} 条；问题 {len(report['errors'])} 项。")
            if "partition_records" in report:
                print("分区记录：" + "，".join(f"{k}={v}" for k, v in report["partition_records"].items()))
            if args.out:
                print("详细报告：" + str(Path(args.out) / "report.md"))
                if args.command == "inspect":
                    print("待复核预览：" + str(Path(args.out) / "review-queue.md"))
        return 0 if success else 1
    except (OSError, ValueError, TypeError) as error:
        if args.json:
            print(json.dumps({"status": "blocked", "errors": [_issue("input_or_output_error", str(error))]}, ensure_ascii=False))
        else:
            print("无法完成：" + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

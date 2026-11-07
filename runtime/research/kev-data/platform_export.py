"""离线核对平台 v2 导出回执，保留用途并转换为原生 Kev JSONL。

用法：python3 platform_export.py manifest.json --out /path/to/new-directory
manifest 格式：{"schema_version":"kev-platform-export-manifest/v1","partitions":{
  "train":[{"path":"train-export.json","sha256":"<文件摘要>",
            "dataset_id":"decision-dataset-<UUID>","read_sha256":"<datasets/read.sha256>"}],
  "development":[...],"calibration":[...],"test":[...]}}
四个用途都必须有至少一个文件。path 相对 manifest；也可用绝对路径。
文件格式：{"dataset_id":"...","read_sha256":"...","mode":"training",
           "export":<原样保存的 datasets/export 返回 value>}
train 对应 mode=training，其他三个用途与 mode 同名。export.blocked 必须是 []。

成功写四个同名 JSONL、split-manifest.json 和 platform-bridge-report.json。
失败只写报告并以 1 退出；已存在的非空输出目录不覆盖。输入保持原样。
只核对留存回执和摘要；不访问平台、不重建来源 bundle、不认证回执真实性，
也不声称当前服务器仍认可该导出。结构检查不能发现所有自然语言标签泄漏。
原始 reviewed/model_suggestion/uncalibrated 及 AI 委托复核记录保存在
_meta.platform.targets；功能验证的 AI 复核不改称人工或 gold。
所有来源关联组保持原用途，不重新切分。
原生 _meta.group_id 使用关联闭包组供 KEV 校准分折；平台原组保存在
_meta.platform.original_group_id，原始 ID、source_group_id 和 group_history 保留。
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import unicodedata
import sys

from human_report import print_summary, write_report


_native_spec = importlib.util.spec_from_file_location("kev_bridge_native_input", Path(__file__).with_name("native_input.py"))
_native_input = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(_native_input)


SCHEMA = "kev-platform-export-manifest/v1"
PARTITIONS = ("train", "development", "calibration", "test")
MODES = {name: "training" if name == "train" else name for name in PARTITIONS}
SHA = re.compile(r"[0-9a-f]{64}\Z")
DATASET = re.compile(r"decision-dataset-[0-9a-f-]{36}\Z")
RECORD = re.compile(r"decision-[0-9a-f]{32}\Z")
RUN = re.compile(r"run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
QUESTION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
JS_SPACE = re.compile(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
HARNESS_PATHS = ["AGENTS.md", ".agents/skills/decision-sample-extraction/SKILL.md",
                 "docs/harness-research/decision-samples.md"]
LIMITS = [
    "offline_receipts_only: 来源批次 read_sha256 是提供并固定的回读身份，未重新访问服务器或原始 bundle。",
    "review_is_not_gold: 保留实际复核和标签来源；不证明行业真值、教师校准或任务效果。",
    "structural_leakage_only: 不通过文本词语巧合推断泄漏；输入可答性依赖实际复核，AI 委托复核仅用于功能验证。",
    "not_checked: 目标 tokenizer、长度、训练、部署及业务收益均未验证。",
]


class BridgeError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise BridgeError(code, message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode("utf-8")).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "duplicate_json_key", "JSON 对象含重复键")
            value[key] = item
        return value
    def invalid(_):
        raise BridgeError("nonfinite_number", "JSON 不允许 NaN 或 Infinity")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def js_json(value):
    """匹配本合同所用 JSON.stringify；拒绝无法无损核对的大整数。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        quoted = json.dumps(value, ensure_ascii=False)
        return "".join(f"\\u{ord(char):04x}" if 0xD800 <= ord(char) <= 0xDFFF else char for char in quoted)
    if type(value) is int:
        require(abs(value) <= 2**53 - 1, "unsupported_number_precision", "整数超过可无损核对的 JavaScript 范围")
        return str(value)
    if isinstance(value, float):
        require(math.isfinite(value), "nonfinite_number", "JSON 数值必须有限")
        if value == 0:
            return "0"
        if 1e-6 <= abs(value) < 1e21:
            result = format(Decimal(repr(value)), "f")
            return result.rstrip("0").rstrip(".") if "." in result else result
        mantissa, exponent = repr(value).lower().split("e")
        return mantissa.removesuffix(".0") + "e" + f"{int(exponent):+d}"
    if isinstance(value, list):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    require(isinstance(value, dict), "invalid_json_type", "只接受 JSON 数据")
    # JSON.stringify 将整数索引键放在前面，其他键保持插入顺序。
    indexed = sorted((key for key in value if re.fullmatch(r"0|[1-9][0-9]*", key)
                      and int(key) < 2**32 - 1), key=int)
    keys = indexed + [key for key in value if key not in indexed]
    return "{" + ",".join(js_json(key) + ":" + js_json(value[key]) for key in keys) + "}"


def normalize(value):
    if isinstance(value, str):
        return JS_SPACE.sub(" ", unicodedata.normalize("NFKC", value)).strip(" ")
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(value[key]) for key in sorted(value, key=lambda item: item.encode("utf-16-be", "surrogatepass"))}
    return value


def content_hash(row):
    return sha(js_json(normalize([row["state"], row["task"]["semantics"], row["questions"]])))


def source_group(row):
    first = next((message for message in row["state"]["messages"] if message["role"] == "user"
                  and (not message.get("source") or message["source"].get("kind") == "user")), None)
    content = first.get("content") if first else None
    if content is None:
        content = row["_meta"]["cutoff"].get("session_log") or "<未记录任务>"
    return "task-" + sha(normalize(js_json(content)))[:24]


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def validate_extractor(extractor):
    require(isinstance(extractor, dict) and text(extractor.get("session_id")), "invalid_extractor", "缺少真实抽取 Session")
    model = extractor.get("model")
    require(isinstance(model, dict) and text(model.get("provider")) and text(model.get("model")), "invalid_extractor", "缺少真实抽取模型")
    require(extractor.get("skill") == "decision-sample-extraction" and extractor.get("skill_path") == HARNESS_PATHS[1]
            and SHA.fullmatch(str(extractor.get("skill_sha256", ""))) and extractor.get("format") == "decision-dataset-v2",
            "invalid_extractor", "抽取 Skill 身份、摘要或格式无效")
    harness = extractor.get("harness_sources", {})
    files = harness.get("files") if isinstance(harness, dict) else None
    require(isinstance(files, list) and len(files) == len(HARNESS_PATHS), "invalid_harness_receipt", "抽取 Harness 来源清单无效")
    for path, entry in zip(HARNESS_PATHS, files):
        require(isinstance(entry, dict) and set(entry) == {"path", "source_sha256"} and entry["path"] == path
                and (entry["source_sha256"] is None or SHA.fullmatch(str(entry["source_sha256"]))),
                "invalid_harness_receipt", "抽取 Harness 来源条目无效")
    require(harness.get("sha256") == sha(js_json(files)) and harness.get("skill_path") == extractor["skill_path"]
            and harness.get("skill_sha256") == files[1]["source_sha256"] == extractor["skill_sha256"],
            "harness_hash_mismatch", "抽取 Harness 清单或 Skill 摘要不一致")


def validate_provenance(provenance, row, origin=False):
    require(isinstance(provenance, dict), "invalid_provenance", "缺少标签来源")
    meta, semantics = row["_meta"], row["task"]["semantics"]
    extractor = meta["extractor"]
    kind = provenance.get("kind")
    if kind == "model_suggestion":
        valid = (origin or semantics == "recommended_decision") and provenance.get("session_id") == extractor["session_id"]
        valid = valid and provenance.get("model") == extractor["model"] and provenance.get("skill_sha256") == extractor["skill_sha256"]
        require(valid and provenance.get("calibration") == "uncalibrated", "provenance_mismatch", "模型建议来源与实际抽取回执不一致")
    elif kind == "observed_action":
        require((origin or semantics == "observed_action") and provenance.get("run_id") == meta["run_id"]
                and provenance.get("decision_id") == meta["decision_id"] and provenance.get("trace_sha256") == meta["trace_sha256"]
                and provenance.get("ref") == meta["cutoff"], "provenance_mismatch", "观察动作来源与决策锚点不一致")
    elif kind in {"human_annotation", "ai_annotation"}:
        require(timestamp(provenance.get("annotated_at")), "invalid_provenance", "标注时间无效")
        if kind == "ai_annotation":
            validate_ai_actor(provenance)
        if "origin" in provenance:
            validate_provenance(provenance["origin"], row, True)
    else:
        raise BridgeError("unsupported_provenance", "平台当前不支持此标签来源；不得自动升级教师或旧标签")


def validate_ai_actor(value):
    model = value.get("model")
    require(text(value.get("session_id")) and isinstance(model, dict) and text(model.get("provider"))
            and text(model.get("model")) and value.get("purpose") == "functional_validation",
            "invalid_ai_review", "AI 委托身份必须包含真实 Session、模型和功能验证用途")


def validate_review_input(evidence, review, row):
    bindings = {"session_id": review["session_id"], "dataset_id": row["_meta"].get("dataset_id"),
                "record_id": row["_meta"]["id"], "run_id": row["_meta"]["run_id"],
                "path": row["_meta"]["trace_path"], "trace_sha256": row["_meta"]["trace_sha256"],
                "source_bundle_sha256": row["_meta"].get("source_bundle_sha256"),
                "state_sha256": sha(js_json(row["state"]))}
    required = {"schema_version", *bindings, "read_method", "receipt_refs"}
    require(isinstance(evidence, dict) and required <= set(evidence)
            and set(evidence) <= required | {"content_sha256", "source_identity_sha256"}
            and type(evidence.get("schema_version")) is int and evidence["schema_version"] == 1
            and evidence.get("read_method") in {"datasets/read", "datasets/source", "datasets/source-fragments"},
            "invalid_review_input", "AI 复核缺少完整决策输入阅读证据")
    require(all(text(value) and value == value.strip() and evidence[key] == value for key, value in bindings.items()),
            "review_input_mismatch", "AI 阅读证据与复核会话、批次或固定决策输入不一致")
    for key in ["trace_sha256", "source_bundle_sha256", "state_sha256", "content_sha256", "source_identity_sha256"]:
        if key in bindings or key in evidence or evidence["read_method"] == "datasets/source-fragments":
            require(SHA.fullmatch(str(evidence.get(key, ""))), "invalid_review_input", "AI 阅读证据摘要无效")
    refs = evidence.get("receipt_refs")
    require(isinstance(refs, list) and refs, "invalid_review_input", "AI 阅读证据缺少实际工具定位")
    calls, results = set(), set()
    for ref in refs:
        require(isinstance(ref, dict) and set(ref) == {"call_id", "call_seq", "result_seq"}
                and text(ref["call_id"]) and type(ref["call_seq"]) is int and type(ref["result_seq"]) is int
                and 0 <= ref["call_seq"] < ref["result_seq"] <= 9007199254740991
                and ref["call_id"] not in calls and ref["result_seq"] not in results,
                "invalid_review_input", "AI 阅读工具回执定位无效或重复")
        calls.add(ref["call_id"]); results.add(ref["result_seq"])


def validate_review(target, row=None):
    review = target.get("review")
    if review is None:
        return  # 旧版人工复核没有 review 字段，不改写历史来源。
    require(isinstance(review, dict) and {"kind", "session_id", "model", "reviewed_at", "purpose"} <= set(review)
            and set(review) <= {"kind", "session_id", "model", "reviewed_at", "purpose", "input_evidence"}
            and review.get("kind") == "ai_delegated" and timestamp(review.get("reviewed_at"))
            and review["reviewed_at"] == target.get("reviewed_at"), "invalid_ai_review", "AI 委托复核记录无效或时间不一致")
    validate_ai_actor(review)
    require(row is not None, "invalid_review_input", "AI 阅读证据需要当前完整导出行")
    validate_review_input(review.get("input_evidence"), review, row)


def validate_question(name, question, target, row):
    require(isinstance(name, str) and QUESTION.fullmatch(name) and name not in {"__proto__", "prototype", "constructor"},
            "invalid_question", "问题名称无效")
    require(isinstance(question, dict) and set(question) <= {"type", "instructions", "criteria"},
            "input_target_leakage", "平台输入题目含监督或不支持的字段")
    require(text(question.get("instructions")), "invalid_question", "题目说明不能为空")
    kind, criteria = question.get("type"), question.get("criteria")
    if kind == "choice":
        require(isinstance(criteria, dict) and 2 <= len(criteria) <= 32 and all(text(key) and text(value) for key, value in criteria.items())
                and len(set(criteria.values())) == len(criteria) and not set(criteria) & {"__proto__", "prototype", "constructor"},
                "invalid_criteria", "choice 需要 2–32 个名称、说明不同且有效的选项")
        keys = list(criteria)
    elif kind == "noul":
        require(criteria is None or isinstance(criteria, dict) and set(criteria) == {"false", "true"}
                and all(text(value) for value in criteria.values()), "invalid_criteria", "noul 只允许 false/true 说明")
        keys = ["false", "true"]
    elif kind == "score":
        require(isinstance(criteria, list) and 2 <= len(criteria) <= 32 and all(text(value) for value in criteria)
                and len(set(criteria)) == len(criteria), "invalid_criteria", "score 需要 2–32 个不同的有序等级")
        keys = [str(index) for index in range(len(criteria))]
    else:
        raise BridgeError("unsupported_question_type", "仅支持平台及 Kev 共同支持的 choice、noul、score")
    require(isinstance(target, dict) and set(target) <= {"label", "probabilities", "provenance", "basis", "status", "decision_time_reviewed", "reviewed_at", "review"},
            "invalid_target", "监督字段无效")
    require(target.get("status") == "reviewed" and target.get("decision_time_reviewed") is True and timestamp(target.get("reviewed_at")),
            "unreviewed_target", "每题必须已复核并完成决策时点核对")
    validate_review(target, row)
    require(text(target.get("basis")), "invalid_target", "缺少标签依据")
    label = target.get("label")
    valid = isinstance(label, str) and label in keys if kind == "choice" else type(label) is bool if kind == "noul" else type(label) is int and 0 <= label < len(keys)
    require(valid, "invalid_label", "标签与题型或候选键不一致")
    validate_provenance(target.get("provenance"), row)
    probabilities = target.get("probabilities")
    if "probabilities" in target:
        require(isinstance(probabilities, dict) and set(probabilities) == set(keys), "invalid_probabilities", "软标签必须覆盖全部候选")
        values = list(probabilities.values())
        require(all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in values)
                and abs(sum(values) - 1) <= 1e-5, "invalid_probabilities", "软标签概率必须有限、非负并归一")
        key = str(label).lower() if kind == "noul" else str(label)
        require(probabilities[key] >= max(values) - 1e-9, "invalid_label", "label 必须属于最大概率候选")
    if row["task"]["semantics"] == "observed_action":
        require(kind == "choice" and label == row["_meta"]["observed_action"].get("name") and probabilities is None,
                "observed_action_mismatch", "观察动作只能保留真实动作名的 choice 硬标签")


def validate_row(row, partition):
    require(isinstance(row, dict) and set(row) == {"schema_version", "state", "workflow", "task", "questions", "targets", "_meta"}
            and row["schema_version"] == 2, "invalid_platform_row", "需要完整的平台 v2 导出行")
    state = row["state"]
    require(isinstance(state, dict) and set(state) == {"messages", "available_tools"} and isinstance(state["messages"], list)
            and bool(state["messages"]), "input_target_leakage", "state 只允许平台的决策前 messages 和 available_tools")
    for message in state["messages"]:
        require(isinstance(message, dict) and {"role", "content"} <= set(message)
                and set(message) <= {"role", "content", "name", "tool_call_id", "tool_calls", "source"} and text(message["role"]),
                "input_target_leakage", "消息外壳含监督、后果或不支持的字段")
        if "source" in message:
            source = message["source"]
            require(isinstance(source, dict) and text(source.get("kind"))
                    and not set(source) & {"replayState", "label", "targets", "basis", "probabilities", "provenance", "review", "outcome_refs"},
                    "input_target_leakage", "消息来源必须保留实际 kind，不包含模型内部状态或监督字段")
    require(text(row["workflow"]) and isinstance(row["task"], dict) and set(row["task"]) == {"id", "semantics"}
            and text(row["task"]["id"]) and row["task"]["semantics"] in {"recommended_decision", "observed_action"},
            "invalid_task", "业务流程、任务身份或监督语义无效")
    questions, targets, meta = row["questions"], row["targets"], row["_meta"]
    require(isinstance(questions, dict) and 1 <= len(questions) <= 32 and isinstance(targets, dict) and set(questions) == set(targets),
            "question_target_mismatch", "输入题目与监督题目必须精确对应")
    require(isinstance(meta, dict) and RECORD.fullmatch(str(meta.get("id", ""))) and RUN.fullmatch(str(meta.get("run_id", ""))),
            "invalid_source_identity", "缺少合法记录 ID 或 Run ID")
    require(meta.get("split") == partition, "split_mismatch", "只能保留平台显式用途，不能把 unassigned 或其他用途改入此分区")
    require(meta.get("variant") == "clean" and meta.get("source") == "dsh_run", "invalid_source_identity", "不是平台 clean DSH Run 样本")
    for key in ("content_sha256", "source_record_content_sha256", "trace_sha256"):
        require(SHA.fullmatch(str(meta.get(key, ""))), "invalid_source_hash", "缺少导出投影或来源摘要")
    require(meta["content_sha256"] == content_hash(row), "content_hash_mismatch", "导出投影摘要与输入、题目或语义不一致")
    require(text(meta.get("decision_id")) and text(meta.get("trace_path")) and meta["context_mode"] in {"actual_request", "reconstructed"},
            "invalid_source_identity", "缺少决策来源或上下文不可用")
    cutoff = meta.get("cutoff")
    require(isinstance(cutoff, dict) and cutoff.get("path") == meta["trace_path"] and cutoff.get("source_sha256") == meta["trace_sha256"]
            and type(cutoff.get("line")) is int and cutoff["line"] >= 1 and SHA.fullmatch(str(cutoff.get("line_sha256", "")))
            and (cutoff.get("seq") is None or type(cutoff["seq"]) is int), "invalid_cutoff", "决策锚点与轨迹来源不一致")
    require(cutoff.get("session_log") is None or text(cutoff["session_log"]), "invalid_cutoff", "Session 定位无效")
    refs = meta.get("evidence_refs")
    require(isinstance(refs, list) and refs, "invalid_visible_evidence", "决策前证据定位不能为空")
    for ref in refs:
        require(isinstance(ref, dict) and ref.get("path") == meta["trace_path"] and ref.get("source_sha256") == meta["trace_sha256"]
                and SHA.fullmatch(str(ref.get("line_sha256", ""))) and ref.get("session_log") == cutoff.get("session_log")
                and type(ref.get("line")) is int and 1 <= ref["line"] < cutoff["line"]
                and (ref.get("seq") is None or type(ref["seq"]) is int and (cutoff.get("seq") is None or ref["seq"] < cutoff["seq"])),
                "future_visible_evidence", "输入证据不在同一固定来源的决策之前")
    require(isinstance(meta.get("observed_action"), dict) and text(meta["observed_action"].get("name"))
            and isinstance(meta.get("outcome_refs"), list) and isinstance(meta.get("limitations"), list),
            "invalid_source_identity", "观察动作及来源限制不完整")
    require(text(meta.get("group_id")) and meta.get("source_group_id") == source_group(row), "source_group_mismatch", "固定来源组与任务输入不一致")
    history = meta.get("group_history")
    require(isinstance(history, list) and all(text(item) for item in history)
            and meta["group_id"] in history and meta["source_group_id"] in history, "invalid_group_history", "不能丢弃原来源组或人工关联组")
    validate_extractor(meta.get("extractor"))
    for name in questions:
        validate_question(name, questions[name], targets[name], row)


def receipt_rows(wrapper, entry, partition):
    require(isinstance(wrapper, dict) and set(wrapper) == {"dataset_id", "read_sha256", "mode", "export"},
            "invalid_receipt", "需要带原批次 ID、回读摘要和模式的完整导出回执")
    require(wrapper["dataset_id"] == entry["dataset_id"] and wrapper["read_sha256"] == entry["read_sha256"],
            "receipt_identity_mismatch", "回执批次身份或回读摘要与 manifest 不一致")
    mode = MODES[partition]
    require(wrapper["mode"] == mode, "mode_mismatch", "导出模式与显式分区不一致")
    export = wrapper["export"]
    require(isinstance(export, dict) and export.get("schema_version") == 2 and export.get("blocked") == []
            and export.get("filename") == f"{entry['dataset_id']}-reviewed-{mode}.jsonl",
            "blocked_export", "必须保存无阻断的平台 v2 合格导出回执，不能使用候选下载")
    require(text(export.get("content")), "empty_export", "导出内容为空")
    rows = [strict_json(line) for line in export["content"].splitlines() if line.strip()]
    require(rows and type(export.get("count")) is int and export["count"] == len(rows), "export_count_mismatch", "导出行数不一致或为空")
    eligibility = export.get("eligibility", {})
    require(isinstance(eligibility, dict) and eligibility.get("blocked") == [] and isinstance(eligibility.get("records"), list)
            and isinstance(eligibility.get("counts"), dict) and eligibility["counts"].get(mode) == len(rows),
            "invalid_eligibility", "缺少无阻断的服务器导出资格回执")
    eligible = {}
    for item in eligibility["records"]:
        require(isinstance(item, dict) and text(item.get("record_id")) and item["record_id"] not in eligible,
                "invalid_eligibility", "资格回执存在重复或缺失记录身份")
        eligible[item["record_id"]] = item
    for row in rows:
        validate_row(row, partition)
        require(row["_meta"].get("dataset_id", wrapper["dataset_id"]) == wrapper["dataset_id"],
                "receipt_identity_mismatch", "导出行批次身份与回执不一致")
        item = eligible.get(row["_meta"]["id"], {})
        require(item.get("legacy") is False and item.get("reasons") == [] and mode in item.get("export_modes", [])
                and isinstance(item.get("eligible_questions"), list) and len(item["eligible_questions"]) == len(row["questions"])
                and set(item["eligible_questions"]) == set(row["questions"])
                and all(item.get("question_reasons", {}).get(name) == [] for name in row["questions"]),
                "eligibility_mismatch", "导出题目与服务器合格题清单不一致")
    mode_ids = {item["record_id"] for item in eligibility["records"] if mode in item.get("export_modes", [])}
    require(mode_ids == {row["_meta"]["id"] for row in rows}, "eligibility_mismatch", "导出行与该用途的合格记录清单不一致")
    signatures = {canonical([row["_meta"][key] for key in ("run_id", "trace_path", "trace_sha256", "extractor")]) for row in rows}
    require(len(signatures) == 1, "mixed_source_receipt", "同一批次导出不能混入其他 Run、轨迹或抽取来源")
    require(export.get("question_count") == sum(len(row["questions"]) for row in rows)
            and type(export.get("omitted_question_count")) is int and export["omitted_question_count"] >= 0,
            "export_count_mismatch", "导出题目数或省略数无效")
    return rows


def group_tokens(row):
    meta = row["_meta"]
    tokens = {"group:" + value for value in [meta["group_id"], meta["source_group_id"], *meta["group_history"]]}
    tokens.add("run:" + meta["run_id"])
    session = meta["cutoff"].get("session_log")
    if session:
        tokens.add("session:" + session)
    if text(meta.get("session_id")):
        tokens.add("session:" + meta["session_id"])
    tokens.add("state-task:" + sha(canonical(normalize([row["state"], row["task"]]))))
    questions = sorted((normalize(question) for question in row["questions"].values()), key=canonical)
    tokens.add("model-input:" + sha(canonical(normalize([row["state"], questions]))))
    tokens.add("native-state:" + _native_input.state_key(row["state"]))
    tokens.update("native-question:" + _native_input.question_key(row["state"], question)
                  for question in row["questions"].values())
    return sorted(tokens)


def connected_groups(items):
    parents = list(range(len(items)))
    def find(index):
        while index != parents[index]:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    seen = {}
    for index, item in enumerate(items):
        for token in group_tokens(item["row"]):
            if token in seen:
                parents[find(index)] = find(seen[token])
            else:
                seen[token] = index
    groups = defaultdict(list)
    for index, item in enumerate(items):
        groups[find(index)].append(item)
    result = []
    for members in groups.values():
        ids = sorted(item["row"]["_meta"]["id"] for item in members)
        result.append({"id": "platform-component/" + sha(canonical(ids)), "members": members})
    return sorted(result, key=lambda item: item["id"])


def native_record(row, receipt, group_id):
    questions = {}
    for name, question in row["questions"].items():
        target = row["targets"][name]
        questions[name] = {**deepcopy(question), "label": target["label"], "src": "platform_dsh_" + question["type"]}
        if "probabilities" in target:
            questions[name]["target"] = deepcopy(target["probabilities"])
    meta = deepcopy(row["_meta"])
    # KEV benchmark/calibrate 用 _meta.group_id 分折；关联闭包必须成为原生分组。
    # 平台原 ID 留在来源命名空间，原回执、source_group_id 与 group_history 均不改。
    meta.update(variant="clean", group_id=group_id, bridge_group_id=group_id, platform={
        "original_group_id": row["_meta"]["group_id"],
        "workflow": row["workflow"], "task": deepcopy(row["task"]), "targets": deepcopy(row["targets"]),
        "export_receipt": deepcopy(receipt),
    })
    return {"state": deepcopy(row["state"]), "questions": questions, "_meta": meta}


def validate_rendered_targets(items):
    """Single-answer reviewed targets must not disagree on an identical task."""
    seen = {}
    for item in items:
        row = item["row"]
        for qid, question in row["questions"].items():
            key = _native_input.question_key(row["state"], question)
            target = row["targets"][qid]["label"]
            previous = seen.get(key)
            require(previous is None or type(previous[0]) is type(target) and previous[0] == target,
                    "conflicting_reviewed_labels", "相同的模型输入有互相矛盾的复核标签。请核对这道题的答案后重新导出。")
            seen[key] = (target, row["_meta"]["id"], qid)


def convert(manifest_path, output):
    """返回报告。阻断不输出 JSONL；不读取任何未声明的来源或服务。"""
    manifest_path, output = Path(manifest_path).resolve(), Path(output).resolve()
    require(not output.exists() or output.is_dir() and not any(output.iterdir()), "output_not_empty", "输出目录必须不存在或为空")
    output.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": "kev-platform-bridge-report/v1", "status": "blocked", "blocked": True, "ok": False,
              "source_format": "platform-decision-dataset-v2", "current_source_validation": "not_performed_offline",
              "limitations": LIMITS, "errors": [], "receipts": [], "mappings": [], "files": {}}
    try:
        manifest_bytes = manifest_path.read_bytes()
        report["input_manifest_sha256"] = sha(manifest_bytes)
        manifest = strict_json(manifest_bytes)
        require(isinstance(manifest, dict) and set(manifest) == {"schema_version", "partitions"} and manifest["schema_version"] == SCHEMA
                and isinstance(manifest["partitions"], dict) and set(manifest["partitions"]) == set(PARTITIONS),
                "invalid_manifest", "manifest 必须显式包含 train/development/calibration/test 四个用途")
        items, sources, seen_ids, seen_files = [], [], set(), set()
        for partition in PARTITIONS:
            entries = manifest["partitions"][partition]
            require(isinstance(entries, list) and entries, "empty_partition", "四个用途都必须有非空导出文件列表")
            for entry in entries:
                require(isinstance(entry, dict) and set(entry) == {"path", "sha256", "dataset_id", "read_sha256"}
                        and text(entry["path"]) and SHA.fullmatch(str(entry["sha256"])) and SHA.fullmatch(str(entry["read_sha256"]))
                        and DATASET.fullmatch(str(entry["dataset_id"])), "invalid_manifest_entry", "导出文件身份和摘要必须完整")
                path = (manifest_path.parent / entry["path"]).resolve()
                require(path not in seen_files, "duplicate_receipt", "同一回执文件不得重复使用")
                seen_files.add(path)
                raw = path.read_bytes()
                require(sha(raw) == entry["sha256"], "file_hash_mismatch", "导出文件摘要与 manifest 不一致")
                wrapper = strict_json(raw)
                rows = receipt_rows(wrapper, entry, partition)
                receipt = {**entry, "partition": partition, "mode": MODES[partition], "content_sha256": sha(wrapper["export"]["content"]),
                           "records": len(rows), "questions": wrapper["export"]["question_count"]}
                report["receipts"].append(receipt)
                sources.append((path, entry["sha256"]))
                for number, row in enumerate(rows, 1):
                    identity = row["_meta"]["id"]
                    require(identity not in seen_ids, "duplicate_record_id", "记录 ID 重复；不能复制记录充当独立样本")
                    seen_ids.add(identity)
                    items.append({"partition": partition, "row": row, "receipt": receipt, "source_line": number})
        groups = connected_groups(items)
        for group in groups:
            partitions = sorted({item["partition"] for item in group["members"]})
            require(len(partitions) == 1, "cross_partition_group", "同源、Run、Session、历史关联组或相同输入的传递关联跨越用途：" + ", ".join(partitions))
        validate_rendered_targets(items)
        native = {name: [] for name in PARTITIONS}
        group_members, group_partition = {}, {}
        for group in groups:
            group_members[group["id"]] = sorted(item["row"]["_meta"]["id"] for item in group["members"])
            group_partition[group["id"]] = group["members"][0]["partition"]
            for item in group["members"]:
                item["group"] = group["id"]
        for item in items:
            partition, row, receipt = item["partition"], item["row"], item["receipt"]
            native[partition].append(native_record(row, receipt, item["group"]))
            report["mappings"].append({"partition": partition, "output_file": partition + ".jsonl", "output_line": len(native[partition]),
                "record_id": row["_meta"]["id"], "questions": list(row["questions"]), "source_line": item["source_line"],
                "dataset_id": receipt["dataset_id"], "read_sha256": receipt["read_sha256"], "receipt_sha256": receipt["sha256"],
                "content_sha256": row["_meta"]["content_sha256"], "source_record_content_sha256": row["_meta"]["source_record_content_sha256"],
                "original_group_id": row["_meta"]["group_id"], "source_group_id": row["_meta"]["source_group_id"],
                "bridge_group_id": item["group"]})
        payloads = {name: ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) for row in native[name]) + "\n").encode("utf-8") for name in PARTITIONS}
        files = {name: {"path": name + ".jsonl", "sha256": sha(payloads[name]), "records": len(native[name]),
                        "questions": sum(len(row["questions"]) for row in native[name])} for name in PARTITIONS}
        require(sha(manifest_path.read_bytes()) == report["input_manifest_sha256"] and all(sha(path.read_bytes()) == digest for path, digest in sources),
                "source_changed_during_read", "核对期间输入发生变化，未输出训练文件")
        split_manifest = {"schema_version": "kev-platform-split-manifest/v1", "source_format": report["source_format"],
            "status": "ready", "blocked": False, "blocked_reasons": [], "allocation": "preserved_platform_splits",
            "input_manifest_sha256": report["input_manifest_sha256"], "input_records": len(items), "independent_groups": len(groups),
            "partition_records": {name: files[name]["records"] for name in PARTITIONS},
            "partition_groups": {name: sum(value == name for value in group_partition.values()) for name in PARTITIONS},
            "group_members": group_members, "group_partition": group_partition, "files": files,
            "source_receipts": report["receipts"], "limitations": LIMITS}
        for name in PARTITIONS:
            (output / files[name]["path"]).write_bytes(payloads[name])
        (output / "split-manifest.json").write_text(json.dumps(split_manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        report.update(status="ready", blocked=False, ok=True, records=len(items), independent_groups=len(groups), files=files)
    except (BridgeError, OSError, ValueError, TypeError, KeyError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        report["errors"].append({"code": getattr(exc, "code", "io_error" if isinstance(exc, OSError) else "invalid_input"), "message": str(exc)})
        # 输出目录最初为空；只清理本命令可能写出的固定派生文件，保留全部输入。
        for name in [*(partition + ".jsonl" for partition in PARTITIONS), "split-manifest.json"]:
            try:
                (output / name).unlink(missing_ok=True)
            except OSError as cleanup_error:
                report["errors"].append({"code":"partial_output_cleanup_failed", "message":str(cleanup_error)})
        report["files"] = {}
    (output / "platform-bridge-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    presentation = human_result(report)
    try:
        write_report(output, "platform-bridge", **presentation)
    except OSError as exc:
        raise BridgeError("report_write_failed", "机器报告已保存，但可读报告写入失败：" + str(exc)) from exc
    return report


def human_result(report):
    """Present only checked counts; ready describes conversion, never training."""
    blocked = report["blocked"]
    reasons = [error["code"] for error in report["errors"]]
    artifacts = [("平台转换检查明细", "platform-bridge-report.json")]
    if blocked:
        summary = [f'转换未通过。已读取并逐份核对 {len(report["receipts"])} 份回执，尚未形成通过检查的四份用途数据。']
        if "partial_output_cleanup_failed" in reasons:
            summary.append('部分派生文件未能清理；这些残留文件不能作为转换通过的结果使用。')
        next_step = '按报告中的具体原因修正导出清单或重新获取完整回执，再使用新的空目录转换。'
    else:
        questions = sum(info["questions"] for info in report["files"].values())
        summary = [f'已核对 {len(report["receipts"])} 份平台导出回执，转换 {report["records"]} 条记录、{questions} 道题，形成 {report["independent_groups"]} 个关联来源组。',
                   '保留平台原用途：' + '；'.join(f'{label} {report["files"][name]["records"]} 条' for name,label in
                       [("train","训练"),("development","开发验证"),("calibration","校准"),("test","独立测试")]) + '。',
                   '本次只完成离线核对与格式转换；编码长度尚未检查，训练尚未执行。']
        artifacts.extend([(label, name + ".jsonl") for name,label in
            [("train","训练数据"),("development","开发验证数据"),("calibration","校准数据"),("test","独立测试数据")]])
        artifacts.append(("保留用途的分区清单", "split-manifest.json"))
        next_step = '复核来源覆盖与输入可答性后，交接 kev-training：先生成训练方案，再按方案使用目标分词器检查编码长度。'
    return {
        "status": "blocked" if blocked else "requires_review", "summary": summary,
        "reason_codes": reasons, "next_step": next_step, "artifacts": artifacts,
        "limitations": [
            '只核对本地留存回执与摘要；未回读平台或原始来源，当前服务器是否仍认可导出尚未确认。',
            '保留实际复核方式；AI 委托复核仅用于功能验证，不等同人工或独立真值；模型建议及未校准等原始状态保持原样。',
            '自然语言中的泄漏、业务覆盖、编码长度、训练、部署及业务收益均未验证。',
        ],
        "diagnostics": [f'{error["code"]}: {error["message"]}' for error in report["errors"]],
    }


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        if '--json' in sys.argv[1:]:
            print(json.dumps({"status":"blocked", "blocked":True,
                "errors":[{"code":"invalid_arguments", "message":message}]}, ensure_ascii=False))
        else:
            print('当前不能继续：命令参数有误（invalid_arguments）。', file=sys.stderr)
            print('参数诊断：' + message, file=sys.stderr)
        raise SystemExit(2)


def main(argv=None):
    parser = ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--json", action="store_true", help="向标准输出返回机器 JSON；仍保存 report.md")
    args = parser.parse_args(argv)
    try:
        report = convert(args.manifest, args.out)
    except (BridgeError, OSError, ValueError, TypeError, KeyError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        code = getattr(exc, "code", "io_error" if isinstance(exc,OSError) else "invalid_input")
        payload = {"status": "blocked", "blocked": True, "errors": [{"code": code, "message": str(exc)}]}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print_summary("platform-bridge", "blocked", '本次操作未完成。未保存新的可读报告。', [code],
                '检查输出位置和原始诊断，再使用新的空目录重试。', diagnostics=[f'{type(exc).__name__}: {exc}'])
        return 1
    if args.json:
        print(json.dumps({"status": report["status"], "blocked": report["blocked"], "report": str(args.out / "platform-bridge-report.json"), "errors": report["errors"]}, ensure_ascii=False))
    else:
        presentation = human_result(report)
        print_summary("platform-bridge", presentation["status"], presentation["summary"], presentation["reason_codes"],
                      presentation["next_step"], args.out / "report.md")
    return 1 if report["blocked"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""面向人的中文回执；机器报告和训练数据仍是各自的事实源。

本模块只呈现调用者已经核对的事实，不推断训练完成或补造数量。
write_report 不打印，print_summary 不写文件，emit_result 将二者组合。
路径按本地文件名呈现，不伪装为平台链接。
"""
from __future__ import annotations

import json
from pathlib import Path
import re


STAGES = {
    "audit": "轨迹检查", "discover": "决策点发现", "extract": "样本抽取",
    "annotate": "标签更新", "compile": "数据编译", "split": "数据分区",
    "audit-dataset": "数据集检查", "platform-bridge": "平台数据转换",
    "prepare": "训练准备", "training-plan": "训练准备",
    "prepare-training": "训练准备", "training-commands": "训练命令检查",
    "check-encoding": "编码检查", "encoding": "编码检查",
    "encoding-review": "编码检查", "legacy-import": "旧数据导入",
}
STATUSES = {
    "completed": "完成当前检查", "requires_review": "还需复核",
    "blocked": "当前不能继续", "ready": "还需复核", "ok": "完成当前检查",
    "failed": "当前不能继续", "partial": "还需复核",
}
REASONS = {
    "invalid_input": "输入内容或结构不符合要求，请按诊断位置修正。",
    "io_error": "文件读写失败，请检查路径、文件状态和读写权限。",
    "invalid_arguments": "命令参数不完整或无效，请按用法修正。",
    "output_not_empty": "输出位置已有内容，请使用新的空目录，保留已有结果。",
    "output_conflicts_with_input": "输出位置与输入冲突，请另选目录。",
    "report_write_failed": "可读报告未能保存，请检查输出目录的写入权限。",
    "trace_audit_errors": "轨迹检查发现结构错误，相关样本不能进入后续阶段。",
    "no_decision_boundaries": "未识别到可重建的模型决策时点，请核对轨迹类型和完整性。",
    "decision_contract_review_required": "发现的是决策候选，需核对实际触发条件、可见输入和候选范围。",
    "runtime_contract_review_required": "运行时的输入与候选合同尚未核实。",
    "no_decision_candidates": "未发现符合当前抽取规则的决策候选。",
    "no_usable_samples": "没有可用样本，无法继续标注或编译。",
    "blocked_decision_prefixes": "部分决策之前的上下文不满足抽取要求；已保留其他可抽取样本。",
    "label_review_required": "标签仍需独立依据与人员复核，历史动作不能自动作为正确答案。",
    "label_semantics_not_verified": "只检查了标注结构和证据引用，标签在业务上是否正确仍需复核。",
    "no_default_export_eligible_labels": "当前没有满足默认导出要求的样本，请核对标签及样本检查结果。",
    "no_compiled_records": "没有记录通过编译，隔离记录需要修正后重新编译。",
    "no_dataset_records": "数据集没有可供检查的记录。",
    "no_records": "输入没有记录，无法分区。",
    "insufficient_independent_groups": "独立来源组少于 4 个，无法形成四份独立数据。",
    "cannot_populate_all_nonzero_partitions": "独立来源组不足以填充所有指定用途。",
    "insufficient_gold_groups_for_heldout_partitions": "可用于独立评估的复核来源组不足。",
    "train_only_group_without_train_partition": "存在仅限训练的来源组，但没有为训练分配份额。",
    "invalid_fractions": "四个分区比例必须为有限非负数，并且总和等于 1。",
    "invalid_seed": "分区随机种子必须为整数。",
    "missing_label_coverage": "部分分区缺少已有类别，当前评估不能代表这些缺失类别。",
    "cross_partition_overlap": "同源或相同输入出现在不同分区，独立评估会受到污染。",
    "cross_partition_group": "平台来源关联组跨越多个用途，不能保留为独立评估数据。",
    "conflicting_verified_labels": "相同输入存在互相矛盾的已复核标签，需重新裁决。",
    "conflicting_reviewed_labels": "同一问题存在互相矛盾的复核标签，请核对答案后重新导出。",
    "conflicting_input_labels": "相同输入的弱标签与其他标签不一致，需核对监督来源。",
    "token_budget_not_checked": "尚未使用目标模型的分词器检查长度。",
    "runtime_equivalence_not_evaluated": "尚未验证替换后的完整业务流程是否等效。",
    "encoding_not_run": "尚未执行目标模型的实际编码与长度检查。",
    "executor_not_started": "训练执行器尚未启动；当前只完成准备与检查。",
    "legacy_snapshot_changed": "原始数据、复核记录或分区清单已变化，旧训练方案不能继续使用；请重新构建并检查。",
    "legacy_snapshot_unavailable": "无法读取已检查的原始数据或复核记录，请恢复完整数据目录后重试。",
    "invalid_legacy_audit_identity": "训练方案缺少旧数据及复核记录的检查依据，请重新准备训练方案。",
    "encoding_legacy_review_identity_mismatch": "编码报告对应的复核记录与当前训练方案不一致，请重新检查。",
    "trace_integrity": "决策之前的轨迹结构不完整，无法可靠重建输入。",
    "missing_actual_user_message": "未找到真实用户请求；运行上下文不能替代用户任务。",
    "profile_not_applicable_to_prefix": "当前抽取规则不适用于这个决策之前的上下文。",
    "reserved_action_collision": "工具名称与保留动作名称冲突。",
    "reserved_skill_collision": "技能名称与保留候选名称冲突。",
    "missing_skill_catalog": "缺少决策当时可见的技能目录。",
    "unparsed_skill_catalog": "技能目录无法按当前规则解析。",
    "duplicate_template_binding": "巡检模板存在重复绑定，无法唯一确定候选。",
    "not_initial_routing_boundary": "该回复属于后续处理，不是初始路由决策，已按抽取范围跳过。",
    "missing_routing_boundary_evidence": "缺少初始路由时点的完整上下文证据，不能假定此前没有模型或工具活动。",
    "invalid_routing_boundary_evidence": "初始路由时点的上下文计数不完整或无效。",
    "inherited_context_not_verified": "继承或压缩上下文尚未核实，无法确定这是初始路由。",
    "latest_actual_user_not_visible": "最新真实用户请求未出现在当前可见上下文中。",
    "empty_user_request": "真实用户请求为空，无法形成路由样本。",
    "routing_projection_scope_exceeded": "可见消息数量或文本长度超出本次路由投影范围，未擅自截断内容。",
    "label_unlabeled": "样本尚未标注，未进入训练导出。",
    "label_ambiguous": "标签仍有歧义，未进入训练导出。",
    "label_invalid": "标签被标为无效，未进入训练导出。",
    "weak_label_not_enabled": "弱标签未获本次编译允许，当前已隔离。",
    "code_site_excluded": "确定性代码节点默认不进入模型训练数据。",
    "input_leakage": "模型输入包含保留的监督、审计或决策之后字段。",
    "native_input_hash_mismatch": "模型实际可见输入的内容或顺序与编译记录不一致；请从已复核原始样本重新编译和分组。",
    "input_target_leakage": "平台模型输入混入监督字段或不支持的字段。",
    "ambiguous_business_field": "输入含可能混淆的业务字段，需要说明其在决策之前的含义。",
    "hard_soft_disagreement": "硬标签与软标签的最高权重不一致，需要确认这是有意且已复核的差异。",
    "unused_target_semantics": "填写了软标签含义，但没有相应的软标签数据。",
    "future_visible_evidence": "输入引用了决策之后或无法确认属于决策之前的证据。",
    "non_gold_in_evaluation": "评估分区包含未满足复核要求或仅限训练的标签。",
    "unreviewed_target": "平台题目尚未完成标签与决策时点的人员复核。",
    "unsupported_provenance": "标签来源不受当前平台合同支持，不能自动升级旧标签或教师建议。",
    "observed_action_mismatch": "观察动作标签与实际动作不一致。",
    "blocked_export": "平台导出回执仍有未解决的阻塞项。",
    "empty_partition": "某个用途没有可用记录或非空导出文件，四份数据尚未齐备。",
    "missing_partition": "缺少要求的数据用途，需补齐训练、开发验证、校准和独立测试数据。",
    "partial_output_cleanup_failed": "部分派生文件清理失败，这些残留文件不能作为通过检查的数据使用。",
    "file_hash_mismatch": "导出文件与清单记录的摘要不一致，需重新核对来源。",
    "source_changed_during_read": "检查期间输入文件发生变化，请固定来源后重试。",
    "receipt_identity_mismatch": "导出回执的批次或回读身份与输入清单不一致。",
    "eligibility_mismatch": "回执中的合格题清单与实际导出内容不一致。",
    "invalid_eligibility": "回执缺少完整、合法的导出资格检查信息。",
    "export_count_mismatch": "导出回执声明的行数或题数与实际内容不一致。",
    "mixed_source_receipt": "同一回执混合了不一致的来源身份，请核对原始导出批次。",
    "split_mismatch": "记录用途与指定分区不一致，不能擅自改分区。",
    "mode_mismatch": "导出模式与指定用途不一致。",
    "duplicate_receipt": "同一导出回执被重复使用。",
    "duplicate_record_id": "记录 ID 重复，不能复制记录充当独立样本。",
    "duplicate_sample_id": "样本 ID 重复，需核对并去除重复来源。",
    "duplicate_json_key": "JSON 对象有重复字段，无法可靠解释其内容。",
    "nonfinite_number": "数据包含 NaN 或 Infinity，不能作为标准 JSON 使用。",
    "unsupported_number_precision": "数值超出可无损核对的范围。",
}


def _describe(codes, description):
    for code in codes.split():
        REASONS[code] = description


_describe("unsupported_session_version unsupported_event unsupported_content_shape unsupported_content_block unsupported_surface_operation",
          "轨迹包含当前适配器不支持的版本、事件或内容结构，请核对原始事件。")
_describe("invalid_seq seq_gap_or_reorder invalid_source_event_seqs assistant_source_refs_forbidden log_only_surface_metadata invalid_surface_replace",
          "轨迹事件的顺序、来源引用或投影操作不符合合同，需核对原始轨迹。")
_describe("invalid_request_header duplicate_or_invalid_tools missing_request_header selected_tool_not_in_header",
          "决策时可用工具清单缺失或不一致，无法可靠重建候选。")
_describe("invalid_or_duplicate_call call_without_model_selection call_differs_from_selection invalid_tool_arguments orphan_tool_result result_source_mismatch result_call_id_mismatch duplicate_tool_result invalid_selection_call_id duplicate_selection_call_id",
          "工具选择、调用参数或结果关联不一致，请按原始事件核对。")
_describe("lineage_requires_group_review", "轨迹具有父子或种子关系，需要把相关任务归入同一来源组。")
_describe("assistant_source_not_model", "该回复不是模型生成的决策，不能作为训练决策时点。")
_describe("missing_message", "轨迹缺少消息对象，无法重建上下文。")
_describe("ignored_extension_event", "扩展事件未参与重建，请核对它是否影响业务决策。")
_describe("missing_tool_result selection_not_executed unfinished_turn", "轨迹缺少工具结果、执行记录或轮次结束信息，需核对记录是否完整。")
_describe("skill_tool_unavailable inspection_catalog_tool_unavailable inspection_start_tool_unavailable inspection_query_tool_unavailable",
          "决策当时缺少当前抽取规则要求的业务工具。")
_describe("invalid_catalog_response invalid_template_record invalid_start_response invalid_result_response",
          "业务工具返回内容不满足抽取合同，需核对原始结果。")
_describe("invalid_routing_decision_seq missing_routing_request_header invalid_routing_surface invalid_routing_surface_node invalid_routing_prefix_evidence unsupported_routing_message_type unsupported_routing_context",
          "路由时点、决策前上下文或请求头不满足当前抽取合同，需核对完整轨迹。")
_describe("invalid_record wrong_ir_schema missing_ir_identity invalid_implementation invalid_state invalid_question invalid_instructions invalid_criteria invalid_candidate_id invalid_candidate_description unknown_question_fields unsupported_question_type",
          "记录的输入、题目、候选或格式身份不符合当前合同；具体字段见机器报告。")
_describe("non_json_type invalid_json_type cyclic_value non_string_json_key", "记录含不能用标准 JSON 表示的结构。")
_describe("invalid_provenance missing_provenance invalid_trace_sha256 invalid_decision_seq invalid_decision_line missing_visible_evidence invalid_evidence_ref invalid_contract_evidence contract_version_mismatch invalid_contract_sha256 unsupported_evidence_kind invalid_evidence_seq invalid_evidence_line cross_session_seq cross_trace_evidence",
          "来源或决策前证据引用缺失、不合法或不一致，需补齐可核对的来源。")
_describe("missing_label invalid_label_status invalid_hard_label missing_label_source missing_label_evidence missing_target_semantics invalid_soft_target unknown_target_key invalid_target_weight invalid_target_total invalid_target invalid_label invalid_probabilities",
          "标签值、来源、证据或软标签概率不符合要求，需按具体字段修正。")
_describe("invalid_compiled_records invalid_compiled_record invalid_compiled_questions invalid_question_id missing_question_source missing_compiled_metadata missing_compiled_identity invalid_metric_metadata unreviewed_compiled_label weak_not_train_only label_status_mismatch label_metadata_mismatch target_metadata_mismatch missing_audited_label input_hash_mismatch",
          "编译数据的内容或审计信息不完整、不一致，请回到原始样本修正后重新编译。")
_describe("invalid_partition partition_audit_failed post_split_audit_failed", "分区结构或分区后检查未通过，请查看对应检查报告。")
_describe("invalid_manifest invalid_manifest_entry invalid_receipt invalid_export empty_export count_mismatch question_count_mismatch",
          "平台导出清单、回执或数量不符合要求，需核对完整原始回执。")
_describe("invalid_extractor invalid_harness_receipt harness_hash_mismatch provenance_mismatch invalid_platform_row invalid_task question_target_mismatch invalid_source_identity invalid_source_hash content_hash_mismatch invalid_cutoff invalid_visible_evidence source_group_mismatch invalid_group_history",
          "平台记录的输入、抽取来源、决策锚点或关联组不一致，需核对原始来源。")


def paragraphs(value):
    """Accept one paragraph or a sequence; omit absent content, never invent it."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(item) for item in value if item is not None and str(item).strip()]


def reason_text(code):
    code = str(code)
    return REASONS.get(code, "该检查项尚未通过或需要复核；请按原始错误码核对机器报告中的具体诊断。")


def status_text(status):
    return STATUSES.get(status, "状态待确认（" + str(status) + "）")


def _artifact_rows(out, artifacts):
    entries = artifacts.items() if isinstance(artifacts, dict) else artifacts
    for title, value in entries:
        path = Path(value)
        path = path if path.is_absolute() else out / path
        if not path.is_file():
            continue
        try:
            display = str(path.resolve().relative_to(out.resolve()))
        except ValueError:
            display = str(path.resolve())
        yield str(title), display


def write_report(out, stage, status, summary, reason_codes=(), next_step=None,
                 artifacts=(), *, details=(), limitations=(), diagnostics=(), report_name='report.md'):
    """Write report.md and return its Path; leave all existing machine files alone.

    summary/details/limitations/diagnostics accept text or sequences of text.
    artifacts accepts [(purpose, path), ...] or {purpose: path}; only real files
    are listed. Output is a plain local-file reference, never an invented URL.
    The caller owns stage status, facts, and the decision to stop or proceed.
    """
    out = Path(out)
    lines = [f"# {STAGES.get(stage, stage)}", "", f"**{status_text(status)}**", ""]
    for paragraph in paragraphs(summary):
        lines.extend([paragraph, ""])
    for paragraph in paragraphs(details):
        lines.extend([paragraph, ""])
    reasons = list(dict.fromkeys(str(code) for code in reason_codes))
    if reasons:
        lines.extend(["## 需要处理的事项", ""])
        lines.extend(f"- {reason_text(code)}（`{code}`）" for code in reasons)
        lines.append("")
    limitations = paragraphs(limitations)
    if limitations:
        lines.extend(["## 本次尚未确认", ""])
        lines.extend(f"- {item}" for item in limitations)
        lines.append("")
    if next_step:
        lines.extend(["## 接下来", ""])
        lines.extend(["\n\n".join(paragraphs(next_step)), ""])
    rows = list(_artifact_rows(out, artifacts))
    if rows:
        lines.extend(["## 文件", ""])
        lines.extend(f"- {title}：`{path}`" for title, path in rows)
        lines.append("")
    diagnostics = paragraphs(diagnostics)
    if diagnostics:
        lines.extend(["## 排查明细", "", "以下保留原始诊断，便于定位字段、行号或文件错误。", ""])
        for diagnostic in diagnostics:
            fence = "`" * max(3, max((len(x) + 1 for x in re.findall(r"`+", diagnostic)), default=0))
            lines.extend([fence + "text", diagnostic, fence, ""])
    path = out / report_name
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def print_summary(stage, status, summary, reason_codes=(), next_step=None,
                  report_path=None, *, diagnostics=()):
    """Print a short receipt; complete reasons and raw diagnostics stay in files."""
    print(f"{STAGES.get(stage, stage)}：{status_text(status)}。")
    for paragraph in paragraphs(summary):
        print(paragraph)
    codes = list(dict.fromkeys(str(code) for code in reason_codes))
    for code in codes[:3]:
        print(f"- {reason_text(code)}（{code}）")
    if len(codes) > 3:
        print(f"另有 {len(codes) - 3} 项检查信息，见报告。")
    if next_step:
        print("接下来：" + " ".join(paragraphs(next_step)))
    if report_path is not None and Path(report_path).is_file():
        print("可读报告：" + str(report_path))
    else:
        for diagnostic in paragraphs(diagnostics):
            print("原始诊断：" + diagnostic)


def emit_result(out, stage, status, summary, reason_codes=(), next_step=None,
                artifacts=(), *, json_output=False, machine_result=None,
                details=(), limitations=(), diagnostics=(), report_name='report.md'):
    """Save a readable report and emit either Chinese text or explicit JSON."""
    path = write_report(out, stage, status, summary, reason_codes, next_step,
                        artifacts, details=details, limitations=limitations,
                        diagnostics=diagnostics, report_name=report_name)
    if json_output:
        value = machine_result if machine_result is not None else {
            "stage": stage, "status": status, "reason_codes": list(reason_codes),
        }
        print(json.dumps(value, ensure_ascii=False, allow_nan=False))
    else:
        print_summary(stage, status, summary, reason_codes, next_step, path)
    return path

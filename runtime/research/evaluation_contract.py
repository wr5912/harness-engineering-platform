#!/usr/bin/env python3
"""解析 evaluation.md 中按阅读顺序排列的业务 Case。"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


CASE_RE = re.compile(r"^#### (U-[A-Z0-9-]+)[ \t]+([^\n]+)$", re.MULTILINE)
CASE_LIKE_RE = re.compile(r"^#### ([A-Z]-[A-Z0-9-]+)\s+", re.MULTILINE)
LABEL_RE = re.compile(r"^\*\*(用户输入(?: ([1-9][0-9]*))?|预期)\*\*[ \t]*$", re.MULTILINE)
BOLD_LABEL_RE = re.compile(r"^\*\*[^*\n]+\*\*[ \t]*$", re.MULTILINE)
SCENE_RE = re.compile(r"^## ([^\n]+)$", re.MULTILINE)
FAST_MARKER = "**评估档位：** `fast`"


def _structure(text: str) -> str:
    """遮蔽围栏代码，保持原偏移；示例中的标题和字段不是合同结构。"""
    lines = []
    fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\n"))
        hidden = fence is not None or marker is not None
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
        elif marker:
            fence = marker[1]
        lines.append(re.sub(r"[^\n]", " ", line) if hidden else line)
    return "".join(lines)


def _input(block: str, case_id: str, label: str) -> str:
    values = []
    for line in block.strip().splitlines():
        if not line.strip():
            continue
        if not line.startswith(">"):
            raise ValueError(f"{case_id} {label}必须使用 Markdown 引用块")
        values.append(line[1:].removeprefix(" "))
    value = "\n".join(values).strip()
    if not value:
        raise ValueError(f"{case_id} {label}不能为空")
    return value


def _case(case_id: str, title: str, body: str) -> dict[str, object]:
    structure = _structure(body)
    labels = list(LABEL_RE.finditer(structure))
    all_labels = list(BOLD_LABEL_RE.finditer(structure))
    if len(labels) != len(all_labels):
        raise ValueError(f"{case_id} 只允许用户输入和预期两个字段")
    if not labels:
        raise ValueError(f"{case_id} 缺少用户输入和预期")

    values = []
    for index, match in enumerate(labels):
        end = labels[index + 1].start() if index + 1 < len(labels) else len(body)
        values.append((match.group(1), match.group(2), body[match.end():end]))

    expected = [value for value in values if value[0] == "预期"]
    inputs = [value for value in values if value[0] != "预期"]
    if len(expected) != 1 or not inputs or values[-1][0] != "预期":
        raise ValueError(f"{case_id} 必须先写用户输入，最后写一次预期")
    if any(value[0] == "预期" for value in values[:-1]):
        raise ValueError(f"{case_id} 预期必须位于 Case 末尾")

    numbers = [value[1] for value in inputs]
    if len(inputs) == 1:
        if numbers != [None]:
            raise ValueError(f"{case_id} 单轮输入必须使用“用户输入”")
    elif numbers != [str(index) for index in range(1, len(inputs) + 1)]:
        raise ValueError(f"{case_id} 多轮输入必须从 1 连续编号")

    prompts = [_input(value[2], case_id, value[0]) for value in inputs]
    expected_behavior = expected[0][2].strip()
    if not expected_behavior:
        raise ValueError(f"{case_id} 预期不能为空")
    return {
        "case_id": case_id,
        "title": title.strip(),
        "inputs": prompts,
        "expected_behavior": expected_behavior,
    }


def load_evaluation(path: Path, *, include_ranges: bool = False) -> dict[str, object]:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"缺少实体评测文件：{path}")
    text = path.read_text(encoding="utf-8")
    structure = _structure(text)
    for heading in re.finditer(r"^(#{1,6})[ \t]+([^\n]+)$", structure, re.MULTILINE):
        level, title = len(heading[1]), heading[2]
        if level == 3 or (level != 4 and re.match(r"[A-Z]-[A-Z0-9-]+(?:\s|$)", title)) or (level == 4 and title.startswith("U-") and not CASE_RE.fullmatch(heading[0])) or (level == 1 and CASE_RE.search(structure[:heading.start()])):
            line = text.count("\n", 0, heading.start()) + 1
            raise ValueError(f"evaluation.md 第 {line} 行标题层级不支持：使用二级场景标题和四级 U-* 用例标题")
    unsupported = [match.group(1) for match in CASE_LIKE_RE.finditer(structure)
                   if not match.group(1).startswith("U-")]
    if unsupported:
        raise ValueError("evaluation.md 只允许业务 U-* Case：" + "、".join(unsupported))
    matches = list(CASE_RE.finditer(structure))
    if not matches:
        raise ValueError("evaluation.md 至少需要一个 U-* Case")

    case_ids = [match.group(1) for match in matches]
    duplicates = sorted({case_id for case_id in case_ids if case_ids.count(case_id) > 1})
    if duplicates:
        raise ValueError("Case ID 重复：" + "、".join(duplicates))

    cases = {}
    catalog = []
    signatures = {}
    ranges = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        next_section = re.search(r"^## ", structure[match.end():end], re.MULTILINE)
        if next_section:
            end = match.end() + next_section.start()
        ranges[match[1]] = {"start_line": text.count("\n", 0, match.start()),
                            "end_line": text.count("\n", 0, end) + (1 if end == len(text) and text and not text.endswith("\n") else 0)}
        body = text[match.end():end]
        lines = body.splitlines()
        first = next((index for index, line in enumerate(lines) if line.strip()), None)
        marker_lines = [index for index, line in enumerate(_structure(body).splitlines()) if line.startswith("**评估档位：**")]
        if marker_lines and (marker_lines != [first] or lines[first] != FAST_MARKER):
            raise ValueError(f"{match.group(1)} 评估档位只能在标题下首行标记为 fast")
        fast = bool(marker_lines)
        if fast:
            del lines[first]
            body = "\n".join(lines)
        value = _case(match.group(1), match.group(2), body)
        signature = tuple("".join(item.split()) for item in value["inputs"])
        if signature in signatures:
            raise ValueError(f"业务测试输入重复：{signatures[signature]}、{value['case_id']}")
        signatures[signature] = value["case_id"]
        cases[value["case_id"]] = value
        headings = list(SCENE_RE.finditer(structure[:match.start()]))
        catalog.append({
            "case_id": value["case_id"],
            "scene": headings[-1].group(1).strip() if headings else "未分组",
            "fast": fast,
        })
    result = {"case_ids": case_ids, "cases": cases, "catalog": catalog}
    if include_ranges:
        result["ranges"] = ranges
        sections = list(SCENE_RE.finditer(structure))
        result["scene_ranges"] = [{"scene": section[1].strip(),
                                   "end_line": text.count("\n", 0, sections[i + 1].start()) if i + 1 < len(sections) else len(text.splitlines())}
                                  for i, section in enumerate(sections)]
    return result


def execution_for(path: Path, selected_case_ids: list[str]) -> list[dict[str, object]]:
    return execution_from(load_evaluation(path), selected_case_ids)


def execution_from(evaluation: dict, selected_case_ids: list[str]) -> list[dict[str, object]]:
    """从同一次解析选择执行输入，保持用例、目录与摘要一致。"""
    if not selected_case_ids:
        raise ValueError("至少显式选择一个 Case")
    if len(selected_case_ids) != len(set(selected_case_ids)):
        raise ValueError("Case 不能重复选择")
    unknown = [case_id for case_id in selected_case_ids if case_id not in evaluation["cases"]]
    if unknown:
        raise ValueError("未定义的 Case：" + "、".join(unknown))
    selected = set(selected_case_ids)
    return [evaluation["cases"][case_id] for case_id in evaluation["case_ids"] if case_id in selected]


def evaluation_digest(path: Path, selected_case_ids: list[str]) -> str:
    """只摘要本次锁定的 Case，忽略其他 Case 的变化。"""
    return cases_digest(execution_for(path, selected_case_ids))


def cases_digest(cases: list[dict[str, object]]) -> str:
    """当前定义和 Run 快照共用相同的用例摘要算法。"""
    raw = json.dumps(
        cases,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(raw).hexdigest()

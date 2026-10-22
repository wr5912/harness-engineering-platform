#!/usr/bin/env python3
"""Read-only, offline, heuristic inspection of an Agent Skill directory.

No third-party packages; does not parse all YAML features or run inspected code.
Findings with level REVIEW are leads for a human/agent, not confirmed defects.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FIELD_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9_-]*):(?:\s*(.*))?$", re.MULTILINE)
RESOURCE_RE = re.compile(r"(?<![A-Za-z0-9_/.])(?:references|scripts|assets)/[A-Za-z0-9_./-]*[A-Za-z0-9_-]")
MCP_RE = re.compile(r"\bmcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+\b")
RISKY_RE = re.compile(r"\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b|\brm\s+-rf\b", re.IGNORECASE)
MAX_TEXT_BYTES = 500_000
MAX_DEEP_FILES = 200


def finding(fid: str, level: str, file: str, line: int, message: str,
            action: str, confidence: str = "heuristic") -> Dict[str, object]:
    return {
        "id": fid, "level": level, "confidence": confidence,
        "file": file, "line": line, "message": message,
        "suggested_review": action,
    }


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def frontmatter(text: str) -> Tuple[Optional[str], str]:
    """Return frontmatter and body. Only delimits YAML; not a YAML parser."""
    if not text.startswith("---\n"):
        return None, text
    match = re.search(r"(?m)^---\s*$", text[4:])
    if not match:
        return None, text
    end = 4 + match.start()
    return text[4:end], text[4 + match.end():]


def get_scalar(fm: str, key: str) -> str:
    """Extract basic YAML scalar or folded/literal block for required fields."""
    rows = fm.splitlines()
    for pos, row in enumerate(rows):
        match = re.match(r"^" + re.escape(key) + r":\s*(.*)$", row)
        if match is None:
            continue
        value = match.group(1).strip()
        if value in {">", ">-", ">+", "|", "|-", "|+"}:
            pieces = []
            for nxt in rows[pos + 1:]:
                if nxt.strip() and not nxt[:1].isspace():
                    break
                if nxt.strip():
                    pieces.append(nxt.strip())
            return (" " if value.startswith(">") else "\n").join(pieces)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        return value
    return ""


def read_text(path: Path) -> Optional[str]:
    try:
        if path.stat().st_size > MAX_TEXT_BYTES:
            return None
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return None


def inspect(root: Path, include_references: bool = False) -> Dict[str, object]:
    findings: List[Dict[str, object]] = []
    scanned = 0
    root = root.expanduser().resolve()
    entry = root / "SKILL.md"
    if not root.is_dir() or not entry.is_file():
        findings.append(finding("STRUCT-001", "ERROR", "SKILL.md", 1,
            "目标不是包含 SKILL.md 的有效目录。", "传入 Skill 文件夹路径。", "certain"))
        return {"target": str(root), "files_read": 0, "findings": findings,
                "note": "ERROR 表示可静态确认的结构问题；REVIEW 只是人工复核线索。"}

    text = read_text(entry)
    if text is None:
        findings.append(finding("STRUCT-002", "ERROR", "SKILL.md", 1,
            "无法以 UTF-8 读取 SKILL.md，或文件超过扫描上限。", "检查编码及文件大小。", "certain"))
        return {"target": str(root), "files_read": 0, "findings": findings,
                "note": "未运行目标 Skill 的脚本。"}
    scanned += 1
    fm, body = frontmatter(text)
    if fm is None:
        findings.append(finding("META-001", "ERROR", "SKILL.md", 1,
            "缺少以 --- 分隔的 YAML frontmatter。", "添加标准 frontmatter。", "certain"))
    else:
        name = get_scalar(fm, "name")
        desc = get_scalar(fm, "description")
        if not name or len(name) > 64 or not NAME_RE.fullmatch(name):
            findings.append(finding("META-002", "ERROR", "SKILL.md", 2,
                "name 缺失或不符合小写字母/数字/单连字符、1–64 字符的规范。",
                "使用有效的 kebab-case name。", "certain"))
        elif root.name != name:
            findings.append(finding("META-003", "ERROR", "SKILL.md", 2,
                "name 与 Skill 文件夹名称不匹配。", "将目录名与 name 保持一致。", "certain"))
        if not desc or len(desc) > 1024:
            findings.append(finding("META-004", "ERROR", "SKILL.md", 3,
                "description 为空或超过 1024 字符。", "缩短并明确用途和触发时机。", "certain"))
        elif len(desc) < 45:
            findings.append(finding("META-005", "REVIEW", "SKILL.md", 3,
                "description 较短，可能不足以表达任务及触发时机。",
                "人工检查触发正负样例；长度本身不是缺陷。"))
        compatibility = get_scalar(fm, "compatibility")
        if compatibility and len(compatibility) > 500:
            findings.append(finding("META-006", "ERROR", "SKILL.md", 3,
                "compatibility 超过规范的 500 字符。", "简化环境依赖说明。", "certain"))

    if len(text.splitlines()) > 500:
        findings.append(finding("CONTEXT-001", "REVIEW", "SKILL.md", 1,
            "SKILL.md 超过建议的 500 行，可检查渐进披露空间。",
            "将必要时才读取的知识移至 references/；不要仅为缩短而拆分。"))
    if not body.strip():
        findings.append(finding("STRUCT-003", "ERROR", "SKILL.md", 1,
            "SKILL.md 没有有效正文指令。", "加入目标、操作边界与必要的执行方法。", "certain"))

    # Only check explicit package-relative resources referenced by the entry point.
    for match in RESOURCE_RE.finditer(text):
        relative = match.group().rstrip(".,:;)")
        if ".." in Path(relative).parts:
            findings.append(finding("RES-001", "REVIEW", "SKILL.md", line_number(text, match.start()),
                "资源引用包含上级目录，需确认可移植性。", "改为包内路径或解释外部依赖。"))
            continue
        reference = root / relative
        if not reference.exists():
            findings.append(finding("RES-002", "ERROR", "SKILL.md", line_number(text, match.start()),
                f"被引用的文件不存在：{relative}", "修复路径或提供缺失文件。", "certain"))

    targets: List[Tuple[str, str]] = [("SKILL.md", text)]
    if include_references:
        count = 0
        for folder in ("references", "scripts"):
            base = root / folder
            if not base.is_dir():
                continue
            for path in sorted(base.rglob("*")):
                if count >= MAX_DEEP_FILES:
                    break
                if path.is_symlink() or not path.is_file() or path.suffix.lower() not in {".md", ".py", ".txt", ".sh", ".js", ".ts"}:
                    continue
                content = read_text(path)
                if content is None:
                    continue
                count += 1
                scanned += 1
                targets.append((str(path.relative_to(root)), content))

    observed_tools = {}
    for label, content in targets:
        for match in MCP_RE.finditer(content):
            key = (label, match.group())
            observed_tools.setdefault(key, line_number(content, match.start()))
        for match in RISKY_RE.finditer(content):
            findings.append(finding("SCRIPT-001", "REVIEW", label, line_number(content, match.start()),
                "发现潜在危险的 shell 操作模式（也可能只是反例或说明）。",
                "人工核查语境与副作用，不要自动执行。"))

    for (label, tool), lineno in list(observed_tools.items())[:15]:
        findings.append(finding("MCP-001", "REVIEW", label, lineno,
            f"出现具体 MCP 工具标识：{tool}",
            "确认它是稳定契约/说明示例还是易变实现名；仅凭出现名称不能判错。"))
    if len(observed_tools) > 15:
        findings.append(finding("MCP-002", "REVIEW", "SKILL.md", 1,
            "存在多处具体 MCP 工具引用，建议优先审查兼容性和固定编排。",
            "使用实际 MCP 清单和 Trace 区分必要工具与可下沉链路。"))

    return {"target": str(root), "files_read": scanned, "findings": findings,
            "note": "只读、无外部依赖；不是完整 YAML 解析器、恶意代码扫描器或真实运行评估。REVIEW 不代表确认缺陷。"}


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only static hints for an Agent Skill")
    parser.add_argument("skill_dir", type=Path, help="Directory containing SKILL.md")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--include-references", action="store_true", help="Also scan references/ and scripts/ (examples may cause false positives)")
    parser.add_argument("--fail-on-error", action="store_true", help="Exit 2 on certain structural ERROR findings")
    args = parser.parse_args(argv)
    report = inspect(args.skill_dir, include_references=args.include_references)
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Skill: {report['target']}\nFiles read: {report['files_read']}")
        if not report["findings"]:
            print("No static findings. This does NOT prove execution quality.")
        for f in report["findings"]:
            print(f"[{f['level']}] {f['id']} {f['file']}:{f['line']} - {f['message']}")
            print(f"  -> {f['suggested_review']}")
        print(f"Note: {report['note']}")
    return 2 if args.fail_on_error and any(f["level"] == "ERROR" for f in report["findings"]) else 0


if __name__ == "__main__":
    sys.exit(main())

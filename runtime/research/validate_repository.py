#!/usr/bin/env python3
"""校验 harness-engineering-platform 的项目与 Harness 资产合同。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import tomllib
except ImportError:  # pragma: no cover
    try:
        import tomli as tomllib
    except ImportError:  # pragma: no cover
        tomllib = None

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


SCHEMA_VERSION = "1.0"
FROZEN_SPEC_COMMIT = "aa3f27ae0b785191d0a122a6857154640073d73b"
STANDARD_COPIES = {
    "Harness_Repo目录结构设计说明_v1.1.md": "cdea9c8612284a81f7a9c9cbbe1989996ff1c839f5b511c8bdfb8e56a76031fa",
    "Harness_Asset_Repository规范_v1.0.md": "d1c5681232fa385b5caefaa2dabba941493a8bbce315eda0a0eedd3aca3011a3",
}
REQUIRED_ROOT_FILES = (
    "README.md",
    "AGENTS.md",
    "VERSION.md",
    "CHANGELOG.md",
    ".gitignore",
    ".codex/config.toml",
    "docs/ai-agent-harness项目验收矩阵.md",
    "docs/项目审查原则.md",
    "docs/AI纠错经验总结.md",
    "docs/项目术语表.md",
    "docs/standards/SOURCES.md",
    "docs/standards/PROJECT-INTERPRETATION.md",
)
REQUIRED_SKILLS = {
    "ai-correction-log": ("scripts/record_correction.py",),
    "dsh-platform-development": (),
    "continuous-dev-progress-vs-project-vision-gap-assessment": (
        "references/assessment-method.md",
        "references/presentation-spec.md",
    ),
}
RETIRED_SKILLS = {"baseline-eval", "security-control-boundary", "delivery-review", "dsh-release-verify"}
PROJECT_MATRIX = "docs/ai-agent-harness项目验收矩阵.md"
PROJECT_REVIEW = "docs/项目审查原则.md"
KEBAB_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ADAPTER = Path(__file__).resolve().parents[1] / "adapters/dsh-container"
if str(ADAPTER) not in sys.path:
    sys.path.insert(0, str(ADAPTER))
from source_contract import EXPERIMENT as EXPERIMENT_RE, resolve as resolve_version
from workspace_paths import PROGRAM_ROOT, workspace_id
SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
RELEASE_RE = re.compile(r"^([a-z0-9]+(?:-[a-z0-9]+)*)-v(.+)$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
PLACEHOLDER_NAMES = {".gitkeep", ".keep", ".DS_Store"}
MAX_TEXT_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ASSET_FILES = 100_000


def issue(code: str, message: str, path: Path | str | None = None) -> dict[str, str]:
    result = {"code": code, "message": message}
    if path is not None:
        result["path"] = str(path)
    return result


def relative(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def strict_json(path: Path) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"重复 JSON key：{key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"不允许非有限数字：{value}")

    with path.open(encoding="utf-8") as handle:
        return json.load(handle, object_pairs_hook=unique, parse_constant=reject_constant)


class StrictLoader(yaml.SafeLoader if yaml else object):  # type: ignore[misc]
    pass


if yaml is not None:
    def construct_mapping(loader: StrictLoader, node: Any, deep: bool = False) -> dict[Any, Any]:
        result: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise ValueError(f"重复 YAML key：{key}")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise RuntimeError("缺少 PyYAML；请安装 runtime/research/requirements.txt")
    if path.stat().st_size > MAX_TEXT_BYTES:
        raise ValueError("YAML 超过 4 MiB 上限")
    value = yaml.load(path.read_text(encoding="utf-8"), Loader=StrictLoader)
    if not isinstance(value, dict) or not value:
        raise ValueError("必须是非空 YAML object")
    return value


def read_text(path: Path) -> str:
    if path.stat().st_size > MAX_TEXT_BYTES:
        raise ValueError("文本超过 4 MiB 上限")
    return path.read_text(encoding="utf-8")


def is_material_file(path: Path) -> bool:
    if not path.is_file() or path.is_symlink() or path.name in PLACEHOLDER_NAMES:
        return False
    return path.stat().st_size > 0


def material_files(directory: Path) -> list[Path]:
    if not directory.is_dir() or directory.is_symlink():
        return []
    files: list[Path] = []
    for path in directory.rglob("*"):
        if is_material_file(path):
            files.append(path)
            if len(files) > MAX_ASSET_FILES:
                raise ValueError("资产文件数超过 100000")
    return files


def validate_required_files(root: Path, errors: list[dict[str, str]]) -> None:
    for name in REQUIRED_ROOT_FILES:
        path = root / name
        if not is_material_file(path):
            errors.append(issue("ROOT_FILE", "缺少非空实体文件", name))


def validate_governance(root: Path, errors: list[dict[str, str]]) -> None:
    agents_text = ""
    readme_text = ""
    try:
        agents_text = read_text(root / "AGENTS.md")
        readme_text = read_text(root / "README.md")
    except (OSError, ValueError) as exc:
        errors.append(issue("GOVERNANCE_READ", str(exc)))
        return
    required_phrases = (
        "禁止过度工程化和过度安全化",
        "简洁优先（Simplicity First）",
        "精准修改（Surgical Changes）",
        "LLM API Key 禁止提交或推送",
    )
    for phrase in required_phrases:
        if phrase not in agents_text:
            errors.append(issue("RESEARCH_MODE", f"AGENTS.md 缺少：{phrase}", "AGENTS.md"))
    try:
        gitignore_lines = {line.strip() for line in read_text(root / ".gitignore").splitlines()}
        if "*.llm-api-key" not in gitignore_lines:
            errors.append(issue("LLM_KEY_IGNORE", ".gitignore 必须忽略 *.llm-api-key", ".gitignore"))
    except (OSError, ValueError) as exc:
        errors.append(issue("GOVERNANCE_READ", str(exc), ".gitignore"))
    matrix_link = f"](./{PROJECT_MATRIX})"
    if matrix_link not in readme_text:
        errors.append(issue("MATRIX_LINK", "README 必须链接项目验收矩阵", "README.md"))
    if PROJECT_MATRIX not in agents_text:
        errors.append(issue("MATRIX_LINK", "AGENTS.md 必须链接项目验收矩阵", "AGENTS.md"))
    if f"]({PROJECT_REVIEW})" not in agents_text:
        errors.append(issue("REVIEW_LINK", "AGENTS.md 必须链接项目审查原则", "AGENTS.md"))
    matrix_path = root / PROJECT_MATRIX
    try:
        matrix_text = read_text(matrix_path)
        count_match = re.search(r"共有 \*\*([0-9]+) 条一级验证路径\*\*", matrix_text)
        count = int(count_match.group(1)) if count_match else 0
        expected_paths = {f"PA-{number:02d}" for number in range(1, count + 1)}
        actual_paths = set(re.findall(r"PA-[0-9]{2}", matrix_text))
        detailed_paths = re.findall(r"^### (PA-[0-9]{2})\b", matrix_text, re.MULTILINE)
        overview_paths = re.findall(r"^\|[^\n|]+\|\s*`(PA-[0-9]{2})`\s*\|[^\n|]+\|[^\n|]+\|", matrix_text, re.MULTILINE)
        if (count < 1 or actual_paths != expected_paths
                or set(detailed_paths) != expected_paths or len(detailed_paths) != count
                or set(overview_paths) != expected_paths or len(overview_paths) != count):
            errors.append(issue("MATRIX_COUNT", "项目验收矩阵的声明总数、连续编号、总览和逐条路径必须一致", PROJECT_MATRIX))
    except (OSError, ValueError) as exc:
        errors.append(issue("MATRIX_READ", str(exc), PROJECT_MATRIX))
    config_path = root / ".codex/config.toml"
    if tomllib is None:
        errors.append(issue("TOML_DEPENDENCY", "无法解析 .codex/config.toml"))
    else:
        try:
            with config_path.open("rb") as handle:
                config = tomllib.load(handle)
            if config.get("features", {}).get("memories") is not True:
                errors.append(issue("MEMORY", "features.memories 必须显式为 true", relative(config_path, root)))
        except (OSError, ValueError) as exc:
            errors.append(issue("MEMORY", f"无法解析项目配置：{exc}", relative(config_path, root)))


def parse_skill_name(path: Path) -> str | None:
    try:
        text = read_text(path)
    except (OSError, ValueError):
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    for line in text[4:end].splitlines():
        if line.startswith("name:"):
            return line.partition(":")[2].strip()
    return None


def validate_skills(root: Path, errors: list[dict[str, str]]) -> None:
    skills_root = root / ".agents/skills"
    if not skills_root.is_dir() or skills_root.is_symlink():
        errors.append(issue("SKILLS_ROOT", ".agents/skills 必须是实体目录"))
        return
    present = {path.name for path in skills_root.iterdir() if path.is_dir()}
    for retired in sorted(RETIRED_SKILLS & present):
        errors.append(issue("RETIRED_SKILL", "项目不维护已退役的生产化技能", skills_root / retired))
    for name, resources in REQUIRED_SKILLS.items():
        skill = skills_root / name
        if not skill.is_dir() or skill.is_symlink():
            errors.append(issue("SKILL_REQUIRED", "缺少项目技能", relative(skill, root)))
            continue
        skill_file = skill / "SKILL.md"
        if parse_skill_name(skill_file) != name:
            errors.append(issue("SKILL_NAME", "SKILL.md name 必须与目录一致", relative(skill_file, root)))
        openai_yaml = skill / "agents/openai.yaml"
        if not is_material_file(openai_yaml):
            errors.append(issue("SKILL_OPENAI", "技能缺少 agents/openai.yaml", relative(openai_yaml, root)))
        else:
            try:
                metadata = load_yaml(openai_yaml)
                policy = metadata.get("policy")
                if not isinstance(policy, dict) or not isinstance(policy.get("allow_implicit_invocation"), bool):
                    raise ValueError("policy.allow_implicit_invocation 必须是 bool")
                if name == "continuous-dev-progress-vs-project-vision-gap-assessment" and policy["allow_implicit_invocation"]:
                    raise ValueError("此技能只允许显式调用")
            except (OSError, ValueError, RuntimeError, yaml.YAMLError if yaml else ValueError) as exc:
                errors.append(issue("SKILL_OPENAI", str(exc), relative(openai_yaml, root)))
        for resource in resources:
            path = skill / resource
            if not is_material_file(path):
                errors.append(issue("SKILL_RESOURCE", "技能缺少必要资源", relative(path, root)))


def validate_sources(root: Path, errors: list[dict[str, str]]) -> None:
    standards = root / "docs/standards"
    for name, expected in STANDARD_COPIES.items():
        path = standards / name
        if not path.is_file() or path.is_symlink():
            errors.append(issue("STANDARD_COPY", "缺少受控规范副本", relative(path, root)))
        elif sha256(path) != expected:
            errors.append(issue("STANDARD_HASH", "受控规范副本摘要已变化", relative(path, root)))
    try:
        sources = read_text(standards / "SOURCES.md")
    except (OSError, ValueError) as exc:
        errors.append(issue("SOURCES", str(exc), "docs/standards/SOURCES.md"))
        return
    if FROZEN_SPEC_COMMIT not in sources:
        errors.append(issue("SPEC_COMMIT", "SOURCES.md 缺少锁定提交", "docs/standards/SOURCES.md"))
    if "未来生产化参考" not in sources:
        errors.append(issue("SPEC_SCOPE", "SOURCES.md 必须说明 agent-engineering-spec 仅作未来生产化参考", "docs/standards/SOURCES.md"))


def validate_jsonl(path: Path, errors: list[dict[str, str]]) -> None:
    seen = 0
    try:
        for number, line in enumerate(read_text(path).splitlines(), 1):
            if not line.strip():
                continue
            seen += 1
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append(issue("JSONL", f"第 {number} 行不是合法 JSON：{exc.msg}", path))
                continue
            if not isinstance(value, dict):
                errors.append(issue("JSONL_OBJECT", f"第 {number} 行必须是 object", path))
        if seen == 0:
            errors.append(issue("JSONL_EMPTY", "JSONL 不得为空", path))
    except (OSError, ValueError) as exc:
        errors.append(issue("JSONL", str(exc), path))


def validate_agents(root: Path, errors: list[dict[str, str]]) -> None:
    agents = root / "agents"
    if not agents.exists():
        return
    if not agents.is_dir() or agents.is_symlink():
        errors.append(issue("AGENTS_ROOT", "agents 必须是实体目录"))
        return
    for agent in sorted(agents.iterdir()):
        if not agent.is_dir() or agent.is_symlink() or not KEBAB_RE.fullmatch(agent.name):
            errors.append(issue("AGENT_DIR", "Agent 必须是小写 kebab-case 实体目录", relative(agent, root)))
            continue
        current = agent / "current"
        if current.exists() or current.is_symlink():
            errors.append(issue("CURRENT_FORBIDDEN", "项目不维护 agents/<id>/current", relative(current, root)))
        manifest_path = agent / "manifest.yaml"
        try:
            manifest = load_yaml(manifest_path)
        except (OSError, ValueError, RuntimeError) as exc:
            errors.append(issue("AGENT_MANIFEST", str(exc), relative(manifest_path, root)))
            continue
        if manifest.get("agent_id") != agent.name:
            errors.append(issue("AGENT_ID", "manifest agent_id 必须与目录一致", relative(manifest_path, root)))
        evaluation = agent / "evaluation.md"
        if not is_material_file(evaluation):
            errors.append(issue("AGENT_SOURCE", "Agent 缺少 evaluation.md", relative(evaluation, root)))
        definition = agent / "definition.md"
        if definition.exists() or definition.is_symlink():
            errors.append(issue("AGENT_SOURCE_DUPLICATE", "Agent 当前业务测试只维护 evaluation.md", relative(definition, root)))
        active = manifest.get("active_experiment")
        if active:
            match = EXPERIMENT_RE.fullmatch(str(active))
            target = root / "evolution/experiments" / str(active)
            if not match or match.group(1) != agent.name or not target.is_dir():
                errors.append(issue("ACTIVE_EXPERIMENT", "active_experiment 必须指向同一 Agent 的现有 Experiment", relative(manifest_path, root)))
        for path in agent.rglob("*"):
            if path.is_symlink():
                errors.append(issue("AGENT_SYMLINK", "Agent 研究资产不得使用符号链接", relative(path, root)))
            elif path.is_file() and path.suffix in {".yaml", ".yml"}:
                try:
                    load_yaml(path)
                except (OSError, ValueError, RuntimeError) as exc:
                    errors.append(issue("AGENT_YAML", str(exc), relative(path, root)))
            elif path.is_file() and path.suffix == ".jsonl":
                validate_jsonl(path, errors)


def load_research_validator(root: Path):
    program = PROGRAM_ROOT if (root / "workspace.json").is_file() else root
    path = program / "runtime/research/validate_experiment.py"
    spec = importlib.util.spec_from_file_location("research_eval_validator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 research-eval 校验器")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_experiments(root: Path, errors: list[dict[str, str]], warnings: list[dict[str, str]]) -> None:
    experiments = root / "evolution/experiments"
    if not experiments.exists():
        return
    if not experiments.is_dir() or experiments.is_symlink():
        errors.append(issue("EXPERIMENTS_ROOT", "evolution/experiments 必须是实体目录"))
        return
    try:
        validator = load_research_validator(root)
    except Exception as exc:  # noqa: BLE001 - 转为稳定 JSON 合同
        errors.append(issue("RESEARCH_VALIDATOR", str(exc)))
        return
    for experiment in sorted(experiments.iterdir()):
        if not experiment.is_dir() or experiment.is_symlink():
            errors.append(issue("EXPERIMENT_DIR", "experiments/ 只能包含实体目录", relative(experiment, root)))
            continue
        if not (experiment / "change.yaml").exists() and EXPERIMENT_RE.fullmatch(experiment.name):
            try:
                visible = subprocess.run(
                    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
                     experiment.relative_to(root).as_posix()],
                    cwd=root, capture_output=True, check=False, timeout=5,
                )
            except (OSError, subprocess.TimeoutExpired):
                visible = None
            if visible is not None and visible.returncode == 0 and not visible.stdout:
                continue
        try:
            resolve_version(experiment.name, repo=root)
        except (OSError, ValueError) as exc:
            errors.append(issue("EXPERIMENT_LOAD", str(exc), relative(experiment / "candidate/harness.yaml", root)))
        payload, _ = validator.validate(experiment.resolve())
        for item in payload.get("errors", []):
            copied = dict(item)
            copied["code"] = "EXPERIMENT_" + copied.get("code", "INVALID")
            if "path" in copied:
                copied["path"] = relative(Path(copied["path"]), root)
            errors.append(copied)
        for item in payload.get("warnings", []):
            copied = dict(item)
            copied["code"] = "EXPERIMENT_" + copied.get("code", "WARNING")
            if "path" in copied:
                copied["path"] = relative(Path(copied["path"]), root)
            warnings.append(copied)


def safe_release_path(release: Path, value: object) -> Path | None:
    if not isinstance(value, str) or not value or "\\" in value:
        return None
    candidate = Path(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        return None
    target = release / candidate
    if not target.is_file() or target.is_symlink():
        return None
    return target


def release_records(release: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(release.rglob("*"), key=lambda item: item.relative_to(release).as_posix()):
        if path.is_symlink():
            raise ValueError(f"Release 不得包含符号链接：{path.relative_to(release)}")
        relative_path = path.relative_to(release).as_posix()
        if not path.is_file() or relative_path in {"artifact-manifest.json", "manifest.yaml"}:
            continue
        metadata = path.stat()
        if metadata.st_size > MAX_FILE_BYTES:
            raise ValueError(f"Release 单文件超过 64 MiB：{path.relative_to(release)}")
        records.append({
            "path": relative_path,
            "sha256": sha256(path),
            "size": metadata.st_size,
        })
    return records


def records_digest(records: list[dict[str, Any]]) -> str:
    raw = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def validate_releases(root: Path, errors: list[dict[str, str]]) -> None:
    releases = root / "releases"
    if not releases.exists():
        return
    if not releases.is_dir() or releases.is_symlink():
        errors.append(issue("RELEASES_ROOT", "releases 必须是实体目录"))
        return
    for release in sorted(releases.iterdir()):
        match = RELEASE_RE.fullmatch(release.name)
        if not release.is_dir() or release.is_symlink() or not match or not SEMVER_RE.fullmatch(match.group(2)):
            errors.append(issue("RELEASE_DIR", "Research Release 必须是 <agent-id>-v<semver> 实体目录", relative(release, root)))
            continue
        agent_id, version = match.groups()
        required = ("manifest.yaml", "harness.yaml", "runtime.yaml", "artifact-manifest.json", "README.md")
        missing = [name for name in required if not is_material_file(release / name)]
        if missing:
            errors.append(issue("RELEASE_FILES", f"缺少：{', '.join(missing)}", relative(release, root)))
            continue
        try:
            manifest = load_yaml(release / "manifest.yaml")
            load_yaml(release / "harness.yaml")
            load_yaml(release / "runtime.yaml")
            artifact = strict_json(release / "artifact-manifest.json")
            records = release_records(release)
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            errors.append(issue("RELEASE_PARSE", str(exc), relative(release, root)))
            continue
        fields = {
            "schema_version", "release_id", "agent_id", "version", "source_experiment",
            "source_commit", "evaluation_ref", "runtime_compatibility", "artifact_digest",
        }
        if set(manifest) != fields:
            errors.append(issue("RELEASE_MANIFEST_FIELDS", "manifest.yaml 字段必须与 Research Release 最小合同完全一致", relative(release / "manifest.yaml", root)))
        expected_identity = {"schema_version": "1.0", "release_id": release.name, "agent_id": agent_id, "version": version}
        for key, value in expected_identity.items():
            if str(manifest.get(key)) != value:
                errors.append(issue("RELEASE_IDENTITY", f"{key} 必须是 {value}", relative(release / "manifest.yaml", root)))
        source_experiment = manifest.get("source_experiment")
        exp_match = EXPERIMENT_RE.fullmatch(str(source_experiment)) if source_experiment else None
        if not exp_match or exp_match.group(1) != agent_id or not (root / "evolution/experiments" / str(source_experiment)).is_dir():
            errors.append(issue("RELEASE_SOURCE", "source_experiment 必须指向同一 Agent 的现有 Experiment", relative(release / "manifest.yaml", root)))
        if not isinstance(manifest.get("source_commit"), str) or not COMMIT_RE.fullmatch(manifest["source_commit"]):
            errors.append(issue("RELEASE_COMMIT", "source_commit 必须是 40 位 Git commit", relative(release / "manifest.yaml", root)))
        if safe_release_path(release, manifest.get("evaluation_ref")) is None:
            errors.append(issue("RELEASE_EVALUATION", "evaluation_ref 必须指向 Release 内的实体文件", relative(release / "manifest.yaml", root)))
        if not isinstance(manifest.get("runtime_compatibility"), str) or not manifest["runtime_compatibility"].strip():
            errors.append(issue("RELEASE_RUNTIME", "runtime_compatibility 必须是非空字符串", relative(release / "manifest.yaml", root)))
        digest = records_digest(records)
        expected_digest = "sha256:" + digest
        if manifest.get("artifact_digest") != expected_digest:
            errors.append(issue("RELEASE_DIGEST", "artifact_digest 与实际文件树不一致", relative(release / "manifest.yaml", root)))
        expected_artifact = {"schema_version": "1.0", "tree_sha256": digest, "files": records}
        if artifact != expected_artifact:
            errors.append(issue("RELEASE_ARTIFACT", "artifact-manifest.json 与实际文件树不一致", relative(release / "artifact-manifest.json", root)))
        try:
            readme = read_text(release / "README.md")
            if "不是生产" not in readme and "非生产" not in readme:
                errors.append(issue("RELEASE_SCOPE", "Release README 必须明确它不是生产部署批准", relative(release / "README.md", root)))
        except (OSError, ValueError) as exc:
            errors.append(issue("RELEASE_README", str(exc), relative(release / "README.md", root)))


def validate_retired_topology(root: Path, errors: list[dict[str, str]]) -> None:
    baseline = root / "evolution/baselines"
    if baseline.exists() or baseline.is_symlink():
        errors.append(issue("BASELINES_FORBIDDEN", "项目不维护 evolution/baselines", relative(baseline, root)))


def validate_asset_nodes(root: Path, errors: list[dict[str, str]]) -> None:
    for name in ("agents", "evolution", "extensions", "plugins", "platform", "releases"):
        base = root / name
        if not base.exists() or not base.is_dir():
            continue
        count = 0
        for directory, directories, files in os.walk(base, followlinks=False):
            # 本地依赖不属于研究资产；仓库自有插件的编译输出也不参与校验。
            directories[:] = [entry for entry in directories if entry != "node_modules"
                              and not (name == "plugins" and Path(directory).parent == base and entry == "lib")
                              and not (name == "platform" and Path(directory) == base / "plugin" and entry == "lib")]
            for entry in directories + files:
                path = Path(directory) / entry
                count += 1
                if count > MAX_ASSET_FILES:
                    errors.append(issue("ASSET_COUNT", f"{name} 节点数超过 100000", name))
                    return
                try:
                    mode = path.lstat().st_mode
                except OSError as exc:
                    errors.append(issue("ASSET_READ", str(exc), relative(path, root)))
                    continue
                if stat.S_ISLNK(mode):
                    errors.append(issue("ASSET_SYMLINK", "研究资产不得使用符号链接", relative(path, root)))
                elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    errors.append(issue("ASSET_SPECIAL", "研究资产只能是普通文件或目录", relative(path, root)))


def run(root: Path) -> tuple[dict[str, Any], int]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    split_workspace = (root / "workspace.json").exists()
    program = PROGRAM_ROOT if split_workspace else root
    validate_required_files(program, errors)
    validate_governance(program, errors)
    validate_skills(program, errors)
    validate_sources(program, errors)
    if split_workspace:
        try:
            workspace_id(root)
        except (OSError, ValueError, TypeError) as exc:
            errors.append(issue("WORKSPACE", str(exc), root / "workspace.json"))
    validate_retired_topology(root, errors)
    validate_asset_nodes(root, errors)
    validate_agents(root, errors)
    validate_experiments(root, errors, warnings)
    validate_releases(root, errors)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "scope": "仅校验项目与 Harness 资产合同；不代表 Experiment 结果或生产验收",
    }
    return payload, 0 if not errors else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root = args.repo.resolve()
    if not root.is_dir():
        print(json.dumps({"schema_version": SCHEMA_VERSION, "valid": False, "errors": [issue("REPO", "仓库目录不存在", root)], "warnings": []}, ensure_ascii=False, indent=2))
        return 2
    try:
        payload, code = run(root)
    except Exception as exc:  # noqa: BLE001 - 顶层始终维持 JSON 输出
        payload = {"schema_version": SCHEMA_VERSION, "valid": False, "errors": [issue("VALIDATOR", str(exc))], "warnings": []}
        code = 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

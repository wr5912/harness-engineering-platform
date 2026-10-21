#!/usr/bin/env python3
"""将 DSH-only 来源（实验候选）解析为单一、无秘密的运行数据合同，并按角色生成挂载计划。

来源只剩 `experiment:<id>` 一种。早期 `snapshot:<id>` 兼容入口已退役：它把当前镜像当作
历史组合使用，并按 `rsplit('/', 1)` 重建容器路径，会丢掉 preset 的 Agent 子目录。
历史快照内容改由 Git 恢复，映射见 evolution/experiments/<id>/snapshots/README.md。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import stat
import sys
from pathlib import Path

from workspace_paths import PROGRAM_ROOT, asset_root, source_catalog, workspace_id


ADAPTER = Path(__file__).resolve().parent
REPO = asset_root()
SOURCES = source_catalog(REPO)
LOCK = ADAPTER / "source.lock.json"
DEFAULT_SOURCE = "EXP-security-operations-expert-001"
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_EXPERIMENT_BASE = r"^EXP-([a-z0-9]+(?:-[a-z0-9]+)*)-[0-9]{3}"
# 解析器保留历史格式；新建与仓库校验另按 NEW_EXPERIMENT 和固定兼容集合判断。
EXPERIMENT = re.compile(_EXPERIMENT_BASE + r"(?:-r[0-9a-f]{12})?$")
NEW_EXPERIMENT = re.compile(_EXPERIMENT_BASE + r"-r[0-9a-f]{12}$")
# d89ad8b 生效前的 14 个身份；013/020 是之后误建并已入库的历史违规，保留原始身份。
# 不按“已经存在/已经提交”自动扩展，避免新无后缀 Experiment 再次被当作旧版放行。
LEGACY_EXPERIMENT_IDS = frozenset(
    {f"EXP-security-operations-expert-{number:03d}" for number in range(1, 13)}
    | {"EXP-test01-001", "EXP-test01-002",
       "EXP-security-operations-expert-013", "EXP-security-operations-expert-020"}
)
RELEASE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
ROLES = ("subject", "scoring")
# evaluation.md 是判分材料：评分角色可读，被测角色不可读。
GRADING_ROLES = ("scoring",)
CONTAINER_WORKSPACE = "/work/harness/workspace"
CONTAINER_REFERENCE = "/work/reference"
CONTAINER_EVAL_INPUT = "/work/eval-input"
IMAGE_FINGERPRINT_VERSION = "2"
IMAGE_LABEL_KEY = "org.ai-agent-harness.dsh.image-build-fingerprint"
# source_contract.py 只在宿主读取来源，不进入镜像；路径/目录调整不能改变 Runtime 镜像身份。
IMAGE_BUILD_FILES = ("Dockerfile", "apt-mirror.sh", "build-image.sh", "dsh-cli.sh")
IMAGE_ARCHITECTURES = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}


def image_platform() -> str:
    """将受支持的 Linux 宿主架构映射为 Docker 平台名。"""
    system = platform.system()
    machine = platform.machine()
    architecture = IMAGE_ARCHITECTURES.get(machine.lower())
    if system != "Linux" or architecture is None:
        raise ValueError(f"unsupported DSH image host: {system}/{machine}; expected Linux amd64 or arm64")
    return f"linux/{architecture}"


def image_build_input_digests(*, lock_path: Path = LOCK, adapter: Path = ADAPTER) -> dict[str, str]:
    """返回会改变本地镜像内容或构建方式的输入摘要。"""
    paths = {lock_path.name: lock_path}
    paths.update({name: adapter / name for name in IMAGE_BUILD_FILES})
    digests = {}
    for name, path in paths.items():
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"missing or symlinked image build input: {path}")
        digests[name] = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(digests.items()))


def image_build_fingerprint(lock: dict, *, image_platform_name: str | None = None,
                            lock_path: Path = LOCK, adapter: Path = ADAPTER) -> str:
    """由锁定来源和镜像构建输入生成稳定的本地镜像身份。"""
    selected_platform = image_platform() if image_platform_name is None else image_platform_name
    if selected_platform not in ("linux/amd64", "linux/arm64"):
        raise ValueError(f"unsupported DSH image platform: {selected_platform}")
    payload = {
        "version": IMAGE_FINGERPRINT_VERSION,
        "platform": selected_platform,
        "source_lock": lock,
        "input_digests": image_build_input_digests(lock_path=lock_path, adapter=adapter),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def strict_json(path: Path, max_bytes: int = 1024 * 1024) -> dict:
    if path.stat().st_size > max_bytes:
        raise ValueError(f"oversized contract: {path.name}")

    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key in {path.name}: {key}")
            result[key] = value
        return result

    with path.open(encoding="utf-8") as stream:
        value = json.load(stream, object_pairs_hook=unique_pairs)
    if not isinstance(value, dict):
        raise ValueError(f"contract must be an object: {path.name}")
    return value


def safe_relative(value: str) -> Path:
    if not isinstance(value, str) or "\\" in value:
        raise ValueError("source path must be a POSIX relative string")
    path = Path(value)
    if not value or path.is_absolute() or path.as_posix() != value \
            or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe relative path: {value}")
    return path


def real_file_below(root: Path, relative: Path) -> bool:
    """拒绝路径任一层的链接，不只检查最终文件名。"""
    current = root
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode):
            return False
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def _agent_asset_roots(repo: Path, agent_id: str) -> dict:
    """Agent 当前评测事实源根；缺失时不伪造空目录。"""
    agent_dir = repo / "agents" / agent_id
    valid = agent_dir.is_dir() and not agent_dir.is_symlink() \
        and real_file_below(agent_dir, Path("evaluation.md"))
    return {"reference_root": str(agent_dir) if valid else None}


def _experiment_contract(
    source_id: str,
    item: dict,
    *,
    repo: Path,
    lock: dict,
    lock_path: Path,
    profile_manifest: Path,
    require_assets: bool,
) -> dict:
    expected = Path("evolution/experiments") / source_id / "candidate/dsh"
    if safe_relative(item["candidate_root"]) != expected:
        raise ValueError("candidate root does not belong to selected experiment")
    for key in ("patch", "preset"):
        safe_relative(item[key])
    if item["guard"] is not None:
        safe_relative(item["guard"])
    root = repo / expected
    if require_assets:
        for parent in (repo / Path(*expected.parts[:depth]) for depth in range(1, len(expected.parts) + 1)):
            if parent.is_symlink() or not parent.is_dir():
                raise ValueError(f"missing or symlinked source ancestor: {parent}")
        for directory in (root, root / "workspace", root / "presets", root / "managed"):
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError(f"missing or symlinked source directory: {directory}")
        for key, folder in (("patch", "managed"), ("preset", "presets"), ("guard", "managed")):
            if key == "guard" and item[key] is None:
                continue
            relative = safe_relative(item[key])
            if not real_file_below(root, Path(folder) / relative):
                raise ValueError(f"missing or unsafe source file: {key}")
    if item["profile"] != "web":
        raise ValueError("only the verified DSH web profile is supported")
    for key in ("config_markers", "required_env_names", "optional_env_names"):
        values = item.get(key, [])
        if not isinstance(values, list) or (key == "config_markers" and not values) \
                or any(not isinstance(value, str) or not value for value in values):
            raise ValueError(f"invalid {key}")
        if len(values) != len(set(values)):
            raise ValueError(f"duplicate {key}")
    optional_env_names = item.get("optional_env_names", [])
    if set(item["required_env_names"]) & set(optional_env_names):
        raise ValueError("environment name cannot be both required and optional")
    for name in item["required_env_names"] + optional_env_names:
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            raise ValueError("invalid environment name")
    # preset_id 是运行时组合身份，agent_id 是业务 Agent 身份；两者允许不同。
    # 实际装载一致性由候选 harness.yaml、sources.json 与基础 patch 默认值的交叉门禁保证。
    declared_preset = preset_id(item["preset"])
    image = dict(lock)
    image["platform"] = image_platform()
    image["build_fingerprint"] = image_build_fingerprint(
        lock, image_platform_name=image["platform"], lock_path=lock_path
    )
    image["local_image_tag"] = (
        f"{lock['local_image_tag']}-{image['platform'].split('/')[1]}-{image['build_fingerprint'][7:19]}"
    )
    contract = {
        "schema_version": "2.1",
        "source_kind": "experiment",
        "source_id": "experiment:" + source_id,
        "experiment_id": source_id,
        "agent_id": item["agent_id"],
        "candidate_root": str(root),
        "experiment_root": str(root.parents[1]),
        "workspace": str(root / "workspace"),
        "presets": str(root / "presets"),
        "managed": str(root / "managed"),
        "profile": item["profile"],
        "profile_manifest": str(profile_manifest),
        "runtime_lock": str(lock_path),
        "program_root": str(PROGRAM_ROOT),
        "asset_root": str(repo),
        "workspace_id": workspace_id(repo),
        "evaluation_patch": "/opt/dsh-adapter/evaluation-registry.patch.yml",
        "patch": "/opt/dsh-managed/" + item["patch"],
        "preset": "/opt/dsh-presets/" + item["preset"],
        "preset_id": declared_preset,
        "guard": "/opt/dsh-managed/" + item["guard"] if item["guard"] else None,
        "config_markers": item["config_markers"],
        "required_env_names": item["required_env_names"],
        "optional_env_names": optional_env_names,
        "image": image,
    }
    contract.update(_agent_asset_roots(repo, item["agent_id"]))
    return contract


def preset_id(preset_relative: str) -> str:
    """从来源声明的 preset 相对路径取 preset ID，避免在通用适配层硬编码业务 Agent 名。"""
    parts = safe_relative(preset_relative).parts
    if len(parts) < 2:
        raise ValueError("preset 必须声明为 <preset-id>/<file>，以便确定运行目标身份")
    return parts[0]


def _resolve_experiment(source_id: str, *, repo: Path, sources: Path, lock_path: Path, require_assets: bool) -> dict:
    catalog = strict_json(sources)
    if catalog.get("schema_version") != "1.1" or not isinstance(catalog.get("sources"), dict):
        raise ValueError("unsupported source catalog")
    item = catalog["sources"].get(source_id)
    match = EXPERIMENT.fullmatch(source_id)
    if not match or not isinstance(item, dict) or item.get("agent_id") != match.group(1):
        raise ValueError(f"unknown or inconsistent DSH source: {source_id}")
    required = {"agent_id", "candidate_root", "profile", "patch", "preset", "guard",
                "config_markers", "required_env_names"}
    if not required <= set(item) or set(item) - required - {"profile_manifest", "optional_env_names"}:
        raise ValueError("source fields differ from schema 1.1")
    experiment_root = Path("evolution/experiments") / source_id / "candidate"
    profile_manifest = ADAPTER / "verification-home-controls/web-profile.package.json"
    if "profile_manifest" in item:
        relative = safe_relative(item["profile_manifest"])
        if relative != experiment_root / "dsh/managed/web-profile.package.json" \
                or not real_file_below(repo, relative):
            raise ValueError("invalid experiment profile manifest")
        profile_manifest = repo / relative
    lock = _read_source_lock(lock_path)
    return _experiment_contract(source_id, item, repo=repo, lock=lock, lock_path=lock_path,
                                profile_manifest=profile_manifest, require_assets=require_assets)


def _read_source_lock(lock_path: Path) -> dict:
    lock = strict_json(lock_path)
    if lock.get("schema_version") != "1.1" or "platform" in lock:
        raise ValueError("unsupported DSH source lock schema or fixed platform")
    for key in ("repository", "commit", "tree", "pnpm_lock_sha256", "package_manager",
                "node_base", "local_image_tag", "cli_version"):
        if not isinstance(lock.get(key), str) or not lock[key]:
            raise ValueError(f"missing DSH lock field: {key}")
    if not re.fullmatch(r"[0-9a-f]{40}", lock["commit"]) or not re.fullmatch(r"[0-9a-f]{40}", lock["tree"]):
        raise ValueError("invalid DSH source commit or tree")
    if not re.fullmatch(r"[0-9a-f]{64}", lock["pnpm_lock_sha256"]):
        raise ValueError("invalid DSH dependency lock digest")
    if lock["repository"] != "https://github.com/deepseek-ai/deepseek-harness.git" \
            or lock.get("cli_package") != "@deepseek-ai/dsh" \
            or not re.fullmatch(r"pnpm@[0-9]+(?:\.[0-9]+){2}", lock["package_manager"]) \
            or not re.fullmatch(r"node:[^@]+@sha256:[0-9a-f]{64}", lock["node_base"]) \
            or lock["local_image_tag"] != "ai-agent-harness/dsh:" + lock["commit"][:9] \
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", lock["cli_version"]):
        raise ValueError("invalid DSH build source or image identity")
    return lock


def _resolve_release(release_name: str, *, repo: Path) -> dict:
    if not RELEASE_NAME.fullmatch(release_name):
        raise ValueError(f"invalid release identity: {release_name}")
    release_dir = repo / "releases" / release_name
    if not release_dir.is_dir() or release_dir.is_symlink() \
            or not real_file_below(release_dir, Path("manifest.yaml")) \
            or not real_file_below(release_dir, Path("artifact-manifest.json")):
        raise ValueError(f"unknown release source: {release_name}")
    raise ValueError("release sources resolve only after the first immutable Release is published and its container mapping is wired")


def resolve(source_id: str = DEFAULT_SOURCE, *, repo: Path = REPO, sources: Path | None = None,
            lock_path: Path = LOCK, require_assets: bool = True) -> dict:
    repo = repo.expanduser().resolve()
    sources = sources if sources is not None else source_catalog(repo)
    if source_id.startswith("experiment:"):
        return _resolve_experiment(source_id[len("experiment:"):], repo=repo, sources=sources, lock_path=lock_path, require_assets=require_assets)
    if source_id.startswith("release:"):
        return _resolve_release(source_id[len("release:"):], repo=repo)
    if ":" in source_id:
        raise ValueError(f"unknown source selector: {source_id}")
    return _resolve_experiment(source_id, repo=repo, sources=sources, lock_path=lock_path, require_assets=require_assets)


def mount_plan(contract: dict, role: str, *, task_dir: str = None, output_dir: str = None,
               eval_input: str = None) -> dict:
    """按运行角色生成挂载视图。

    当前研究定义只挂给评分角色。被测角色默认不挂任何评测材料；确需给被测侧数据时，
    必须显式声明一个已确认不含预期答案的输入根。
    """
    if role not in ROLES:
        raise ValueError("role must be subject 或 scoring")
    if eval_input is not None and role != "subject":
        raise ValueError("eval-input 只允许挂载给被测角色（subject）")
    mounts = [
        {"host": contract["workspace"], "container": CONTAINER_WORKSPACE, "mode": "ro", "purpose": "harness-workspace"},
        {"host": contract["presets"], "container": "/opt/dsh-presets", "mode": "ro", "purpose": "presets"},
        {"host": contract["managed"], "container": "/opt/dsh-managed", "mode": "ro", "purpose": "managed"},
    ]
    grading = role in GRADING_ROLES
    if grading:
        host = contract.get("reference_root")
        if host:
            mounts.append({"host": host, "container": CONTAINER_REFERENCE, "mode": "ro", "purpose": "reference"})
    elif eval_input:
        mounts.append({"host": eval_input, "container": CONTAINER_EVAL_INPUT, "mode": "ro", "purpose": "eval-input"})
    if task_dir:
        mounts.append({"host": task_dir, "container": "/work/task", "mode": "rw", "purpose": "task-workspace"})
    if output_dir:
        mounts.append({"host": output_dir, "container": "/work/output", "mode": "rw", "purpose": "run-output"})
    return {
        "schema_version": "2.1",
        "role": role,
        "source_id": contract["source_id"],
        "grading_material_exposed": grading,
        "subject_input_declared": bool(eval_input) if role == "subject" else None,
        "mounts": mounts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--repo", type=Path, default=REPO, help="用户数据工作区根目录")
    parser.add_argument("--field", help="print one top-level scalar field")
    parser.add_argument("--image-input-digests", action="store_true",
                        help="print image build input SHA-256 digests")
    parser.add_argument("--env-names", action="store_true", help="print selected Runtime environment names, one per line")
    parser.add_argument("--allow-missing-assets", action="store_true", help="resolve identity for frozen recovery")
    parser.add_argument("--mount-plan", choices=ROLES, help="print the role mount plan instead of the contract")
    parser.add_argument("--task-dir", help="task workspace host path for the mount plan")
    parser.add_argument("--output-dir", help="run output host path for the mount plan")
    parser.add_argument("--eval-input", help="已确认不含预期答案的被测输入根；只对 subject 角色有效")
    args = parser.parse_args()
    try:
        contract = resolve(args.source, repo=args.repo, require_assets=not args.allow_missing_assets)
        selected = sum(flag is not None and flag is not False
                       for flag in (args.field, args.image_input_digests, args.env_names, args.mount_plan))
        if selected > 1:
            raise ValueError("choose only one of --field、--image-input-digests、--env-names、--mount-plan")
        if args.mount_plan:
            plan = mount_plan(
                contract,
                args.mount_plan,
                task_dir=args.task_dir,
                output_dir=args.output_dir,
                eval_input=args.eval_input,
            )
            print(json.dumps(plan, ensure_ascii=False, separators=(",", ":")))
        elif args.image_input_digests:
            print(json.dumps(image_build_input_digests(lock_path=Path(contract["runtime_lock"])),
                             ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        elif args.env_names:
            if contract["required_env_names"]:
                print("\n".join(contract["required_env_names"]))
        elif args.field:
            value = contract
            for key in args.field.split("."):
                value = value.get(key) if isinstance(value, dict) else None
            if not isinstance(value, str):
                raise ValueError("field must name a top-level string")
            print(value)
        else:
            print(json.dumps(contract, ensure_ascii=False, separators=(",", ":")))
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        print(f"DSH source resolution failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

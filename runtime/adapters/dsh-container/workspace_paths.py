"""程序安装位置与可迁移的用户数据工作区寻址。"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


PROGRAM_ROOT = Path(os.environ.get("HARNESS_PROGRAM_ROOT", Path(__file__).resolve().parents[3])).expanduser().resolve()


def asset_root() -> Path:
    selected = os.environ.get("HARNESS_ASSET_ROOT")
    locator = Path.home() / ".config/harness-engineering-platform/workspace.json"
    if not selected and locator.exists():
        value = json.loads(locator.read_text(encoding="utf-8"))
        selected = value.get("assetRoot") if isinstance(value, dict) else None
        if not isinstance(selected, str) or not Path(selected).is_absolute():
            raise ValueError("部署定位文件必须包含绝对 assetRoot")
    return Path(selected or Path.home() / "harness-engineering-platform-data").expanduser().resolve()


def source_catalog(root: Path) -> Path:
    """初始化工作区只认当前目录；旧提交和隔离 fixture 保留原布局。"""
    current = root / "config/sources.json"
    if current.exists() or (root / "workspace.json").exists():
        return current
    return root / "runtime/adapters/dsh-container/sources.json"


def sites_config(root: Path) -> Path:
    current = root / "config/sites.json"
    if current.exists() or (root / "workspace.json").exists():
        return current
    legacy = root / "runtime/adapters/dsh-web/sites.json"
    return legacy if legacy.is_file() else current


def workspace_descriptor(root: Path) -> dict | None:
    path = root / "workspace.json"
    if not path.exists():
        return None
    descriptor = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(descriptor, dict) or isinstance(descriptor.get("schemaVersion"), bool) \
            or descriptor.get("schemaVersion") != 1 \
            or not isinstance(descriptor.get("id"), str) \
            or not re.fullmatch(r"workspace-[a-zA-Z0-9-]+", descriptor["id"]) \
            or not isinstance(descriptor.get("legacyRoots", []), list) \
            or any(not isinstance(value, str) or not Path(value).is_absolute()
                   for value in descriptor.get("legacyRoots", [])):
        raise ValueError("workspace.json 的 schemaVersion、id 或 legacyRoots 无效")
    return descriptor


def workspace_id(root: Path) -> str | None:
    descriptor = workspace_descriptor(root)
    return descriptor["id"] if descriptor else None


def instance_belongs_to_workspace(root: Path, manifest: dict) -> bool:
    """登记身份优先；旧登记只通过当前根或明确迁移别名下的 Candidate 挂载确认。"""
    if not isinstance(manifest, dict):
        return False
    descriptor = workspace_descriptor(root)
    roots = [root.resolve(), *(Path(value).resolve() for value in (descriptor or {}).get("legacyRoots", []))]
    recorded_id, recorded_root = manifest.get("workspace_id"), manifest.get("asset_root")
    if recorded_id is not None and recorded_id != (descriptor or {}).get("id"):
        return False
    if recorded_root is not None and (not isinstance(recorded_root, str)
            or not Path(recorded_root).is_absolute() or Path(recorded_root).resolve() not in roots):
        return False
    if recorded_root is not None:
        return True  # UUID 可随 Git 克隆；只有 ID 的旧登记仍须核对挂载路径。
    if descriptor is None:
        return True  # 尚无描述符的历史工作区保持原合同，不接纳其他已绑定身份。
    source = manifest.get("source_id", "")
    if not isinstance(source, str) or not re.fullmatch(r"experiment:(?:EXP|VAR)-[a-z0-9]+(?:-[a-z0-9]+)*-\d{3}(?:-r[0-9a-f]{12})?", source):
        return False
    mounts = manifest.get("mounts") or {}
    if not isinstance(mounts, dict):
        return False
    paths = [mounts.get(key) for key in ("workspace", "presets", "managed")]
    if any(value is not None and (not isinstance(value, str) or not Path(value).is_absolute()) for value in paths):
        return False
    paths = [Path(value).resolve() for value in paths if isinstance(value, str) and Path(value).is_absolute()]
    return bool(paths) and any(all(path.is_relative_to(base / "evolution/experiments" / source[11:] / "candidate")
                                   for path in paths) for base in roots)


def instances_root(root: Path) -> Path:
    if os.environ.get("HARNESS_INSTANCE_STATE_ROOT"):
        selected = os.environ["HARNESS_INSTANCE_STATE_ROOT"]
    # 显式 XDG_STATE_HOME 是已有 CLI 调用者和隔离测试的状态覆盖入口。
    elif os.environ.get("XDG_STATE_HOME"):
        selected = str(Path(os.environ["XDG_STATE_HOME"]) / "dsh-dev")
    else:
        return root / ".local/instances"
    if selected.startswith("~") and selected != "~" and not selected.startswith("~/"):
        raise ValueError("实例状态目录仅支持当前用户的 ~ 或 ~/ 路径")
    return (root / Path(selected).expanduser()).resolve()

"""从固定数据提交恢复历史合同测试资产，不依赖当前工作树保留旧版本。"""

import json
import yaml
import atexit
import os
from functools import cache
from pathlib import Path
import subprocess
import tarfile
import tempfile


DATA_REVISION = "1f162a1ce12025ffeb9d2e36c7a3ae283b41e421"


@cache
def historical_assets() -> Path:
    repository = Path(os.environ.get("HARNESS_ASSET_ROOT", Path.home() / "harness-engineering-platform-data"))
    temporary = tempfile.TemporaryDirectory(prefix="harness-test-assets-")
    atexit.register(temporary.cleanup)
    root = Path(temporary.name)
    with subprocess.Popen(
        ["git", "-C", str(repository), "archive", DATA_REVISION,
         "agents", "evolution", "config/sources.json", "config/sites.json"],
        stdout=subprocess.PIPE,
    ) as archive:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as files:
            files.extractall(root, filter="data")
        if archive.wait() != 0:
            raise RuntimeError("无法从固定 Git 提交恢复历史测试资产")
    for identity, source in json.loads((root / "config/sources.json").read_text())["sources"].items():
        manifest = root / "evolution/experiments" / identity / "candidate/harness.yaml"
        if not manifest.exists():
            continue
        value = yaml.safe_load(manifest.read_text())
        value["loadable_assets"] = {"workspace": "dsh/workspace", "preset_root": "dsh/presets", "managed_root": "dsh/managed",
            "preset_id": source["preset"].split("/")[0], "preset_file": source["preset"], "profile_patch": "dsh/managed/" + source["patch"],
            **({"guard": source["guard"]} if source.get("guard") else {}),
            **({"profile_manifest": source["profile_manifest"].split("/candidate/", 1)[1]} if source.get("profile_manifest") else {})}
        value["credential_environment_keys"] = list(dict.fromkeys([*value.get("credential_environment_keys", []), *source.get("required_env_names", []), *source.get("optional_env_names", [])]))
        manifest.write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False))
    return root

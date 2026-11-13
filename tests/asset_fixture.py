"""从仓库自带的精简文件集恢复历史合同测试资产。"""

import json
import yaml
import atexit
from functools import cache
from pathlib import Path
import tarfile
import tempfile



@cache
def historical_assets() -> Path:
    temporary = tempfile.TemporaryDirectory(prefix="harness-test-assets-")
    atexit.register(temporary.cleanup)
    root = Path(temporary.name)
    with tarfile.open(Path(__file__).parent / "fixtures/research-assets.tar.gz") as files:
        files.extractall(root, filter="data")
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
    for manifest in (root / "agents").glob("*/manifest.yaml"):
        value = yaml.safe_load(manifest.read_text())
        active = value.get("active_experiment")
        if active and not (root / "evolution/experiments" / active).exists():
            value["active_experiment"] = None
            manifest.write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False))
    return root

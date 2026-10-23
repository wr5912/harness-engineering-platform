"""从固定数据提交恢复历史合同测试资产，不依赖当前工作树保留旧版本。"""

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
    return root

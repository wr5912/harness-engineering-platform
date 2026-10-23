#!/usr/bin/env python3
"""校验、冻结或恢复所选 DSH Candidate 的三棵资产树，不执行 Harness。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from source_contract import DEFAULT_SOURCE, resolve, strict_json


from workspace_paths import asset_root
REPO = asset_root()
EXPERIMENT = DSH_ROOT = WORKSPACE = FROZEN = None
ALLOWED_ROOTS = set()
SOURCE_ID = DEFAULT_SOURCE
AGENT_ID = None
DEFAULT_LIMITS = {
    "max_file_bytes": 64 * 1024 * 1024,
    "max_total_bytes": 1024 * 1024 * 1024,
    "max_depth": 256,
    "max_nodes": 100_000,
}


def narrowed_limits(override: dict) -> dict:
    for name in override:
        if name not in DEFAULT_LIMITS:
            raise ValueError(f"unknown asset scan limit: {name}")
    limits = {**DEFAULT_LIMITS, **override}
    for name, value in limits.items():
        if type(value) is not int or value < 1 or value > DEFAULT_LIMITS[name]:
            raise ValueError(f"asset scan limit cannot be widened: {name}")
    return limits


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot(root: Path, override: dict = None, *, allowed_roots: set[Path] = None) -> dict:
    root = root.absolute()
    limits = narrowed_limits(override or {})
    if root not in (ALLOWED_ROOTS if allowed_roots is None else allowed_roots):
        raise ValueError("only the three exact selected DSH mount sources are allowed")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("asset root must be a real directory")

    records = []
    directory_records = []
    pending = [(root, 0)]
    nodes = 1
    total_bytes = 0
    while pending:
        folder, depth = pending.pop()
        folder_mode = folder.lstat().st_mode
        if not stat.S_ISDIR(folder_mode):
            raise ValueError(f"asset directory changed type: {folder.relative_to(root)}")
        directory_records.append({
            "path": folder.relative_to(root).as_posix(),
            "mode": f"{stat.S_IMODE(folder_mode) & 0o7777:04o}",
        })
        has_entry = False
        for entry in folder.iterdir():
            if entry.name == "node_modules":
                continue
            has_entry = True
            nodes += 1
            if nodes > limits["max_nodes"]:
                raise ValueError("asset scan exceeds node limit")
            child_depth = depth + 1
            if child_depth > limits["max_depth"]:
                raise ValueError(f"asset scan exceeds depth limit: {entry.relative_to(root)}")
            prior = entry.lstat()
            if stat.S_ISDIR(prior.st_mode):
                pending.append((entry, child_depth))
                continue
            if not stat.S_ISREG(prior.st_mode):
                raise ValueError(f"unsupported asset type: {entry.relative_to(root)}")
            if prior.st_nlink != 1:
                raise ValueError(f"hardlinked asset is not an isolated source: {entry.relative_to(root)}")
            if prior.st_size > limits["max_file_bytes"]:
                raise ValueError(f"asset file exceeds 64 MiB limit: {entry.relative_to(root)}")
            if total_bytes + prior.st_size > limits["max_total_bytes"]:
                raise ValueError("asset scan exceeds 1 GiB total byte limit")

            if not hasattr(os, "O_NOFOLLOW"):
                raise ValueError("O_NOFOLLOW is required for asset scan")
            file_hash = hashlib.sha256()
            descriptor = os.open(str(entry), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as source:
                opened = os.fstat(source.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or (opened.st_dev, opened.st_ino) != (
                    prior.st_dev,
                    prior.st_ino,
                ):
                    raise ValueError(f"asset changed type during scan: {entry.relative_to(root)}")
                if opened.st_size > limits["max_file_bytes"]:
                    raise ValueError(f"asset file exceeds 64 MiB limit: {entry.relative_to(root)}")
                file_bytes = 0
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    file_bytes += len(chunk)
                    if file_bytes > limits["max_file_bytes"]:
                        raise ValueError(f"asset file grew beyond limit: {entry.relative_to(root)}")
                    file_hash.update(chunk)
                after = os.fstat(source.fileno())
                if file_bytes != opened.st_size or (
                    after.st_size,
                    after.st_mtime_ns,
                    after.st_ctime_ns,
                    stat.S_IMODE(after.st_mode),
                ) != (
                    opened.st_size,
                    opened.st_mtime_ns,
                    opened.st_ctime_ns,
                    stat.S_IMODE(opened.st_mode),
                ):
                    raise ValueError(f"asset changed during scan: {entry.relative_to(root)}")
            total_bytes += file_bytes
            if total_bytes > limits["max_total_bytes"]:
                raise ValueError("asset scan exceeds 1 GiB total byte limit")
            records.append({
                "mode": f"{stat.S_IMODE(opened.st_mode) & 0o7777:04o}",
                "path": entry.relative_to(root).as_posix(),
                "sha256": file_hash.hexdigest(),
                "size": file_bytes,
            })
        if not has_entry:
            raise ValueError(f"empty asset directory cannot be frozen: {folder.relative_to(root)}")

    records.sort(key=lambda record: record["path"].encode("utf-8"))
    directory_records.sort(key=lambda record: record["path"].encode("utf-8"))
    serialized = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    serialized_directories = json.dumps(
        directory_records, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return {
        "tree_sha256": "sha256:" + hashlib.sha256(serialized).hexdigest(),
        "directory_sha256": "sha256:" + hashlib.sha256(serialized_directories).hexdigest(),
        "file_count": len(records),
        "total_bytes": total_bytes,
        "files": records,
        "directories": directory_records,
    }


def write_json_once(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write("\n")


def select_source(source_id: str, require_assets: bool = True) -> dict:
    global EXPERIMENT, DSH_ROOT, WORKSPACE, ALLOWED_ROOTS, FROZEN, SOURCE_ID, AGENT_ID
    contract = resolve(source_id, require_assets=require_assets)
    SOURCE_ID = contract["source_id"]
    AGENT_ID = contract["agent_id"]
    DSH_ROOT = Path(contract["candidate_root"])
    WORKSPACE = Path(contract["workspace"])
    ALLOWED_ROOTS = {WORKSPACE, Path(contract["presets"]), Path(contract["managed"])}
    EXPERIMENT = DSH_ROOT.parents[1]
    FROZEN = EXPERIMENT / "snapshots/frozen-sources"
    return contract


def copy_tree(source: Path, destination: Path, expected: dict) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    for record in expected["files"]:
        relative = Path(record["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("invalid frozen file path")
        source_file = source / relative
        target_file = destination / relative
        target_file.parent.mkdir(parents=True, exist_ok=True)
        if source_file.is_symlink() or not source_file.is_file():
            raise ValueError(f"source changed during materialization: {relative}")
        descriptor = os.open(source_file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as input_file, target_file.open("xb") as output_file:
            stat_before = os.fstat(input_file.fileno())
            if not stat.S_ISREG(stat_before.st_mode) or stat_before.st_nlink != 1 \
                    or stat_before.st_size != record["size"]:
                raise ValueError(f"source changed during materialization: {relative}")
            digest = hashlib.sha256()
            size = 0
            while True:
                block = input_file.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > DEFAULT_LIMITS["max_file_bytes"]:
                    raise ValueError(f"source grew during materialization: {relative}")
                digest.update(block)
                output_file.write(block)
            stat_after = os.fstat(input_file.fileno())
            if size != record["size"] or digest.hexdigest() != record["sha256"] \
                    or (stat_before.st_mtime_ns, stat_before.st_ctime_ns, stat_before.st_size) != \
                    (stat_after.st_mtime_ns, stat_after.st_ctime_ns, stat_after.st_size):
                raise ValueError(f"source changed during materialization: {relative}")
        os.chmod(target_file, int(record["mode"], 8))
    for directory in sorted(expected["directories"], key=lambda item: len(Path(item["path"]).parts), reverse=True):
        relative = Path(directory["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("invalid frozen directory path")
        target = destination if relative == Path(".") else destination / relative
        if not target.is_dir() or target.is_symlink():
            raise ValueError(f"frozen directory missing: {relative}")
        os.chmod(target, int(directory["mode"], 8))


def frozen_snapshots(root: Path) -> dict:
    allowed = {root / name for name in ("workspace", "presets", "managed")}
    return {
        name: snapshot(root / name, allowed_roots=allowed)
        for name in ("workspace", "presets", "managed")
    }


def check_freeze_inputs(mounts: dict) -> None:
    """冻结只接受可审查资产，不将被 Git 排除的本机私有文件带入副本。"""
    candidate_env = WORKSPACE / ".env"
    if candidate_env.exists() or candidate_env.is_symlink():
        controlled_env = Path(__file__).resolve().parent / "verification-home-controls/locked-bootstrap.env"
        if candidate_env.is_symlink() or not candidate_env.is_file() \
                or candidate_env.read_bytes() != controlled_env.read_bytes():
            raise ValueError("Candidate workspace .env is not the controlled comment-only sentinel")
    try:
        DSH_ROOT.relative_to(REPO)
    except ValueError:
        return
    paths = [
        str((DSH_ROOT / name / record["path"]).relative_to(REPO))
        for name, mount in mounts.items()
        for record in mount["files"]
    ]
    try:
        completed = subprocess.run(
            ["git", "-C", str(REPO), "check-ignore", "--no-index", "-z", "--stdin"],
            input=("\0".join(paths) + "\0").encode(), capture_output=True, check=False,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("cannot verify Candidate files against Git ignore rules") from error
    if completed.returncode not in (0, 1):
        raise ValueError("cannot verify Candidate files against Git ignore rules")
    if completed.stdout:
        raise ValueError("Candidate includes Git-ignored files; review before freezing")


def candidate_reference() -> str:
    try:
        return DSH_ROOT.relative_to(REPO).as_posix()
    except ValueError:
        return str(DSH_ROOT)


def remove_new_tree(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("cleanup target is not the newly created directory")
    for folder, _, _ in os.walk(root, followlinks=False):
        os.chmod(folder, stat.S_IMODE(Path(folder).lstat().st_mode) | 0o700)
    shutil.rmtree(root)


def freeze() -> None:
    """复制未提交字节；验证源为副本而非仍可写的 Candidate。"""
    before_mounts = {
        name: snapshot(DSH_ROOT / name)
        for name in ("workspace", "presets", "managed")
    }
    check_freeze_inputs(before_mounts)
    freeze_id = "fr-" + str(uuid.uuid4())
    FROZEN.mkdir(parents=True, exist_ok=True)
    temp_root = FROZEN / (".tmp-" + freeze_id)
    final_root = FROZEN / freeze_id
    temp_root.mkdir(exist_ok=False)
    try:
        for name, recorded in before_mounts.items():
            copy_tree(DSH_ROOT / name, temp_root / name, recorded)
        if frozen_snapshots(temp_root) != before_mounts:
            raise ValueError("materialized bytes differ from Candidate scan")
        after_mounts = {
            name: snapshot(DSH_ROOT / name)
            for name in ("workspace", "presets", "managed")
        }
        if after_mounts != before_mounts:
            raise ValueError("Candidate changed during materialization; retry")
        write_json_once(temp_root / "snapshot.json", {
            "schema_version": "1.0",
            "freeze_id": freeze_id,
            "source_id": SOURCE_ID,
            "agent_id": AGENT_ID,
            "created_at": utc_now(),
            "source_candidate_root": candidate_reference(),
            "mount_snapshots": before_mounts,
            "scope": "materialized Candidate source only; not an evaluated baseline or Release",
        })
        temp_root.rename(final_root)
    except BaseException:
        remove_new_tree(temp_root)
        raise
    print(final_root)


def verify_frozen(root: Path) -> dict:
    root = root.absolute()
    if root.parent != FROZEN or not root.name.startswith("fr-") or root.is_symlink() \
            or not root.is_dir() or (root / "snapshot.json").is_symlink():
        raise ValueError("frozen source must be a direct directory under selected Experiment")
    manifest = strict_json(root / "snapshot.json", 64 * 1024 * 1024)
    if manifest.get("schema_version") != "1.0" or manifest.get("freeze_id") != root.name \
            or manifest.get("source_id") != SOURCE_ID or manifest.get("agent_id") != AGENT_ID \
            or manifest.get("source_candidate_root") != candidate_reference():
        raise ValueError("frozen source identity mismatch")
    if frozen_snapshots(root) != manifest.get("mount_snapshots"):
        raise ValueError("frozen source bytes or file modes drifted")
    return manifest


def restore(frozen_source: Path) -> None:
    manifest = verify_frozen(frozen_source)
    if DSH_ROOT.exists() or DSH_ROOT.is_symlink():
        raise ValueError("restore refuses to overwrite an existing Candidate root")
    DSH_ROOT.parent.mkdir(parents=True, exist_ok=True)
    DSH_ROOT.mkdir(exist_ok=False)
    try:
        for name, recorded in manifest["mount_snapshots"].items():
            copy_tree(frozen_source / name, DSH_ROOT / name, recorded)
        if {
            name: snapshot(DSH_ROOT / name)
            for name in ("workspace", "presets", "managed")
        } != manifest["mount_snapshots"]:
            raise ValueError("restored bytes differ from frozen source")
    except BaseException:
        remove_new_tree(DSH_ROOT)
        raise
    print(DSH_ROOT)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="selected DSH Experiment identity")
    commands = parser.add_subparsers(dest="command", required=True)
    digest_parser = commands.add_parser("digest", help="print one exact DSH Candidate mount tree digest")
    digest_parser.add_argument("root", type=Path)
    commands.add_parser("freeze", help="materialize and verify all three Candidate trees")
    restore_parser = commands.add_parser("restore", help="restore a frozen source to an absent Candidate root")
    restore_parser.add_argument("frozen_source", type=Path)
    frozen_digest_parser = commands.add_parser("frozen-digest", help="verify frozen bytes and print one mount digest")
    frozen_digest_parser.add_argument("frozen_source", type=Path)
    frozen_digest_parser.add_argument("mount", choices=("workspace", "presets", "managed"))
    args = parser.parse_args()

    try:
        select_source(args.source, require_assets=args.command not in ("restore", "frozen-digest"))
        if args.command == "digest":
            print(snapshot(args.root)["tree_sha256"])
        elif args.command == "freeze":
            freeze()
        elif args.command == "frozen-digest":
            print(verify_frozen(args.frozen_source)["mount_snapshots"][args.mount]["tree_sha256"])
        else:
            restore(args.frozen_source)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"candidate source failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hep-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

NODE=""
TARBALL=$(find "$ROOT/offline/node" -maxdepth 1 -name 'node-*-linux-*.tar.xz' 2>/dev/null | sort | head -n 1 || true)
if [ -n "$TARBALL" ]; then
  tar -xJf "$TARBALL" -C "$TMP"
  NODE=$(find "$TMP" -maxdepth 3 -type f -path '*/bin/node' | sort | head -n 1)
elif [ -x "$ROOT/offline/node/bin/node" ]; then
  NODE="$ROOT/offline/node/bin/node"
else
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
  echo "install: 安装包没有 Node 运行时，系统 PATH 中也没有 node" >&2
  exit 4
fi
VERSION=$("$NODE" -p "process.versions.node")
MAJOR=$(printf '%s' "$VERSION" | cut -d. -f1)
if [ "$MAJOR" -lt 24 ]; then
  echo "install: 需要 Node 24 或更新版本，当前为 $VERSION" >&2
  exit 4
fi
"$NODE" "$ROOT/program/platform/deploy/cli.mts" install --bundle-root "$ROOT" "$@"

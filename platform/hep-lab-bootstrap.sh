#!/bin/sh
set -eu
umask 077

BOOTSTRAP_VERSION="0.1.0"
DEFAULT_PROGRAM_REPOSITORY="https://github.com/wr5912/harness-engineering-platform.git"
DEFAULT_DATA_REPOSITORY="https://github.com/wr5912/harness-engineering-platform-data.git"
DEFAULT_DATA_COMMIT="34e0250ce621fde03777b70d9c852b2bf8e7efd7"

PROGRAM_REPOSITORY=${HEP_LAB_PROGRAM_REPOSITORY:-$DEFAULT_PROGRAM_REPOSITORY}
PROGRAM_COMMIT=${HEP_LAB_PROGRAM_COMMIT:-}
DATA_REPOSITORY=${HEP_LAB_DATA_REPOSITORY:-$DEFAULT_DATA_REPOSITORY}
DATA_COMMIT=${HEP_LAB_DATA_COMMIT:-$DEFAULT_DATA_COMMIT}
CACHE_ROOT=${HEP_LAB_BOOTSTRAP_CACHE:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/hep-lab}
DESTINATION=""
REUSE=0
START=0

usage() {
  cat <<'EOF'
用法：
  platform/hep-lab-bootstrap.sh --destination <目录> [--reuse] [--start] [--cache-dir <目录>]

作用：下载并校验固定版本的 hep-lab CLI；从数据仓库锁定文件取得四仓库来源；
创建四仓库工作区并写入 hep-lab.yaml。--start 会在初始化后启动平台。

环境变量（仅用于镜像、测试或受控升级）：
  HEP_LAB_PROGRAM_REPOSITORY / HEP_LAB_PROGRAM_COMMIT
  HEP_LAB_DATA_REPOSITORY / HEP_LAB_DATA_COMMIT
  HEP_LAB_BOOTSTRAP_CACHE
EOF
}

fail() { echo "hep-lab-bootstrap: $*" >&2; exit 2; }
need_command() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"; }
sha() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' || fail "提交不是完整的小写 Git SHA：$1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination)
      [ "$#" -ge 2 ] || fail "--destination 缺少值"
      DESTINATION=$2; shift 2 ;;
    --cache-dir)
      [ "$#" -ge 2 ] || fail "--cache-dir 缺少值"
      CACHE_ROOT=$2; shift 2 ;;
    --reuse) REUSE=1; shift ;;
    --start) START=1; shift ;;
    --help|-h) usage; exit 0 ;;
    --version) printf 'hep-lab-bootstrap %s\n' "$BOOTSTRAP_VERSION"; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[ -n "$DESTINATION" ] || fail "需要 --destination <目录>"
sha "$DATA_COMMIT"
need_command git
need_command node

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "无法读取 Node.js 版本" ;;
esac
[ "$NODE_MAJOR" -ge 24 ] || fail "需要 Node.js 24 或更新版本，当前为 $(node -p 'process.versions.node')"

case "$DESTINATION" in
  /*) ;;
  *) DESTINATION=$(pwd -P)/$DESTINATION ;;
esac
case "$CACHE_ROOT" in
  /*) ;;
  *) CACHE_ROOT=$(pwd -P)/$CACHE_ROOT ;;
esac

clone_fixed() {
  url=$1
  commit=$2
  target=$3
  if [ -L "$target" ]; then fail "缓存路径不能是符号链接：$target"; fi
  if [ -e "$target" ]; then
    [ -d "$target/.git" ] || fail "缓存目录不是 Git 仓库：$target"
    origin=$(git -C "$target" remote get-url origin 2>/dev/null || true)
    [ "$origin" = "$url" ] || fail "缓存仓库 origin 不匹配：$target"
    [ -z "$(git -C "$target" status --porcelain --untracked-files=all)" ] || fail "缓存仓库存在未提交修改：$target"
  else
    mkdir -p "$(dirname -- "$target")"
    git -c core.hooksPath=/dev/null init "$target" >/dev/null
    git -C "$target" remote add origin "$url"
  fi
  if ! git -C "$target" cat-file -e "$commit^{commit}" >/dev/null 2>&1; then
    git -c core.hooksPath=/dev/null -C "$target" fetch --depth=1 --no-tags origin "$commit" >/dev/null
  fi
  git -C "$target" cat-file -e "$commit^{commit}" >/dev/null 2>&1 || fail "仓库没有固定提交：$commit"
  git -c core.hooksPath=/dev/null -C "$target" checkout --detach "$commit" >/dev/null
}

lock_value() {
  section=$1
  field=$2
  file=$3
  awk -v section="$section" -v field="$field" '
    $0 == "  " section ":" { inside=1; next }
    inside && $0 ~ /^  [^ ]/ { inside=0 }
    inside && $1 == field ":" { sub(/^[^:]+:[[:space:]]*/, "", $0); gsub(/^["\047]|["\047]$/, "", $0); print; exit }
  ' "$file"
}

mkdir -p "$CACHE_ROOT"; chmod 700 "$CACHE_ROOT" 2>/dev/null || true
DATA_ROOT="$CACHE_ROOT/data-$DATA_COMMIT"
clone_fixed "$DATA_REPOSITORY" "$DATA_COMMIT" "$DATA_ROOT"

LOCK_FILE="$DATA_ROOT/locks/repositories.yaml"
[ -f "$LOCK_FILE" ] || fail "数据仓库缺少 locks/repositories.yaml：$LOCK_FILE"
platform_url=$(lock_value platform url "$LOCK_FILE")
platform_commit=$(lock_value platform commit "$LOCK_FILE")
dsh_url=$(lock_value platform_manager_dsh_home url "$LOCK_FILE")
dsh_commit=$(lock_value platform_manager_dsh_home commit "$LOCK_FILE")
business_url=$(lock_value business_agents url "$LOCK_FILE")
business_commit=$(lock_value business_agents commit "$LOCK_FILE")
for value in "$platform_url" "$platform_commit" "$dsh_url" "$dsh_commit" "$business_url" "$business_commit"; do
  [ -n "$value" ] || fail "数据仓库锁定文件缺少四仓库来源"
done
sha "$platform_commit"; sha "$dsh_commit"; sha "$business_commit"
if [ -n "${HEP_LAB_PROGRAM_REPOSITORY:-}" ] && [ "$PROGRAM_REPOSITORY" != "$platform_url" ]; then
  fail "HEP_LAB_PROGRAM_REPOSITORY 与数据仓库平台来源不一致"
fi
if [ -n "${HEP_LAB_PROGRAM_COMMIT:-}" ] && [ "$PROGRAM_COMMIT" != "$platform_commit" ]; then
  fail "HEP_LAB_PROGRAM_COMMIT 与数据仓库平台提交不一致"
fi
PROGRAM_REPOSITORY="$platform_url"
PROGRAM_COMMIT="$platform_commit"
PROGRAM_ROOT="$CACHE_ROOT/program-$PROGRAM_COMMIT"
clone_fixed "$PROGRAM_REPOSITORY" "$PROGRAM_COMMIT" "$PROGRAM_ROOT"

PLUGIN_ROOT="$PROGRAM_ROOT/platform/plugin"
if [ ! -f "$PLUGIN_ROOT/node_modules/js-yaml/index.js" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm --dir "$PLUGIN_ROOT" install --frozen-lockfile --prod --ignore-scripts
  elif command -v corepack >/dev/null 2>&1; then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --dir "$PLUGIN_ROOT" install --frozen-lockfile --prod --ignore-scripts
  else
    fail "缺少 pnpm 或 corepack，无法准备 hep-lab CLI 依赖"
  fi
fi
[ -f "$PLUGIN_ROOT/node_modules/js-yaml/index.js" ] || fail "无法准备 hep-lab CLI 依赖 js-yaml"

set -- "$PROGRAM_ROOT/platform/hep-lab" init \
  --destination "$DESTINATION" \
  --data-repository "$DATA_REPOSITORY" --data-commit "$DATA_COMMIT" \
  --platform-repository "$platform_url" --platform-commit "$platform_commit" \
  --platform-manager-dsh-home-repository "$dsh_url" --platform-manager-dsh-home-commit "$dsh_commit" \
  --business-agents-repository "$business_url" --business-agents-commit "$business_commit"
[ "$REUSE" -eq 1 ] && set -- "$@" --reuse
echo "hep-lab-bootstrap: 使用程序 $PROGRAM_COMMIT，数据 $DATA_COMMIT；初始化 $DESTINATION" >&2
"$@"

if [ "$START" -eq 1 ]; then
  "$DESTINATION/harness-engineering-platform/platform/dsh-platform" prepare
  exec "$DESTINATION/harness-engineering-platform/platform/dsh-platform" start
fi

cat <<EOF

工作区已初始化：$DESTINATION
检查：$DESTINATION/harness-engineering-platform/platform/hep-lab doctor --lab $DESTINATION
启动：$DESTINATION/harness-engineering-platform/platform/dsh-platform start
EOF

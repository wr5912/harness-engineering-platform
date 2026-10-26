# 开发和安装入口共用；安装环境是安装器生成的工具定位，不是另一套启动配置。
HEP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ -f "$HEP_ROOT/bin/hep-env.sh" ]; then
  . "$HEP_ROOT/bin/hep-env.sh"
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "hep: 需要可执行的 Node.js 24 或更新版本" >&2
  exit 2
fi

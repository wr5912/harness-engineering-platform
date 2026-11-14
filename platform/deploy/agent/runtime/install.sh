#!/bin/bash
set -euo pipefail
usage() { echo '用法：./install.sh [--prefix <空目录>] [--port <端口>] [--host <地址>] [-h|--help]'; }
argument_error() { echo "$1" >&2; usage >&2; exit 2; }
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$SOURCE/runtime/bundle.env"
prefix="${HOME}/.local/share/standalone-agents/${AGENT_ID}"
port=''
public_host=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --prefix|--port|--host)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || argument_error '安装参数缺少值'
      case "$1" in --prefix) prefix=$2 ;; --port) port=$2 ;; --host) public_host=$2 ;; esac
      shift 2 ;;
    *) argument_error '未知安装参数' ;;
  esac
done
if [ -n "$port" ]; then
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$port))" -ge 1 ] && [ "$((10#$port))" -le 65535 ] || argument_error '指定端口无效'
  port=$((10#$port))
fi
[ -z "$public_host" ] || [[ "$public_host" =~ ^[a-zA-Z0-9.-]+$ ]] || argument_error '目标访问地址格式无效'
case "$(uname -m)" in x86_64|amd64) host_arch=amd64 ;; aarch64|arm64) host_arch=arm64 ;; *) echo '仅支持 Linux AMD64/ARM64' >&2; exit 2 ;; esac
[ "$(uname -s)" = Linux ] && [ "$host_arch" = "$AGENT_ARCH" ] || { echo '安装包与目标主机架构不一致' >&2; exit 2; }
if [ ! -f "$SOURCE/SHA256SUMS" ]; then echo '安装包缺少 SHA256SUMS 校验清单' >&2; exit 2; fi
(cd "$SOURCE" && sha256sum -c SHA256SUMS --status) || { echo '安装包文件校验失败，请重新获取完整包' >&2; exit 2; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  bash "$SOURCE/runtime/bootstrap-docker.sh" "$SOURCE/offline/docker"
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null; then systemctl start docker; fi
  docker info >/dev/null 2>&1 || { echo 'Docker daemon 不可用或当前用户无权限，请修复后重新安装' >&2; exit 2; }
fi
if [ -d "$prefix" ] && [ -n "$(ls -A "$prefix")" ]; then echo '安装目录不是空目录；已有部署请使用其 agent 启动器' >&2; exit 2; fi
if [ "${AGENT_PROFILE:-web}" = sdk ]; then
  [ -z "$port$public_host" ] || { echo 'SDK 型智能体不发布 Web 地址，无需指定 --port 或 --host' >&2; exit 2; }
else
# Docker 可通过 NAT 发布端口而不创建宿主监听进程，需与全部 IPv4/IPv6 LISTEN 一起核对。
declare -A occupied_ports=()
proc_tables=(/proc/net/tcp)
if [ -r /proc/net/tcp6 ]; then proc_tables+=(/proc/net/tcp6); fi
tcp_ports=$(awk '$4 == "0A" { split($2, address, ":"); print address[2] }' "${proc_tables[@]}") || { echo '无法读取主机 TCP 监听状态，请检查后重试' >&2; exit 2; }
while IFS= read -r hex_port; do
  if [[ "$hex_port" =~ ^[0-9A-Fa-f]{4}$ ]]; then occupied_ports[$((16#$hex_port))]=1; fi
done <<< "$tcp_ports"
running_containers=$(docker ps --format '{{.ID}}') || { echo '无法读取 Docker 已有端口映射，请检查后重试' >&2; exit 2; }
if [ -n "$running_containers" ]; then
  mapfile -t container_ids <<< "$running_containers"
  docker_mappings=$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s %s\n" $port .HostPort}}{{end}}{{end}}' "${container_ids[@]}") || { echo '无法核对 Docker 已有端口映射，请检查 Docker 状态后重试' >&2; exit 2; }
  while read -r container_port host_port; do
    if [[ "$container_port" = */tcp && "$host_port" =~ ^[0-9]+$ ]]; then occupied_ports[$((10#$host_port))]=1; fi
  done <<< "$docker_mappings"
fi
if [ -z "$port" ]; then
  for ((candidate=18500; candidate<=28999; candidate++)); do
    if [ -z "${occupied_ports[$candidate]:-}" ]; then port=$candidate; break; fi
  done
fi
[[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { echo '没有可用端口或指定端口无效' >&2; exit 2; }
port=$((10#$port))
if [ -n "${occupied_ports[$port]:-}" ]; then echo '指定端口已被占用，请使用其他端口重新安装；安装目录未写入' >&2; exit 2; fi
fi
mkdir -p "$prefix"
cp -a "$SOURCE"/. "$prefix"/
chmod 700 "$prefix" "$prefix/install.sh" "$prefix/standalone_agent_launcher"
mkdir -p "$prefix/state/home"
runtime_uid=$(id -u)
runtime_gid=$(id -g)
if [ "$runtime_uid" = 0 ]; then runtime_uid=1000; runtime_gid=1000; chown -R "$runtime_uid:$runtime_gid" "$prefix"; fi
deployment="hep-agent-${AGENT_ID}-$(date +%s)-${RANDOM}"
if [ -z "$public_host" ]; then
  public_host=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}' || true)
  public_host=${public_host:-$(hostname -I 2>/dev/null | awk '{print $1}' || true)}
fi
public_host=${public_host:-127.0.0.1}
[[ "$public_host" =~ ^[a-zA-Z0-9.-]+$ ]] || argument_error '目标访问地址格式无效'
printf 'AGENT_PORT=%s\nCOMPOSE_PROJECT_NAME=%s\nAGENT_HOST=%s\nAGENT_UID=%s\nAGENT_GID=%s\n' "$port" "$deployment" "$public_host" "$runtime_uid" "$runtime_gid" > "$prefix/state/deployment.env"
chmod 600 "$prefix/state/deployment.env"
if [ "$(id -u)" = 0 ]; then chown "$runtime_uid:$runtime_gid" "$prefix/state/deployment.env"; fi
# 镜像导入和身份校验统一由运行器执行，安装入口不维护另一套判断。
if [ "${AGENT_PROFILE:-web}" = sdk ]; then
  "$prefix/standalone_agent_launcher" prepare-sdk
  printf '安装目录：%s\nSDK 环境已准备，尚未提交任务。\n运行：%s/standalone_agent_launcher run --input-file <JSON文件>\n' "$prefix" "$prefix"
else
  "$prefix/standalone_agent_launcher" start
  printf '安装目录：%s\n再次启动：%s/standalone_agent_launcher start\n' "$prefix" "$prefix"
fi
# 镜像已经导入 Docker；安装目录只保留运行资产，原始安装包仍可用于恢复。
rm -rf -- "$prefix/images" "$prefix/offline"
echo '标准 Runtime 镜像已核验，安装目录中的镜像归档和 Docker 安装介质已清理；Harness、HOME 与原始安装源保留。'

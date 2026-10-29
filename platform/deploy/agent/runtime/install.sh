#!/bin/bash
set -euo pipefail
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$SOURCE/runtime/bundle.env"
prefix="${HOME}/.local/share/standalone-agents/${AGENT_ID}"
port=''
public_host=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix=${2:?缺少安装目录}; shift 2 ;;
    --port) port=${2:?缺少端口}; shift 2 ;;
    --host) public_host=${2:?缺少主机地址}; shift 2 ;;
    --help) echo '用法：./install.sh [--prefix <空目录>] [--port <端口>] [--host <地址>]'; exit 0 ;;
    *) echo "未知安装参数：$1" >&2; exit 2 ;;
  esac
done
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
mkdir -p "$prefix"
cp -a "$SOURCE"/. "$prefix"/
chmod 700 "$prefix" "$prefix/install.sh" "$prefix/agent"
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
[[ "$public_host" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo '目标访问地址格式无效' >&2; exit 2; }
printf 'AGENT_PORT=%s\nCOMPOSE_PROJECT_NAME=%s\nAGENT_HOST=%s\nAGENT_UID=%s\nAGENT_GID=%s\n' "$port" "$deployment" "$public_host" "$runtime_uid" "$runtime_gid" > "$prefix/state/deployment.env"
chmod 600 "$prefix/state/deployment.env"
if [ "$(id -u)" = 0 ]; then chown "$runtime_uid:$runtime_gid" "$prefix/state/deployment.env"; fi
docker load -i "$prefix/images/dsh-runtime.tar" >/dev/null
actual_arch=$(docker image inspect "$IMAGE_TAG" --format '{{.Architecture}}')
[ "$actual_arch" = "$AGENT_ARCH" ] || { echo '导入镜像架构不一致；安装结果已保留' >&2; exit 2; }
actual_id=$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')
actual_fingerprint=$(docker image inspect "$IMAGE_TAG" --format '{{index .Config.Labels "org.ai-agent-harness.dsh.image-build-fingerprint"}}')
[ -n "${IMAGE_ID:-}" ] && [ "$actual_id" = "$IMAGE_ID" ] || { echo '导入镜像身份不一致；安装结果已保留' >&2; exit 2; }
[ -n "${IMAGE_FINGERPRINT:-}" ] && [ "$actual_fingerprint" = "$IMAGE_FINGERPRINT" ] || { echo '导入镜像指纹不一致；安装结果已保留' >&2; exit 2; }
"$prefix/agent" start
printf '安装目录：%s\n再次启动：%s/agent start\n' "$prefix" "$prefix"

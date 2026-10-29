#!/bin/bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then
  echo 'Docker 离线引导需要 root；已有 Docker 的目标机可直接使用平台安装器。' >&2
  exit 2
fi
if ! command -v systemctl >/dev/null; then
  echo 'Docker 离线引导需要 systemd，请先为当前系统安装并启动 Docker。' >&2
  exit 2
fi
resource_root=${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/bootstrap}
if ! command -v docker >/dev/null; then
  shopt -s nullglob
  archives=("$resource_root"/docker-*.tgz)
  if [ "${#archives[@]}" != 1 ] || [ ! -x "$resource_root/docker-compose" ]; then
    echo 'Docker 离线资源应包含一个 docker-*.tgz 和可执行的 docker-compose；请提供与目标架构一致的官方二进制。' >&2
    exit 2
  fi
  if systemctl cat docker.service >/dev/null 2>&1; then
    echo 'Docker 命令缺失但已有 Docker 服务配置，请先修复现有安装；未覆盖服务。' >&2
    exit 2
  fi
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT
  tar -xzf "${archives[0]}" -C "$temporary"
  # 写入系统前实际执行，提前发现架构或运行库不兼容。
  "$temporary/docker/docker" --version
  "$temporary/docker/dockerd" --version
  "$resource_root/docker-compose" version
  mkdir -p /usr/local/bin
  install -m 0755 "$temporary"/docker/* /usr/local/bin/
  install -D -m 0755 "$resource_root/docker-compose" /usr/local/lib/docker/cli-plugins/docker-compose
  if command -v restorecon >/dev/null; then restorecon -RF /usr/local/bin /usr/local/lib/docker; fi
  cat > /etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Docker Engine
After=network.target
[Service]
Type=notify
ExecStart=/usr/local/bin/dockerd
Restart=on-failure
Delegate=yes
KillMode=process
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi
# Engine 与 Compose 独立检查，已有 Engine 不因缺少插件被覆盖。
if ! docker compose version >/dev/null 2>&1; then
  if [ ! -x "$resource_root/docker-compose" ]; then
    echo 'Docker Engine 已有，但缺少 Compose；离线资源需要可执行的 docker-compose。' >&2
    exit 2
  fi
  "$resource_root/docker-compose" version
  install -D -m 0755 "$resource_root/docker-compose" /usr/local/lib/docker/cli-plugins/docker-compose
  if command -v restorecon >/dev/null; then restorecon -RF /usr/local/lib/docker; fi
fi
systemctl enable --now docker
docker version --format '{{.Server.Version}} {{.Server.Arch}}'
docker compose version

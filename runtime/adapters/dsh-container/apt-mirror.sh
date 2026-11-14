#!/bin/sh
# 把基础镜像的 Debian APT 主源切换到指定镜像，并在切换后强制签名核验。
# 默认优先使用阿里云主源和 security；TUNA、Debian 官方源作为显式回退。
set -eu

tuna_main=http://mirrors.tuna.tsinghua.edu.cn/debian
aliyun_main=http://mirrors.aliyun.com/debian
official_main=http://deb.debian.org/debian
aliyun_security=http://mirrors.aliyun.com/debian-security
official_security=http://deb.debian.org/debian-security

task_main_mirror="${1:-$aliyun_main}"
task_security_mirror="$official_security"

case "$task_main_mirror" in
  "$aliyun_main") task_security_mirror="$aliyun_security" ;;
  "$tuna_main"|"$official_main") task_security_mirror="$official_security" ;;
  *)
    printf 'Unsupported apt mirror: %s\n' "$task_main_mirror" >&2
    exit 2
    ;;
esac

task_sources=/etc/apt/sources.list.d/debian.sources

test -f "$task_sources"
test "$(grep -c '^Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg$' "$task_sources")" -eq 2
grep -q "^URIs: $official_main\$" "$task_sources"
grep -q "^URIs: $official_security\$" "$task_sources"

if [ "$task_main_mirror" != "$official_main" ]; then
  # 原始 URI 已被精确 grep 锁定；镜像的 main/security 均保持签名校验。
  sed -i "s#^URIs: $official_main\$#URIs: $task_main_mirror#" "$task_sources"
  sed -i "s#^URIs: $official_security\$#URIs: $task_security_mirror#" "$task_sources"
fi

grep -Fqx "URIs: $task_main_mirror" "$task_sources"
grep -Fqx "URIs: $task_security_mirror" "$task_sources"
test "$(grep -c '^Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg$' "$task_sources")" -eq 2

# APT 核验 Release/InRelease 签名、Suite 与 Valid-Until；任一索引失败即中止。
apt-get -o APT::Update::Error-Mode=any \
  -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::ForceIPv4=true update

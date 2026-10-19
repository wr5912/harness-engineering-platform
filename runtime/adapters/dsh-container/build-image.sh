#!/usr/bin/env bash
set -euo pipefail

task_adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
task_repo_dir="$(cd "$task_adapter_dir/../../.." && pwd -P)"
task_source_dir=""
task_source_id="EXP-security-operations-expert-001"
task_evidence_file=""
task_build_network="default"
# 构建期 APT 默认使用 TUNA 主源和 Debian 官方 security；npm/pnpm 走 registry.npmmirror.com。
# 只有 TUNA 不可达时，才由调用方显式改回 Debian 官方主源。
task_apt_mirror="http://mirrors.tuna.tsinghua.edu.cn/debian"
task_npm_registry="https://registry.npmmirror.com"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      printf 'Usage: %s [--source EXP-agent-NNN-r12hex] [--evidence-output FILE] [--build-network host] [--apt-mirror http://mirrors.tuna.tsinghua.edu.cn/debian|http://deb.debian.org/debian]\n' "$0"
      printf 'Build locked official DSH source. APT defaults to TUNA main with Debian official security;\n'
      printf 'the official Debian APT source is an explicit fallback when the mirror is unreachable.\n'
      printf 'Host network is opt-in for local build egress only.\n'
      exit 0
      ;;
    --evidence-output)
      if [[ $# -lt 2 || -n "$task_evidence_file" ]]; then
        printf 'Missing or duplicate --evidence-output value\n' >&2
        exit 2
      fi
      task_evidence_file="$2"
      shift 2
      ;;
    --source)
      if [[ $# -lt 2 ]]; then
        printf 'Missing --source value\n' >&2
        exit 2
      fi
      task_source_id="$2"
      shift 2
      ;;
    --build-network)
      if [[ $# -lt 2 || "$2" != host || "$task_build_network" != default ]]; then
        printf 'Only one explicit --build-network host is supported\n' >&2
        exit 2
      fi
      task_build_network="host"
      shift 2
      ;;
    --apt-mirror)
      # TUNA 是默认主源；官方主源只作为 TUNA 不可达时的显式回退。
      if [[ $# -lt 2 || ( "$2" != http://mirrors.tuna.tsinghua.edu.cn/debian && "$2" != http://deb.debian.org/debian ) || "$task_apt_mirror" != http://mirrors.tuna.tsinghua.edu.cn/debian ]]; then
        printf 'Only the TUNA default or an explicit Debian official fallback is supported\n' >&2
        exit 2
      fi
      task_apt_mirror="$2"
      shift 2
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
task_source_commit="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.commit)"
task_source_tree="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.tree)"
task_lock_sha="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.pnpm_lock_sha256)"
task_package_manager="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.package_manager)"
task_pnpm_version="${task_package_manager#pnpm@}"
task_node_base="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.node_base)"
task_platform="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.platform)"
task_cli_version="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.cli_version)"
task_image_tag="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.local_image_tag)"
task_image_build_fingerprint="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.build_fingerprint)"
task_image_input_digests="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --image-input-digests)"
task_image_label_key="org.ai-agent-harness.dsh.image-build-fingerprint"
task_source_repository="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field image.repository)"
task_experiment_root="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" --field experiment_root)"
if [[ -z "$task_evidence_file" ]]; then
  task_evidence_file="$task_experiment_root/evaluation/evidence/dsh-image-build-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
fi

task_cleanup() {
  if [[ -n "$task_source_dir" && -d "$task_source_dir" && "$task_source_dir" == /tmp/dsh-adapter-source.* ]]; then
    rm -rf -- "$task_source_dir"
  fi
}
trap task_cleanup EXIT

command -v git >/dev/null
command -v docker >/dev/null
command -v python3 >/dev/null

task_source_dir="$(mktemp -d /tmp/dsh-adapter-source.XXXXXXXX)"
git -C "$task_source_dir" init -q
git -C "$task_source_dir" remote add origin "$task_source_repository"
git -C "$task_source_dir" fetch --depth=1 origin "$task_source_commit"
git -C "$task_source_dir" checkout --detach --quiet FETCH_HEAD

[[ "$(git -C "$task_source_dir" rev-parse HEAD)" == "$task_source_commit" ]]
[[ "$(git -C "$task_source_dir" rev-parse HEAD^{tree})" == "$task_source_tree" ]]
[[ "$(sha256sum "$task_source_dir/pnpm-lock.yaml" | cut -d ' ' -f 1)" == "$task_lock_sha" ]]
# 固定提交核验完成后去掉每次 fetch 都不同的 Git 元数据，保持源码构建缓存稳定。
rm -rf -- "$task_source_dir/.git"

# 使用同一固定 Node 底座与 mirror 规则先签名核验 main/updates/security 索引。
# 如果镜像缺 security、签名或 Valid-Until 不通过，不进入耗时的 DSH 构建。
docker run --rm --network "$task_build_network" \
  --env http_proxy --env https_proxy --env no_proxy \
  --env HTTP_PROXY --env HTTPS_PROXY --env NO_PROXY \
  --mount "type=bind,src=$task_adapter_dir/apt-mirror.sh,dst=/opt/dsh-adapter/apt-mirror.sh,readonly" \
  --entrypoint sh \
  "$task_node_base" \
  /opt/dsh-adapter/apt-mirror.sh "$task_apt_mirror"

docker buildx build \
  --platform "$task_platform" \
  --network "$task_build_network" \
  --build-context "dsh_source=$task_source_dir" \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$task_source_commit" \
  --build-arg "DSH_LOCK_SHA256=$task_lock_sha" \
  --build-arg "DSH_CLI_VERSION=$task_cli_version" \
  --build-arg "DSH_PACKAGE_MANAGER=$task_package_manager" \
  --build-arg "DSH_NODE_BASE=$task_node_base" \
  --build-arg "DSH_APT_MIRROR=$task_apt_mirror" \
  --build-arg "DSH_NPM_REGISTRY=$task_npm_registry" \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --load \
  --label "$task_image_label_key=$task_image_build_fingerprint" \
  -t "$task_image_tag" \
  -f "$task_adapter_dir/Dockerfile" \
  "$task_adapter_dir"

task_image_id="$(docker image inspect "$task_image_tag" --format '{{.Id}}')"
task_image_platform="$(docker image inspect "$task_image_tag" --format '{{.Os}}/{{.Architecture}}')"
task_image_labels="$(docker image inspect "$task_image_tag" --format '{{json .Config.Labels}}')"
task_image_label="$(python3 -c 'import json,sys; print((json.loads(sys.argv[1]) or {}).get(sys.argv[2], ""))' \
  "$task_image_labels" "$task_image_label_key")"
task_image_ref="$task_image_tag@$task_image_id"
task_runtime_version="$(docker run --rm --network none --entrypoint node "$task_image_ref" /opt/dsh/apps/cli/lib/bin.js --version)"
task_dsh_command_version="$(docker run --rm --network none --entrypoint dsh "$task_image_ref" --version)"
task_dsh_web_help="$(docker run --rm --network none --entrypoint dsh "$task_image_ref" web --help)"
task_pnpm_runtime_version="$(docker run --rm --network none --entrypoint pnpm "$task_image_ref" --version)"
[[ "$task_image_platform" == "$task_platform" ]]
[[ "$task_image_label" == "$task_image_build_fingerprint" ]]
[[ "$task_runtime_version" == "$task_cli_version" ]]
[[ "$task_dsh_command_version" == "$task_cli_version" ]]
[[ "$task_dsh_web_help" == *"Usage: dsh --profile web"* ]]
[[ "$task_pnpm_version" != "$task_package_manager" && "$task_pnpm_runtime_version" == "$task_pnpm_version" ]]
docker run --rm --network none --entrypoint sh "$task_image_ref" -c 'test -x /usr/bin/chromium'

python3 - "$task_evidence_file" "$task_source_id" "$task_source_repository" "$task_source_commit" "$task_source_tree" "$task_lock_sha" "$task_package_manager" "$task_node_base" "$task_image_tag" "$task_image_id" "$task_image_platform" "$task_runtime_version" "$task_dsh_command_version" "$task_pnpm_runtime_version" "$task_build_network" "$task_apt_mirror" "$task_npm_registry" "$task_image_build_fingerprint" "$task_image_label_key" "$task_image_input_digests" <<'PY'
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

target = Path(sys.argv[1]).absolute()
target.parent.mkdir(parents=True, exist_ok=True)
evidence = {
    "schema_version": "1.1",
    "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "build_status": "pass",
    "source_id": sys.argv[2],
    "source_repository": sys.argv[3],
    "source_commit": sys.argv[4],
    "source_tree": sys.argv[5],
    "pnpm_lock_sha256": sys.argv[6],
    "package_manager": sys.argv[7],
    "node_base": sys.argv[8],
    "local_image_tag": sys.argv[9],
    "local_image_id": sys.argv[10],
    "platform": sys.argv[11],
    "dsh_cli_version": sys.argv[12],
    "dsh_command_version": sys.argv[13],
    "pnpm_runtime_version": sys.argv[14],
    "build_network_mode": sys.argv[15],
    "apt_mirror_main": sys.argv[16],
    "apt_mirror_security": "http://deb.debian.org/debian-security",
    "npm_registry": sys.argv[17],
    "image_build_fingerprint": sys.argv[18],
    "image_label_key": sys.argv[19],
    "image_input_digests": json.loads(sys.argv[20]),
    "chromium_executable": "/usr/bin/chromium",
    "apt_signed_metadata_preflight": "pass",
    "registry_digest_verified": False,
    "scope": "local image build and CLI identity only; no Harness or business acceptance",
}
with target.open("x", encoding="utf-8") as output:
    json.dump(evidence, output, ensure_ascii=False, indent=2)
    output.write("\n")
PY

printf 'DSH source commit: %s\n' "$task_source_commit"
printf 'DSH image tag: %s\n' "$task_image_tag"
printf 'Local image ID: %s\n' "$task_image_id"
printf 'Image build fingerprint: %s\n' "$task_image_build_fingerprint"
printf 'DSH CLI version: %s\n' "$task_runtime_version"
printf 'dsh command version: %s\n' "$task_dsh_command_version"
printf 'pnpm runtime version: %s\n' "$task_pnpm_runtime_version"
printf 'Build network mode: %s\n' "$task_build_network"
printf 'APT mirror main: %s\n' "$task_apt_mirror"
printf 'npm registry: %s\n' "$task_npm_registry"
printf 'Registry digest: not available until the image is pushed and verified\n'
printf 'Build evidence: %s\n' "$task_evidence_file"

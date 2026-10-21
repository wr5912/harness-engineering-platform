#!/usr/bin/env bash
set -euo pipefail

task_adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
task_mode="verification"
task_source_id="EXP-security-operations-expert-001"
task_frozen_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      printf 'Usage: %s [verification] [--source experiment:EXP-agent-NNN-r12hex] [--frozen FROZEN_SOURCES_DIR]\n' "$0"
      printf 'Compare exact host/container mounts and DSH composed config; no business acceptance.\n'
      exit 0 ;;
    verification)
      task_mode="$1"; shift ;;
    --source)
      if [[ $# -lt 2 ]]; then exit 2; fi
      task_source_id="$2"; shift 2 ;;
    --frozen)
      if [[ $# -lt 2 || -n "$task_frozen_root" ]]; then exit 2; fi
      task_frozen_root="$2"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ -n "$task_frozen_root" ]]; then
  task_frozen_root="$(realpath -e -- "$task_frozen_root")"
  if [[ -f "$task_frozen_root/snapshot.json" ]]; then
    printf 'Research snapshots are retired; restore the historical combination from Git (see snapshots/README.md).\n' >&2
    exit 2
  fi
fi

task_source_resolve_options=()
if [[ -n "$task_frozen_root" ]]; then
  task_source_resolve_options+=(--allow-missing-assets)
fi
task_source_json="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}")"
task_default_env_text="$(python3 "$task_adapter_dir/source_contract.py" --allow-missing-assets --env-names)"
task_selected_env_text="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --env-names)"
task_default_env_names=()
task_selected_env_names=()
if [[ -n "$task_default_env_text" ]]; then mapfile -t task_default_env_names <<<"$task_default_env_text"; fi
if [[ -n "$task_selected_env_text" ]]; then mapfile -t task_selected_env_names <<<"$task_selected_env_text"; fi
task_compose_prefix=(env)
task_run_env_args=()
for task_env_name in "${task_default_env_names[@]}"; do
  task_env_required=false
  for task_selected_name in "${task_selected_env_names[@]}"; do
    if [[ "$task_selected_name" == "$task_env_name" ]]; then task_env_required=true; break; fi
  done
  if [[ "$task_env_required" == false ]]; then task_compose_prefix+=(-u "$task_env_name"); fi
done
for task_env_name in "${task_selected_env_names[@]}"; do
  task_env_in_compose=false
  for task_default_name in "${task_default_env_names[@]}"; do
    if [[ "$task_default_name" == "$task_env_name" ]]; then task_env_in_compose=true; break; fi
  done
  if [[ "$task_env_in_compose" == false ]]; then task_run_env_args+=(-e "$task_env_name"); fi
done
task_candidate_root="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field candidate_root)"
task_image_tag="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field image.local_image_tag)"
task_image_build_fingerprint="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field image.build_fingerprint)"
task_image_platform_expected="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field image.platform)"
task_image_label_key="org.ai-agent-harness.dsh.image-build-fingerprint"
task_patch="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field patch)"
if [[ -n "$task_frozen_root" ]]; then
  task_candidate_root="$task_frozen_root"
fi
# 适配层脚本不在镜像里，由本目录只读挂载进容器；因此脚本改动只需重启实例，不必重建镜像。
export DSH_ADAPTER_HOST="$task_adapter_dir"
export DSH_WEB_ADAPTER_HOST="$(cd "$task_adapter_dir/../dsh-web" && pwd -P)"
export DSH_WEB_PROFILE_MANIFEST_HOST="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field profile_manifest)"
export DSH_WEB_PROFILE_SEED_DIR_HOST="$(dirname -- "$DSH_WEB_PROFILE_MANIFEST_HOST")"
export DSH_MANAGED_PATCH="$task_patch"
export DSH_EVAL_TARGET_PRESET="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field preset_id)"
export DSH_EVALUATION_PATCH="$(python3 "$task_adapter_dir/source_contract.py" --source "$task_source_id" "${task_source_resolve_options[@]}" --field evaluation_patch)"
export DSH_WORKSPACE_HOST="$task_candidate_root/workspace"
export DSH_PRESETS_HOST="$task_candidate_root/presets"
export DSH_MANAGED_HOST="$task_candidate_root/managed"

if [[ -n "$task_frozen_root" ]]; then
  task_workspace_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" frozen-digest "$task_frozen_root" workspace)"
  task_presets_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" frozen-digest "$task_frozen_root" presets)"
  task_managed_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" frozen-digest "$task_frozen_root" managed)"
else
  task_workspace_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" digest "$task_candidate_root/workspace")"
  task_presets_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" digest "$task_candidate_root/presets")"
  task_managed_sha="$(python3 "$task_adapter_dir/mutation-receipt.py" --source "$task_source_id" digest "$task_candidate_root/managed")"
fi
task_user_patch_sha=""
task_web_manifest_sha=""
task_global_agents_sha=""
task_bootstrap_env_sha=""
task_module_deny_sha=""
task_prepare_script_sha=""
task_verify_script_sha=""
task_tree_script_sha=""

task_user_patch_sha="sha256:$(sha256sum "$task_adapter_dir/verification-home-controls/locked-user.patch.yml" | cut -d ' ' -f 1)"
task_web_manifest_sha="sha256:$(sha256sum "$DSH_WEB_PROFILE_MANIFEST_HOST" | cut -d ' ' -f 1)"
task_global_agents_sha="sha256:$(sha256sum "$task_adapter_dir/verification-home-controls/locked-global.AGENTS.md" | cut -d ' ' -f 1)"
task_bootstrap_env_sha="sha256:$(sha256sum "$task_adapter_dir/verification-home-controls/locked-bootstrap.env" | cut -d ' ' -f 1)"
task_module_deny_sha="sha256:$(sha256sum "$task_adapter_dir/verification-home-controls/module-deny/POLICY.md" | cut -d ' ' -f 1)"
task_prepare_script_sha="sha256:$(sha256sum "$task_adapter_dir/prepare-verification-home.mjs" | cut -d ' ' -f 1)"
task_verify_script_sha="sha256:$(sha256sum "$task_adapter_dir/verify-load.mjs" | cut -d ' ' -f 1)"
task_tree_script_sha="sha256:$(sha256sum "$task_adapter_dir/tree-digest.mjs" | cut -d ' ' -f 1)"

# Docker 会在 RW parent bind 下为缺失的 nested file target 隐式创建宿主文件。
# 这里要求 Candidate owner 的仅注释 sentinel 精确存在，禁止隐式写入或私密 .env。
task_workspace_env="$task_candidate_root/workspace/.env"
task_workspace_env_sentinel_sha="e574f8d1faf66f9167c33055ae1e2f99c70b031811f64aaac5bae1be54a19489"
if [[ ! -f "$task_workspace_env" || -L "$task_workspace_env" ]] \
  || [[ "$(stat -c '%h' "$task_workspace_env")" != 1 ]] \
  || [[ "$(sha256sum "$task_workspace_env" | cut -d ' ' -f 1)" != "$task_workspace_env_sentinel_sha" ]]; then
  printf 'Selected workspace .env mount target is absent or differs from controlled comment-only sentinel.\n' >&2
  exit 1
fi

python3 "$task_adapter_dir/preflight-access.py" \
  "$DSH_WORKSPACE_HOST" "$DSH_PRESETS_HOST" "$DSH_MANAGED_HOST"

if ! task_image_id="$(docker image inspect "$task_image_tag" --format '{{.Id}}')"; then
  printf 'Locked image is missing; run dsh-dev image build --source %s first.\n' "$task_source_id" >&2
  exit 1
fi
if [[ ! "$task_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'Locked image returned an invalid Image ID: %s.\n' "$task_image_id" >&2
  exit 1
fi
task_image_platform="$(docker image inspect "$task_image_tag" --format '{{.Os}}/{{.Architecture}}')"
task_image_labels="$(docker image inspect "$task_image_tag" --format '{{json .Config.Labels}}')"
task_image_label="$(python3 -c 'import json,sys; print((json.loads(sys.argv[1]) or {}).get(sys.argv[2], ""))' \
  "$task_image_labels" "$task_image_label_key")"
if [[ "$task_image_label" != "$task_image_build_fingerprint" ]]; then
  printf 'Locked image build fingerprint mismatch; rebuild %s before verification.\n' "$task_image_tag" >&2
  exit 1
fi
if [[ "$task_image_platform" != "$task_image_platform_expected" ]]; then
  printf 'Locked image platform mismatch: expected %s, got %s.\n' "$task_image_platform_expected" "$task_image_platform" >&2
  exit 1
fi
task_image_ref="$task_image_tag@$task_image_id"
export DSH_IMAGE_TAG="$task_image_ref"
node "$DSH_WEB_ADAPTER_HOST/build.mjs"
"${task_compose_prefix[@]}" docker compose -f "$task_adapter_dir/verification.compose.yaml" config --quiet

# 先在无卷、无网络的容器中核挂载进来的三脚本身份：脚本来自本目录的只读 bind，
# 因此这里核对的是"容器实际读到的字节"与"宿主审查过的字节"一致，而不是镜像是否过期。
task_mounted_script_hashes="$(docker run --rm --platform "$task_image_platform_expected" --network none --read-only --user 1000:1000 \
  --mount "type=bind,src=$task_adapter_dir,dst=/opt/dsh-adapter,readonly" \
  --entrypoint sha256sum "$task_image_ref" \
  /opt/dsh-adapter/prepare-verification-home.mjs \
  /opt/dsh-adapter/verify-load.mjs \
  /opt/dsh-adapter/tree-digest.mjs)"
for task_script_record in \
  "${task_prepare_script_sha#sha256:} /opt/dsh-adapter/prepare-verification-home.mjs" \
  "${task_verify_script_sha#sha256:} /opt/dsh-adapter/verify-load.mjs" \
  "${task_tree_script_sha#sha256:} /opt/dsh-adapter/tree-digest.mjs"; do
  if ! awk -v wanted="$task_script_record" '{ if (($1 " " $2) == wanted) found=1 } END { exit !found }' \
    <<<"$task_mounted_script_hashes"; then
    printf 'Mounted adapter scripts differ from the reviewed files in this directory.\n' >&2
    exit 1
  fi
done

# `run --no-deps` 会跳过 Compose depends_on；先显式准备首次
# 空数据卷的精确子文件与模块目录挂载目标，并核对 home-init 的非零退出。
"${task_compose_prefix[@]}" docker compose -f "$task_adapter_dir/verification.compose.yaml" run --rm --no-deps home-init

"${task_compose_prefix[@]}" docker compose -f "$task_adapter_dir/verification.compose.yaml" run --rm --no-deps \
  "${task_run_env_args[@]}" \
  -e "DSH_EXPECT_WORKSPACE_TREE_SHA=$task_workspace_sha" \
  -e "DSH_EXPECT_PRESETS_TREE_SHA=$task_presets_sha" \
  -e "DSH_EXPECT_MANAGED_TREE_SHA=$task_managed_sha" \
  -e "DSH_EXPECT_USER_PATCH_SHA=$task_user_patch_sha" \
  -e "DSH_EXPECT_WEB_MANIFEST_SHA=$task_web_manifest_sha" \
  -e "DSH_EXPECT_GLOBAL_AGENTS_SHA=$task_global_agents_sha" \
  -e "DSH_EXPECT_BOOTSTRAP_ENV_SHA=$task_bootstrap_env_sha" \
  -e "DSH_EXPECT_MODULE_DENY_SHA=$task_module_deny_sha" \
  -e "DSH_EXPECT_PREPARE_SCRIPT_SHA=$task_prepare_script_sha" \
  -e "DSH_EXPECT_VERIFY_SCRIPT_SHA=$task_verify_script_sha" \
  -e "DSH_EXPECT_TREE_SCRIPT_SHA=$task_tree_script_sha" \
  -e "DSH_EXPECT_SOURCE_JSON=$task_source_json" \
  --entrypoint node dsh /opt/dsh-adapter/verify-load.mjs

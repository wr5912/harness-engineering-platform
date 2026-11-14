# syntax=docker/dockerfile:1.7

# 源码由 build-image.sh 以固定提交生成，并通过 BuildKit named context 提供。
# Dockerfile 不从本仓库复制或隐式获取 DSH Runtime。
ARG DSH_NODE_BASE
FROM ${DSH_NODE_BASE} AS build

ARG DSH_CLIENT_COMMIT_HASH
ARG DSH_LOCK_SHA256
ARG DSH_CLI_VERSION
ARG DSH_PACKAGE_MANAGER
# 构建期 APT 默认使用 TUNA 主源并保留 Debian 官方 security；npm/pnpm 使用 registry.npmmirror.com。
# 两者仍由 debian-archive-keyring 与包完整性摘要校验；TUNA 不可达时才由调用方显式改回官方主源。
ARG DSH_APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DSH_NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_HOME=/opt/corepack

# 基础镜像使用 Debian HTTP 源与 debian-archive-keyring 签名验证；
# HTTPS 的 CA 引导问题不通过忽略 apt 索引错误规避。
COPY apt-mirror.sh /opt/dsh-adapter/apt-mirror.sh
RUN sh /opt/dsh-adapter/apt-mirror.sh "$DSH_APT_MIRROR" \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::ForceIPv4=true \
      install -y --no-install-recommends ca-certificates build-essential musl-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dsh
COPY --from=dsh_source / /opt/dsh
ENV NODE_USE_ENV_PROXY=1

# corepack 下载包管理器、pnpm 解析依赖都走同一个国内 registry；
# 依赖仍按 pnpm-lock.yaml 的完整性摘要校验，换源不改变锁定内容。
RUN --mount=type=cache,id=dsh-pnpm-store,target=/root/.local/share/pnpm/store,sharing=shared \
    test -n "$DSH_CLIENT_COMMIT_HASH" \
    && test -n "$DSH_LOCK_SHA256" \
    && test -n "$DSH_CLI_VERSION" \
    && test -n "$DSH_PACKAGE_MANAGER" \
    && test -n "$DSH_NPM_REGISTRY" \
    && test "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f 1)" = "$DSH_LOCK_SHA256" \
    && test "$(node -p 'require("./package.json").version')" = "$DSH_CLI_VERSION" \
    && corepack enable \
    && COREPACK_NPM_REGISTRY="$DSH_NPM_REGISTRY" corepack prepare "$DSH_PACKAGE_MANAGER" --activate \
    && printf 'registry=%s\n' "$DSH_NPM_REGISTRY" > .npmrc \
    && test "$(pnpm config get registry | sed 's:/$::')" = "${DSH_NPM_REGISTRY%/}" \
    && pnpm install --frozen-lockfile \
    # 官方聚合构建默认并发多个高内存 gate；共享开发主机按原生开关串行构建。
    && DSH_GATE_CONCURRENCY=1 DSH_CLIENT_COMMIT_HASH="$DSH_CLIENT_COMMIT_HASH" pnpm run build \
    && test -s apps/cli/lib/bin.js \
    && rm -rf /opt/dsh/.git /opt/dsh/.npmrc

ARG DSH_NODE_BASE
FROM ${DSH_NODE_BASE}

ENV COREPACK_HOME=/opt/corepack
COPY --from=build --chown=node:node /opt/corepack /opt/corepack
COPY --from=build --chown=node:node /opt/dsh /opt/dsh
COPY --chmod=0755 dsh-cli.sh /usr/local/bin/dsh

# 评测复用 Playwright；威胁研判固定流程使用 Python 标准库和时区数据。
ARG DSH_APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
COPY apt-mirror.sh /opt/dsh-adapter/apt-mirror.sh
RUN sh /opt/dsh-adapter/apt-mirror.sh "$DSH_APT_MIRROR" \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::ForceIPv4=true \
      install -y --no-install-recommends chromium python3 python3-venv tzdata \
    && rm -rf /var/lib/apt/lists/* /opt/dsh-adapter \
    && cd /opt/dsh/apps/web \
    && node --input-type=module -e "await import('playwright'); await import('fflate')" \
    && chromium --version >/dev/null

# 平台开发适配器仍可 bind 挂载；独立运行的通用适配器和依赖属于共享标准镜像。
COPY --from=standalone_runtime / /opt/dsh-standalone/
RUN cd /opt/dsh-standalone/dependencies \
    && npm ci --omit=dev --registry=https://registry.npmmirror.com \
    && python3 -m venv /opt/dsh-standalone/python-env \
    && /opt/dsh-standalone/python-env/bin/pip install --no-cache-dir --require-hashes -r requirements.txt \
    && ln -s dependencies/node_modules /opt/dsh-standalone/node_modules \
    && mkdir -p /opt/harness-model-runtime \
    && ln -s /opt/dsh-standalone/model-binding-runtime.js /opt/harness-model-runtime/model-binding-runtime.mjs
ENV PYTHONPATH=/opt/dsh-standalone/python-env/lib/python3.11/site-packages
# 平台实例通过只读卷装载 /opt/dsh-adapter；独立实例使用镜像内的通用适配器。
RUN mkdir -p /opt/dsh-adapter \
      /var/lib/dsh/profiles/node_modules \
      /var/lib/dsh/profiles/web/node_modules \
      /var/lib/dsh/profiles/web/.dsh-module-fallback/node_modules \
      /var/lib/dsh/node_modules /work/harness/workspace \
    && chown -R node:node /var/lib/dsh /work/harness \
    && ln -s /var/lib/dsh/profiles/node_modules /node_modules \
    && corepack enable

ENV HOME=/var/lib/dsh DSH_HOME=/var/lib/dsh XDG_CACHE_HOME=/var/lib/dsh/.cache
WORKDIR /work/harness/workspace
USER node
ENTRYPOINT ["node", "/opt/dsh/apps/cli/lib/bin.js"]

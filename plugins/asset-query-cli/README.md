# DSH 只读资产查询原型

此原型验证 DSH 应用级命令行扩展：不装载业务 Bundle、模型或 MCP，只读取显式挂载的仓库资产目录，输出 Agent 与 Experiment 目录清单。Experiment 缺少 `change.yaml` 时，仅跳过没有 Git 可见文件的残留目录；仍有资料的目录会报错。它不判断清单内容、评估结论或插件是否激活，也不是完整研发管理 CLI。

Profile 模板位于 `profile/`，插件入口为 `query.mjs`。容器内将本目录只读挂载到 `/opt/harness-plugins/asset-query-cli`；把模板复制到独立、可写的 `$DSH_HOME/profiles/asset-query-cli`，因为 DSH 启动时会生成该 Profile 的有效 `cordis.yml`。只读挂载仓库资产并设置 `HARNESS_ASSET_ROOT` 后，可运行 `dsh --profile asset-query-cli --help` 或 `dsh --profile asset-query-cli inventory`。标准输出的查询结果是单行 JSON；参数错误写标准错误并返回非零码。Profile 的运行态副本不归档为 Harness 资产。

在仓库根目录、已构建锁定镜像后，可执行一次隔离查询：

```bash
docker run --rm --network none --read-only \
  --tmpfs /var/lib/dsh:rw,uid=1000,gid=1000 \
  --tmpfs /tmp:rw,uid=1000,gid=1000 \
  --mount "type=bind,src=$PWD/plugins/asset-query-cli,dst=/opt/harness-plugins/asset-query-cli,readonly" \
  --mount "type=bind,src=$PWD,dst=/asset-repo,readonly" \
  --env HARNESS_ASSET_ROOT=/asset-repo \
  --entrypoint /bin/sh "$(python3 runtime/adapters/dsh-container/source_contract.py --field image.local_image_tag)" \
  -c 'mkdir -p /var/lib/dsh/profiles/asset-query-cli && cp /opt/harness-plugins/asset-query-cli/profile/* /var/lib/dsh/profiles/asset-query-cli/ && exec node /opt/dsh/apps/cli/lib/bin.js --profile asset-query-cli inventory'
```

该命令只用于本地管理原型验证，不是业务 Agent 的挂载或发布启动方式。

此 Profile 的空 Bundle 列表是特意限定的原型范围；后续若增加资产变更操作，应另行处理身份校验、单写者和快照一致性，不直接扩展本只读查询为发布入口。

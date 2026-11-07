# KEV 离线数据工具

复用既有轨迹解析、数据复核与训练输入身份实现。工具只处理显式输入文件，不执行轨迹中的工具、不联网、不训练，不接管 DSH 会话。

## 调用

需要 Python 3.10+，仅使用标准库。通过平台 context 的 program_root 定位本目录，不依赖数据侧兄弟 Skill 的安装位置。用 `python3 <本目录>/kev_trace.py --help`、`legacy_native.py --help`、`platform_export.py --help` 查询当前参数。

- `kev_trace.py`：audit、discover、extract、annotate、compile、split、audit-dataset；输入真实轨迹或对应阶段产物，输出中文 report.md、机器产物与 stage-status.json。
- `legacy_native.py`：inspect、build、audit；保留原生 KEV 数据身份，不伪造 DSH 来源。
- `platform_export.py`：接收平台冻结导出清单，保留分组、来源和复核证据。

输入与输出使用绝对路径，输出必须是新的空目录。读取 stage-status.json 的 completed、requires_review、blocked 及 reason_codes；退出 0 仍可能需要复核，退出 2 表示已报告阻断，退出 1 表示输入或 I/O 异常。未知状态先读取原输出，不覆盖或重复生成。方法与业务解释由调用 Skill 自带资料维护。

## Python 调用合同

现有训练方案与报告复用本目录模块：dataset.compile_records / split_records / audit_partitions，native_input.question_key，legacy_native 的复核与审计，以及 human_report 的报告函数。调用方通过 `HARNESS_PROGRAM_ROOT` 指定已核对的程序根；函数参数和返回字段以对应源码及 tests 为准，数据检查失败不得跳过。

## 安全路由合同

机器消费者唯一读取 assets/security-routing-contract.json；该文件随工具维护。源数据、标签与测试结论仍属于各自业务来源，不写回本工具。固定上游校验器及许可位于 upstream/，其来源、提交与摘要见 upstream/README.md。

## 验证

在本目录执行 `python3 -m unittest discover -s tests -v`。跨仓训练交接测试另需 HARNESS_ASSET_ROOT 指向当前数据根，HARNESS_PROGRAM_ROOT 指向当前程序根。离线测试通过只证明转换及检查合同，不代表编码、训练、模型效果或业务验收通过。

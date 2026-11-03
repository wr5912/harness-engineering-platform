# 深色主题实际核验

本次以用户提供的本地AI-SOC曲面驾驶舱HTML为视觉参考，调整当前开发环境的深色配色与材质。当前规范只在[前端设计规范2.3节](../../../../../docs/platform-design/26_前端设计规范与原则.md#23-深色主题与视觉参考)维护。参考已实际查看静态及启用脚本后的页面，文件身份和预览边界见[来源记录](reference-source.json)、[参考截图](reference.png)。未将参考中的固定大屏布局、内嵌字体或整张背景图用作平台运行资产。

## 当前效果与范围

深海军蓝背景、青蓝边界、蓝色主操作、局部紫色和渐变浮层由共享HEP变量提供。业务页、管理对话、助手、设置、下拉、抽屉和弹窗使用同一暗色来源。原生颜色通过锁定DSH的公开`overrideTokens`接入，保留原生反色语义、主题持久方式及布局；没有新增主题存储或图形框架。

代表截图：[首页焦点](main/1440-home-dark-focus.png)、[原生管理对话](main/390-conversations-dark.png)、[手机智能体详情](main/390-agents-dark.png)、[评测弹窗](main/1440-evaluation-dialog-dark.png)、[助手](overlays/1440-assistant-dark.png)、[原生设置](overlays/1440-native-settings-dark.png)、[只读抽屉](details/390-source-drawer-dark.png)。主页面首轮截图同时覆盖加载状态，后续窄屏图及详情使用实际加载的数据。

## 验证

| 范围 | 证据及结果 |
|---|---|
| 相邻组件 | [浮层直接消费者](surfaces-tests.log)206/206、[首页/MCP](home-mcp-tests.log)77/77、[导航/助手](native-adjacent-tests-complete.log)33/33，分别记录，不重复累加 |
| 原生主题服务 | [锁定ThemeRuntime源码核验](native-runtime-check.json)9项通过；UI视图和宿主持久接口隔离，52对浅色表达式与原生来源一致，注册/清理不写偏好，切换沿原服务 |
| 原生具体颜色消费者 | [锁定编译器及隔离浏览器](native-selector-browser.json)核对真实生成的主按钮、反馈、状态点、附件样式；蓝底白字与亮底深字分别可读。此项是组件CSS核验，不是业务操作 |
| 实际页面 | [主路径报告](main/report.json)56项断言通过：七模块×1440/768/390、Portal搜索、创建/评测/接入弹窗、浅色及草稿；脚本随后在不存在的首页浮窗入口定位中断，原报告保留 |
| 剩余实际路径 | 修正验收入口后，仅补测未完成部分：[浮窗、设置、减少动效及刷新](overlays/report.json)10/10；没有为修正定位重跑全部已通过页面 |
| 抽屉与对比度 | [实际只读抽屉与颜色采样](details/detail-and-contrast.json)11/11，含1440/390、正文/次要文字/链接/反色/完成与失败图标，采样对比度均高于4.5 |
| 动效 | [实际时间采样](animation.json)确认首页氛围透明度随时间变化，减少动效后动画关闭；不据此宣称帧率或性能提升 |
| 工具链 | TypeScript检查及隔离完整构建exit 0，`git diff --check`通过；未写入业务或登记配置 |

首次[原始CSS比较](initial-raw-css-comparison.json)把等值的构建产物hex与运行时rgba字符串当成差异，原回执保留。[差异值](light-differences.json)显示18项序列化差异；改用相同8位色值及CSS空白归一后，402个原生变量的绘制值和四组浅色控件样式均保持。此结论不宣称原始字符串或整页像素逐字节相同。[浅色切回截图](overlays/1440-home-light-restored.png)记录实际往返结果。

## 实际生效

当前入口为 **http://10.0.160.32:18120/hep/**，切换到深色主题可查看。仅将隔离构建的`client.js`原子替换到当前客户端，由原生热更新/页面刷新加载。[装载核对](activation.json)确认PID2500377不变、服务端`index.js`和Profile逐字节未改、运行客户端与隔离构建一致，实现摘要仍为`2f558c98cd71bde4a5135b7bb83c4273a6d2ce8cfc58c5c9726b2404e1ed7d58`。

本轮没有重启平台或业务实例。真实页面只读取对象、打开表单和切换主题，没有发送模型任务、运行评测或调用业务工具。验证不替代这些业务路径的功能验收，不构成其他部署环境已同步或生产验收。

[已知凭据精确扫描](credential-scan.json)覆盖新证据与工作树新增行，25个实际值及转义形式均无匹配；36个图片文件跳过文本扫描，不做截图OCR，不构成全仓无凭据声明。项目结构校验见[校验回执](repository-validation.json)。

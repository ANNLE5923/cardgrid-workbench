# 模块地图

CardGrid 采用模块化单体：一套浏览器应用，共用工作区保存机制。当前应用、依赖、脚本和测试都在 `app/`；下面 v0.3 的 `src/` 等路径以 `app/` 为前缀理解，历史引用保留原语境。

根目录保留产品入口、许可证、Git 与文档；`.github/` 集中 CI、贡献指南与安全说明。`app/scripts/`、`app/src/`、`app/public/`、`app/tests/` 分别承载脚本、源码、静态资源和验证，所有 npm 命令从 `app/` 执行。

[仓库编码原则](../../AGENTS.md)是新会话的执行入口：开发时保持状态归属、请求身份和数据边界；每个版本依次整理代码、整理文件、验证和按授权提交上传。格式规则由 `app/.prettierrc.json` 及 CI 检查保持。

## v0.6 当前集成路径

| 模块／入口 | 职责 |
| --- | --- |
| `app/src/app/RootApp.tsx`、`app/src/app/v06/V06App.tsx` | 按 Data 格式分派旧入口／通用入口，显式升级、页面装配、离页 flush |
| `app/src/app/v06/BackupRestore.tsx`、`ReferencePlacement.tsx` | 各自拥有表单、对应预览与异步失效；换输入／离页后晚到结果不能恢复旧确认 |
| `app/src/workspace/v06-host.ts`、`v5-*.ts` | Data5、具名事务、回执与来源校验；旧备份精确恢复，不自动升级 |
| `app/src/decision/`、`drawing/v06-action-session.ts` | 通用候选、稳定决策、字段合成／消费和行动球面会话 |
| `app/src/workshop/ui/v06/`、`formal-catalog-editor.ts` | 正式工坊／独立清单、三槽合成；未确认命令重试保留原身份 |
| `app/src/daily/hand/`、`workspace/v06-today-client.ts` | 统一浮窗、Today 独占打出、参考和事实冻结 |
| `app/src/journal/`、`app/src/app/v06/V06JournalView.tsx` | 表盘自动段投影、独立感想与旧正文、草稿保存及修改时间 |
| `app/src/maintenance/`、`workspace/v06-maintenance.ts` | 应用内具名操作及清单网址发起的独立日志 |
| `app/src/text-output/`、`workspace/v06-text-source.ts` | 日记／日志共用单向队列、权限、intent、字节核对、外部副本与最后成功输出 |
| `app/src/workspace/v06-archives.ts`、`archive-*.ts` | 月度闭包 ZIP、外部重读证明、明确原子移出、只读历史与单包解码缓存 |

自动段不重复保存为可写事实，感想与旧正文分别保存。归档只读按实际时间区间及封存时区判断；保留在活动区的未完成安排仍可移到活动日或收回。完整历史文本按各包冻结上下文投影，多个源日跨到同一展示日时不采用单一新模板。所有文件检查只处理输出，不反向改写工作区。当前证据与发布限制见[计划第 23 节](../开发/2026-10-06-v0.6并行开发计划.md#23-主线集成与整体收尾2026-10-07)。

同日整理：`app/src/app/v06/` 集中正式 V06App、抽卡／日记／文件／归档／配置页面和对应 CSS；`RootApp.tsx` 与旧 App 保持原位，外部调用继续经 `app/index.ts`。内部文件的位置可调整，调用方依赖的公开出口保持稳定。业务、存储及其他模块边界未变，A6 样稿保持隔离。

旧根依赖、构建和历史测试输出在忽略的 `.local/legacy-root/{node_modules,dist,test-results}/` 原样保留；当前运行只使用 `app/` 中相应目录。移动清单、字节保留及整理后回归见[计划第 24 节](../开发/2026-10-06-v0.6并行开发计划.md#24-代码与本地文件整理2026-10-07)。

## 源码树

```text
src/
├─ main.tsx          仅启动应用与离线缓存
├─ app/              页面装配、导航、工作区生命周期
├─ workshop/         原卡、书目、卡池、生成规则与配置编辑
├─ drawing/          库存生成/归档纯规则、组合与正式抽取会话
├─ daily/            独立手牌堆叠、归档、时间盘、排期与事实
├─ workspace/        正式命令、格式校验、原子存储、备份迁移
└─ shared/           无业务状态的基础界面与焦点工具
```

这是 v0.3 已落地的源码归属。工坊与抽卡各自管理界面草稿，经正式 Host 提交具名命令；矩阵与球面只显示传入数据和回传具体 ID。验收证据见[v0.3 收尾](../归档/v0.3/开发/2026-10-05-v0.3收尾与验收.md)。

## 公开入口

| 模块 | 面向界面的入口 | 不加载界面的规则入口 | 内部职责 |
| --- | --- | --- | --- |
| 工坊 | `workshop/index.ts` | `workshop/model.ts` | 原卡编辑、配置表单与 JSON；目录、版本和引用纯校验 |
| 抽卡 | `drawing/index.ts` | `drawing/model.ts` | 指定候选筛选和拒绝采样；选择不创建行动 |
| 日常 | `daily/index.ts` | `daily/model.ts`、`daily/time.ts`、`daily/projection.ts` | 行动状态、分钟时间、权威投影与实际记录 |
| 工作区 | `workspace/index.ts` | `workspace/codec.ts`、`workspace/legacy/index.ts` | 命令、事务、格式与兼容解析 |
| 基础界面 | `shared/ui/index.ts` | 无 | 卡片外观、焦点进出；不拥有业务或数据库状态 |

规则入口单列，是为了让存储层和 Node 测试无需加载 React 页面。跨模块生产代码只能访问上述入口；模块内部可直接调用内部文件。低层实现测试可以使用内部文件验证事务与边界，但内部文件不因此成为产品公共 API。

## 运行路径

```text
main → app
        ├─ workshop / drawing / daily 的公开界面
        └─ app 内部生命周期：权威快照、配置草稿、能力失效和导航

界面 → workspace-client → 命令协调 → daily 领域规则 → store.atomic
读日 → 权威投影 → 时间盘/手牌适配
抽取 → drawing.model → 只读选择结果 → 用户明确接受命令
```

页面不直接写 IndexedDB。正式 Host 对每次具名业务命令校验 token、版本和引用，业务变更、历史、回执、恢复点在同一事务提交。旧目录重建的 Envelope4/Data2 基线保留为兼容分支，v0.3 新格式为 Envelope4/Data3。

v0.3 版本证据复用 `planner.history`。`load/readInventory/previewCombo` 等读取不生成、不归档；app 启动、回到可见状态和规则时区午夜调用命名协调，先归档到期副本再生成当前日。隐藏页面不轮询，浏览日期不驱动生成。旧 Data v2 升级需备份、预览与显式提交；完整备份保留原版本，ConfigV3 不含库存、手牌、事实或记账。

`app/ActionWorkspace.tsx` 保留现有抽取/手牌/当日切换状态和命令回调；三个界面分别由各模块实现。它是过渡装配层，不是让 drawing 直接管理日常数据的接口。`app/use-workspace-app.ts` 保留同 epoch 的 adopt、跨窗口通知、备份证据、失败重试和配置草稿。

## 并行开发边界

- 工坊负责人修改 `src/workshop/` 及对应模块测试。
- 抽卡负责人修改 `src/drawing/`；球面与下拉已复用统一选择/组合接口。
- 日常负责人修改 `src/daily/`；时间和事实语义保持既有回归门槛。
- 公共负责人修改 `src/workspace/`、应用接线、依赖和格式迁移；接口变化先协调，再依次合入。
- 各线使用独立工作目录。不能同时对同一个应用装配文件、数据格式或迁移步骤作不协调的修改。

`npm test` 包含公共入口、运行时循环依赖与 shared 越界检查，防止以后重新形成隐含耦合。新增入口先解释调用需求，再更新检查白名单。

## 对应测试和文档

`tests/modules/` 按 workshop、drawing、daily、workspace 与 shared 对应源码；`tests/architecture/` 验证依赖边界；`tests/browser/` 验证真实跨模块用户流程；`tests/review/` 保留独立反例，`tests/support/` 存内存测试适配器。两类 Node 入口递归发现测试，不因移动目录漏掉旧断言。

测试适配器不从生产入口导出；WorkshopEditor 仅识别适配器标记，不依赖测试实现类型。未接入生产的 B2 界面草稿与 A0 样稿归入[版本原型](../归档/v0.3/README.md)，保留代码与复现说明。

正式产品规则见[设计入口](../README.md)与[v0.3 C0 合同](../产品设计/12-v0.3工坊与抽取合同.md)。已完成计划、过程、验收和原型从[版本归档](../归档/README.md)查阅；生产代码不导入文档、原型或 fixture。

## 2026-10-05 结构审查

结论：结构符合“外部封装、内部解耦”。根目录按源码、测试、文档、运行资源与工程脚本提供少数入口；源码按功能归属，跨模块只使用公开入口，运行依赖无循环，shared 不依赖业务状态。三处开发遗留已收拢：顶层 A0 原型、生产导出的内存适配器、未接入的 B2 界面草稿。完成资料按版本归档，当前开发入口只保留维护指引。

这是目录与依赖边界的结论。`workspace/format.ts` 的兼容校验和部分交互组件仍较集中，未来按实际改动热点再拆分；本轮不改变数据结构、正式保存语义或模块职责。整理与发布复测记录见[v0.3 归档](../归档/v0.3/README.md)。

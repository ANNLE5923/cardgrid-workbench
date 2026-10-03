# 模块地图

CardGrid 采用模块化单体：一套浏览器应用，三个业务模块，共用工作区保存机制。

## 源码树

```text
src/
├─ main.tsx          仅启动应用与离线缓存
├─ app/              页面装配、导航、工作区生命周期
├─ workshop/         行动原卡与高级配置编辑
├─ drawing/          候选选择规则与抽取界面
├─ daily/            手牌、时间盘、排期、事实与兼容视图
├─ workspace/        正式命令、格式校验、原子存储、备份迁移
└─ shared/           无业务状态的基础界面与焦点工具
```

这是已落地的源码归属。书目池、模板预留位、球面抽取和每日池副本仍为后续功能，不能从目录名推断已经实现。当前导航与已验收操作保持原样；三个场所的完整新界面另按产品设计推进。

## 公开入口

| 模块 | 面向界面的入口 | 不加载界面的规则入口 | 内部职责 |
| --- | --- | --- | --- |
| 工坊 | `workshop/index.ts` | 暂无独立规则 API | 原卡编辑、配置表单与 JSON |
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

页面不能提交整份替换 Data，不直接写 IndexedDB。正式 `WorkspaceClient` 方法集合、命令载荷和数据格式沿用已冻结合同。此次目录重建保持 Envelope v4/Data v2，没有真实数据迁移。

`app/ActionWorkspace.tsx` 保留现有抽取/手牌/当日切换状态和命令回调；三个界面分别由各模块实现。它是过渡装配层，不是让 drawing 直接管理日常数据的接口。`app/use-workspace-app.ts` 保留同 epoch 的 adopt、跨窗口通知、备份证据、失败重试和配置草稿。

## 并行开发边界

- 工坊负责人修改 `src/workshop/` 及对应模块测试。
- 抽卡负责人修改 `src/drawing/`；球面与下拉以后复用统一选择/组合接口。
- 日常负责人修改 `src/daily/`；时间和事实语义保持既有回归门槛。
- 公共负责人修改 `src/workspace/`、应用接线、依赖和格式迁移；接口变化先协调，再依次合入。
- 各线使用独立工作目录。不能同时对同一个应用装配文件、数据格式或迁移步骤作不协调的修改。

`npm test` 包含公共入口、运行时循环依赖与 shared 越界检查，防止以后重新形成隐含耦合。新增入口先解释调用需求，再更新检查白名单。

## 对应测试和文档

`tests/modules/` 按 daily、drawing、workspace 对应源码；`tests/architecture/` 验证依赖边界；`tests/browser/` 验证真实跨模块用户流程；`tests/review/` 保留原独立反例。测试发现递归执行，不因移动目录漏掉旧断言。

正式产品规则见[设计入口](../README.md)。旧过程与[时间盘原型](../归档/阶段0-3/原型/time-dial/README.md)统一归档，生产代码不导入文档、原型或 fixture。当前重建验证和发布状态见[交接记录](../开发/2026-10-03-模块重建与迁移.md)。

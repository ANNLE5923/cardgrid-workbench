# 浏览器回归

## 当前G3回归入口（2026-10-02）

G3已完成分离验收：默认Node220通过/1原有跳过，独立反例8/8，浏览器93/93。下文2B失败记录和G0入口均为历史，当前结论见[G3验收记录](../../docs/归档/阶段0-3/测试记录/G3-2026-10-02-有界修复与最终验收.md)。

先运行npm ci和npm run build。浏览器脚本使用外部Playwright及隔离的新context，不使用个人浏览器profile；项目运行依赖不含Playwright。必须将CARDGRID_PLAYWRIGHT_MODULE设置为已安装Playwright的index.mjs文件URL；有本机Chrome时将CARDGRID_CHROME_PATH设为可执行文件路径，否则先准备Playwright Chromium。

按顺序运行，避免同时运行开发入口测试：

```powershell
# 按实际机器填写这两个路径；下方历史命令仅对应原检查机器。
$env:CARDGRID_PLAYWRIGHT_MODULE='file:///C:/tools/browser-tests/node_modules/playwright/index.mjs'
$env:CARDGRID_CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/browser/action-3g-gate-main.mjs
node tests/browser/action-3g-gate-supplement.mjs
node tests/browser/action-3g-gate-additional.mjs
node tests/browser/action-3g-final-extra.mjs
node tests/browser/action-3g-hook-faults.mjs
node tests/browser/action-3g-readonly-edges.mjs
node tests/browser/action-2g.mjs
node tests/browser/action-2g-closure.mjs
node tests/browser/action-2g-save-failures.mjs
node tests/browser/action-2g-annotation.mjs
```

前六个脚本覆盖B30/C8/D8/P6/E10/Q3，旧G2四个脚本覆盖28项；独立Node用npm run test:independent。结果JSON、验收报告保留在仓库；批量运行PNG和修改前源码备份由.gitignore保留在本地。重跑会生成新的结果和截图，请分别记录新结论，勿将历史报告冒称为本轮验证。CI当前只执行Node和构建。


## 2B 当前独立契约回归（2026-09-28）

2B 测试已交付，发现两项核心问题，下一项为 2C 修复和审查。当前门禁保持失败，不能把失败用例跳过后宣布通过。完整范围、复现与证据见[2B 回归与 2C 交接](../fixtures/action/2B-2026-09-28-回归与2C交接.md)。

沿用下方 Playwright/Chrome 环境变量，在仓库根目录执行：

```powershell
node --experimental-strip-types --test tests/modules/workspace/action-independent.test.ts
node tests/browser/action-independent.mjs
```

- 新增 Node 49 项：47 通过、2 失败；全量 Node 154 项：151 通过、2 失败、1 原有跳过。
- 独立浏览器 15 组：13 通过、2 失败。F01 为前日模板跨午夜占用漏确认；F02 为新模板非五分钟起点被保存，随后日查询报错。
- 使用手写契约 fixture、新建浏览器 context、独立 `cardgrid-isolated-2b` 数据库。输出位于 Evidence 行；可通过 CARDGRID_2B_OUTPUT 指定证据目录。
- 最终 TAP、浏览器 JSON 和 20 个受保护文件的前后校验值保存在 tests/fixtures/action/2b-evidence。失败返回非零退出码，2C 修复前属于已确认阻断。

## 2A 当前行动核心与正式入口（2026-09-28）

当前正式启动已切换为 workspace-client。下文 G0 脚本记录旧 P1A 流程，不能直接用其旧可写页面断言验证新入口。

沿用下面的 Playwright/Chrome 环境变量后，在仓库根目录执行：

```powershell
node tests/browser/action-storage.mjs
node tests/browser/action-entry.mjs
```

- action-storage：真实 IndexedDB/BroadcastChannel，14 组事务、重试、原样恢复、清空、迁移、模板、容量及配置历史保护场景；使用隔离数据库。
- action-entry：先构建到临时目录，再用生产构建检查 3 组页面流程（打开/切日只读、准备日与捕获、下载/清空/精确恢复、多窗口草稿失效、旧库/未知格式保护）。无需预先覆盖 dist。
- 所有场景创建全新 context，禁止使用个人浏览器 profile；不接触真实工作区。Service Worker 禁用，离线升级另测。
- 输出位置在终端 Evidence 行；浏览器与服务在 finally 关闭。最终证据已保存到 docs/归档/阶段0-3/测试记录/2A证据-2026-09-28。
- 2A 主线自测通过不等于 2B 或 G2 外部独立验收。完整接口及入口边界见 docs/归档/阶段0-3/测试记录/2A-2026-09-27-实现与交接.md。

## G0 历史浏览器回归

`g0.mjs` 对已构建的 `dist/` 启动临时回环服务器，使用全新的 Chrome/Chromium 测试上下文。不会打开正常用户配置；使用真实 IndexedDB、BroadcastChannel、UI 下载和导入。

先运行 `npm run build`。需要 Node 支持 TypeScript 类型擦除，以及可用的 Playwright 模块和 Chrome/Chromium。本仓库未新增浏览器依赖；0D 使用 Codex 已提供的 Playwright 1.62.1 与本机 Chrome 156.0.8063.3。

本机已验证的 PowerShell 命令（在仓库根目录）：

```powershell
$env:CARDGRID_PLAYWRIGHT_MODULE='file:///C:/Users/arstot/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
$env:CARDGRID_CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CARDGRID_G0_CASE=''
node --experimental-strip-types tests/browser/g0.mjs
```

其它机器可把 CARDGRID_PLAYWRIGHT_MODULE 指向已有 Playwright 模块的 file URL；若可从仓库解析 `playwright` 包，可省略。CARDGRID_CHROME_PATH 省略时使用 Playwright 已配置的 Chromium。不要把个人 Chrome 用户配置传给此测试。

CARDGRID_G0_OUTPUT 可指定证据输出目录；默认使用系统临时目录中的独立目录。保存 results.json、恢复及冲突截图，失败会保留现场截图。浏览器关闭时临时配置及下载自动清理；证据文件保留供审查。Service Worker 在测试上下文中禁用，离线能力不在此验证范围。

只复验配置草稿场景可设 `CARDGRID_G0_CASE=C-config`；空值运行全部。找不到该用例或任何断言失败均返回非零退出码。生产 CI 目前仍只跑单元测试和构建，不自动执行此脚本。

| 检查 ID | 覆盖 |
| --- | --- |
| A01-A04 | 空白导出、含日期例外和历史的完整备份、UI 清空恢复、刷新、再导出逐字段一致 |
| A05 / A06 | 非空 previous 恢复点、非空 schema v1 原文保留与真实数据库升级 |
| A07-A08 | 具有重叠 ID 与独立记录的合并、替换、预览、Planner 保留 |
| B01-B04 | 双标签通知、10 秒不自动覆盖页面、过期提交失败、重载重试 |
| B05-B06 | 交替提交和事件数量、关闭后继续保存、重开后数据与通知 |
| C-capture/inbox/block/template/config/top3 | 明确等待修订冲突提示；整个工作区及两个恢复点不变；草稿或重试入口保留 |
| transaction-abort | 对一次真实 IndexedDB 写入主动 abort，检查工作区和恢复点原子回滚、输入保留与重试仅写一次 |

测试 fixture 使用真实 validator 和领域命令生成。每轮生成独立 ID/历史时间，记录该轮 fixture 散列；比较同轮前后完整 Data，不忽略历史时间戳。常规用例的浏览器时间固定为 2026-09-24 / Asia/Shanghai；旧版升级用例按运行当日生成例行。

R2-01 在单元列表中保留为跳过的追踪项，真实行为由 C-* 与 transaction-abort 验证，不再把恒过占位当作通过。

## 2026-10-03 路径整理

源码按功能模块迁移，运行时字段、命令与断言保持。六个 G3 浏览器脚本的当前输出写入忽略的 `test-results/<脚本名>/`，避免覆盖 `tests/fixtures/` 中的历史证据；G2 和 action-entry/storage 仍按各脚本 Evidence 输出查找。仅调整导入路径、fixture 定位和结果保存位置，不删除行为断言。

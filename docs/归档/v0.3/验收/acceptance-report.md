# v0.3 最终分离验收

日期：2026-10-05。角色：只读独立检查方，未参与生产实现或修复。

## 结论

**建议放行 G-V03。** 冻结版本的完整门禁和独立反例全部通过。当前没有开放的阻塞发现。

本结论限定于下述冻结代码、产品合同和实测范围，不表示已经完成真实用户数据迁移、实体触屏或连续七日使用验证。检查方未提交或推送。

## 受检快照与只读边界

- 工作目录：`D:\Develop\codex\CardGrid`。
- 基线：`ef71af30a9c9f7bfa8cca671ea87b160c6094c82`；范围包含本版已跟踪和未跟踪工作树代码及测试。
- 最终冻结清单：`test-results/v03-closure-20261004/final-code-snapshot.json`，284 个文件。
- 清单 SHA256：`582044A3D05C0F75C4A67AE5A7F1313B5BA4A7D7A24627E09144D6054A7CB17F`。
- 最终清单开始和结束均逐文件复核，**284/284 相符、0 变动**。见 `frozen-revised-before.json`、`frozen-after.json`。
- 最初清单曾为 `84D3C42E1D89742573AEF9D0D1A2BD630606D40D6A3D14CACEA210816FCA7D9A`。作者仅对旧 G2 测试增加折叠入口展开步骤并重新冻结；随后完整浏览器和全部 Node/兼容门禁均在最终快照执行。
- 检查方只在本 `independent` 目录写自建测试、日志和证据。未改生产源码、作者测试、配置、依赖或正式文档。
- 所有浏览器检查使用新上下文及合成数据，无个人浏览器 profile 或真实用户数据。

## 原样门禁结果

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| `npm test` | 349 项：348 通过、1 原有跳过、0 失败 | `final-npm-test.txt` |
| `npm run test:independent` | 8/8 | `final-old-independent.txt` |
| 自建核心反例 N-V03-01—17 | 17/17 | `core-counterexamples.test.ts`、`final-core.txt` |
| 原基线解析器兼容反例 | 3/3 | `baseline-format-compatibility.mjs`、`baseline-compatibility.json` |
| `npm run build` | tsc 无诊断，Vite 113 模块构建成功 | `final-build.txt` |
| `npm run test:browser` | 15 个脚本，138/138 | `final-browser-gate.txt`、`gates/` |
| 自建浏览器 I-V03-01—07 | 7/7 | `browser-counterexamples.mjs`、`browser-evidence/results.json` |

构建产物 `index-DSKGEWml.js`、`index-DtKUwT9N.css` 与作者冻结说明一致。四个产物的字节数和 SHA256 已记录在 `summary.json`。构建有既有 chunk 大于 500 kB 的体积提示。

浏览器完整门禁分组：

| 分组 | 通过/总数 |
| --- | --- |
| v03-closure | 17/17 |
| workspace-v3 | 7/7 |
| action-storage | 14/14 |
| sphere-a3 | 6/6 |
| workshop-hierarchy | 1/1 |
| G3 main / supplement / additional / extra / faults / edges | 30/30、8/8、8/8、6/6、10/10、3/3，共 65/65 |
| G2 main / closure / save-failures / annotation | 13/13、7/7、6/6、2/2，共 28/28 |
| 合计 | **138/138** |

运行 `npm run test:browser` 时仅设置既有浏览器依赖及输出环境变量。`evidence-paths.mjs` 通过 Node preload 为四个 G2 子脚本分别设置 `CARDGRID_2G_OUTPUT`，避免共同输出目录相互覆盖；未改变 runner、作者脚本或业务断言。六个 G3 输出使用已有 `CARDGRID_BROWSER_OUTPUT_ROOT`。层级检查证据为完整门禁日志与 `gates/workshop-hierarchy/` 截图。

## 独立审查与反例覆盖

以冻结 C0 及 B3 正式 Host 合同为依据，审查 `workspace` 的命令、客户端、格式、迁移、版本历史、v3 状态和操作，以及 `drawing` 的生成、归档、组合和生产会话；另检查工坊校验、手牌堆叠、弹层焦点和跨午夜应用接线。

独立核心反例验证：

- 来源日期 D—D+6 保留，D+7 的规则时区本地午夜到期；七日滚动、DST 重复日、已归档账本不可复活。
- 每次明确重复接受生成独立实例；同 commandId 重试回执、丢响应和跨客户端重放不重复写。
- 归档撤销未完成排期，移除活动手牌，保留实例、事实、批注和归档日志；中途失败时工作区、回执及恢复点整体不变。
- 只自动生成当天；合法补日使用可证明的原卡/规则历史，不借用未来创建或当前版本，不接受过期补日。
- 已生成快照不因后来同时间戳编辑而改写；来源日使用冻结规则时区，不使用 UTC 或浏览日期。
- 伪造合成文字、过期/变化/停用词条拒绝且不重抽；含花括号书名只组合一次；可选槽可空。
- 配置与备份共同拒绝非法引用、类型混池、层级循环、槽位歧义；备份同时验证当前版本、历史、快照和账本关联。
- v2 读取和普通写入仍维持 v2；显式升级必须提供备份证据并保留旧数据。

独立浏览器七组验证：

1. 真实 IndexedDB 接受/归档事务 abort 后工作区、回执、恢复点均未变，原命令重试成功且只产生一份结果。
2. 两页共用合成数据库，过期 token 被拒；提交后丢响应由另一页回放原回执，不重复实例。
3. 正式构建 UI 的下拉首个可选项是随机，明确选中即固定具体词条；打开/取消球面不重新抽；取消未接受不新增行动。
4. 正式构建 UI 球面第一步锁定所选具体 id，第二步翻开同一张，背面无正面文本；Escape 回到触发按钮，取消不接受。
5. 320 px、减少动效显示静止列表，键盘两步路径有效，无横向溢出。
6. 三个来源日期通过正式接受入口进入手牌，显示堆叠不合并实例；撤出中间一份仍保留其他两份及三份历史实例。
7. **新 Data3 规则实际页面跨午夜**：上海规则时区 10 月 9 日 23:59:31 加载，手动浏览 10 月 6 日；Playwright clock 跨午夜后仅生成 10 月 10 日一份，归档 10 月 3 日到期副本并退出手牌，当前浏览日仍为 10 月 6 日。再前进两分钟及重新载入，次日账本仍一条、归档仍一条、命令回执未增加。

## 发现与修复复审

### I-V03-R01 / P2：重复槽位文字标签生成不可接受副本——已关闭

首次独立反例重现：同一行动配置两个不同 slot id、相同文字标签，可保存原卡并生成每日副本；组合层之后拒绝该歧义，副本在七日内不可接受。问题来自保存校验与组合校验不一致。

作者在 `src/workshop/validation.ts` 的统一 action 单实体校验中增加重复 label 检查，精确报告 `.slots[i].label`，保存/配置/备份共用。组合层的防御保留。

自建 **N-V03-17 原业务断言未改**，修复后及最终快照两次通过。最终核心 17/17；没有为通过测试删除断言或放宽输入要求。

### 旧 G2 折叠入口定位适配——合理

`tests/browser/action-2g-closure.mjs` 仅在进入抽卡手牌页后增加点击“已有行动定义抽取”，使旧入口可见。只读重抽、接受、排序及事实零新增断言全部保留。该组在本检查方完整门禁原样通过 7/7。

### 离线 shell 修复边界——通过实测与审查

SW 缓存读取增加 `ignoreVary`，用于预缓存请求与 ES 模块请求的 `Vary: Origin` 差异。仍限 GET、同源、注册 scope 及本次构建静态资源白名单；未扩大为用户数据或任意 URL 缓存。

正式浏览器门禁实际验证待更新 SW、激活和离线重载渲染。旧解析器反例另外证明原 v2 解析器拒绝 Data3/envelope 与 v3 备份。其旧解析器仅将相对 imports 重定位到当前未改的共享辅助模块，未启动完整旧浏览器产物，因此不将这三项描述成旧完整应用更新实测。

## 明确未覆盖范围

- 实体触屏手感；浏览器新 context、鼠标/键盘及小屏模拟不替代实体设备。
- 真实私人数据的迁移与灾难恢复；本轮是合成数据、真实 IndexedDB 的事务/备份/恢复验证。
- 连续七个现实自然日使用；本轮通过领域日期和 Playwright clock 验证日界与保留规则。
- 完整历史生产 bundle 的浏览器离线升级；当前更新场景与原解析器拒绝证据分别登记。
- 完整视觉偏好，交由用户判断。

这些范围未计入自动化通过数，也未发现本轮合同规定的阻塞问题。

## 复现入口

在项目根目录执行：

```powershell
node test-results/v03-closure-20261004/independent/verify-frozen.mjs after
npm test
npm run test:independent
npm run build
node --experimental-strip-types --test test-results/v03-closure-20261004/independent/core-counterexamples.test.ts
node --experimental-strip-types test-results/v03-closure-20261004/independent/baseline-format-compatibility.mjs
node test-results/v03-closure-20261004/independent/browser-counterexamples.mjs
```

完整作者浏览器入口是 `npm run test:browser`；原始日志记录本检查方全部执行结果，输出路径适配见 `evidence-paths.mjs`。机器可读总表：`summary.json`；自动一致性校验：`summarize-evidence.mjs`。

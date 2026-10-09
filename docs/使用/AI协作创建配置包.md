# AI 协作创建配置包

让 AI 把你的日常需求整理成可导入 CardGrid 的配置包：**分轮了解需求 → 展示方案并对齐 → 生成 JSON → 校验 → 在应用中预览和导入**。你负责决定需要什么，AI 负责把需求映射到现有结构、检查引用，并交付文件。

本指引适用于 **v0.6.1-preview.1 开发预览版**的通用框架，使用 **ConfigV4（`config-v4`）**，目标工作区为 Data5。产品版本、配置格式和工作区格式分别编号，不能把配置 JSON 的 `version` 写成 `6` 或 `0.6.1`。预览验证及未测范围见[当前交接](../开发/2026-10-05-新对话开发交接.md)。

## 1. 开始与 AI 协作

把本文件交给 AI，再描述你希望怎样使用 CardGrid。已有配置时，在“备份与恢复 → 通用配置与 AI 生成”点击“导出配置”，将配置文件作为更新基线；通常不需要提供包含事实和日记的完整备份。

可直接复制下面的开场提示词：

```text
请阅读 CardGrid 的 docs/使用/AI协作创建配置包.md，帮助我制作个人配置包。

先分轮了解我的目标、日常行动、候选清单、需要回答的问题和固定作息。
先问影响配置的关键问题，允许我用自然语言回答，不要求我懂 JSON 或内部字段。
信息足够后，用表格展示行动、清单、决策关系、时长、作息和待定项，跟我对齐。
不要把示例内容或你推测的习惯当成我的需求。

方案对齐后，生成完整的 config-v4 JSON 文件，并按本指引校验。
若我提供旧配置，以它为基线，保留已有 ID、设置和未要求修改的配置。
交付文件、内容摘要、校验结果和导入步骤；无法执行校验时明确说明。
先准备文件，应用中的备份、升级和确认导入由我操作。

我的目标和第一批需求是：……
```

能够访问仓库的 AI，应核对当前校验器和示例；无法访问仓库的 AI，可使用本文完整示例和应用下载的官方示例。发生版本差异时，以当前应用的导出、示例及校验结果为准。

## 2. 分轮了解需求

从“我想每天怎么用”开始，再补足真正影响配置的内容。已有答案继续沿用，不重复询问；不确定的内容列为待定，不自行补造。

| 需要了解什么 | 为什么需要 | 回答示例（仅示意） |
| --- | --- | --- |
| 使用目标与现状 | 决定第一批范围，以及新建还是更新 | 从空白开始，先管理阅读和锻炼 |
| 行动、预计时长与完成标准 | 决定行动卡正文与排期时长 | 阅读 30 分钟，写下一条收获 |
| 候选清单及可用属性 | 决定条目与资源牌堆 | 我提供书名；作者未知可以不填 |
| 哪些选择需要 AI 配置为决策 | 建立问题、候选与行动字段的关系 | “这次读哪本书？”给阅读行动填书名 |
| 哪些内容只用作清单 | 清单可以独立存在 | 常用网址仅供查看和打开 |
| 固定作息、适用星期与时区 | 决定日型模板，避免时区误差 | 睡眠 23:00 至次日 07:00，周一至周五 |
| 是否需要每日生成库存 | 手动拿卡与生成规则是两种使用方式 | 先手动拿卡；需要自动库存时再补规则 |

首次包可以只包含已明确的一部分。时长、睡眠、候选书目等会影响实际使用的内容由用户决定；配色和 ID 命名等常规细节可由 AI 选择，并在摘要中说明。提供网址时使用用户给出的准确地址；资料缺失可用空属性或 `null`，不编造。

## 3. 先展示配置方案

AI 在写最终 JSON 前展示一份短表，列出实际名称、对象种类、时长／星期、引用关系和待定项。让用户能看懂导入后会得到什么。

| 用户表达 | 配置对象 | 与其他对象的关系 |
| --- | --- | --- |
| 阅读 30 分钟 | `actionCards` 行动卡 | 正文可写 `阅读《{书名}》`，字段标签为“书名” |
| 待读书清单 | `catalogEntries` 条目＋`decks` 资源牌堆 | 牌堆 `deckKind` 为 `entry`，成员为书目条目 ID |
| 这次读哪本？ | `decisionCards` 决策卡 | 归属阅读行动，候选来自资源牌堆，条目标题填入书名字段 |
| 从球面选择行动 | `decks` 行动牌堆 | `deckKind` 为 `action`，成员为行动卡 ID |
| 整理一组决策问题 | `decks` 决策牌堆 | `deckKind` 为 `decision`，成员为决策卡 ID |
| 常用网址 | 独立资源牌堆＋条目 | 不必绑定行动或决策，条目可带 `url` |
| 夜间睡眠 | `templates` 日型模板 | 保存安排起点和时长，不创建已经发生的睡眠事实 |

吃饭、阅读、锻炼都使用同一套结构，不需要为每个领域新增格式。普通行动可以没有字段和决策；一个行动可以关联多个决策，各自补充字段。资源条目与答案不能直接当成可执行行动。

更新配置时，再说明：哪些 ID 新增、哪些同 ID 对象更新、哪些原配置保留，以及是否改变设置。默认采用“合并并更新同 ID”；需要停用缺失对象时，先说明替换方式的影响。

## 4. 生成 JSON 的规则

配置包顶层固定为 `format`、`version`、`kind`、`config`。`config` 必须含下表全部九个键；未使用的集合写成 `[]`，不能省略。

| 键 | 内容 |
| --- | --- |
| `settings` | 时区、显示偏好与分类；整份设置会随导入更新 |
| `definitions` | 原行动定义；首次通用卡包通常为空 |
| `templates` | 日型模板，例如睡眠与固定安排 |
| `rules` | 引用 `definitions` 的原计划规则；不是决策规则 |
| `generationRules` | 引用行动原卡的库存生成规则；需要时才配置 |
| `actionCards` | 行动原卡、正文、时长与字段定义 |
| `catalogEntries` | 清单条目、扁平属性与可选网址 |
| `decks` | 资源、行动或决策牌堆 |
| `decisionCards` | 问题、归属行动、候选资源牌堆与字段映射 |

AI 生成时遵循这些实际约束：

- 新对象使用稳定、非空的 ID，`version: 1`、`source: {"kind":"manual"}`。建议按用途加前缀，如 `personal-action-read`。更新已有对象保持 ID；导入器按内容处理实际版本，不靠手动增加版本号表达更新。
- 配置包本身须引用完整：成员、父对象、归属行动与映射字段均存在；不能依赖“合并后应该能找到”而省掉包内必需对象。集合内 ID 不重复，行动内字段 ID 和标签不重复，父关系不形成循环。
- `deckKind` 只能为 `entry`、`action`、`decision`，成员必须对应同类对象。每堆最多 100 个直接成员，不重复。可拆成多堆；决策显式列出候选堆，`parentDeckId` 仅建立层级，不会自动把子堆成员纳入候选。
- 决策恰好归属一个行动，`deckIds` 引用资源牌堆。`mappings.fieldId` 对应行动字段 ID，`entryPath` 仅为 `title` 或 `attributes.<属性名>`，不使用嵌套路径。所有拟使用候选都应能提供所需值且类型匹配；标题只能填文本字段。
- 正文占位符使用**单层花括号** `{字段标签}`，按 `fields.label` 匹配，而不是字段 ID。例如 `{书名}` 对应 `label: "书名"`。标题和完成标准都可使用；替换一次，不递归解释插入值中的花括号。
- 字段类型为 `text`、`number`、`boolean`。必填字段要有明确补全方式；缺字段的本次材料不能当作完整行动打出。需要直接安排的行动应有可用预计时长，首次包优先使用五分钟倍数。
- 条目 `attributes` 为扁平对象，值仅为字符串、有限数字、布尔或 `null`；`url` 为 `null` 或有效 `http/https` 地址。
- 模板 `start` 用 `HH:mm`，起点和 `elapsedMinutes` 均落在五分钟网格；时长 5—1440 分钟，可以跨午夜。星期 `0` 为周日，`1`—`6` 为周一至周六。生成规则的起始日期与时区由实际需求确定。
- 现有日型模板按星期匹配，不支持起止日期或教学周到期停用。遇到学期课程等有限期安排，先说明限制并对齐使用方式；用户可选择保留为参考清单，或按星期安排、到期手动停用。不能给模板添加未知日期字段，也不能宣称名称／条目属性中的日期会自动生效；后续方向见[固定安排的有效期](../产品设计/04-后续路线图.md)。
- JSON 使用 UTF-8，不能有注释、尾随逗号、省略号或未知字段。JSON 文件内仅放配置，说明放在交付消息中。不要加入事实、手牌实例、日记、维护日志、备份 `data` 或文件授权句柄。

完整字段以[官方示例源码](../../app/src/workspace/v5-config-example.ts)、[ConfigV4 与通用对象类型](../../app/src/workspace/contracts-v06.ts)、[配置解析器](../../app/src/workspace/v5-format.ts)为准。需要生成规则时另查[GenerationRule 类型](../../app/src/workspace/contracts-v3.ts)，不要根据名称猜字段。

## 5. 一个完整的最小示例

以下是**合成演示内容**，展示阅读行动、两条候选、三类牌堆、一个决策和跨午夜睡眠模板。它不代表用户的书目或作息；首次个人包应替换为已对齐的需求，更新已有配置时保留原设置。

```json
{
  "format": "cardgrid",
  "version": 4,
  "kind": "config",
  "config": {
    "settings": {
      "zone": "Asia/Shanghai",
      "preferences": {
        "theme": "paper",
        "density": "comfortable",
        "startHour": 8,
        "endHour": 23,
        "defaultMinutes": 15
      },
      "categories": []
    },
    "definitions": [],
    "templates": [
      {
        "id": "demo-template-sleep",
        "version": 1,
        "name": "演示睡眠日型",
        "weekdays": [0, 1, 2, 3, 4, 5, 6],
        "entries": [
          {
            "id": "demo-sleep-night",
            "title": "睡眠",
            "start": "22:00",
            "elapsedMinutes": 480,
            "definitionId": null
          }
        ],
        "source": {"kind": "manual"}
      }
    ],
    "rules": [],
    "generationRules": [],
    "actionCards": [
      {
        "id": "demo-action-read",
        "version": 1,
        "kind": "action",
        "content": {
          "title": "阅读《{书名}》",
          "criteria": "阅读 30 分钟，记录一条收获",
          "presetMinutes": 30,
          "color": "#6495ed",
          "categoryId": null,
          "categoryLabel": null,
          "minimum": false,
          "projectIds": [],
          "goalIds": [],
          "projectLabels": [],
          "goalLabels": []
        },
        "fields": [
          {"id": "book", "label": "书名", "valueType": "text", "required": true}
        ],
        "status": "active",
        "parentId": null,
        "source": {"kind": "manual"}
      }
    ],
    "catalogEntries": [
      {
        "id": "demo-entry-book-a",
        "version": 1,
        "title": "演示书目 A",
        "attributes": {},
        "url": null,
        "status": "active",
        "source": {"kind": "manual"}
      },
      {
        "id": "demo-entry-book-b",
        "version": 1,
        "title": "演示书目 B",
        "attributes": {},
        "url": null,
        "status": "active",
        "source": {"kind": "manual"}
      }
    ],
    "decks": [
      {
        "id": "demo-deck-books",
        "version": 1,
        "name": "演示待读书",
        "deckKind": "entry",
        "parentDeckId": null,
        "memberIds": ["demo-entry-book-a", "demo-entry-book-b"],
        "source": {"kind": "manual"}
      },
      {
        "id": "demo-deck-actions",
        "version": 1,
        "name": "演示行动",
        "deckKind": "action",
        "parentDeckId": null,
        "memberIds": ["demo-action-read"],
        "source": {"kind": "manual"}
      },
      {
        "id": "demo-deck-decisions",
        "version": 1,
        "name": "演示决策",
        "deckKind": "decision",
        "parentDeckId": null,
        "memberIds": ["demo-decision-book"],
        "source": {"kind": "manual"}
      }
    ],
    "decisionCards": [
      {
        "id": "demo-decision-book",
        "version": 1,
        "question": "这次读哪本书？",
        "ownerActionId": "demo-action-read",
        "deckIds": ["demo-deck-books"],
        "mappings": [{"fieldId": "book", "entryPath": "title"}],
        "status": "active",
        "source": {"kind": "manual"}
      }
    ]
  }
}
```

应用的“下载吃饭／阅读／锻炼与独立清单示例”提供更完整的官方配置。仓库内也可从 `app/` 运行 `node scripts/check-v06-config.mjs --example` 查看，或用 `--prompt` 查看应用配套生成提示。

## 6. 校验与交付

能够操作本地仓库的 AI 将个人配置、草案和备份集中写入仓库外的专用个人资料目录，使用用户指定的位置；不要把个人卡包混入公开示例或随源码提交。以下校验命令中的路径仅为示例，请替换为实际个人配置位置。

从仓库根进入 `app/`，调用现有校验器：

```powershell
cd D:\Develop\codex\CardGrid\app
node scripts/check-v06-config.mjs "D:\CardGrid-个人资料\配置包\CardGrid-config-v4-个人起步.json"
```

AI 根据错误中的路径修正格式、引用或容量，再校验最终文件。只制作配置包时无需修改校验器或重跑整个产品的测试矩阵。校验器通过表示配置格式、引用和牌堆容量通过；与当前工作区合并后的合法性仍需应用 Host 预览。

交付时提供：

- JSON 文件链接，以及行动／条目／牌堆／决策／模板／生成规则的数量和作用。
- 更新已有配置时的变更摘要，特别是设置、同 ID 对象和牌堆成员变化。
- 实际校验命令与结果，未解决的待定项。没有运行能力时写明“未执行本地校验，待应用预览”，不能称为已验证可导入。
- 下节导入路径与推荐方式，提醒配置包不能替代完整数据备份。

## 7. 在应用中导入

1. 打开支持通用框架的当前应用。如果仍显示旧界面，先通过“预览通用卡牌升级”保存完整备份、阅读影响并确认升级。旧 Data2/3 先按原界面升级到 Data4；旧 Inbox／定义／项目独立页面尚未接入 Data5，依赖这些页面时先评估升级影响。具体兼容说明见[使用说明](使用说明.md)。
2. 进入“备份与恢复 → 通用配置与 AI 生成”，选择生成的 JSON。先检查预览和内容摘要；预览失败时把错误交给 AI 修改，重新选择修正后的文件。
3. 默认选择“合并并更新同 ID”。它保留包中未列出的对象，但**同 ID 对象整体更新**，同 ID 牌堆的 `memberIds` 按包内名单更新，并非自动追加。`settings` 也会整份更新；已有时区、偏好和分类应在包里保留。
4. “替换配置，停用缺失对象”会停用／归档缺失对象，并清空缺失牌堆成员；原事实和日记保留。仅在明确需要替换当前配置时选择。
5. 点击“下载导入前活动 JSON 备份”，实际保存文件及它列出的必需归档 ZIP，然后勾选“确认已保存这份 JSON 及所需归档 ZIP”，最后点击“确认导入配置”。
6. 成功后在工坊核对清单与行动，走一遍计划使用的流程：拿行动、选择决策答案、合成后查看标题与时长，再到 Today 安排。确认导入配置不会自动生成完成事实；模板也不代表睡眠已经发生。

日记和维护日志的目录授权在应用中另行设置，不能随配置包导入。导入、升级或恢复遇到失败时保留原文件和提示，先处理原因，不通过清空浏览器数据绕过。

## 8. 后续修改仍用同一流程

正式使用后，从应用重新“导出配置”，让 AI 在这份最新文件上修改。新增候选时保留原条目 ID 和同堆既有成员；改名称保留对象 ID；只有确实要创建另一对象时才生成新 ID。

再次生成 → 校验 → 对齐变化 → 预览导入。稳定 ID 表示同一个对象，所以可持续更新配置；每次换 ID 会创建新对象。导入前备份保留恢复能力，配置导出本身不包含事实、手牌或日记。

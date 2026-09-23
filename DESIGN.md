---
version: alpha
name: CardGrid-design
description: "CardGrid 是本地优先的个人工作台。浅色纸面底 (#f7f8f4) 配松绿主色 (#315e50)，Inter 无衬线，左侧固定边栏 + 右侧内容区。设计哲学是工具不是营销页：产品 UI 本身就是主角，不用 hero 插画、不用渐变、不用霓虹。层级靠三级表面差 (#fffefa → #f7f8f4 → #eef1e9) 和 1px 暖灰边 (#dfe4da)，几乎不用投影。主色松绿只出现在主按钮、focus 状态、当前选中态，其余靠字重和表面差区分。按钮 8px 矩形，卡片 12px 圆角，胶囊只给标签和分段切换。"

colors:
  # 浅色（默认纸白主题）
  canvas: "#f7f8f4"
  surface: "#fffefa"
  soft: "#eef1e9"
  line: "#dfe4da"
  line-strong: "#c8cfc2"
  side: "#f0f3eb"
  ink: "#2c4239"
  ink-body: "#3a4f45"
  muted: "#758279"
  accent: "#315e50"
  accent-hover: "#3c715c"
  focus: "#c7a252"
  on-accent: "#ffffff"
  # 语义色（稀缺使用）
  success: "#2f7d4f"
  warning: "#b8742a"
  danger: "#ab5142"
  # 夜间主题（.app.night 覆盖）
  night-canvas: "#19241f"
  night-surface: "#23312b"
  night-soft: "#2d4035"
  night-line: "#405044"
  night-ink: "#e2e9df"
  night-muted: "#abb8ac"
  night-accent: "#457b62"
  night-side: "#1d2a22"

typography:
  font-family: "Inter, system-ui, 'Microsoft YaHei', sans-serif"
  h1:
    fontSize: "30px"
    fontWeight: 620
    letterSpacing: "1px"
  h2:
    fontSize: "17px"
    fontWeight: 600
    marginBottom: "10px"
  body:
    fontSize: "14px"
    lineHeight: 1.75
  body-small:
    fontSize: "12px"
    color: "muted"
  caption:
    fontSize: "11px"
    letterSpacing: "2px"
  button:
    fontSize: "14px"
    fontWeight: 500
  tabular:
    fontVariant: "tabular-nums"

rounded:
  xs: "4px"
  sm: "7px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "9999px"

spacing:
  base: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "26px"
  xxl: "32px"

components:
  button-primary:
    background: "accent"
    color: "on-accent"
    radius: "md (8px)"
    padding: "10px 15px"
  button-quiet:
    background: "transparent"
    border: "0"
    color: "muted"
    fontSize: "12px"
  button-danger:
    color: "danger"
    border: "#d8b8a8"
  panel:
    background: "surface"
    border: "1px solid line"
    radius: "lg (12px)"
    padding: "26px"
  input:
    background: "surface"
    border: "1px solid line"
    radius: "sm (7px)"
    padding: "10px"
  capture-input:
    flex: 1
    # 快速捕获是核心交互，输入框 + 主按钮横排，右侧 "约 10 秒" 提示
  top3-item:
    background: "soft"
    radius: "md"
    minHeight: "58px"
  routine-row:
    borderBottom: "1px solid line"
    padding: "10px 0"
  schedule-block-fixed:
    borderLeft: "4px solid accent"
    background: "soft"
    radius: "sm (7px)"
  schedule-block-flexible:
    borderLeft: "4px transparent"
    # 弹性块用描边或更浅底，与 fixed 实色块区分
  nav-item:
    padding: "13px 17px"
    color: "muted"
  nav-item-active:
    background: "accent"
    color: "on-accent"
  dialog:
    background: "surface"
    border: "1px solid line"
    radius: "xl (16px)"
    padding: "30px"
  message:
    background: "soft"
    border: "1px solid #d8cfae"
    radius: "md"
    padding: "12px 16px"
---

## Overview

CardGrid 是本地优先的个人工作台：日程、卡片、Top3、Inbox、例行、复盘。它不是营销页，也不是看板 SaaS。设计原则只有一条：**打开就用，看完就走，键盘不脱手**。

视觉上是"纸面工作台"——浅米白纸色底、松绿主色、暖灰边栏，像一张写满字的纸质计划本被搬到了屏幕上。没有渐变、没有霓虹、没有大气 hero。所有视觉权重都给真实内容：今天的日程块、Top3 卡片、Inbox 列表。

**Key Characteristics:**
- 左侧固定边栏（220px）+ 右侧内容区，边栏是导航不是装饰
- 三级表面差承载层级：页面底 `#f7f8f4` → 卡片 `#fffefa` → 浅灰块 `#eef1e9`
- 1px 暖灰边 `#dfe4da`，不用投影分层级（对话框除外）
- 松绿 `#315e50` 是唯一主色，只给主按钮、当前选中、focus ring
- 按钮 8px 矩形，卡片 12px 圆角，胶囊只给标签/分段切换
- Inter 一套字体，时间数字用 tabular-nums
- 浅色为默认，深色 `.app.night` 是完整反色变量集

## Colors

### 浅色主题（默认）

| Token | Hex | 用途 |
|---|---|---|
| `--bg` | `#f7f8f4` | 页面底色，最冷的一层 |
| `--surface` | `#fffefa` | 卡片/面板底，纸面白 |
| `--soft` | `#eef1e9` | 浅灰块、hover、Top3 槽、candidate chip |
| `--line` | `#dfe4da` | 1px 边框和分隔线 |
| `--side` | `#f0f3eb` | 左侧边栏底色，比 bg 略暖 |
| `--ink` | `#2c4239` | 主文字，深松绿不是纯黑 |
| `--muted` | `#758279` | 次要文字、说明、面包屑 |
| `--accent` | `#315e50` | 主色：主按钮、选中 nav、Top3 数字圈、fixed 块左边条 |
| `--accent-hover` | `#3c715c` | 主按钮 hover |
| `--focus` | `#c7a252` | focus ring（金色，和松绿形成弱对比） |

### 语义色（稀缺）

| Token | Hex | 只给 |
|---|---|---|
| `success` | `#2f7d4f` | 完成状态、成功提示 |
| `warning` | `#b8742a` | 警告、Pending 但需注意 |
| `danger` | `#ab5142` | 危险操作（清空工作台）、错误 |

**Do**：主色松绿用在该用的地方。语义色只在状态提示和危险按钮出现。
**Don't**：不要给按钮换第三个彩色；不要用松绿做大面积背景；不要为"分类"发明鲜艳色，分类色走 pastel 底 + 深字（参考 Notion 的 peach/rose/mint）。

### 夜间主题

`.app.night` 覆盖全套变量：`--bg #19241f`、`--surface #23312b`、`--soft #2d4035`、`--line #405044`、`--ink #e2e9df`、`--muted #abb8ac`、`--accent #457b62`、`--side #1d2a22`。不要为深色单独设计组件，只换变量。

## Typography

- **字体**：`Inter, system-ui, 'Microsoft YaHei', sans-serif`。不需要定制字体。
- **h1** 30px / weight 620 / letter-spacing 1px。今天日期和页面大标题。
- **h2** 17px / weight 600。卡片标题。
- **body** 14px / line-height 1.75。正文和列表。
- **small/muted** 12px。说明文字。
- **caption** 11px / letter-spacing 2px。边栏分组标题、eyebrow。
- **数字**：时间、日期、倒计时一律 `font-variant-numeric: tabular-nums`，避免数字跳动。
- **字重**：标题 600–620，正文 400，按钮 500。不用 700。

## Layout

### 结构

```
.app (flex, min-height 100vh)
├── .sidebar (220px, sticky, 边栏)
└── main (flex:1, max-width 1500px, padding 0 42px)
    ├── header (83px, 面包屑 + 重新载入)
    ├── .heading (35px 顶距, eyebrow + h1 + 说明)
    └── 各页内容
```

### 边距

- 基距 4px。
- 卡片内 padding 26px（`.panel`）。
- 卡片之间 20px margin。
- 按钮/输入框 10px 垂直、15px 水平。
- 边栏内 35px 上下、23px 左右。

### 网格

- Today 双栏（`.todaycolumns` 1fr 1fr，≤800px 折单栏）。
- Top3 三列等宽（≤800px 折单栏）。
- Inbox 左右双栏（1.2fr / 0.8fr，≤800px 折单栏）。
- 数据页双栏卡片（≤650px 折单栏）。

## Elevation

| 层级 | 处理 | 用途 |
|---|---|---|
| 0 | 表面差，无边框 | 页面底、导航 |
| 1 | 卡片 `--surface` + 1px `--line` | 默认面板 |
| 2 | `--soft` 底 | Top3 槽、chip、hover 行 |
| 3 | 轻微阴影 | dialog、message |
| 4 | `dialog::backdrop` `#142b2466` | 模态遮罩 |

**不要**给卡片加 box-shadow。层级靠表面差和边框。对话框是唯一允许阴影的地方。

## Shapes

| Token | 值 | 用在 |
|---|---|---|
| `xs` | 4px | chip 圆角 |
| `sm` | 7px | 输入框、小标签 |
| `md` | 8px | 所有按钮、小面板 |
| `lg` | 12px | `.panel`、`.welcome`、日历 |
| `xl` | 16px | dialog |
| `pill` | 9999px | 头像、状态标签、分段切换 |

按钮是矩形不是胶囊。胶囊只给状态标签和 nav-pill-group。

## Components

### Buttons

- **`.primary`**：松绿底白字。主操作。hover `#3c715c`。
- **默认 `button`**：`--surface` 底、1px `--line` 边。次级操作。
- **`.quiet`**：透明、无边、muted 字、12px。辅助/删除入口。
- **`.danger`**：红字 `#ab5142`、浅红边。只给"清空工作台"这类不可恢复操作。
- **`:disabled`**：`opacity .45`，`cursor: default`。

### Inputs

- 8px 圆角、1px `--line` 边、padding 10px。
- focus：3px `#c7a252` outline，offset 3px。
- checkbox 16px、`accent-color: var(--accent)`。

### Panels

`.panel` = `--surface` 底 + 1px 边 + 12px 圆角 + 26px padding + 20px 下边距。这是所有内容卡的基类。

### 日程块（schedule-block）

- **fixed**（固定课程/不可改）：左 4px `--accent` 实色边 + `--soft` 底。
- **flexible**（弹性可拖）：左 4px 透明边 + 描边或更浅底。
- 一眼能分：fixed 是"砖"，flexible 是"草稿纸"。

### Routine 行

- 底部 1px `--line` 分隔，padding 10px 0。
- checkbox + 标题 + 右侧状态小标签。
- 完成后标题 `line-through` + muted。
- **不要**给 routine 行加花哨动画或状态色点。

### Top3

- 三列等宽，每格 58px 高、`--soft` 底、8px 圆角。
- 左侧 26px 圆形松绿数字圈。
- 空槽显示"选择今天要保护的任务"。
- Top3 是"今天最重要的三件"，不是积分排行榜。

### 快速捕获

- 输入框 flex:1 + 右侧主按钮"放入 Inbox"。
- 旁边 11px muted 提示"约 10 秒"。
- 捕获后底部显示最近 3 条 Inbox（chip 形式）。
- 这是 Raycast 式核心交互，输入框要有视觉重量，不要缩成小字段。

### Inbox 列表

- 左右双栏：左列表（1.2fr）右编辑面板（0.8fr）。
- 列表项：无边框、底部 1px 边、padding 15px 0。hover 变 `--soft`。
- 选中记录后右侧面板显示原文 + 标题输入 + 丢弃/归档/转 Card 三按钮。

### Dialog

- 16px 圆角、`--surface` 底、遮罩 `#142b2466`。
- 危险确认要用户输入"清空"二字才能提交。

## Do's and Don'ts

### Do

- 用表面差（`--bg` / `--surface` / `--soft`）分层级，不用阴影。
- 主色松绿只给主按钮、选中态、focus、fixed 边条。
- 按钮 8px 矩形，卡片 12px，胶囊只给标签。
- 时间数字用 tabular-nums。
- 空状态文案具体："还没有日程模板。可以先在配置工坊创建。" 不要写"空空如也"。
- 危险操作二次确认，且要打字确认。
- 保存失败时保留用户输入（R2-01 修复契约：onSave 返回 boolean，成功才清空）。

### Don't

- 不要渐变、不要霓虹、不要大气 hero 图。
- 不要给按钮换彩色（主操作永远松绿）。
- 不要 pill 按钮——胶囊只给标签和分段切换。
- 不要纯黑文字（用 `#2c4239` 深松绿）和纯白底（用 `#fffefa`）。
- 不要为每个状态发明新颜色。
- 不要在卡片上用 box-shadow。
- 不要让营销文案风格进产品 UI。
- 不要自动把 Inbox 捕获塞进 Top3 或 Today。

## Responsive

| 断点 | 变化 |
|---|---|
| >1050px | 双栏 Today/Inbox，max-width 1500px |
| ≤1050px | main padding 收窄到 23px，边栏 185px |
| ≤800px | Today/Inbox 折单栏，Top3 折单栏，捕获输入竖排 |
| ≤650px | 边栏变顶部横向导航，日历双栏折单栏，卡片 padding 20px |

触摸目标：按钮 ≥40px，输入框 ≥40px。

## 给 AI Agent 的提示

- 改样式前先读这份文件，所有颜色走 CSS 变量，不要硬编码 hex。
- 加新组件时，先决定它住在哪层表面（bg / surface / soft），再选圆角（md 还是 lg）。
- 主操作永远 `.primary`（松绿）。次级用默认 button。辅助用 `.quiet`。
- 新增彩色前先问自己：能不能用 `--soft` 底 + 深字替代。
- 夜间模式不要写新组件，只靠 `.app.night` 变量覆盖。

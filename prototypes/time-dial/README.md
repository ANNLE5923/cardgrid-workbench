# 1D 双环时间盘与手牌原型

这是独立的合成数据原型，入口为 `http://127.0.0.1:4174/`。它只使用内存中的 S01—S07 场景；刷新或切换场景会重置原型状态。不会连接 CardGrid 的真实工作区、IndexedDB、备份或生产页面。

在 CardGrid 仓库根目录运行：

```powershell
node node_modules/vite/bin/vite.js --config prototypes/time-dial/vite.config.ts --configLoader native
```

检查：

```powershell
node --experimental-strip-types --test prototypes/time-dial/host.test.mjs prototypes/time-dial/card-placement.test.mjs
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --jsx react-jsx --lib ES2022,DOM,DOM.Iterable --allowImportingTsExtensions --skipLibCheck prototypes/time-dial/time.ts prototypes/time-dial/fixtures.ts prototypes/time-dial/host.ts prototypes/time-dial/App.tsx prototypes/time-dial/main.tsx
node node_modules/vite/bin/vite.js build --config prototypes/time-dial/vite.config.ts --configLoader native
```

操作顺序：选择场景 → 展开独立悬浮牌堆 → 点牌转正放大为独立浮窗，或直接按住卡牌拖向表盘。拖动时上边缘先触发外圈虚拟滑块，继续向盘心推进切到内圈；松手时只要虚拟滑块出现，就以收缩过渡留在盘上等待核对，无预览时吸回手牌。也可从查看浮窗向上推，吸附到指针时间。按住滑块调落点，表盘不动；按住表盘转动两环、12 个数字和已有滑块，固定指针不动 → 核对重叠对象 → 明确确认后保存。松手只形成预览，不直接提交。计划或固定滑块可双击进入调整，再双击预览滑块取消调整并重新锁定；实际记录不可调整。浮窗内也有“安排到指针时间”按钮；表盘下方按钮可逐次调指针 5 分钟。左侧 24 格预览条显示日程色段，点击色段打开只读概述；左指针可复位到现在。长手牌每组最多展示 4 张，窄屏另有文字选择路径。

反向手势：将卡牌预览滑块或已保存的计划滑块向外拉过表盘边缘并松手，即收回手牌。预览滑块只取消预览；已保存的计划会撤回。只在内外两圈间移动仍是调整半日。固定日程和完成事实不支持变为手牌。

S04 使用“模拟当前时间”检查 23:59 与次日 00:00 的红色空时间；S05 的故障按钮可以注入一次保存失败或外部修订；S06 展示纽约夏令时缺失/重复刻度与 25 小时日。浅色/夜间、减少动态效果和交换内外圈仅影响原型展示。

读取接口为1F-prototype-2：计划/固定版本、实例关联由Host返回，跨日末段标注“续次日”。正式合同见[1F](../../docs/产品设计/08-1F正式合同与阶段2边界.md)，历史输入见[1C](../../docs/产品设计/07-1C合同收敛与原型接口.md)。测试与限制见[1D记录](../../docs/测试记录/1D-时间盘原型验证.md)及[1F交接](../../docs/测试记录/1F-2026-09-25-合同收敛与断点.md)。本原型的成功只说明所测合成场景的交互表现，不能证明真实存储、迁移、备份或正式页面通过验收。

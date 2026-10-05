# B2 抽卡界面草稿

这里保留未接入正式产品的 `DrawSessionPanel` 和 `use-draw-session`。2026-10-05 从 `src/drawing/ui/` 移入，移除生产公开导出；仅修正相对 imports，未删代码或改变草稿行为。

这是早期 B2 注入式会话界面参考，没有独立应用入口。正式抽取使用 `src/drawing/ui/ProductionDrawPanel.tsx` 与 `src/drawing/workspace-session.ts`。业务规则与原有 reducer 测试继续保留在源码和测试模块中，不能将草稿的回调当成正式持久化回执。

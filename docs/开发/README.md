# 开发入口

- [贡献指南](../../CONTRIBUTING.md)：安装、验证与提交要求。
- [模块地图](../架构/README.md)：源码职责、公开接口和并行分工。
- [浏览器回归](../../tests/browser/README.md)：隔离测试运行方式。
- [v0.3 工坊与抽取合同](../产品设计/12-v0.3工坊与抽取合同.md)：继续生效的 C0 规则与接口约束。
- [版本归档](../归档/README.md)：已完成计划、交接、原型与验收记录。

`tests/modules/` 按功能组织，`tests/architecture/` 守模块边界，`tests/review/` 保留独立反例，`tests/support/` 存测试适配器。`npm run test:independent` 递归发现独立核心反例，不因归档而漏测。

本地测试输出放在忽略的 `test-results/` 或系统临时目录，不能覆盖已归档的验收结果。原型在版本归档内保留独立入口，正式源码不导入原型或测试支持文件。

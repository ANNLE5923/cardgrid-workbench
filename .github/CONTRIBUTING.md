# 贡献指南

先读 [README](../README.md)、[模块地图](../docs/架构/README.md) 和[产品规则](../docs/产品设计/03-项目决策与问题.md)。

## 开发

需要 Node.js 22.18+（22.x）或 24+。

```sh
cd app
npm ci
npm run dev
npm test
npm run test:independent
npm run build
npx playwright install chromium
npm run test:browser
```

浏览器专项见[运行说明](../app/tests/browser/README.md)。测试只使用隔离工作区与合成数据。

## 改动边界

- 按功能找到对应模块，生产跨模块调用使用公开入口。
- 业务规则留在所属模块；shared 不承接业务状态或保存逻辑。
- 涉及数据格式、事实语义、迁移或跨模块接受操作，先说明合同变化和兼容办法。
- 保留原失败断言。重命名或移动测试须确保仍被测试命令发现。
- 自动检查通过是开发证据；独立验收要由实现作者以外的检查者执行。
- 并行工作各用独立目录；公共接口和最终合入由明确负责人协调。

## Pull Request

说明目标、受影响模块、验证结果、未测项和数据影响。普通修改无需新增长文档；重要设计理由写入已有架构/决策文档。

不要提交个人备份、数据库、浏览器 profile、真实日程截图、依赖目录或构建产物。安全问题见 [SECURITY](SECURITY.md)，分发说明见[上传与分发](../docs/使用/分发说明.md)。

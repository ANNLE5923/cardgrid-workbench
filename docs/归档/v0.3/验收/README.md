# v0.3 独立验收证据

2026-10-05 的只读检查方未参与生产修复，建议放行 G-V03。报告、总表和原冻结清单按原字节保留；独立脚本已移至 `tests/review/v0.3/`，断言与脚本内容原样保留。

- [原始报告](acceptance-report.md)：范围、发现关闭、原样门禁与未测事项。
- [机器可读总表](summary.json)：Node、浏览器各组计数、构建产物哈希和冻结复核。
- [原冻结文件清单](final-code-snapshot.json)：独立验收时的 284 个文件；清单 SHA256 为 `582044a3d05c0f75c4a67ae5a7f1313b5ba4a7d7a24627e09144d6054a7cb17f`。后续结构整理改变了部分路径、公开导出和测试发现方式，不能用此历史清单声称当前源码逐字相同；整理后的回归见[架构说明](../../../架构/README.md)。
- [独立核心反例](../../../../tests/review/v0.3/core-counterexamples.test.ts)、[独立浏览器反例](../../../../tests/review/v0.3/browser-counterexamples.mjs)：17 与 7 项，自建断言未改。
- [旧解析器反例](../../../../tests/review/v0.3/baseline-format-compatibility.mjs)与[当时结果](baseline-compatibility.json)：3 项；需要包含基线 commit 的 Git 历史。

原始报告与总表中的相对证据路径指 `test-results/v03-closure-20261004/independent/` 的本地运行，不表示批量截图和全部日志随仓库分发。原始输出仍在本地忽略目录。当前正式交付状态见[收尾记录](../开发/2026-10-05-v0.3收尾与验收.md)。

## 复跑

在项目根目录完成 `npm ci`，再运行：

```powershell
npm test
npm run test:independent
npm run build
npm run test:browser
```

独立浏览器脚本使用 Chrome 的隔离 context 与合成数据；需要先构建。输出放在忽略目录，避免覆盖验收归档：

```powershell
$env:CARDGRID_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CARDGRID_INDEPENDENT_OUTPUT = Join-Path (Get-Location).Path 'test-results/v03-repeat/independent/browser-evidence'
node 'tests/review/v0.3/browser-counterexamples.mjs'
```

未安装 Chrome 时可指定本机 Chromium 的实际 executablePath。项目完整浏览器门禁另支持 Playwright 自带 Chromium，见[浏览器说明](../../../../tests/browser/README.md)。

旧解析器脚本会生成一个仅重定位 imports 的临时旧源码，因此先复制到同样深度的忽略目录再执行。Git clone 需存在 `ef71af30a9c9f7bfa8cca671ea87b160c6094c82`；源码 ZIP 不包含 Git 历史，不能仅凭 ZIP 重跑此项。

```powershell
New-Item -ItemType Directory -Path 'test-results/v03-repeat/independent' -Force | Out-Null
Copy-Item -LiteralPath 'tests/review/v0.3/baseline-format-compatibility.mjs' -Destination 'test-results/v03-repeat/independent/baseline-format-compatibility.mjs'
node --experimental-strip-types 'test-results/v03-repeat/independent/baseline-format-compatibility.mjs'
```

三个兼容断言执行原基线解析器及未改的共享辅助模块，未启动完整历史浏览器产物。实体触屏、个人数据迁移、连续七日使用和完整视觉偏好未纳入放行结论。

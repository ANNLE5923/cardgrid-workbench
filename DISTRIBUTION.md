# 源码分发与 GitHub 上传

## 当前仓库与版本

- 仓库：[ANNLE5923/cardgrid-workbench](https://github.com/ANNLE5923/cardgrid-workbench)，公开，默认分支 main。
- 许可证：AGPL-3.0-or-later，已存在 LICENSE；package.json 同步标识。private: true 仅防止误发布 npm 包。
- 产品版本：v0.2.0，阶段0—3及G3已完成。正式验收见[G3记录](docs/测试记录/G3-2026-10-02-有界修复与最终验收.md)。
- 2026-10-02用户确认提交并推送完整产品。本次提交包含阶段2、3正式实现和GitHub上传准备；此前远端main基线为 b7eb94e。未创建版本标签、Release或启用Pages。

## 上传内容

上传完整 src、public、依赖锁文件、启动脚本、CI、设计合同、回归脚本、合成fixture及验收报告/结果JSON。原型目录仅作历史参考，正式入口位于src。README演示图来自隔离的合成工作区。

node_modules、dist、环境变量、完整备份、浏览器配置、本地数据库和测试运行的批量截图不进入源码上传。修改前源码副本留在本地；回归脚本与结果保留，缺少运行截图不影响重跑。旧文档已引用的少量合成验收图保留。忽略文件不会从磁盘删除。

个人备份请存放在仓库外；backups、private-data、browser-profiles目录也已忽略。不要依靠文件名判断任意JSON是否可以公开。

## 从源码运行与验证

需要Node.js 22.18+（22.x）或24+，首次安装需访问npm registry：

```sh
npm ci
npm test
npm run test:independent
npm run build
npm run start
```

浏览器打开 http://127.0.0.1:4173/。日常开发用npm run dev；Windows启动脚本启动开发服务器。应用数据保存在浏览器IndexedDB，源码安装不导入个人数据。不同浏览器来源、端口或设备不会自动同步。

GitHub Actions在push和Pull Request执行干净安装、Node全量/独立反例和生产构建，权限限于读取源码。浏览器93项为G3分离验收的实跑结果，当前CI不自动安装浏览器或重跑该矩阵；执行入口见[浏览器回归说明](tests/browser/README.md)。

## 分发与后续发布

源码ZIP使用与上传相同的文件清单，不包含依赖目录、构建产物或真实备份。接收人安装Node后执行上述步骤，首次工作区为空白。下载源码不会自动恢复另一台设备的数据。

上传源码与部署网站是两个动作。构建资源已使用相对路径，但本轮不启用GitHub Pages、不上传个人数据、不创建Release。若后续部署，单独确定托管地址和升级/离线验证范围。

当前已通过合成数据回归；实体触屏、真实个人迁移/恢复、七日连续使用及完整视觉偏好仍未测。真实迁移需先备份并验证恢复，不属于源码上传。

## 本轮上传准备验证（2026-10-02）

- 仅按上传清单复制源码到干净目录，没有复用原node_modules；npm ci成功。
- Node 24.19.0 / npm 11.17.0：默认221项，220通过/1原有跳过/0失败；独立反例8/8；类型检查和生产构建通过（60模块）。
- 构建资产仍为index-BgLLQjWW.js / index-Ro_6nYut.css，产品src与G3最终验收指纹无差异。
- G3浏览器93/93沿用独立验收记录，本轮仅制作合成演示图，没有冒称重跑完整浏览器矩阵。
- 相对文档链接完整；明显凭据模式未检出；当前上传清单不含批量运行截图或修改前源码备份。
- 当前Vite使用native配置加载器；22.x至少需22.18默认支持TypeScript类型剥离，见[Node.js官方版本说明](https://nodejs.org/en/blog/release/v22.18.0)。支持的运行范围已写入package.json，未改变依赖版本。
- 用户已明确确认提交与推送，按上述完整上传清单执行；源码上传不包含网站部署或真实个人数据迁移。

# 画布固定合同

`site-video-capabilities.json` 是站点当前生产使用的视频能力合同（版本 `2026-09-18.1`）的原样副本。按 LF 换行计算，SHA-256 记录在 `MANIFEST.json` 中。

画布以这份固定合同作为基准，不依赖仓库中后端代码的版本：

- 画布能力表 `docs/星盘AI_视频模型能力表.json` 须与本合同逐项一致（`server/capability-contract.test.mjs`）。
- 仓库中的后端快照（`src/new-api/.../profiles.json`，以及 Portal、网关中的副本）版本相同时会一并比对；版本较旧时，这几项检查标记为跳过并说明原因。后端快照需要另行更新，这不属于画布问题。

后端合同变化时，同时替换本文件并更新 `MANIFEST.json` 中的版本与哈希，再同步画布能力表并运行测试。

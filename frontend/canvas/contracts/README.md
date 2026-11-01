# 画布固定合同

`site-video-capabilities.json` 是站点视频能力合同（版本 `2026-10-22.1`）的原样副本，唯一来源是后端 `src/new-api/setting/video_capability/profiles.json`，由仓库根目录的 `scripts/sync-video-capabilities.mjs` 同步。按 LF 换行计算，SHA-256 记录在 `MANIFEST.json` 中。

画布以这份固定合同作为基准，不依赖仓库中后端代码的版本：

- 画布能力表 `docs/星盘AI_视频模型能力表.json` 须与本合同逐项一致（`server/capability-contract.test.mjs`）。
- 仓库中的后端快照（`src/new-api/.../profiles.json`，以及 Portal、网关中的副本）版本相同时会一并比对；版本不同时，只有在 `approved-copies.json` 登记过的副本才标记为跳过并说明原因，否则失败。后端快照需要另行更新，这不属于画布问题。
  - 较旧的副本登记为历史副本。
  - 较新的副本默认要求先更新本合同；只有某个服务已上线、站点合同和画布尚未采纳的扩展，才按精确哈希登记为超前副本（`relation: "ahead"`）。目前没有超前或历史副本：2026-10-28 起后端、门户、网关和本合同统一为 `2026-10-22.1`。

后端合同变化时，在仓库根目录运行 `node scripts/sync-video-capabilities.mjs`：它把后端合同写到网关、门户和本文件，并更新 `MANIFEST.json` 的版本与哈希。然后同步画布能力表 `docs/星盘AI_视频模型能力表.json` 并运行测试。

# 导演台宿主协议

协议实现在 `frontend/canvas/src/director-protocol.js`、`director-hosted.js` 和 `frontend/director/integration/client.js`。`namespace` 为 `starlight-director`，消息版本为 `1`，保存文档格式为 `starlight-director@1`。同源 iframe 用于界面与生命周期分隔；账户权限由宿主及既有服务校验。

## 消息与会话

每条消息包含 `namespace`、`version`、`sessionId`、`projectId`、`nodeId`、`requestId`、`kind`、`method`、`payload`。`kind` 为 `request`、`response` 或 `event`；请求 ID 是 1–128 字符的非空字符串，客户端生成 UUID。

双方同时检查来源域、来源窗口及完整会话范围。宿主在每次异步存储或素材读取前后检查账户 epoch、当前项目对象、节点与会话。项目或账户切换、节点删除及关闭使旧会话失效，旧结果不能回复到新编辑器。

响应的 `payload` 为 `{ ok: true, result }` 或 `{ ok: false, error: { code, message, ... } }`。冲突响应还带 `storedRevision` 和 `conflictId`。客户端默认等待 30 秒；超时保留编辑器中的修改。相同会话、相同请求 ID 的变更请求复用已有结果；读取结果不长期缓存。新请求 ID 不代表重试幂等保证。

## 方法

| 方法 | 输入和结果 |
| --- | --- |
| `ready` | 返回当前文档、账户作用域、保留的旧格式记录及可用模型目录；目录读取不提交模型任务。 |
| `document.load` | 返回完整宿主文档或 `null`；未知格式、错误绑定或无效分辨率报错并保留原档。 |
| `document.save` | 输入 `expectedRevision`、`scene`、`dependencies`；原子比较修订号后返回实际保存文档。 |
| `asset.list` | 返回当前项目素材描述；输入连线顺序优先，其次当前修订输出及其他素材。 |
| `asset.read` | 输入 `assetId` 或稳定 `ref`，可指定 `sha256`；验证内容后返回描述及完整字节。 |
| `asset.write` | 输入完整 `bytes`、`mime`、`name`，可带摘要、角色与对象 ID；返回稳定素材描述。 |
| `output.publish` | 发布一个完整成功输出，返回素材描述及画布素材节点 ID。 |
| `output.publishBatch` | 输入 `entries`；全部校验、暂存后原子发布整批输出。失败不创建成功节点。 |
| `generation.createDraft` | 输入模型、模式、提示词、时长、画幅、修订及有序参考素材；建立既有画布生成草稿，创建草稿本身不提交收费请求。 |
| `proposal.quote` | 查询用户主动选择的 AI 提案报价。 |
| `proposal.request` | 用户明确确认后通过现有模型接口请求提案；费用和幂等边界由提案及既有提交模块负责。 |
| `proposal.status` | 查询该会话的提案状态。 |
| `session.close` | 关闭会话；宿主也可发送同名 `event` 通知编辑器退出。 |

## 完整修订与稳定素材

`scene` 必须包含 `projectRef` 和 `projectSha256`，指向完整 `.cclayproject` JSON 素材。`dependencies` 必须包含相同引用和摘要的根素材，每项包含稳定 `xp-asset://<assetId>` 引用及 SHA-256，可包含角色、对象 ID、MIME 和大小；宿主验证实际字节而非信任调用者摘要。根工程内嵌恢复所需模型、贴图、动作和姿态库。

`scene.summary` 是展示摘要，不替代完整工程。可选 `scene.characterBindings` 按真实工程角色 ID 绑定原始图片素材，最多 64 项，禁止重复或未知角色。可选 `scene.exportResolution` 只接受数字 `720` 或 `1080`，回执和加载保留该值；旧文档缺少此字段时编辑器默认使用 1080。

新文档使用 `expectedRevision: null`；已有文档使用实际修订号。宿主要求原子 `setIfRev`，成功才产生下一修订。冲突不覆盖当前文档，而在同一账户、项目及节点范围另存草稿。未知格式或已有损坏记录不会通过保存空工程清除。

当前持久化使用浏览器 IndexedDB，按服务器核验的账户 subject 分隔 KV 和素材字节，再按项目与节点绑定。保存回执表示该浏览器中的完整修订已经提交，并不表示工程已同步到服务器或其他电脑。跨浏览器迁移须导出并导入完整工程包；不要把运行时 blob URL、本机路径或缓存作为迁移依赖。

素材上限与画布一致：图片 30 MiB，视频及工程文件 100 MiB，依赖清单最多 2000 项。相同字节、来源节点、角色和对象身份可复用已有素材；持久化引用保持稳定，临时 URL 仅用于运行。

## 输出与费用边界

输出必须带 `completed: true` 和当前 `sceneRevision`。视频只支持 24/30 fps、最多 30 秒，并保留整数帧编号、帧数和镜头信息。输出暂存前后、最终原子提交时均校验修订及当前会话，失败清理本次未提交的暂存字节；提交后的展示失败不撤销已保存输出。

保存确认后，导出、生成草稿和提案准备还须核对当前完整工程、输出设置及工程会话。等待期间有新修改或切换工程时停止该次操作，保留修改，重新保存后再操作；已打开的作者面板在导出时禁用编辑。工程文件声明未知工作流子版本时拒绝加载和改写，保留原档。

参考素材模式和首尾帧模式分别建立连线，角色原图、首尾帧及视频顺序由稳定素材 ID 保持。供应商生成时长遵守模型能力合同，参考视频长度不自动成为生成时长。

编辑、预览、导出、保存、导入和建立生成草稿不自动调用收费模型。AI 提案或实际视频生成由用户主动发起，经现有报价、确认与任务恢复流程执行；已接受任务通过查询和下载恢复，不重新创建。

# 智能画布 0.5 核心接口合同

基线：c582a02a6d9b2c5a1489444fbcaa335b65745ee4（canvas/0.4.4）。本合同先于核心实现提交；集成方以本文件和后续明确的合同变更为准。

## 五种独立事实

1. 服务器生成事实保存在任务记录的 status、stage、contentReady、deliveryStatus、executorVersion 等字段。status 只由可信服务器响应改变；HTTP 查询失败、本地暂停和下载到期均不能伪造生成失败。serverObservedAt 只表示本地收到响应的时间，不充当服务器顺序号。
2. 本地查询健康用 queryHealth（ok、retrying、needs_review、auth_required）、queryError、nextQueryAt 表示。404、超时、断线和 5xx 只改变这些字段，保留最后确认的服务器状态、taskId、idempotencyKey 和原请求身份。Retry-After 是最短等待时间。显式重新查询只发送 GET。
3. 本地任务记录保存用 localSaveState（saved、pending、blocked）和 localSaveError 表示。保存失败先保留内存记录并按限速重试；页面关闭后内存无法保证存活，重新打开时从原持久任务或待提交记录恢复并用原 taskId 查询。持续不可写时阻止依赖可靠持久化的新付费操作。
4. 节点关联用 projectId、nodeId、node.data.run.taskId、detached、resultAssetId 表示。canAttachResult 仍是写节点的必要条件；跨标签页须在最新持久项目稿中重新核验关联，不能依据旧缓存写入。
5. 交付事实与生成事实分离。contentReady 和 deliveryStatus 描述服务器交付；resultBlobId、resultAssetId 只是本地元数据线索，不证明文件存在。读取本地成片必须验证 blob 实体、非空、视频类型和记录与素材的任务归属；远端链接过期不使已验证的本地成片失效。

## 接口与返回约定

- task-status.js 保持 isSettled、canFetchContent、isFinalFailure、canAttachResult、needsTracking、hasLocalResult、taskPhase 的导出名称和调用形态。hasLocalResult 仍只回答“有本地结果线索”；实际可播放或保存须走异步实体校验。明确服务器终态由 terminalEvidence 标记；旧 not_found 若无可信终态来源，按查询待核对解释并允许 GET，不直接放行新 POST。
- gennode.js 保持 runner.poll(taskId, projectId)、setPollPaused(taskId, paused, projectId)、download(taskId)、resultURL(taskId, projectId)、recOf(taskId, projectId) 的既有入口。新增 runner.requery(taskId, projectId)，返回 { started, reason? }：核验身份后立即查询原任务，绝不创建新任务。新增 runner.localResult(taskId, projectId)，返回 { ready, source?, assetId?, reason? }，供 UI 在预览、保存和时间线使用前校验。download 仍以 true 表示完整入库，null 表示未完成；本地完整结果可复用且无须远端仍可下载。
- store.saveTask(record) 成功返回 { ok: true, record, rev }；原子条件写不可用或有限重试仍冲突时抛带 code 的错误，分别为 task_atomic_unavailable、task_write_conflict。失败不得退回无条件 set。传入记录不视为数据库真源；调用方应使用返回的合并记录。
- api.js 的 ApiError 继续提供 status、code、retryAfter。裸 HTTP 404、410 及身份错误只表示该次请求的结果；只有服务端合同明确的、可区分任务与内容地址的不存在/删除代码，才可作为任务终态证据。未知 executorVersion 按保守门槛处理，不能当成确定的旧版。
- 本地任务记录版本单独维护，绝不从 executorVersion 推断。0.4.4 的记录与工程包继续可读；升级保留原 taskId、幂等键与原正文、取消意图、v2 字段、素材映射及未知字段。导入/恢复不发生成 POST。“创建副本/新版本”是独立的显式操作。

## 集成方调用原则

| 用户动作 | 核心条件与结果 |
|---|---|
| 继续查询 | 调用 requery 或解除暂停后查询；queryHealth 异常不改变服务器 status，不创建任务 |
| 恢复下载 | 先调用 localResult；ready 时直接用本地文件，否则仅对原 taskId 调用 download |
| 停止等待 | setPollPaused 只停本地 GET，不代表服务器取消或失败 |
| 请求取消 | 仅 canRequestCancel 为真时调用已有 cancelTask，保留原任务身份 |
| 创建新版本 | 由 UI 单独明确确认；未决提交、查询待核对、保存待恢复不能借此自动换键重投 |

工作流仅对经验证的本地产出复用；有可信 taskId 时查询或下载；无 taskId 且发送结果不明时保留原键和原正文并阻止自动重投。completed 但未 ready、查询待核对、落盘待恢复时暂停依赖链，允许无关节点状态展示。已确认计划的范围、型号、参数、素材角色或估价依据变化须重新预检确认。跨标签页驱动前后均核对持久运行身份和驱动权。

## 兼容与回退

0.5 不清空 IndexedDB，不进行破坏性全库重建。升级前先保存可恢复的旧工程快照，写入失败保留旧稿。0.5 新字段缺失时按保守状态解释；旧 not_found 没有 terminalEvidence 时可重新查询原任务，但不能因此自动生成。回退到 0.4.4 前需暂停新写入并保留 0.5 工程快照；旧客户端不理解的新记录不得以旧默认值覆盖。真实服务器的状态码与错误代码仍需在集成验收核对，客户端模拟测试不证明真实计费恰好一次。

## 实现后的接口增补（2026-09-25）

- `store.saveTask(record, { fields?: string[] })` 的可选 `fields` 指定本次调用拥有的字段。轮询只写查询观察字段，暂停、脱离和结果关联分别单独写；成功仍返回 `{ ok: true, record, rev }`。新增 `task_identity_conflict` 与 `task_record_version_unsupported` 错误。`rev` 是本地 CAS 修订，不代表服务器事件顺序。
- `task-status.js` 新增 `isSupportedTaskRecord(record)`。本地 `recVersion` 缺失视为旧工程，1–2 可读；高于 2、非整数或小于 1 的记录只读待核对，不可自动查询、下载、覆盖或据其脱离标记新建付费任务。`executorVersion` 与此判断独立。
- `runner.localResult(taskId, projectId)` 返回 `{ ready: true, source: 'asset'|'result', key, assetId, blob }` 或 `{ ready: false, reason }`。只认本任务命名空间的结果 blob 键或经任务归属核验的素材 blob；核验实体非空、视频 MIME、素材记录大小以及常见错误页头。它回答的是本机实体是否可用，UI 不能再用 `hasLocalResult`、`taskPhase('local_ready')` 或 `resultAssetId` 代替。
- `runner.resultURL` 创建 object URL 后，调用方应在预览/保存结束时调用新增 `runner.releaseResultURL(url)`。核心拥有的节点预览已处理生命周期；任务列表与其他 UI 调用点由集成方配对释放。
- `runner.requery(taskId, projectId)` 仅恢复原任务 GET，失败返回 `{ started: false, reason: 'task_missing'|'identity_changed'|'local_save_pending'|'task_record_version_unsupported' }`；成功返回 `{ started: true }`。旧 `paused=true` 且缺少 `pauseSource` 保持暂停，只有明确旧 `status='need_key'` 才迁为身份暂停并允许原密钥自动恢复。手动暂停不被恢复扫描解除。
- 终态互相矛盾且缺可靠服务器修订时保留首次已落盘终态，并设置 `terminalConflict` 与 `queryHealth='needs_review'`，不可按任一冲突状态自动继续工作流。远端下载过期用 `downloadExpired=true`，不抹去已确认的 `completed`；完整本地成片仍可使用。工作流在下游付费前检查已完成上游的产出身份和持久驱动权。
- 时间线片段的 `durationManual === true` 是手动时长来源标记；`normalizeTimeline` 和工程导入的 `importStudio` 保留该布尔真值，缺失/假值不补写。若片段已有可信 `sourceDuration`，归一化后不同时保留冲突的手动来源标记。工程包按原项目身份重映射素材，但不丢该片段来源事实。

## 集成复核后的接口增补（2026-09-25，核心实现 096c332）

- `runner.restoreTask(taskId, projectId)` 对不支持的本地 `recVersion` 在新增或改写节点前返回 `null`；`restorePending` 遇到关联的较新版本任务也不清除 pending。任务中心应只读展示这类记录。
- `workflow.resume()` 以当前打开项目的 `projectId`、运行 `id` 和密钥指纹识别原运行。切走再切回同一项目后可续跑已受理任务，不新建 POST。浏览器驱动在执行全程持有 `xp-workflow-driver:<runId>` Web Lock；刷新释放锁后，新页面可接管遗留 `running` 稿。活跃他端驱动不可被另一个页面抢占或代为暂停。非浏览器测试用同进程存活记录与 `driverAt` 租约兜底。
- `workflow.resume()` 与 `retryRow()` 在项目或密钥身份不一致时抛出明确错误，不改写持久运行稿；持久运行不存在或不可读时不从内存旧稿复活。导入工程里的工作流仅作为历史状态展示，须重新预检并确认新运行；原任务 ID、幂等键与素材关联仍由任务中心独立恢复。

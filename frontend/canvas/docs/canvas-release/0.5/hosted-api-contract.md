# 智能画布 0.5.0 托管 API 与账户边界合同

状态：托管核心开发合同。基线 `18cc00c336ee95926951beea398ad99f6009e373`；本文件须先于依赖它的实现提交。此合同只约束托管候选，不是生产部署证明。

## 身份选择与已核对的实现

### 星光账号登录入口（当前实现）

正式托管画布只提供账号登录，不提供手动输入 API Key 的表单。入口在脚本加载前显示账号确认状态；登录 Cookie 有效时自动进入，刷新继续使用原账号。未登录或会话已撤销时跳到 `/login?canvas=1`，完成用户站登录后返回画布。身份服务暂不可用或缺少接口时保留重连入口，不把故障当作退出，也不降级到手填 Key。

完成账号登录及所有验证因素后，服务端自动准备该账号唯一的画布专用 Key。已有绑定原样保留，已撤销的 Key 不会被登录自动替换。浏览器只持有登录会话绑定的画布凭据，不取得原始 Key 或服务端调用证明。适配层核验实时登录会话后，通过受保护的桥接接口换取服务端调用凭证；账号切换、登出、禁用和撤销继续使旧浏览器会话失效。

画布 Key 从用户令牌列表、搜索、单项读取、原文读取、批量读取及删除中排除；原始 Key 单独用于 relay 认证也会被拒绝。管理员在用户管理的“画布专用私密 Key”入口主动查看，接口为 `POST /api/user/:id/canvas-key`，需管理员登录，并返回 `Cache-Control: no-store`。管理员取得的原始 Key 仍不含服务端调用证明。

专用凭证按用户账号的正常分组优先，再按已配置分组查找可用模型；可以访问站内已启用且已配置计费的模型，不改变普通 API Key 的分组权限。费用和共享生成并发继续归属于该账号，没有平台公共 Key，也不免除余额、禁用、计费合同及模型能力校验。站内存在模型不代表画布已实现其全部输入形式。

凭据核验依赖失败返回 503，不视为用户退出；确认无效或被撤销才返回认证错误。视频网关保留原始 Key 对应的幂等作用域，升级服务端调用证明不创建重复任务。上线前应排空旧凭证对应的未提交异步队列；旧已接受任务继续查询和交付。桥接秘密轮换必须在旧凭证后台工作排空后进行，不能与这次升级混做。

以下为早期手填 API Key 模式的合同记录；其普通 Key 路径仍受原有权限限制，账号登录入口以本节为准。

首版托管画布使用用户自己的 New API Bearer API Key。每个托管请求由专用、同源的 `/canvas-api` 适配层按固定路径转给现有 New API、视频任务网关或参考素材服务；适配层先以原 Key 请求 New API 的 `GET /api/usage/token/canvas-identity`，不接受客户端提供的用户 ID、显示名、Key 指纹或 Cookie 作为授权。此身份端点在仓库快照的 `router/api-router.go`、`middleware.TokenAuthReadOnly` 和 `controller/canvas_identity.go` 中已实现并有 SQLite 合成用户测试；它再次核对令牌 ID、所有者、状态、有效期和用户状态，返回 `data.subject = "u<用户数据库 ID>"`。同用户换 Key 时 subject 不变，跨用户 Key 必须得到不同 subject。生成和查询所用的 `TokenAuth` 还核验令牌状态、用户状态、分组和模型限制；适配层不得使用平台共用 Key。

Portal 的已登录会话包含短期 access token、`POST /api/user/auth/refresh` 和 `GET /api/user/self`，但仓库中的 `/v1/videos`、图片/文本 relay 与参考素材上传要求用户 API Key，并不直接接受 Portal access token。Portal 可负责页面入口及其自己的登录体验，画布数据访问仍以经过服务器核验的用户 Key 为准。不得把 Portal 页面上的 user ID 当作 relay 身份。若以后改为纯 Portal 会话调用，需要单独实现并测试逐用户计费与授权转接，不得隐式换成共享平台 Key。

原始 Key 仅存当前页面内存；请求头 `Authorization: Bearer <用户 Key>`，不放入 URL、项目、IndexedDB、导出包、日志或分析。托管适配层不转发 Cookie，不设置宽泛 CORS；使用 Bearer 而非 Cookie 授权，因此没有 Cookie CSRF 凭据。写请求仍只接受配置的同源 `Origin`，防止错误反向代理接线。Key 失效、被禁用、用户被禁用或身份服务不可核实时拒绝新请求；不得将认证失败解释成任务终态。

## 路由与数据合同

适配层只接受下表路径和方法，其他路径返回 404，不是通用 `/site` 或 New API 代理。`/canvas-api` 由同站反向代理提供；`/site` 保留给旧本机模式，托管页不得失败后自动回落到 localhost。

| 方法与路径 | 请求与响应 | 服务端授权和能力 |
| --- | --- | --- |
| `GET /canvas-api/features` | `{mode:"hosted", apiVersion:1, features:{cancel:false, sharedRender:false, director:false}}` | 仅功能探测；结果不构成用户身份。缺服务或版本不符时托管功能停止，不回落本机模式。 |
| `GET /canvas-api/identity` | Bearer Key → `{subject:"u42", displayName:"…"}`，`Cache-Control: no-store` | 每次通过 New API `/api/usage/token/canvas-identity` 取得并核验；不接受客户端 subject。401 `auth_required` 或 403 `identity_forbidden` 表示当前 Key/用户身份不可用，应停止旧会话；其他单任务 403 不推断会话失效。503 表示身份后端不可核验。 |
| `GET /canvas-api/v1/models` | 透传 New API 模型目录 JSON | 用户 Key；可用型号仍由 New API `TokenAuth` 和画布能力表共同约束。目录不证明生产计费口径。 |
| `GET /canvas-api/api/pricing` | 公开标准价 JSON | 不带 Key；仅供参考，不作为实际分组扣费依据。 |
| `POST /canvas-api/reference-assets` | 原始图片/视频/音频字节、准确 `Content-Type` → 现有 `{id,url,kind,content_type,size,expires_at,…}` | 用户 Key 经身份核验后送现有参考素材网关；网关自身以 `/v1/models` 验证 Key、格式、大小和媒体内容。 |
| `POST /canvas-api/v1/videos` | 现有 JSON、`Idempotency-Key` 原样保留 → 网关公开 `vjob_…` 任务 JSON | 用户 Key、JSON 型号校验、托管可用性策略后送固定 `VIDEO_API_URL` 的 task-error-gateway `/v1/videos`。网关在 PostgreSQL 按原 Key 哈希与幂等键持久化队列和映射，再单次提交 New API 计费核心。适配层绝不在超时、404 或 5xx 后切换上游或自动重提。 |
| `GET /canvas-api/v1/videos/:id` | 原公开任务 JSON | `vjob_` 先用同 Key 调 New API 的 Canvas 所有权端点，允许后送网关；`task_` 旧公开 ID 直接送 New API 自身按用户查询。403/404、查询超时和代理错误只表示本次查询失败，不推断终态。未知 ID 格式直接拒绝，不猜测或切换上游。 |
| `GET /canvas-api/v1/videos/:id/content` | 原始 MP4/WebM，保留 200/206、`Content-Type`、`Content-Length`、`Content-Range` | 与查询相同的 ID 分类和服务器端所有权核验；`vjob_` 经过网关原交付缓存和签名链，`task_` 经过 New API `VideoDownloadAuth`/`VideoProxy`。适配层不跟随重定向，客户端继续执行完整性检查。 |
| `POST /canvas-api/v1/videos/:id/cancel` | 当前候选对自有任务返回 501 `cancel_unsupported` | 先按同一 ID 路由核验所有权；非本人/不存在返回 404，自有任务明确返回 501，绝不伪造服务器取消。只有确认取消合同并补完测试，才可把功能探测改为 true。 |
| `POST /canvas-api/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits` | 现有 JSON → 现有 New API 响应 | 用户 Key；同步付费请求没有视频的 24 小时幂等承诺，调用方保留持久化操作守卫，不自动重发不确定提交。 |

所有认证请求使用 `credentials: "omit"`、`cache: "no-store"` 和 `redirect: "manual"`。除首次 `/identity` 外，已打开的浏览器会话每次请求还带 `X-Canvas-Subject: u<ID>`，由适配层与**重新核验的 Key 归属**比较；不一致返回 409 `identity_changed`，该头本身绝不授权。适配层只转发业务所需头，不复制客户端 `Cookie`、`X-User-ID`、`X-Canvas-Subject`、`X-Forwarded-*` 或任意目标 URL。错误格式为 `{error:{code,message}}`；核心可识别 `auth_required`（401）、`forbidden`（403）、`task_not_found`（404）、`identity_unavailable`（503）、`cancel_unsupported`（501）、`model_billing_unverified`（409）、`identity_changed`（409 或本地切换后丢弃旧响应）。未知 404/410、超时与网关错误均不得被解释为服务器任务终态。

## 素材、任务与取消的所有权

现有站点 `/v1/videos*` 先进入 task-error-gateway：异步新建立即返回 `vjob_<32位小写十六进制>`，网关在 PostgreSQL 保存 Key 范围的幂等及公开 ID→New API 内部 `task_` 映射，并负责错误规范化、交付缓存及 Range。直接调用 New API 不具备这些已在用的公开任务和交付语义，因此托管视频新建固定走网关。`NEW_API_URL` 仍是身份、型号、价目、图文 API 的独立后端，不能整体改为网关；`REFERENCE_ASSETS_URL` 仍是素材网关。新增必填 `VIDEO_API_URL` 是固定内部网关 Origin，浏览器不得指定上游。

网关原生 `vjob_` 路径不能把随机 ID 本身当托管账户授权：排队期查询可匿名获取状态，已提交后的查询还取决于 New API 的用户 Key；内容路径是有意公开的分享能力，由网关为内部任务重新签名。托管适配层在每次 `vjob_` 查询、下载和取消预检前，以用户 Bearer Key 调 New API `GET /api/usage/token/canvas-video-ownership/:id`。该端点位于 `TokenAuthReadOnly` 路由下，返回 204 仅表示拥有权；不存在与他人任务统一返回 404，不返回内部任务 ID、供应商地址或 Key。端点只读取现有 `video_async_submissions` 与 `tasks`：尚无 New API 内部任务号时，当前原始 Key 的 SHA-256 必须匹配网关的 `scope_hash`（兼容旧授权头哈希）；已有内部任务号时，还必须有唯一 `tasks.task_id` 且 `tasks.user_id` 等于当前经服务器认证的用户 ID。数据库/映射不可核实时返回 503，适配层失败关闭，不改走匿名网关查询。所需后端补丁严格限于 `src/new-api/router/api-router.go`、`src/new-api/controller/canvas_video_ownership.go` 及其测试；不改网关计费、schema 或供应商策略。本站公开 `/v1/videos/vjob_…/content` 分享路径继续存在；托管 `/canvas-api` 是账户核验接口，不能声称底层分享链接是私有媒体。

旧 New API 公开 `task_<32位字母数字>` 任务号仍由 New API 以用户 ID 鉴权查询、下载，故历史此类任务可直接恢复。现有网关 `vjob_` 号用上述 Key/内部任务归属证明恢复。网关尚在排队、没有内部任务的 `vjob_` 在换 Key 后需要原 Key；内部任务建立后同账户新 Key 可凭 New API 的用户归属恢复。网关已受理但响应丢失的请求，只能在 24 小时窗口内由**原 Key、原正文、原幂等键**显式重试；同账户新 Key 不可重投，因为网关幂等范围是原始 Key，换 Key 会创建另一个逻辑任务。历史未知格式或缺少可验证映射的 ID 需要明确迁移/人工核对，适配层不猜测归属。请求取消当前不支持；任务中心应隐藏或禁用，导入任务仍保留原 ID 与幂等键。

现有参考素材网关的 `POST /reference-assets` 需要有效用户 Key，但它生成的 `/reference-assets/<hash>.<ext>` 在有效期内可公开读取。这是现有、有期限的链接分享能力，**不是私人素材读取接口**；获得完整 URL 的用户可以引用它。托管画布的私人项目 Blob 只在浏览器本地、按账户命名空间隔离，不向其他账户自动列出或附加。若产品以后要求参考素材也按用户私有，须改网关所有权存储与读取规则，不能把当前公开 URL 说成私有。

## 浏览器账户切换与数据连续性

托管账户命名空间只取 `/identity` 返回的 `subject`，形式为 `hosted:v1:u<ID>:`；未登录草稿使用独立 `guest:v1:`。同一浏览器中的账户 A 与 B 的项目索引、文档、task/pending、素材 Blob 和预览缓存不能互相枚举。切换 Key、登出、失效认证时先停止旧工作流/任务轮询与上传、尝试保存当前项目，再使旧 scope 失效、撤销旧对象 URL，最后建立新账户存储与 API 客户端；Key 一旦改变，旧客户端即使 scope 尚未失效也拒绝新调用和迟到响应。已持久化为已受理任务的记录绝不重 POST；同账户新 Key 查询原 `task_` 与已建立内部任务的 `vjob_`，排队期 `vjob_` 的限制如上。未确认网关提交只能由原 Key 以原幂等身份显式重试；从本机导入的未确认提交不继承托管账户证明。工作流运行身份按核验的 subject 维持同账户换 Key 续跑，但旧会话在 Key 变化时停调度。

旧本机工程不会自动出现在网站：浏览器存储按 origin 分隔，只能由用户显式导出、再在已验证账户下导入。导入后不自动创建任务；原 task ID 先经服务端所有权查询核对，未确认 pending 继续保持禁发。浏览器本地存储不防御拥有同一操作系统/浏览器配置文件访问权的人；产品界面应提示备份与共享浏览器限制。

## 托管型号可用性与部署前提

`minimax-h3-768p-full-slow` 已于2026-09-27核对生产配置为 ¥0.10/秒（启用分组倍率1，无分组专价覆盖），与2026-09-18.1能力合同一致。新建走统一视频网关并要求原始幂等键；旧任务查询、下载和原计费快照继续保留。此型号不再返回固定 `model_billing_unverified`；该错误码的会话分类仍保留，其他业务计费拒绝不能使用户退出登录。

托管适配层不保存账户、任务或资产所有权映射，重启不丢失这些状态；安全关键状态依赖 New API 数据库的用户/令牌/任务、网关已有 PostgreSQL 异步提交与幂等映射，以及网关既有交付缓存。部署前必须确认运行中的 New API 已包含 `/api/usage/token/canvas-identity` 和新增所有权端点、用户范围查询/下载、必要分组限制；网关已启用并持久化异步队列，且与 New API 访问同一个任务数据库；参考素材网关版本与站点路由也须确认。仓库快照不是生产版本证据。适配层必填 `NEW_API_URL`、`VIDEO_API_URL`、`REFERENCE_ASSETS_URL`、`PUBLIC_ORIGIN`，可选 `HOST`/`PORT`；具有 IP 允许列表的用户 Key 须核对适配层→New API/网关→New API 的实际来源 IP。不得在没有上述核验时把它接到生产或迁移生产数据库。首版无云项目库、跨设备同步或共享服务端 FFmpeg；现有本机 `/site` 运行模式保持独立。

本开发分支原有后端补丁为 `src/new-api/controller/canvas_identity.go` 及其测试：身份端点在已校验令牌与用户状态之外，复核令牌指定分组或用户默认分组仍在允许集合中。视频路由新增的窄补丁仅为上文列出的所有权端点、路由及测试；二者都不修改计费或后端 schema，也不代表生产已部署。

## 交给 UI/部署负责人的接线

请在托管页显式选择 `/canvas-api` 模式；Key 输入后调用 `openHostedCanvasSession({storage, getKey, base:'/canvas-api'})`，一次获得 `{identity, features, storage:scope, api, invalidate}`。此工厂先探测版本、再由服务端核验身份，核心 `createSiteClient({mode:'hosted'})` 只接受该工厂签发且与当前 Key 绑定的 scope；不要自行以显示名、Portal 页面字段或 Key 指纹构造 scope。以该 `scope` 创建 `createStore(scope)`、`createTaskRunner({... ,accountScope:scope})`、`createWorkflow({... ,accountScope:scope})`；其他付费模块若使用 `createSubmitLock`，传 `{namespace:scope.lockNamespace,assertActive:scope.assertActive}`。账户切换顺序为 `await workflow.stopForIdentityChange()`、`runner.stopForIdentityChange()`、尽力 `await store.flushForSwitch()`、`session.invalidate()`、更换或清除内存 Key、创建新会话与 UI；如果 runner 返回的 `pendingLocalSaves` 非零，向用户显示尚待恢复的本地保存状态。任务中心的 `taskPhase`/`statusLabel`/`statusTone` 传 `{keyFp,accountSubject:scope.subject}`；已受理任务仅在服务端成功 GET 后附 `ownerSubject`，导入文件中的所有者自称不受信。读取 `features.cancel` 后隐藏或禁用取消入口；对 `model_billing_unverified` 显示“该型号托管新建暂停，原任务仍可恢复”。托管构建不使用 `/site`、localhost、Node 本机服务或浏览器密钥指纹作为授权。
# 用户站账号绑定增量（2026-09-26）

用户站侧栏“智能画布”为普通 `/canvas/` 链接。所有成功完成的登录通过公共 `setupLogin` 签发 `new_api_canvas`：同源、根路径、HttpOnly、生产 Secure、SameSite=Strict、无 Domain。升级前已登录但没有该 Cookie 的用户首次需经 `/login?canvas=1` 重新登录；密码和 2FA 均通过后才绑定。刷新、bootstrap、退出响应不写或删除此 Cookie，避免迟到响应覆盖新账户；退出与撤销在服务端使 SID 失效。新登录撤销其携带的旧有效 Canvas 会话，撤销失败不发放成功登录。

`GET /canvas-api/session` 只读返回短格式、按 SID/安全版本固定的签名凭证、subject 和稳定 fingerprint。后续请求同时携带同源 Cookie 和内存 Bearer；二者不符返回409 identity_changed，旧工作区停止，不能自动换账号续跑。普通刷新不改变凭证，新的明确登录改变凭证但保持该账户的任务 Key 指纹。返回的 fingerprint 是普通完整 `sk-` Key 的 SHA-256 前16位。

Adapter 每次通过独立服务密钥调用 New API `/internal/canvas/session`，验证浏览器会话、用户状态和安全版本后，取得该用户的稳定普通 Token。映射表 `canvas_account_tokens` 只存 user_id/token_id，事务锁和唯一索引保证绑定唯一；用户禁用/删除该 Token 后不自动补发，额度耗尽保留只读任务恢复。正常余额、Key额度、分组、IP和具体路由计费检查继续生效。真实 Key 仅服务端转发，Cookie、Canvas凭证和服务密钥不转发到供应商/素材/视频接口。Caddy公开封闭 `/internal/canvas/*`；即使误暴露，内部处理器仍要求服务认证。`/internal/canvas/ready` 核对服务密钥及所需表。

`CANVAS_SESSION_BRIDGE_KEY_FILE` 在 New API 与 adapter 中指向同一专用密钥文件；宿主目录0700、文件仅必要UID可读（adapter UID65534，New API root），只读挂载，不写入Compose值、镜像、构件或聊天。正式网页不再提供手动 API Key 入口；原手动 Key 创建的尚未确认提交保留原始记录及幂等身份，不会改用账号专用 Key 重投。本机开发版的手动配置入口不受此变更影响。

以下章节保留原手动 Key 合同；账号绑定的会话协议以上述增量为准，业务路径与数据安全约束不变。

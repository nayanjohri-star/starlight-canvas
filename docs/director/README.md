# 托管导演台构建、安装与恢复

版本以产物 build.json、源码包 SOURCE-VERSION.json 和 Git 完整 SHA 为准。未提交构建不能作为正式发布候选。

配套说明：[宿主协议](host-protocol.md)、[MiniMax 功能对照](minimax-comparison.md)、[基准与测量范围](benchmark.md)。

## 构建与托管

源码保留 frontend/director、frontend/canvas、docs/星盘AI_视频模型能力表.json、docs/director、deploy/canvas-web 与 deploy/canvas-hosted-api。Node.js 24 上先在两个前端目录分别执行 npm ci，再在画布目录运行 node scripts/build.mjs --mode hosted。编辑器纯测试为 frontend/director 下的 npm test；完整发布须通过画布严格门禁和 CI。

产物 frontend/canvas/dist-hosted 安装到静态服务 site/canvas，包括根入口与 releases/<内容身份> 的完整不可变资源图。不要拆分不同版本文件或删除旧 release 目录。用户从已登录站点进入 /canvas/，使用既有 /canvas-api 会话和任务恢复协议。New API、视频网关、素材服务及账号秘密由管理员按 deploy/canvas-web/README.md 配置；源码不含后端数据库或真实配置，也不伪造登录。

deploy/canvas-web/Caddyfile 服务静态文件，primary-site.caddy 是主站转发片段，deploy/canvas-hosted-api/server.mjs 是实际请求边界。开发不自动部署生产环境或改变仓库可见性。

## 开源范围

CozyClay 修改版及与其结合运行所必需的画布导演台集成按 AGPL 网络源码要求提供对应源码。第三方组件保留各自授权；站点后端及仓库其他组件按已有权利与声明提供，不用一个根许可证声称整库重新授权。程序人物为原创资产，不分发上游 Mixamo 原始文件。运行字体和第三方文本随包保留。

每个运行版本的页脚链接到同目录 source.zip。正式候选需验证源码可重新构建、锁文件完整，且没有真实秘密、用户素材、数据库、日志或机器专属配置。

依赖许可证正文与锁定清单位于导演台 `public/licenses/`。构建会检查清单与两份前端锁文件及正文摘要一致；升级依赖后先复核缺失许可证的官方来源，再运行 `node frontend/director/tools/dependency-notices.mjs` 重新收集。`--verify` 只读验证现有清单。来源与发布者只提供 SPDX 声明的限制随源码保留。

## 保存与回退

宿主文档 starlight-director@1 以修订号、完整 cclayproject 素材及 SHA-256 清单绑定账户、画布项目和节点。完整修订与素材字节存于当前浏览器 IndexedDB，账户 subject 由服务器核验；保存回执不代表服务器、云端或跨设备同步，跨浏览器迁移使用完整工程包，见 [宿主协议](host-protocol.md)。保存冲突保留草稿；摘要不符、未知版本或缺少必要素材停止加载并保留旧存档。

scene.exportResolution 是可选的数字字段，仅接受 720 或 1080，与编辑器的分辨率选择一致；保存回执和重新加载保留该值。旧文档未提供时使用编辑器默认 1080。无效字段会拒绝加载或保存，并保留原档。

回退只切换本次涉及的前端/适配器版本，保留不可变资源目录。用户先导出完整画布工程包或导演工程，保留格式版本；旧应用不能读取新格式时不得当成空工程覆盖。不重置数据库、模型价格或浏览器工程。安装、回退及用户工程保留必须在固定候选上实测。

## 验收要求

七项必需作业：strict-gate、hosted-topology、hosted-backend-tests、launch-staging、production-compatibility、hosted-director、release-verdict。资源缺失、零测试、失败进程和未经登记的跳过均阻断新导演台发布；旧插件可选测试不能替代。

Windows 参考电脑另外执行 `npm run test:director-native -- --no-build`：预先设置 `CANVAS_HOSTED_URL` 指向隔离 Caddy、`CANVAS_E2E_CHROME` 为正式 Chrome 或 Edge 的完整路径、`CANVAS_DIRECTOR_CANDIDATE_SHA` 为干净产物的完整提交号。该层串行检查真实 125% 浏览器缩放与 NVIDIA 绘制性能，缺设备或候选身份不一致直接失败。普通 CI 的软件渲染测试不能替代这份发布证据。

真实费用证据单独记录。本轮授权仅 1 次 Seedance 2.5、总额不超过人民币5元；该唯一测试已于 2026-10-01 完成，型号 `seedance-2.5-vip-480p`、4 秒、实际费用人民币2.20元，返回 MP4 已下载并完整解码（1,568,315 字节，97 帧，854×480）。它证明该次供应商任务与交付；不能替代最终候选的软件验收，也不保证其他场景的生成质量。请求关闭声音，但交付仍有音轨且实测有声，原因尚未确认；本轮不再收费重试。

正式发布必须取得同一 SHA 的浏览器、原生显卡和媒体验收、七项必需 CI 及聚合批准构件，并用该构件实际执行 V24 隔离预发布安装与回退，核对旧资源可访问及工程保留。历史或中断门禁不能代替最终批准。实际验收范围、剩余项和部署状态以该版本随附的独立验收报告为准；实现或必需验证存在阻断项时，状态为“尚不可上线”，全部必要条件齐全后才可标记“可受控上线”。

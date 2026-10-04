# 星光托管导演台

这是 CozyClay `4226099b42958b9d76ef390aa067d2449d3c2994` 的 AGPL 修改版，通过同源、按需加载的 iframe 接入星光画布。原始说明保存在 README-UPSTREAM.md；实际运行边界以本文件、UPSTREAM.json、CHANGES-STARLIGHT.md 与 ../../docs/director/README.md 为准。

## 构建与测试

要求 Node.js 24。保留 frontend/director 与 frontend/canvas 的相邻结构，在两个目录分别运行 npm ci，然后在画布目录运行 node scripts/build.mjs --mode hosted。完整产物为 frontend/canvas/dist-hosted/，包括导演台、字体、动态模块与同版本 director/source.zip。单独访问导演台会提示从已登录画布打开。

导演台 npm test 执行纯场景、人物、工程、摄影机、整数帧和输出边界测试。真实浏览器、账号隔离、H.264 完整解码、性能、安装和回退属于画布必需门禁；纯测试不能替代这些证据。npm run dev 只用于源码调试。未分发原始 FBX 或本机服务的上游测试保留作参考，不宣称全套上游测试通过。

## 运行边界

常规编辑、保存、预览、PNG、H.264 MP4 与参考包在浏览器完成，不触发模型消费。支持24/30 fps，单段参考视频最长30秒；无法编码时明确报告，不输出假成功素材。素材与完整修订由画布宿主持有，存入当前浏览器 IndexedDB，按服务器核验的账户 subject、项目和节点分开。保存回执不代表服务器或跨设备同步；迁移使用完整工程包，见 [宿主协议](../../docs/director/host-protocol.md)。

人物几何体、骨架和 rest 数据是原创程序资产，上游 Mixamo 原始 FBX 未分发。未接入的 GPU 服务、Fal、OAuth 和旧 Agent 不是普通操作的前置条件。本站文本提案与视频生成必须由用户主动发起。

## 授权与源码

修改版按 AGPL-3.0-or-later 提供，保留上游版权、GPL 历史贡献和第三方声明。字体、Three.js、Mediabunny 等继续使用各自许可证，见 LICENSE、LICENSING.md 与 THIRD_PARTY_NOTICES.md。这不是整库统一换许可证的声明。

页脚源码入口固定到当前安装目录的 source.zip。部署必须一同提供它，不能只链接上游。对应源码包含修改版、画布集成、锁文件、能力合同、安装说明及相关托管适配器和静态配置，不包含真实凭据、用户工程、数据库和运行日志。

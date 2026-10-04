# 第三方来源与许可

星盘画布及本包的集成修改按 AGPL-3.0-or-later 提供。此声明不替代第三方内容的许可证。

- **CozyClay 1.10.0**：AGPL-3.0-or-later。固定上游提交和来源见 `frontend/director/UPSTREAM.json`，历史 GPL 贡献见 `frontend/director/LICENSING.md`、`LICENSES/GPL-3.0-or-later.txt`。
- **Vibe-Workflow 改编部分**：MIT，保留 `frontend/director/THIRD_PARTY_NOTICES_VIBE_WORKFLOW.md`。
- **字体、字体解析器、Three.js、Mediabunny 及其他导演台依赖**：各自许可证及固定来源见 `frontend/director/THIRD_PARTY_NOTICES.md`、`LICENSES/` 和 `public/licenses/`。构建会核验清单与锁文件。
- **Playwright Core**：仅用于画布开发测试，许可证由其 npm 依赖包提供。源码包包含锁文件，不包含 node_modules。

本包不分发上游 Mixamo 原始 FBX、外部 GPU 服务或未授权 MiniMax 插件。上游列出的第三方模型服务、模型权重和可选工具不因出现在文档中而获得重新分发授权。

运行修改版的网络服务时，保留并更新对应源码入口。默认构建提供 `director/source.zip`，部署者应确保它包含实际运行版本及构建所需文件。

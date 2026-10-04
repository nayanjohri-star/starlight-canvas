// 页面构建身份：`npm run build` 用 package.json 与服务端协议级别重新生成 dist/build-info.js。
// 源码目录中的这份仅用于未构建的开发/单元测试环境（version 为 dev）。
export const BUILD = Object.freeze({
  version: 'dev',
  builtAt: null,
  capabilityVersion: null,
  requiresServerApi: 5,
});

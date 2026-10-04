// 运行形态配置：页面在「本机单用户」与「托管网页版」之间的所有差异都从这里读取，不从地址栏或探测结果猜测。
// 源码目录中的这份是本机开发默认值；`node scripts/build.mjs --mode hosted` 会在产物中生成托管版配置
// （见 scripts/lib/runtime-config.mjs）。托管形态下：
//  · 所有请求只发往同源的固定相对路由（apiBase / readyUrl 必须是以单个 / 开头的站内路径，不能是其他主机）；
//  · 不访问本机 /health、/media、/workspace 或旧插件资源；
//  · 服务端渲染与云端工作区关闭，导演台从本版同源资源按需加载；
//  · blockedModels 中的型号不能发起新生成（原任务的查询、下载与恢复不受影响）。
export const RUNTIME = Object.freeze({
  mode: 'local',
  basePath: '/',
  apiBase: '/site',
  readyUrl: '/health',
  features: Object.freeze({ localService: true, serverRender: true, workspace: true, director: true, hostedDirector: true }),
  blockedModels: Object.freeze({}),
});

export const isHosted = () => RUNTIME.mode === 'hosted';
export const feature = name => RUNTIME.features?.[name] === true;
// 新生成准入：返回 null 表示允许；否则返回给用户看的具体原因
export const newGenerationBlock = modelId => RUNTIME.blockedModels?.[modelId] ?? null;

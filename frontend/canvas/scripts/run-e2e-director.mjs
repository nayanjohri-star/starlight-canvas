// 导演台 3D E2E（已恢复）：真实本机服务 + 真实 MiniMax 参考插件 + 软件渲染 WebGL
// （SwiftShader，--enable-unsafe-swiftshader；无 GPU/黑屏环境也可跑）。串行单测。
// 用法：node scripts/run-e2e-director.mjs
process.env.E2E_DIRECTOR = '1';
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/e2e-director.test.mjs'], { stdio: 'inherit' });
child.on('exit', c => process.exit(c ?? 1));

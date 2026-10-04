// 发布包结构核验（test:package 的后置步骤）：
// dist/ 与 src/+public/ 文件一一对应、capabilities.json 可解析且有版本与型号、
// build.json 版本与 package.json 一致。任一不符 → 非零退出。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const fail = [];

const walk = (dir, base = dir) => !existsSync(dir) ? [] :
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p).replaceAll('\\', '/')];
  });

if (!existsSync(DIST)) fail.push('dist/ 不存在：请先运行 npm run build 或测试层级（默认自动构建）');
const srcFiles = existsSync(DIST) ? new Set([...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public'))]) : new Set();
const distFiles = new Set(existsSync(DIST) ? walk(DIST) : []);
const GENERATED = new Set(['build.json', 'capabilities.json']);
const directorFiles = new Set(walk(join(ROOT, '../director/dist')).map(file => `director/${file}`));
directorFiles.add('director/source.zip');
for (const required of ['director/index.html', 'director/source.zip', 'director/fonts/Inter-OFL.txt'])
  if (!distFiles.has(required)) fail.push(`dist 缺失必需导演台文件：${required}`);
for (const f of srcFiles) if (!distFiles.has(f)) fail.push(`dist 缺失源文件：${f}`);
for (const f of distFiles) if (!srcFiles.has(f) && !GENERATED.has(f) && !directorFiles.has(f)) fail.push(`dist 出现源之外的文件：${f}`);

if (existsSync(join(DIST, 'capabilities.json'))) {
  try {
    const caps = JSON.parse(readFileSync(join(DIST, 'capabilities.json'), 'utf8'));
    // 型号目录以站点合同为准（server/capability-contract.test.mjs 逐项比对），此处只核结构
    const n = Object.keys(caps.models ?? {}).length;
    if (!caps.version || n < 1) fail.push(`capabilities.json 缺少版本或型号（型号数 ${n}）`);
  } catch (e) { fail.push(`capabilities.json 不可解析：${e.message}`); }
}
if (existsSync(join(DIST, 'build.json'))) {
  try {
    const b = JSON.parse(readFileSync(join(DIST, 'build.json'), 'utf8'));
    const v = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    if (b.version !== v) fail.push(`build.json 版本 ${b.version} ≠ package.json ${v}`);
    if (!b.capabilityVersion) fail.push('build.json 缺 capabilityVersion');
  } catch (e) { fail.push(`build.json 不可解析：${e.message}`); }
}
// src 中不得残留内联脚本（父页 CSP script-src 'self'）
if (existsSync(join(DIST, 'index.html'))) {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) fail.push('index.html 含内联脚本，违反 CSP script-src self 约定');
}

if (fail.length) { console.error('发布包核验失败：\n' + fail.map(f => `  - ${f}`).join('\n')); process.exit(1); }
console.log(`发布包核验通过：dist/ ${distFiles.size} 个文件与源一致（含 ${GENERATED.size} 个生成文件）`);
process.exit(0);

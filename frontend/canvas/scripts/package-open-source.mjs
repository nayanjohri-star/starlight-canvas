// A standalone source candidate. Never copy the production repository or Git history.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildZip } from '../../director/src/zip-store.js';
import { isUtf8 } from 'node:buffer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWED = ['frontend/canvas/', 'frontend/director/', 'docs/director/'];
const CAPABILITY = 'docs/星盘AI_视频模型能力表.json';
const PUBLIC_GUIDES = ['docs/星盘AI_视频模型接入指南.md', 'docs/星盘AI_画布视频适配规范.md'];
const PUBLIC_RELEASE_GUIDES = new Set(['frontend/canvas/docs/canvas-release/0.5/core-contract.md',
  'frontend/canvas/docs/canvas-release/0.5/hosted-api-contract.md']);
const BLOCKED = /(?:^|\/)(?:\.git|node_modules|dist|dist-hosted|\.vite|\.release-evidence|release-packages|outputs|logs|shots|playwright-report|test-results|_temp|_backups|secrets|cookies|sessions)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|pfx|har|db|sqlite3?|dump|bak|tgz)$/i;
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/g],
  ['url-credential', /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@[^\s/"'<>]+/g],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function secretFindings(path, bytes) {
  if (!isUtf8(bytes) || bytes.includes(0)) return [];
  const text = bytes.toString('utf8'), findings = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // Explicit negative tests use reserved example hosts. Other matches fail closed.
      if (kind === 'url-credential' && /(?:\.example|example\.com|localhost|127\.0\.0\.1)(?:[/:]|$)/.test(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ path, line, kind }); // Never include matched values.
    }
  }
  return findings;
}

export async function sourceFiles() {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...ALLOWED, CAPABILITY, ...PUBLIC_GUIDES], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('源码候选需从开发 Git 仓库生成');
  const paths = [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  const files = new Map(), findings = [];
  for (const path of paths) {
    if (!(ALLOWED.some(prefix => path.startsWith(prefix)) || path === CAPABILITY || PUBLIC_GUIDES.includes(path)) || BLOCKED.test(path)) continue;
    if (path.startsWith('frontend/canvas/docs/canvas-release/') && !PUBLIC_RELEASE_GUIDES.has(path)) continue;
    if (path.startsWith('frontend/director/public/fonts/unicode-local/')) continue;
    const info = await lstat(join(ROOT, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`源码中有非普通文件：${path}`);
    const bytes = await readFile(join(ROOT, path)); findings.push(...secretFindings(path, bytes));
    files.set(path, isUtf8(bytes) && !bytes.includes(0) ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n')) : bytes);
  }
  if (findings.length) throw new Error(`源码敏感项检查未通过（值已隐藏）：${findings.map(x => `${x.path}:${x.line} ${x.kind}`).join(', ')}`);
  return files;
}

export async function packageOpenSource({ out } = {}) {
  if (!out) throw new Error('请用 --out 指定新的候选目录');
  const dest = resolve(out);
  if (await lstat(dest).then(() => true).catch(() => false)) throw new Error('候选目录已存在，请指定新目录');
  const archive = dest + '.zip';
  if (await lstat(archive).then(() => true).catch(() => false)) throw new Error('压缩包已存在，拒绝覆盖');
  const files = await sourceFiles();
  const templates = join(ROOT, 'frontend/canvas/docs/open-source');
  for (const [source, target] of [['README.md', 'README.md'], ['CONTRIBUTING.md', 'CONTRIBUTING.md'], ['SECURITY.md', 'SECURITY.md'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['community-ci.yml', '.github/workflows/community-ci.yml']])
    files.set(target, await readFile(join(templates, source)));
  files.set('LICENSE', await readFile(join(ROOT, 'frontend/canvas/LICENSE')));
  files.set('.gitignore', Buffer.from('**/node_modules/\n**/dist/\n**/dist-hosted/\n**/.vite/\n**/.release-evidence/\n**/release-packages/\n**/test-results/\n**/shots/\n**/playwright-report/\n.env\n.env.*\n*.pem\n*.key\noutputs/\nlogs/\n'));
  files.set('package.json', Buffer.from(JSON.stringify({ name: 'xingpan-smart-canvas', version: '0.5.0', private: true, type: 'module', license: 'AGPL-3.0-or-later', engines: { node: '>=24' }, scripts: {
    setup: 'npm ci --prefix frontend/director && npm ci --prefix frontend/canvas',
    build: 'npm run build --prefix frontend/canvas', start: 'npm start --prefix frontend/canvas',
    test: 'npm test --prefix frontend/canvas', 'test:e2e': 'npm run test:e2e --prefix frontend/canvas',
  } }, null, 2) + '\n'));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...ALLOWED, CAPABILITY], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const version = { kind: 'canvas-open-source-candidate', status: 'prepared-unpublished', sourceCommit: commit.stdout.trim(), sourceDirty: Boolean(dirty.stdout.trim()), historyIncluded: false,
    license: 'AGPL-3.0-or-later', includesProductionBackend: false, files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) })) };
  files.set('SOURCE-VERSION.json', Buffer.from(JSON.stringify(version, null, 2) + '\n'));
  await mkdir(dest, { recursive: true });
  for (const [path, bytes] of files) { await mkdir(dirname(join(dest, path)), { recursive: true }); await writeFile(join(dest, path), bytes); }
  await writeFile(archive, buildZip([...files].map(([name, data]) => ({ name, data: new Uint8Array(data) }))));
  await writeFile(archive + '.sha256', `${sha(await readFile(archive))}  ${relative(dirname(archive), archive)}\n`);
  return { dest, archive, count: files.size, sourceDirty: version.sourceDirty };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  try { console.log(JSON.stringify(await packageOpenSource({ out: i >= 0 ? process.argv[i + 1] : null }))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

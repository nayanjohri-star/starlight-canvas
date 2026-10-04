// 发布包 SHA-256 清单（裁决12：文本文件按 LF 归一化后计算哈希，二进制原样）。
// 用法：
//   node scripts/sha256-manifest.mjs <目录|文件...> [--out manifest.json] [--base <dir>]
// 判定文本：扩展名白名单 OR 内容嗅探（首 8KB 无 NUL 字节）。归一化仅 CRLF/CR → LF。
// 输出 JSON：{ generatedAt, algorithm, textEol, files:[{path, sha256, bytes, normalized}] }
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.map',
  '.md', '.txt', '.css', '.html', '.htm', '.svg', '.xml',
  '.yml', '.yaml', '.csv', '.srt', '.sh', '.bat', '.ps1',
  '.gitignore', '.gitattributes', '.env', '.editorconfig', '.npmrc',
]);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'shots', 'out']);

function isTextBytes(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}
const isTextFile = (p, buf) => TEXT_EXT.has(extname(p).toLowerCase()) || isTextBytes(buf);

const normalizeLF = buf => {
  // CRLF → LF；孤立 CR → LF。仅对判定为文本的文件调用。
  let out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 13) { if (buf[i + 1] === 10) i++; out[o++] = 10; }
    else out[o++] = b;
  }
  return out.subarray(0, o);
};

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function* walkPaths(input) {
  const st = statSync(input, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { yield input; return; }
  if (st.isDirectory()) {
    for (const e of readdirSync(input, { withFileTypes: true })) {
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      yield* walkPaths(join(input, e.name));
    }
  }
}

export function buildManifest(inputs, { base }) {
  const files = [];
  for (const input of inputs) {
    const abs = resolve(input);
    for (const p of walkPaths(abs)) {
      const buf = readFileSync(p);
      const text = isTextFile(p, buf);
      const data = text ? normalizeLF(buf) : buf;
      files.push({
        path: (base ? relative(resolve(base), p) : p).replaceAll('\\', '/'),
        sha256: sha256(data),
        bytes: buf.length,
        normalized: text && data.length !== buf.length ? true : text ? 'text' : false,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha256',
    textEol: 'LF（文本文件 CRLF/CR 归一化后计算；二进制原样）',
    files,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const baseIdx = args.indexOf('--base');
  const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--base');
  if (!inputs.length) { console.error('用法：node scripts/sha256-manifest.mjs <目录|文件...> [--out m.json] [--base dir]'); process.exit(2); }
  const manifest = buildManifest(inputs, { base: baseIdx >= 0 ? args[baseIdx + 1] : null });
  const text = JSON.stringify(manifest, null, 2);
  if (outIdx >= 0) {
    const out = resolve(args[outIdx + 1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text + '\n');
    console.log(`清单已写入 ${out}（${manifest.files.length} 个文件）`);
  } else console.log(text);
}

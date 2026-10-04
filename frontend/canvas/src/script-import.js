// 脚本文件导入（TXT / DOCX / JSON）：本地解析、批量上限、显式预览数据。
// DOCX 走有界 ZIP 中央目录 + DecompressionStream(deflate-raw)，只读取
// word/document.xml：不解析外部关系、宏或网络引用；字节数/边界/CRC 逐项校验，
// 加密、损坏、重复主文档一律显式拒绝。文本层 UTF-8/UTF-16 BOM 自动识别，
// GB18030 仅由用户显式选择，绝不静默猜测编码。

export const IMPORT_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 20 * 1024 * 1024,
  maxBatchBytes: 40 * 1024 * 1024,
  maxXmlBytes: 8 * 1024 * 1024,
  maxShots: 200,
  maxFieldChars: 20000,
};
const MIB = 1024 * 1024;
const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;
const MAIN_XML = 'word/document.xml';

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------- 文本解码 ----------
function decodeWith(u8, label, fatal) {
  let dec;
  try { dec = new TextDecoder(label, { fatal }); }
  catch { throw new Error(`当前环境不支持 ${label} 解码`); }
  try { return dec.decode(u8); }
  catch {
    throw new Error(label === 'utf-8'
      ? '不是有效的 UTF-8 文本；若为旧版 GBK/GB18030 文档请在编码选项中选择 GB18030 重试'
      : `文件内容不是有效的 ${label} 编码`);
  }
}
// BOM 优先（字节级无歧义）；无 BOM 时按显式选择解码，默认 UTF-8 严格校验。
export function decodeTextBytes(u8, { encoding = 'auto' } = {}) {
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF)
    return decodeWith(u8.subarray(3), 'utf-8', true);
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE)
    return decodeWith(u8.subarray(2), 'utf-16le', true);
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF)
    return decodeWith(u8.subarray(2), 'utf-16be', true);
  if (encoding === 'gb18030') return decodeWith(u8, 'gb18030', true);
  if (encoding !== 'auto' && encoding !== 'utf-8') throw new Error(`不支持的编码选项：${encoding}`);
  return decodeWith(u8, 'utf-8', true);
}

// ---------- DOCX：有界 ZIP 读取 word/document.xml ----------
function findEocd(dv, len) {
  const min = Math.max(0, len - 22 - 0xFFFF);   // EOCD 允许 ≤64KiB 注释
  for (let p = len - 22; p >= min; p--) {
    if (dv.getUint32(p, true) !== EOCD_SIG) continue;
    if (p + 22 + dv.getUint16(p + 20, true) === len) return p;   // 注释长度须恰好收尾
  }
  return -1;
}

async function inflateRaw(raw, cap) {
  if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function')
    throw new Error('当前环境不支持解压 DOCX（DecompressionStream 缺席），请改用 .txt 导入');
  let reader;
  try {
    reader = new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } })
      .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  } catch { throw new Error('当前环境不支持 deflate-raw 解压，无法读取该 DOCX'); }
  const chunks = []; let total = 0, capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { capped = true; break; }
      chunks.push(value);
    }
  } catch {
    throw new Error('DOCX 主文档解压失败（文件损坏或压缩方式不支持）');
  } finally { try { await reader.cancel(); } catch { /* 取消失败不阻塞 */ } }
  if (capped) throw new Error(`DOCX 主文档解压后超过 ${IMPORT_LIMITS.maxXmlBytes / MIB}MiB 上限`);
  const out = new Uint8Array(total);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// 返回 word/document.xml 的解压字节：EOCD→中央目录→本地头逐层定位，
// 大小/边界先验、STORE/DEFLATE 两类方法、CRC32 校验，异常一律显式抛出。
export async function docxMainXmlBytes(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.length < 22) throw new Error('文件过小，不是有效的 DOCX/ZIP');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const eocd = findEocd(dv, u8.length);
  if (eocd < 0) throw new Error('不是有效的 DOCX（ZIP 中央目录缺失）');
  const entries = dv.getUint16(eocd + 10, true);
  if (dv.getUint16(eocd + 4, true) || dv.getUint16(eocd + 6, true) || dv.getUint16(eocd + 8, true) !== entries)
    throw new Error('分卷 DOCX/ZIP 不支持');
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (entries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF)
    throw new Error('ZIP64 格式的 DOCX 不支持');
  if (cdOff + cdSize > eocd) throw new Error('DOCX 中央目录越界（文件损坏）');
  const cdEnd = cdOff + cdSize;
  const mains = [];
  for (let i = 0, pos = cdOff; i < entries; i++) {
    if (pos + 46 > cdEnd) throw new Error('DOCX 中央目录截断');
    if (dv.getUint32(pos, true) !== CEN_SIG) throw new Error('DOCX 中央目录损坏');
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commLen = dv.getUint16(pos + 32, true);
    if (pos + 46 + nameLen + extraLen + commLen > cdEnd) throw new Error('DOCX 中央目录越界');
    const name = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + nameLen));
    if (name === MAIN_XML) mains.push({
      flags: dv.getUint16(pos + 8, true), method: dv.getUint16(pos + 10, true),
      crc: dv.getUint32(pos + 16, true), comp: dv.getUint32(pos + 20, true),
      uncomp: dv.getUint32(pos + 24, true), lho: dv.getUint32(pos + 42, true),
    });
    pos += 46 + nameLen + extraLen + commLen;
  }
  if (!mains.length) throw new Error('不是有效的 DOCX（缺少 word/document.xml）');
  if (mains.length > 1) throw new Error('DOCX 含重复主文档（word/document.xml），已拒绝');
  const e = mains[0];
  if (e.flags & 0x0041) throw new Error('DOCX 条目已加密，不支持导入');
  if (e.method !== 0 && e.method !== 8) throw new Error(`DOCX 压缩方式不支持（method ${e.method}）`);
  if (e.uncomp === 0xFFFFFFFF || e.comp === 0xFFFFFFFF) throw new Error('ZIP64 条目不支持');
  if (e.uncomp > IMPORT_LIMITS.maxXmlBytes)
    throw new Error(`DOCX 主文档声明 ${Math.ceil(e.uncomp / MIB)}MiB，超过 ${IMPORT_LIMITS.maxXmlBytes / MIB}MiB 上限`);
  if (e.lho + 30 > u8.length || dv.getUint32(e.lho, true) !== LOC_SIG)
    throw new Error('DOCX 本地文件头损坏');
  const localNameLength = dv.getUint16(e.lho + 26, true);
  const dataStart = e.lho + 30 + localNameLength + dv.getUint16(e.lho + 28, true);
  if (dataStart > cdOff || dataStart + e.comp > cdOff) throw new Error('DOCX 主文档数据截断或越界');
  const localName = new TextDecoder().decode(u8.subarray(e.lho + 30, e.lho + 30 + localNameLength));
  if (localName !== MAIN_XML || dv.getUint16(e.lho + 6, true) !== e.flags || dv.getUint16(e.lho + 8, true) !== e.method)
    throw new Error('DOCX 本地头与中央目录不一致');
  const raw = u8.subarray(dataStart, dataStart + e.comp);
  const data = e.method === 8 ? await inflateRaw(raw, IMPORT_LIMITS.maxXmlBytes) : raw.slice();
  if (data.byteLength !== e.uncomp) throw new Error('DOCX 主文档大小与目录声明不符');
  if (crc32(data) !== e.crc) throw new Error('DOCX 主文档 CRC 校验失败（文件损坏）');
  return data;
}

// ---------- DOCX XML → 纯文本（DOMParser，保留段落/表格/换行） ----------
const lname = n => String(n.localName ?? n.tagName ?? '').split(':').pop();
const kids = n => {
  const children = Array.from(n?.childNodes ?? n?.children ?? []);
  if (lname(n) === 'AlternateContent') {
    const choice = children.find(c => lname(c) === 'Choice') ?? children.find(c => lname(c) === 'Fallback');
    return choice ? kids(choice) : [];
  }
  return children;
};
export function docxXmlToText(xml, domParser) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 不支持文档类型或实体声明');
  let parser = domParser ?? null;
  if (typeof parser === 'function') { try { parser = new parser(); } catch { parser = null; } }
  parser ??= typeof DOMParser === 'function' ? new DOMParser() : null;
  if (!parser || typeof parser.parseFromString !== 'function')
    throw new Error('当前环境不支持 DOCX 文本提取（DOMParser 缺席），请改用 .txt 导入');
  const doc = parser.parseFromString(String(xml), 'application/xml');
  const rootEl = doc?.documentElement ?? null;
  if (!rootEl || lname(rootEl) === 'parsererror'
    || (typeof doc.getElementsByTagName === 'function' && doc.getElementsByTagName('parsererror').length))
    throw new Error('DOCX 主文档 XML 解析失败（文件损坏）');
  if (lname(rootEl) !== 'document') throw new Error('DOCX 主文档结构不合法');
  const textOf = node => {
    let out = '';
    const walk = n => {
      for (const c of kids(n)) {
        if (c.nodeType === 3 || c.nodeType === 4) { if (lname(n) === 't') out += c.nodeValue ?? ''; continue; }
        if (c.nodeType !== 1) continue;
        const ln = lname(c);
        if (ln === 'tab') out += '\t';
        else if (ln === 'br' || ln === 'cr') out += '\n';
        else if (ln === 'instrText' || ln === 'delText' || ln === 'del') continue;
        else walk(c);
      }
    };
    walk(node);
    return out;
  };
  const body = kids(rootEl).find(n => n.nodeType === 1 && lname(n) === 'body');
  if (!body) throw new Error('DOCX 缺少正文结构');
  const lines = [];
  const blocks = node => { for (const n of kids(node)) {
    if (n.nodeType !== 1 || lname(n) === 'del') continue;
    const ln = lname(n);
    if (ln === 'p') lines.push(textOf(n));
    else if (ln === 'tr') {
        const cells = kids(n).filter(c => c.nodeType === 1 && lname(c) === 'tc')
          .map(tc => {
            const ps = [];
            const collect = node => { for (const c of kids(node)) {
              if (c.nodeType !== 1 || lname(c) === 'del') continue;
              if (lname(c) === 'p') ps.push(textOf(c)); else collect(c);
            } };
            collect(tc);
            return (ps.length ? ps.join(' ') : textOf(tc)).trim();
          });
        lines.push(cells.join('\t'));
    } else blocks(n); // 内容控件 sdt、插入修订等包装不应让正文消失。
  } };
  blocks(body);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function docxToText(u8, domParser) {
  const bytes = await docxMainXmlBytes(u8);
  const text = docxXmlToText(decodeTextBytes(bytes, { encoding: 'auto' }), domParser);
  if (!text.trim()) throw new Error('DOCX 中未提取到文本');
  return text;
}

// ---------- 文件级入口 ----------
const EXT_KIND = { '.txt': 'txt', '.json': 'json', '.docx': 'docx' };
export function fileKind(name = '') {
  const ext = String(name).toLowerCase().match(/\.[^.\/\\]*$/)?.[0] ?? '';
  if (ext === '.doc') throw new Error('旧版 .doc 不支持，请另存为 .docx 或 .txt 后导入');
  const kind = EXT_KIND[ext];
  if (!kind) throw new Error(`不支持的文件类型「${ext || '无扩展名'}」（仅接受 .txt / .docx / .json）`);
  return kind;
}
async function bytesOf(f) {
  if (f instanceof Uint8Array) return f;
  if (f instanceof ArrayBuffer) return new Uint8Array(f);
  if (f?.data instanceof Uint8Array) return f.data;
  if (typeof f?.arrayBuffer === 'function') return new Uint8Array(await f.arrayBuffer());
  throw new Error('无法读取文件内容（需要 File/Blob 或字节数据）');
}
// 单文件解析 → {name,kind,bytes,text,fields,shots}：类型/大小/解码/提取/分镜解析
// 全链路校验，任何一步失败都抛出，绝不产出半成品结果。
export async function parseImportFile(file, { encoding = 'auto', parse, domParser } = {}) {
  if (typeof parse !== 'function') throw new Error('缺少分镜解析器');
  const name = String(file?.name ?? file?.filename ?? '导入文件');
  const kind = fileKind(name);
  const declared = Number(file?.size ?? NaN);
  if (Number.isFinite(declared) && declared > IMPORT_LIMITS.maxFileBytes)
    throw new Error(`单文件超过 ${IMPORT_LIMITS.maxFileBytes / MIB}MiB 上限（${Math.ceil(declared / MIB)}MiB）`);
  const u8 = await bytesOf(file);
  if (u8.byteLength > IMPORT_LIMITS.maxFileBytes)
    throw new Error(`单文件超过 ${IMPORT_LIMITS.maxFileBytes / MIB}MiB 上限`);
  const text = kind === 'docx' ? await docxToText(u8, domParser) : decodeTextBytes(u8, { encoding });
  if (!text.trim()) throw new Error('文件未提取到文本');
  if (text.length > IMPORT_LIMITS.maxShots * IMPORT_LIMITS.maxFieldChars)
    throw new Error('文本总量超出分镜容量，拒绝导入');
  if (kind === 'json') {
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('JSON 文件语法不合法，请修正后重新导入'); }
    if (!Array.isArray(value) && !Array.isArray(value?.shots))
      throw new Error('JSON 文件需为分镜数组或含 shots 数组');
  }
  const fields = parse(text);
  if (!Array.isArray(fields) || !fields.length) throw new Error('未解析出分镜');
  return { name, kind, bytes: u8.byteLength, text, fields, shots: fields.length };
}

// 批量解析：文件数/单文件/整批字节/合计分镜逐层校验；所有文件全过才返回预览数据，
// 任一失败按文件名汇总报错——调用方保证「全验证后才写项目」。
export async function prepareImportFiles(files, { encoding = 'auto', parse, maxShots = IMPORT_LIMITS.maxShots, domParser } = {}) {
  const list = Array.from(files ?? []);
  if (!list.length) throw new Error('未选择文件');
  if (list.length > IMPORT_LIMITS.maxFiles)
    throw new Error(`文件数量超限（≤${IMPORT_LIMITS.maxFiles} 个，选择了 ${list.length} 个）`);
  if (list.reduce((n, f) => n + (Number.isFinite(f?.size) ? f.size : 0), 0) > IMPORT_LIMITS.maxBatchBytes)
    throw new Error('批量总量超过 40MiB 上限');
  const entries = [], errors = [];
  let totalBytes = 0;
  for (const f of list) {
    const label = String(f?.name ?? f?.filename ?? `文件 ${entries.length + errors.length + 1}`);
    try {
      const e = await parseImportFile(f, { encoding, parse, domParser });
      totalBytes += e.bytes;
      if (totalBytes > IMPORT_LIMITS.maxBatchBytes)
        throw new Error(`批量总量超过 ${IMPORT_LIMITS.maxBatchBytes / MIB}MiB 上限`);
      entries.push(e);
    } catch (err) { errors.push(`「${label}」${err.message}`); }
  }
  if (errors.length) throw new Error(errors.join('；'));
  const totalShots = entries.reduce((n, e) => n + e.shots, 0);
  if (totalShots > maxShots)
    throw new Error(`合计分镜数量超限（${totalShots} > ${maxShots}），整批未导入`);
  return { files: entries, totalShots, totalBytes };
}

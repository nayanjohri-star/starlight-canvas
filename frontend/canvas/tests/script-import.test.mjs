// script-import：TXT/DOCX/JSON 文件导入。有界 ZIP/DOCX 提取、编码识别、批量上限、
// 显式预览数据、原子应用与项目切换守卫。全部本地 mock，无网络/文件系统。

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createStoryboards, parseScript } from '../src/storyboard.js';
import {
  IMPORT_LIMITS, decodeTextBytes, fileKind, docxXmlToText, docxMainXmlBytes,
  docxToText, parseImportFile, prepareImportFiles,
} from '../src/script-import.js';

const MIB = 1024 * 1024;
const enc = s => new TextEncoder().encode(s);

class StubEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; }
  set className(v) { this._c = v; } get className() { return this._c; }
  set textContent(v) { this._t = v; } get textContent() { return this._t; }
  setAttribute(k, v) { (this._a ??= {})[k] = v; }
  addEventListener() {}
  append(...c) { this.children.push(...c); }
  prepend(...c) { this.children.unshift(...c); }
  replaceChildren(...c) { this.children = c; }
  remove() {}
}
globalThis.document ??= {
  getElementById: id => (id === 'toast-root' ? new StubEl('div') : null),
  createElement: t => new StubEl(t),
  addEventListener() {}, removeEventListener() {}, body: new StubEl('body'),
};

// 极简 XML 解析桩：仅支持测试夹具的元素/文本/属性/自闭合/常见实体，
// 形状对齐 DOMParser 产物（documentElement/childNodes/nodeType/nodeValue/tagName）。
class XEl {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.childNodes = []; }
  get textContent() { return this.childNodes.map(c => c.textContent ?? '').join(''); }
}
const xtext = v => ({ nodeType: 3, nodeValue: v, get textContent() { return v; } });
function parseXml(xml) {
  const root = new XEl('#document');
  const stack = [root];
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  for (const m of String(xml).matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const t = m[0];
    if (t.startsWith('<!--') || t.startsWith('<?') || t.startsWith('<!')) continue;
    if (t.startsWith('</')) { stack.pop(); continue; }
    if (t.startsWith('<')) {
      const node = new XEl(t.slice(1, t.search(/[\s/>]/)).replace(/\/+$/, ''));
      stack.at(-1).childNodes.push(node);
      if (!/\/\s*>$/.test(t)) stack.push(node);
    } else if (t) stack.at(-1).childNodes.push(xtext(unesc(t)));
  }
  const documentElement = root.childNodes.find(n => n.nodeType === 1) ?? null;
  return { documentElement, getElementsByTagName: () => [] };
}
class StubDOMParser { parseFromString(xml) { return parseXml(xml); } }

// 测试用 zip 构造：STORE/DEFLATE 条目 + 可选 flags（用于加密/损坏夹具）。
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function mkzip(entries) {   // {name, data(解压后), comp?(压缩后), method?, flags?}
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const nb = enc(e.name);
    const data = e.data, comp = e.comp ?? data;
    const flags = (e.flags ?? 0) | 0x0800, method = e.method ?? 0;
    const crc = crc32(data), cs = comp.length, us = data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, cs, true); lh.setUint32(22, us, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true); ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, cs, true); ch.setUint32(24, us, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + comp.length;
  }
  const cdStart = off;
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, cdStart, true);
  const out = new Uint8Array(cdStart + cdSize + 22);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const c of central) { out.set(c, o); o += c.length; }
  out.set(new Uint8Array(eo.buffer), o);
  return out;
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>第1镜 清晨街道</w:t></w:r></w:p>
<w:p><w:r><w:t>第2镜 室内对白 8秒</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>续行</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

const tfile = (name, text) => Object.assign(new Blob([enc(text)]), { name });
const bfile = (name, u8) => Object.assign(new Blob([u8]), { name });
const strictParse = t => parseScript(t, { strictLength: true });

async function boot() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('导入测试');
  const sb = createStoryboards({ store, generators: {}, workflow: null, board: null });
  return { store, storage, sb };
}

test('decodeTextBytes：UTF-8/UTF-16 BOM 自动识别，非法 UTF-8 提示选 GB18030', () => {
  assert.equal(decodeTextBytes(enc('你好')), '你好');
  assert.equal(decodeTextBytes(Uint8Array.of(0xEF, 0xBB, 0xBF, 0x41)), 'A');
  assert.equal(decodeTextBytes(Uint8Array.of(0xFF, 0xFE, 0x2D, 0x4E)), '中');   // U+4E2D LE
  assert.equal(decodeTextBytes(Uint8Array.of(0xFE, 0xFF, 0x4E, 0x2D)), '中');   // U+4E2D BE
  assert.throws(() => decodeTextBytes(Uint8Array.of(0xC4, 0xE3)), /GB18030|UTF-8/);   // GBK「你」
  let gbOk = true; try { new TextDecoder('gb18030'); } catch { gbOk = false; }
  if (gbOk) assert.equal(decodeTextBytes(Uint8Array.of(0xC4, 0xE3, 0xBA, 0xC3), { encoding: 'gb18030' }), '你好');
  else assert.throws(() => decodeTextBytes(Uint8Array.of(0xC4, 0xE3), { encoding: 'gb18030' }), /不支持|gb18030/i);
  // BOM 无歧义优先：显式 GB18030 不覆盖带 BOM 文件的真实编码
  assert.equal(decodeTextBytes(Uint8Array.of(0xEF, 0xBB, 0xBF, 0x41), { encoding: 'gb18030' }), 'A');
  assert.throws(() => decodeTextBytes(enc('x'), { encoding: 'shift_jis' }), /不支持/);
});

test('fileKind：仅接受 txt/docx/json，.doc 与未知类型显式拒绝', () => {
  assert.equal(fileKind('a.TXT'), 'txt');
  assert.equal(fileKind('b.docx'), 'docx');
  assert.equal(fileKind('c.json'), 'json');
  assert.throws(() => fileKind('old.doc'), /\.doc/);
  assert.throws(() => fileKind('x.pdf'), /不支持/);
  assert.throws(() => fileKind('noext'), /不支持/);
});

test('docxXmlToText：段落/表格/换行保留；DOMParser 缺席与解析失败显式报错', () => {
  const text = docxXmlToText(DOCX_XML, new StubDOMParser());
  const lines = text.split('\n');
  assert.equal(lines[0], '第1镜 清晨街道');
  assert.equal(lines[1], '第2镜 室内对白 8秒');
  assert.equal(lines[2], '续行');
  assert.equal(lines.at(-1), '甲\t乙');
  const badParser = { parseFromString: () => ({ documentElement: { nodeType: 1, tagName: 'parsererror', childNodes: [] }, getElementsByTagName: () => [{}] }) };
  assert.throws(() => docxXmlToText('<w:document><w:body>', badParser), /XML 解析失败/);
  if (typeof DOMParser !== 'function')
    assert.throws(() => docxXmlToText('<x/>'), /DOMParser|不支持/);
});

test('docxMainXmlBytes：STORE 包提取主文档；缺主文档/重复/加密/坏法/CRC/越界逐项拒绝', async () => {
  const good = mkzip([
    { name: '[Content_Types].xml', data: enc('<x/>') },
    { name: 'word/document.xml', data: enc(DOCX_XML) },
    { name: 'word/media/p.bin', data: new Uint8Array(16) },   // 无关条目不读
  ]);
  const xml = await docxMainXmlBytes(good);
  assert.match(new TextDecoder().decode(xml), /第1镜/);
  await assert.rejects(docxMainXmlBytes(mkzip([{ name: 'a.xml', data: enc('<x/>') }])), /缺少 word\/document\.xml/);
  await assert.rejects(docxMainXmlBytes(mkzip([
    { name: 'word/document.xml', data: enc('<a/>') },
    { name: 'word/document.xml', data: enc('<b/>') },
  ])), /重复/);
  await assert.rejects(docxMainXmlBytes(mkzip([{ name: 'word/document.xml', data: enc('<a/>'), flags: 0x01 }])), /加密/);
  await assert.rejects(docxMainXmlBytes(mkzip([{ name: 'word/document.xml', data: enc('<a/>'), method: 12, comp: enc('<a/>') }])), /压缩方式/);
  const bad = mkzip([{ name: 'word/document.xml', data: enc(DOCX_XML) }]).slice();
  bad[30 + 'word/document.xml'.length] ^= 0xFF;   // 翻转主文档数据首字节 → CRC 不符
  await assert.rejects(docxMainXmlBytes(bad), /CRC|不符/);
  await assert.rejects(docxMainXmlBytes(new Uint8Array([1, 2, 3, 4])), /过小|DOCX/);
  await assert.rejects(docxMainXmlBytes(enc('definitely not a zip file at all, plain text here')), /中央目录|DOCX/);
  // 声明解压大小越限：读数据前即拒绝
  const big = mkzip([{ name: 'word/document.xml', data: enc('<a/>') }]);
  const dv = new DataView(big.buffer);
  dv.setUint32(22, 9 * MIB, true);
  let cen = -1;
  for (let i = 0; i + 4 <= big.length; i++)
    if (big[i] === 0x50 && big[i + 1] === 0x4B && big[i + 2] === 0x01 && big[i + 3] === 0x02) { cen = i; break; }
  assert.ok(cen > 0);
  dv.setUint32(cen + 24, 9 * MIB, true);
  await assert.rejects(docxMainXmlBytes(big), /上限|MiB/);
});

test('docxToText：deflate 条目解压校验；空文档显式报错', async () => {
  if (typeof DecompressionStream === 'function') {
    const raw = enc(DOCX_XML);
    const zip = mkzip([{ name: 'word/document.xml', data: raw, method: 8, comp: deflateRawSync(raw) }]);
    assert.deepEqual(await docxMainXmlBytes(zip), raw);
    assert.match(await docxToText(zip, new StubDOMParser()), /第1镜/);
  }
  const empty = mkzip([{ name: 'word/document.xml', data: enc('<w:document><w:body><w:p/></w:body></w:document>') }]);
  await assert.rejects(docxToText(empty, new StubDOMParser()), /未提取到文本/);
});

test('parseImportFile：单文件上限、空文本、类型与超长分镜逐项拒绝', async () => {
  const ok = await parseImportFile(tfile('a.txt', '1. 甲\n2. 乙'), { parse: strictParse });
  assert.equal(ok.shots, 2); assert.equal(ok.kind, 'txt');
  const j = await parseImportFile(tfile('s.json', '[{"title":"A","duration":7}]'), { parse: strictParse });
  assert.equal(j.fields[0].duration, 7);
  await assert.rejects(parseImportFile(bfile('big.txt', new Uint8Array(21 * MIB)), { parse: strictParse }), /上限/);
  await assert.rejects(parseImportFile({ name: 'fake.txt', size: 21 * MIB, arrayBuffer: async () => new ArrayBuffer(8) }, { parse: strictParse }), /上限/);
  await assert.rejects(parseImportFile(tfile('e.txt', '   '), { parse: strictParse }), /文本/);
  await assert.rejects(parseImportFile(tfile('o.doc', 'x'), { parse: strictParse }), /\.doc/);
  const huge = 'x'.repeat(IMPORT_LIMITS.maxFieldChars + 1);
  await assert.rejects(parseImportFile(tfile('h.txt', huge), { parse: strictParse }), /超过|上限/);
  // 同一文本走非严格粘贴路径仍按既有行为截断——两条路径语义不混
  assert.throws(() => parseScript(huge), /超过|上限/);
});

test('prepareImportFiles：逐文件预览数据 + 文件数/批量字节/合计分镜上限', async () => {
  const p = await prepareImportFiles([tfile('a.txt', '1. 甲\n2. 乙'), tfile('b.txt', '1. 丙')], { parse: strictParse });
  assert.equal(p.totalShots, 3);
  assert.deepEqual(p.files.map(f => f.name), ['a.txt', 'b.txt']);
  assert.deepEqual(p.files.map(f => f.shots), [2, 1]);
  assert.deepEqual(p.files.map(f => f.kind), ['txt', 'txt']);
  const many = Array.from({ length: 21 }, (_, i) => tfile(`f${i}.txt`, 'x'));
  await assert.rejects(prepareImportFiles(many, { parse: strictParse }), /数量超限|20/);
  await assert.rejects(prepareImportFiles([], { parse: strictParse }), /未选择/);
  // 任一文件失败 → 整批拒绝并列出文件名
  await assert.rejects(prepareImportFiles([tfile('ok.txt', '1. 甲'), bfile('bad.docx', enc('notzip'))], { parse: strictParse }), /bad\.docx/);
  // 批量字节：docx 内未读取的大条目也计入真实文件大小（7×~6MiB > 40MiB）
  const padDoc = () => bfile('pad.docx', mkzip([
    { name: 'word/document.xml', data: enc('<w:document><w:body><w:p><w:r><w:t>1. 甲</w:t></w:r></w:p></w:body></w:document>') },
    { name: 'word/media/big.bin', data: new Uint8Array(6 * MIB) },
  ]));
  await assert.rejects(
    prepareImportFiles(Array.from({ length: 7 }, padDoc), { parse: strictParse, domParser: new StubDOMParser() }),
    /批量总量|40MiB/);
  // 合计分镜 ≤200
  const f150 = tfile('a.txt', Array.from({ length: 150 }, (_, i) => `${i + 1}. x`).join('\n'));
  const f100 = tfile('b.txt', Array.from({ length: 100 }, (_, i) => `${i + 1}. y`).join('\n'));
  await assert.rejects(prepareImportFiles([f150, f100], { parse: strictParse }), /合计|超限/);
});

test('importFiles/applyImport：默认追加、replace 需显式确认、取消不改草稿', async () => {
  const { sb } = await boot();
  sb.fromScript('1. 已有镜头');
  const made = await sb.importFiles([tfile('a.txt', '1. 新甲\n2. 新乙')]);
  assert.equal(made.length, 2);
  assert.equal(sb.list().length, 3);                 // 默认 append
  assert.match(sb.scriptText(), /新甲/);             // 源文本记入剧本
  const p = await sb.prepareImport([tfile('b.txt', '1. 替一\n2. 替二\n3. 替三')]);
  await assert.rejects(sb.applyImport(p, { mode: 'replace' }), /confirmReplace|确认/);
  assert.equal(sb.list().length, 3);
  const r0 = await sb.applyImport(p, { mode: 'replace', confirmReplace: async () => false });
  assert.equal(r0, null);                            // 取消 → 草稿原样
  assert.equal(sb.list().length, 3);
  const r1 = await sb.applyImport(p, { mode: 'replace', confirmReplace: async () => true });
  assert.equal(r1.length, 3);
  assert.equal(sb.list().length, 3);
  assert.equal(sb.list()[0].description, '替一');
  await assert.rejects(sb.applyImport(p, { mode: 'bogus' }), /未知导入模式/);
});

test('编号剧本的导语段保留为首个分镜', async () => {
  const { sb } = await boot();
  const made = await sb.importFiles([tfile('s.txt', '前言：雨夜城市\n\n1. 街道\n2. 室内')]);
  assert.equal(made.length, 3);
  assert.match(made[0].description, /前言/);
  assert.match(made[1].description, /街道/);
});

test('importFiles：JSON 与 DOCX 混合导入，逐文件计数与验证先行', async () => {
  const { sb } = await boot();
  const docx = bfile('剧本.docx', mkzip([{ name: 'word/document.xml', data: enc(DOCX_XML) }]));
  const made = await sb.importFiles(
    [tfile('s.json', '[{"title":"J1","duration":9},{"title":"J2"}]'), docx],
    { domParser: new StubDOMParser() });
  assert.equal(made.length, 4);                      // JSON 2 + DOCX 2
  assert.equal(made[0].title, 'J1');
  assert.equal(made[0].duration, 9);
  assert.match(made[3].description, /室内对白/);
  if (typeof DOMParser !== 'function')
    await assert.rejects(sb.importFiles([docx]), /DOCX|DOMParser|不支持/);   // 环境缺席 → 优雅拒绝
});

test('任一文件验证失败 → 整批不写，现有草稿原样保留', async () => {
  const { sb } = await boot();
  sb.fromScript('1. 保留我');
  await assert.rejects(
    sb.importFiles([tfile('ok.txt', '1. 甲'), bfile('bad.docx', enc('zz not zip'))]),
    /bad\.docx/);
  assert.equal(sb.list().length, 1);
  assert.equal(sb.list()[0].description, '1. 保留我');
  for (const bad of ['剧本不是 JSON', '"字符串也不是分镜数组"', 'null', '42']) {
    await assert.rejects(sb.importFiles([tfile('ok.txt', '第1镜 新镜头'), tfile('bad.json', bad)]), /bad\.json.*JSON/);
    assert.equal(sb.list().length, 1, '损坏的 JSON 不得静默按文本导入');
  }
});

test('追加容量预检：现有 199 + 导入 2 超 200 → 整批拒绝', async () => {
  const { sb } = await boot();
  for (let i = 0; i < 199; i++) sb.addShot({ title: `s${i}` });
  const p = await sb.prepareImport([tfile('a.txt', '1. 甲\n2. 乙')]);
  await assert.rejects(sb.applyImport(p, { mode: 'append' }), /超限/);
  assert.equal(sb.list().length, 199);
});

test('项目切换守卫：解析后切项目 → applyImport 拒写；解析中切项目 → 整批不写', async () => {
  const { sb, store } = await boot();
  const p = await sb.prepareImport([tfile('a.txt', '1. 甲\n2. 乙')]);
  await store.newProject('新项目');
  await assert.rejects(sb.applyImport(p, { mode: 'append' }), /切换|重置/);
  assert.equal(sb.list().length, 0);
  // 异步解析期间切换：慢 arrayBuffer 模拟
  let release;
  const gate = new Promise(r => release = r);
  const slow = { name: 'slow.txt', size: 8, arrayBuffer: async () => { await gate; return enc('1. 慢').buffer; } };
  const pending = sb.importFiles([slow]);
  await store.newProject('再次切换');
  release();
  await assert.rejects(pending, /切换|重置/);
  assert.equal(sb.list().length, 0, '切换后的项目不得被写入');
});

test('replace 确认回调期间切项目 → 确认通过也拒绝写入', async () => {
  const { sb, store } = await boot();
  sb.fromScript('1. 旧镜头');
  const p = await sb.prepareImport([tfile('a.txt', '1. 新镜头')]);
  const pending = sb.applyImport(p, {
    mode: 'replace',
    confirmReplace: async () => { await store.newProject('别的项目'); return true; },
  });
  await assert.rejects(pending, /切换/);
  assert.equal(sb.list().length, 0, '新项目不得被清空或写入');
});

test('同项目的编辑、预览内容篡改和重复应用均不得覆盖原分镜', async () => {
 const {sb}=await boot();const shot=sb.addShot({title:'保留'});
 const p=await sb.prepareImport([tfile('a.txt','第1镜 新片')]);
 await assert.rejects(sb.applyImport(p,{mode:'replace',confirmReplace:async()=>{sb.updateShot(shot.id,{title:'确认期间修改'});return true;}}),/已变更/);
 assert.equal(sb.find(shot.id).title,'确认期间修改');
 const q=await sb.prepareImport([tfile('a.txt','第1镜 新片')]);q.files[0].fields[0].description='恶意替换';
 await assert.rejects(sb.applyImport(q),/被修改/);
 const good=await sb.prepareImport([tfile('a.txt','第1镜 正确导入')]);await sb.applyImport(good);
 await assert.rejects(sb.applyImport(good),/失效/);assert.equal(sb.list().length,2);
});

test('旧字符串剧本规范化不使预览失效；原文容量在替换确认前校验',async()=>{
  const {sb,store}=await boot();sb.addShot({title:'保留'});store.project.studio.script='旧稿';
  const p=await sb.prepareImport([tfile('new.txt','新镜头')]);assert.equal(sb.scriptText(),'旧稿');
  await sb.applyImport(p);assert.equal(sb.list().length,2);assert.match(sb.scriptText(),/旧稿/);
  const large=' '.repeat(3*1024*1024)+'有效镜头';
  const q=await sb.prepareImport([tfile('one.txt',large),tfile('two.txt',large),tfile('three.txt',large)]);
  let confirmed=false;
  await assert.rejects(sb.applyImport(q,{mode:'replace',confirmReplace:async()=>{confirmed=true;return true;}}),/原文总量超限/);
  assert.equal(confirmed,false);assert.equal(sb.list().length,2);
  const empty=createStoryboards({store:createStore(createMemoryStorage())});
  await assert.rejects(empty.prepareImport([tfile('empty.txt','内容')]),/没有打开的项目/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localOnlyFontResolver } from '../tools/local-font-resolver.mjs';
const upstream = await readFile(new URL('../node_modules/troika-three-text/libs/unicode-font-resolver-client.factory.js',import.meta.url),'utf8');
const { default: factory } = await import('data:text/javascript;base64,'+Buffer.from(localOnlyFontResolver(upstream)).toString('base64'));
assert.throws(()=>localOnlyFontResolver('// changed upstream'),/review/);
execFileSync(process.execPath,[fileURLToPath(new URL('../tools/build-unicode-fonts.mjs',import.meta.url))],{windowsHide:true});
const fontRoot=new URL('../public/fonts/unicode-local/',import.meta.url),origin='https://local-font-test.invalid';
const oldFetch=globalThis.fetch,requests=[];
try {
 globalThis.fetch=async value=>{
  const url=new URL(value);assert.equal(url.origin,origin,'Troika fallback must never retry its public CDN');
  requests.push(url.pathname);const path=url.pathname.slice('/fonts/unicode-local/'.length);
  const body=await readFile(new URL(path,fontRoot),'utf8');return {ok:true,json:async()=>JSON.parse(body)};
 };
 const result=await factory().getFontsForString('道具甲乙 · 测试人物 😀 𠀀',{dataUrl:origin+'/fonts/unicode-local'});
 assert.deepEqual(result.fontUrls,[origin+'/fonts/unicode-local/font-files/noto-sc/sans-serif.normal.400.woff']);
 assert.ok(result.chars.length>0);assert.ok(requests.some(path=>path.includes('plane2/')),'rare Unicode remains a local missing-glyph fallback');
 const metadata=JSON.parse(await readFile(new URL('../LICENSES/NotoSansSC-source.json',import.meta.url),'utf8'));
 const font=await readFile(new URL('../LICENSES/NotoSansSC-Regular.woff',import.meta.url));
 assert.equal(createHash('sha256').update(font).digest('hex'),metadata.woffSha256);
 assert.equal(font.subarray(0,4).toString(),'wOFF');assert.ok(metadata.glyphCount>=30000);
 requests.length=0;
 globalThis.fetch=async value=>{const url=new URL(value);requests.push(url.origin);return {ok:false,statusText:'404 local font index'};};
 await assert.rejects(factory().getFontsForString('本地故障',{dataUrl:origin+'/fonts/unicode-local'}),/404 local font index/);
 assert.ok(requests.length>0);assert.ok(requests.every(value=>value===origin),'local data failure never retries a public CDN');
 console.log('PASS licensed CJK font and real Troika resolver: Chinese, emoji and rare Unicode request only local indexes/font');
} finally {globalThis.fetch=oldFetch}

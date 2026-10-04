// SPDX-License-Identifier: AGPL-3.0-or-later
// Complete same-origin fallback indexes for Troika's documented dataUrl schema.
// Missing glyphs render the bundled font's .notdef; no document text is altered
// and no missing index can trigger the resolver's automatic public-CDN retry.
import { mkdir,writeFile,readFile,copyFile } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'public/fonts/unicode-local');
const source=join(root,'LICENSES/NotoSansSC-Regular.woff');
const metadata=JSON.parse(await readFile(join(root,'LICENSES/NotoSansSC-source.json'),'utf8'));
assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),metadata.woffSha256);
await mkdir(join(output,'font-meta'),{recursive:true});
await mkdir(join(output,'font-files/noto-sc'),{recursive:true});
await writeFile(join(output,'font-meta/latin.json'),JSON.stringify([1,{id:'noto-sc',ranges:metadata.ranges,typeforms:{'sans-serif':{normal:[400]}}}]));
await copyFile(source,join(output,'font-files/noto-sc/sans-serif.normal.400.woff'));
for(let plane=0;plane<17;plane++) {
 const dir=join(output,`codepoint-index/plane${plane}`);await mkdir(dir,{recursive:true});
 for(let block=0;block<256;block+=16) {
  await Promise.all(Array.from({length:16},(_,offset)=>{
   const start=(plane<<16)+((block+offset)<<8),end=start+255;
   return writeFile(join(dir,`${start.toString(16)}-${end.toString(16)}.json`),'[1,{}]');
  }));
 }
}
console.log(`Bundled local Unicode indexes with ${metadata.glyphCount} font codepoints; missing glyphs stay local`);

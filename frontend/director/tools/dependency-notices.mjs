// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline license collection from the exact installed lockfiles. Explicit
// official-source fallbacks retain their provenance and publisher declarations.
import { readFile,readdir,stat,writeFile,mkdir } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lf=text=>text.replace(/\r\n?/g,'\n');
const hash=text=>createHash('sha256').update(lf(text)).digest('hex');
const fallback=JSON.parse(await readFile(join(root,'LICENSES/dependency-fallbacks.json'),'utf8'));
const roots=[['director',root],['canvas',resolve(root,'../canvas')]];
const output=join(root,'public/licenses');
// This package omits SPDX metadata; its shipped LICENSE explicitly grants MIT.
const verifiedDeclarations=new Map([['webgl-constants@1.1.1','MIT']]);
// These components are vendored inside Troika's factories, so lockfile-only
// enumeration cannot discover their independent copyrights and licenses.
const bundled=JSON.parse(await readFile(join(root,'LICENSES/bundled/BUNDLED-LICENSE-SOURCES.json'),'utf8'));
const bundledSections=[];
for(const row of bundled.components) {
 const embedded=row.embeddedIn;
 const installed=JSON.parse(await readFile(join(root,'node_modules',embedded.package,'package.json'),'utf8'));
 assert.equal(installed.version,embedded.version,'reviewed bundled factory version');
 const factory=await readFile(join(root,'node_modules',embedded.package,embedded.file),'utf8');
 assert.equal(hash(factory),embedded.fileSha256,'reviewed bundled factory source digest');
 for(const kind of ['license','notice']) {
  if(!row[`${kind}Filename`])continue;
  const body=await readFile(join(root,'LICENSES/bundled',row[`${kind}Filename`]),'utf8');
  assert.equal(hash(body),row[`${kind}Sha256`],`${row.id} official ${kind} digest`);
  bundledSections.push(`\n===== ${row.id} — ${kind} =====\nSource: ${row.officialGitBlobURL ?? row.officialLicenseURL}\n${lf(body)}`);
 }
}
const bundledNotices='Independent components vendored inside the locked Troika font parsers.\nSee BUNDLED-MANIFEST.json for pinned official attribution, source digests and revision limitations.\n'+bundledSections.join('\n')+'\n';
if(process.argv.includes('--verify')) {
 const manifest=JSON.parse(await readFile(join(output,'DEPENDENCY-MANIFEST.json'),'utf8'));
 const notices=await readFile(join(output,'DEPENDENCY-NOTICES.txt'),'utf8');
 assert.equal(hash(notices),manifest.noticesSha256,'full license text digest');
 const bundledManifest=JSON.parse(await readFile(join(output,'BUNDLED-MANIFEST.json'),'utf8'));
 assert.deepEqual(bundledManifest.components,bundled.components,'bundled notices provenance');
 assert.equal(bundledManifest.noticesSha256,hash(bundledNotices),'bundled notices source digest');
 assert.equal(hash(await readFile(join(output,'BUNDLED-NOTICES.txt'),'utf8')),bundledManifest.noticesSha256,'bundled notice body digest');
 for(const [name,path] of roots) {
  const text=await readFile(join(path,'package-lock.json'),'utf8'), lock=JSON.parse(text);
  assert.equal(hash(text),manifest.locks[name],'notices must match the locked dependencies');
  const records=manifest.packages.filter(row=>row.project===name);
  assert.equal(records.length,Object.keys(lock.packages).length-1);
  for(const row of records) {const expected=lock.packages[row.path];assert.equal(row.version,expected.version);assert.equal(row.integrity,expected.integrity);assert.ok(row.license);}
 }
 console.log(`Verified ${manifest.packages.length} locked declarations and ${bundled.components.length} embedded component notices`);
} else {
 const packages=[],locks={},sections=[];
 for(const [project,path] of roots) {
  const text=await readFile(join(path,'package-lock.json'),'utf8'),lock=JSON.parse(text);locks[project]=hash(text);
  for(const [relative,row] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))) {
   if(!relative)continue;
   const directory=join(path,relative);
   let pkg;try{pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   const entry={project,path:relative,name:pkg?.name??relative.split('node_modules/').at(-1),version:row.version,license:row.license??pkg?.license,integrity:row.integrity,optional:!!row.optional,texts:[]};
   entry.license??=verifiedDeclarations.get(`${entry.name}@${entry.version}`);
   assert.ok(entry.license,`Missing license declaration: ${entry.name}`);
   if(pkg) {
    assert.equal(pkg.version,row.version);
    const files=(await readdir(directory)).filter(name=>/(?:^|[._-])(?:license|licence|notice|copying)(?:[._-]|$)/i.test(name)).sort();
    for(const name of files) {
     const file=join(directory,name);if(!(await stat(file)).isFile())continue;
     const body=lf(await readFile(file,'utf8'));if(!body.trim())continue;
     entry.texts.push({source:`${project}/${relative}/${name}`,sha256:hash(body)});
     sections.push(`\n===== ${project}: ${entry.name}@${entry.version} — ${name} =====\n${body}`);
    }
    if(!entry.texts.length) {
     const source=fallback.packages[entry.name];
     assert.ok(source,`Publisher omitted LICENSE and no reviewed fallback exists: ${entry.name}`);
     assert.equal(source.version,row.version,'fallback is bound to the reviewed package version');
     assert.equal(hash(source.text),source.sha256,'fallback text digest');
     entry.texts.push({source:source.url,sha256:source.sha256,declarationOnly:!!source.declarationOnly});
     sections.push(`\n===== ${project}: ${entry.name}@${entry.version} — official/publisher fallback =====\nSource: ${source.url}\n${lf(source.text)}`);
    }
   } else {
    assert.equal(row.optional,true,`Required dependency is not installed: ${relative}`);
    entry.notBundledHere=true; // OS-specific build tools: no absent binaries are represented as bundled code.
   }
   packages.push(entry);
  }
 }
 const notices='Locked dependency license notices. Each component keeps its own license.\nOptional platform packages marked notBundledHere are lock declarations; their absent binaries are not redistributed.\n'+sections.join('\n')+'\n';
 await mkdir(output,{recursive:true});
 await writeFile(join(output,'DEPENDENCY-NOTICES.txt'),notices);
 await writeFile(join(output,'DEPENDENCY-MANIFEST.json'),JSON.stringify({version:1,locks,noticesSha256:hash(notices),packages},null,2)+'\n');
 await writeFile(join(output,'BUNDLED-NOTICES.txt'),bundledNotices);
 await writeFile(join(output,'BUNDLED-MANIFEST.json'),JSON.stringify({version:1,...bundled,noticesSha256:hash(bundledNotices)},null,2)+'\n');
 console.log(`Collected ${packages.length} declarations and ${packages.filter(row=>row.texts.length).length} package license notices`);
}

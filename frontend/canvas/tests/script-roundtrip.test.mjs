import test from 'node:test';
import assert from 'node:assert/strict';
import {importStudio} from '../src/studio-schema.js';

test('script draft survives document import with content and revision time intact',()=>{
 const text='序幕\n第一场 雨夜\n\n第二场 重逢\n';
 const got=importStudio({script:{text,updatedAt:1234},shots:[]},new Map(),new Map(),{});
 assert.deepEqual(got.script,{text,updatedAt:1234});
 assert.deepEqual(importStudio({script:text},new Map(),new Map(),{}).script,{text,updatedAt:0});
 assert.throws(()=>importStudio({script:{text:37}},new Map(),new Map(),{}),/剧本原文/);
 assert.throws(()=>importStudio({script:{text:'x'.repeat(8*1024*1024+1)}},new Map(),new Map(),{}),/超过/);
});

test('shot duration fidelity: import preserves raw value + invalid flag, never clamps',()=>{
 // WO-B4a：非法/超范围/小数时长在导入侧保留原值并标记，不再静默夹逼到 1–30。
 const got=importStudio({shots:[
  {id:'a',title:'a',duration:45,durationInvalid:true,durationRaw:'45秒'},
  {id:'b',title:'b',duration:3.5},
  {id:'c',title:'c',duration:8},
  {id:'d',title:'d',duration:'45秒'},
  {id:'e',title:'e'},
 ]},new Map(),new Map(),{});
 const [a,b,c,d,e]=got.shots;
 assert.equal(a.duration,45);assert.equal(a.durationInvalid,true);assert.equal(a.durationRaw,'45秒');
 assert.equal(b.duration,3.5);assert.equal(b.durationInvalid,true);assert.equal(b.durationRaw,3.5);
 assert.equal(c.duration,8);assert.equal(c.durationInvalid,undefined);assert.equal(c.durationRaw,undefined);
 assert.equal(d.duration,5);assert.equal(d.durationInvalid,true);assert.equal(d.durationRaw,'45秒');
 assert.equal(e.duration,5);assert.equal(e.durationInvalid,true,'缺失时长同样标记非法而非静默取 5');
 // 版本快照字段同样不夹逼
 const v=importStudio({shots:[{id:'v',duration:8,versions:[{at:1,fields:{title:'t',duration:45}}]}]},new Map(),new Map(),{}).shots[0];
 assert.equal(v.versions[0].fields.duration,45);
});

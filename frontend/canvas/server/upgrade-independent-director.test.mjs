import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('独立验收：导演台引用素材托管失败时不能保存不可恢复的 blob 地址并返回成功',async()=>{
  const code=await readFile(new URL('../public/__hub-sdk__.js',import.meta.url),'utf8'),sent=[],listeners=new Map();
  class LocalURL extends URL{}LocalURL.createObjectURL=()=> 'blob:http://localhost:4178/owned-local';LocalURL.revokeObjectURL=()=>{};
  const parent={postMessage:message=>sent.push(message)},origin='http://127.0.0.1:4178';
  const scope={URL:LocalURL,URLSearchParams,Blob,ArrayBuffer,Map,Set,Promise,crypto,location:new URL('http://localhost:4178/director/?node=n1&nonce=s1'),document:{referrer:origin+'/'},innerWidth:1000,innerHeight:700,parent,addEventListener:(type,fn)=>listeners.set(type,fn),setTimeout:()=>0,clearTimeout(){}};scope.window=scope;
  vm.runInContext(code,vm.createContext(scope));
  const url=scope.URL.createObjectURL(new Blob(['local-scene'],{type:'model/gltf-binary'}));
  const saving=scope.hub.storage.set('composition',{scene:url});saving.catch(()=>{});
  for(let i=0;i<12;i++)await Promise.resolve();
  const req=sent.find(m=>m.method==='asset.embed');assert.ok(req);
  listeners.get('message')({origin,source:parent,data:{ns:'xp-hub',kind:'rpc-res',id:req.id,nonce:'s1',ok:false,error:'模拟空间不足'}});
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(sent.filter(m=>m.method==='storage.set').length,0,'托管失败不能覆盖原来可恢复的场景');
  await assert.rejects(saving,/保存|素材|托管|blob|空间|失败/);
});

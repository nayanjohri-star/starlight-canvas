import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';

test('独立复审：带最大输出token数的正常文本节点可以安全导出并重新导入',async()=>{
 const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('文本工程');
 store.addNode('text',0,0,{model:'gpt-5.6-sol',text:'分镜提示词',params:{max_tokens:2048,temperature:0.5}});
 const json=await store.exportJSON();await store.importJSON(json);
 const node=store.project.nodes.find(n=>n.type==='text');assert.equal(node.data.params.max_tokens,2048);await store.flush();
});

test('独立复审：导出当前项目拒绝真正的秘密字段，不因支持token数量而放行apiKey',async()=>{
 const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('拒绝秘密字段');
 store.addNode('text',0,0,{model:'mock',params:{apiKey:'fake-not-a-real-key'}});
 await assert.rejects(()=>store.exportJSON(),/密钥|秘密|secret|凭据/);await store.flush();
});

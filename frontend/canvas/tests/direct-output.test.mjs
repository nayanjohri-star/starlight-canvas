import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/store.js';
import {createMemoryStorage} from '../src/storage.js';
import {directVideoOutput} from '../src/studio-schema.js';

test('视频输出偏好兼容旧连线，导出导入保留，非法值不成为开关',async()=>{
 const s=createStore(createMemoryStorage());await s.newProject('output');
 const a=s.addNode('gen',0,0,{draft:{model:'wan-3.0'}}),b=s.addNode('gen',500,0,{directOutput:false,draft:{model:'wan-3.0'}});
 assert.equal(directVideoOutput(s.project,a),true);assert.equal(directVideoOutput(s.project,b),false);
 const edge=s.addEdge(a.id,'out',b.id,'refs','video');
 assert.equal(directVideoOutput(s.project,a),false,'旧连线不能被默认直接生成隐藏');
 assert.equal(s.project.edges.length,1);
 const text=await s.exportJSON();
 const s2=createStore(createMemoryStorage());await s2.importJSON(text);
 const first=s2.project.nodes.find(n=>n.x===0),second=s2.project.nodes.find(n=>n.x===500);
 assert.equal(directVideoOutput(s2.project,first),false);assert.equal(second.data.directOutput,false);
 s.removeEdge(edge.id);assert.equal(directVideoOutput(s.project,a),true);
 a.data.directOutput='false';await s2.importJSON(await s.exportJSON());
 assert.equal('directOutput' in s2.project.nodes.find(n=>n.x===0).data,false);
});

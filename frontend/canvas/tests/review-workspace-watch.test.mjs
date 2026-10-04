import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteWatch} from '../src/workspace.js';

test('独立复审：二次读取链接期间换密钥，也不能发布旧轮询结果',async()=>{
 let reads=0,key='old-mock-identity',notices=0;const link={id:'remote',owner:'owner',head:1};
 const watch=createRemoteWatch({getProjectId:()=> 'local',getKey:()=>key,getLink:async()=>{reads++;if(reads===2)key='new-mock-identity';return {...link};},checkRemote:async()=>({changed:true,head:2}),onNotice:()=>notices++});
 await watch.tick();assert.equal(notices,0);watch.stop();
});

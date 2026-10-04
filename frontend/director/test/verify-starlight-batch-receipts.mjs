import assert from 'node:assert/strict';
import { shotsFixture,seedShot } from './bus/shots-fixture.mjs';
const f=shotsFixture();
try {
 assert.equal(f.run('shot.setTimeline',{frameCount:900}).ok,true);
 const before=f.snapshot();
 const shots=Array.from({length:12},(_,index)=>({...seedShot(),id:`batch-shot-${index}`,
  name:`正式基准镜头 ${index+1}：双角色与三个机位的完整合成场景`,
  startFrame:index*75,endFrame:index*75+74,cameraKeys:[]}));
 const receipt=f.run('shot.replace',{shots});
 assert.equal(receipt.ok,true,JSON.stringify(receipt));
 assert.equal(f.shots.state().shots.length,12);
 assert.ok([...receipt.summary].length<=240);
 assert.ok(receipt.summary.endsWith('…'),'bounded human summary reports truncation');
 for(const shot of shots)assert.ok(receipt.affectedIds.includes(shot.id),'no affected shot is dropped');
 assert.equal(receipt.delta.length,8);assert.ok(receipt.detailCursor);
 assert.equal(receipt.revision.after,receipt.revision.before+1);assert.equal(receipt.undo.entries,1);
 const after=f.snapshot();
 assert.equal(f.run('edit.undo',{receiptId:receipt.receiptId}).ok,true);
 assert.deepEqual(f.snapshot(),before,'one undo restores the whole real shot document');
 assert.equal(f.run('edit.redo').ok,true);assert.deepEqual(f.snapshot(),after);
 console.log('PASS twelve real authored shots: bounded summary, complete affected IDs, retained detail cursor and one undo/redo');
} finally {f.dispose()}

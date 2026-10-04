import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCamPathDsl} from '../src/director-controls.js';

for(const dsl of [
 'campath "复审"\nlook at 0 1 0\nfrom 0 1 4 fov 500\nhold 2s',
 'campath "复审"\nlook at 0 1 0\nfrom 0 1 4\nhold 2s fov 0',
 'campath "复审"\nlook at 0 1 0\nfrom 0 1 4\nmove to 0 1 3 2s fov 999'
]) test('复审：非法FOV不得通过宿主运镜校验：'+dsl.split('\n').slice(-2).join(' / '),()=>{
 assert.throws(()=>parseCamPathDsl(dsl),/fov|视场|视角/i);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSync } from 'rolldown/experimental';
import { projectFixture, useScenes } from './bus/project-fixture.mjs';

test('App initializes document and scene refs before its real scene-owner first-render call and lexical getters', () => {
  const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
  const app=parseSync('App.jsx',source).program.body.find(node=>node.type==='ExportDefaultDeclaration').declaration;
  assert.equal(app.type,'FunctionDeclaration');
  const declaration=name=>app.body.body.find(node=>node.type==='VariableDeclaration'&&node.declarations.some(row=>row.id?.name===name));
  const documentRef=declaration('studioDocumentEpochRef'),sceneRef=declaration('studioSceneEpochRef'),sceneOwner=declaration('scenesDomain');
  assert.ok(documentRef&&sceneRef&&sceneOwner,'the test must execute the actual App declarations');
  const call=sceneOwner.declarations.find(row=>row.id.name==='scenesDomain').init;
  assert.equal(call.callee.name,'useScenes');
  const callText=source.slice(sceneOwner.start,sceneOwner.end);
  assert.match(callText,/get studioDocumentEpochRef\(\) \{ return studioDocumentEpochRef; \}/);
  assert.match(callText,/get studioSceneEpochRef\(\) \{ return studioSceneEpochRef; \}/);
  const getterNames=[...callText.matchAll(/get (\w+)\(\) \{ return (\w+); \}/g)].map(row=>row[2]);
  const parameters=[...new Set(['appContext','useScenes','useRef','observe',...getterNames])]
    .filter(name=>!['studioDocumentEpochRef','studioSceneEpochRef'].includes(name));
  // Preserve the exact production statement order. A ref initializer after
  // the call remains in the lexical scope and reproduces its actual TDZ.
  const body=[documentRef,sceneRef,sceneOwner].sort((a,b)=>a.start-b.start).map(node=>source.slice(node.start,node.end)).join('\n');
  for(const singleScene of [true,false]){
    const f=projectFixture({singleScene}),observations=[];
    try{
      const values={...f.scope,appContext:f.scope.appContext,useScenes,useRef,observe:owner=>observations.push(owner.projectSaveIdentity())};
      const FirstMount=new Function(...parameters,`return function ActualAppSceneEntry(){${body}\nobserve(scenesDomain);return null;}`)(...parameters.map(name=>values[name]));
      assert.doesNotThrow(()=>renderToStaticMarkup(createElement(FirstMount)),'the actual first-render scene hook must not read an uninitialized App ref');
      assert.equal(observations.length,1);
      assert.match(observations[0].documentEpoch,/^[0-9a-f-]{36}$/,'identity comes from the actual App useRef(crypto.randomUUID()) initializer');
      assert.notEqual(observations[0].documentEpoch,f.scope.studioDocumentEpochRef.current,'the fixture preinitialized ref cannot mask the lexical getter ordering');
      assert.ok(documentRef.start<sceneOwner.start&&sceneRef.start<sceneOwner.start,'both identity hooks have one unconditional position before their scene owner');
    }finally{f.dispose();}
  }
});

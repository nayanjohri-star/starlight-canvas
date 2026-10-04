// AI 改写角色：H3 专用角色按模式显示、占位符填充、JSON 结果解析、项目内保存与导入清洗、最近 5 版。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_ROLES, builtinRole, roleFits, roleIdForH3Intent, renderRolePrompt, parseRewriteOutput,
  resolveRoles, saveRoles, sanitizeRewriteRoles, sanitizeRewriteState, pushVersion, MAX_VERSIONS,
} from '../src/rewrite-roles.js';
import { importStudio, sanitizeStudioNode } from '../src/studio-schema.js';

test('H3 专用角色只在对应的 H3 模式下可用，其他角色始终可用', () => {
  const i2v = builtinRole('i2v-polish'), r2v = builtinRole('r2v-polish');
  assert.equal(roleFits(i2v, new Set()), false, '没有 H3 下游时不显示');
  assert.equal(roleFits(i2v, new Set(['frames'])), true);
  assert.equal(roleFits(i2v, new Set(['last_frame'])), true);
  assert.equal(roleFits(i2v, new Set(['refs'])), false, '素材参考模式不显示图生视频润色');
  assert.equal(roleFits(r2v, new Set(['refs'])), true);
  assert.equal(roleFits(r2v, new Set(['frames', 'text'])), false);
  for (const id of ['screenwriter', 'shot-polish', 'polish']) assert.equal(roleFits(builtinRole(id), new Set()), true, id);
  assert.equal(roleIdForH3Intent('frames'), 'i2v-polish');
  assert.equal(roleIdForH3Intent('refs'), 'r2v-polish');
  assert.equal(roleIdForH3Intent('text'), null, 'H3 纯文字模式没有专用改写');
});

test('发送前组装：{DRAFT} 就地替换并解开 {{ }}，其余角色作为系统提示；改写要求附在原文后', () => {
  const inline = renderRolePrompt(builtinRole('shot-polish').prompt, { source: '男孩@图片1坐着', request: '更有氛围' });
  assert.equal(inline.system, '');
  assert.ok(inline.prompt.includes('男孩@图片1坐着\n\n【改写要求】更有氛围'));
  assert.ok(!/\{\{|\}\}|\{DRAFT\}|\{ASSETS\}/.test(inline.prompt), '占位符全部填好');
  assert.match(inline.prompt, /@图片N/, '要求沿用画布的素材引用写法');
  const sys = renderRolePrompt(builtinRole('i2v-polish').prompt, { source: '少年站在城门口' });
  assert.match(sys.system, /图生视频/);
  assert.equal(sys.prompt, '少年站在城门口');
  assert.ok(!/\{\{/.test(sys.system));
});

test('三段复制来的提示词保持原文结构，并注明来源', () => {
  for (const id of ['shot-polish', 'i2v-polish', 'r2v-polish']) {
    const r = builtinRole(id);
    assert.equal(r.source, 'iframe-studio');
    assert.match(r.prompt, /prompt_cn/);
  }
  assert.match(builtinRole('r2v-polish').prompt, /\{SLOTS\}/);
  assert.equal(BUILTIN_ROLES.length, 5);
});

test('结果解析：prompt_cn 作为结果、英文另存；普通文本原样', () => {
  assert.deepEqual(parseRewriteOutput('```json\n{"prompt_cn":"中文","prompt_en":"English"}\n```'), { text: '中文', en: 'English' });
  assert.deepEqual(parseRewriteOutput('1-1 城门 [黄昏] [外]'), { text: '1-1 城门 [黄昏] [外]', en: '' });
  assert.deepEqual(parseRewriteOutput('{不是 JSON'), { text: '{不是 JSON', en: '' });
});

test('项目内保存：内置角色只存改动，自定义角色完整保存；导入清洗保留范围', () => {
  const project = { studio: { version: 1, groups: [], shots: [], timeline: [], workflow: null } };
  const roles = resolveRoles(project, { includeHidden: true });
  roles.find(r => r.id === 'polish').desc = '口语化润色';
  roles.find(r => r.id === 'shot-polish').hidden = true;
  roles.push({ id: 'role-x', name: '古风编剧', desc: '', prompt: '你是古风编剧', scope: 'h3-refs', builtin: false });
  const saved = saveRoles(project, roles);
  assert.deepEqual(saved, [
    { id: 'shot-polish', hidden: true },
    { id: 'polish', desc: '口语化润色' },
    { id: 'role-x', name: '古风编剧', desc: '', prompt: '你是古风编剧', scope: 'h3-refs' },
  ]);
  assert.equal(resolveRoles(project).some(r => r.id === 'shot-polish'), false, '隐藏的内置角色不出现在选择里');
  assert.equal(resolveRoles(project).find(r => r.id === 'polish').desc, '口语化润色');
  const imported = importStudio({ rewriteRoles: [...saved, { id: 'bad' }, { id: 'role-y', name: 'x', prompt: 'p', scope: 'evil' }] }, new Map(), new Map(), {});
  assert.deepEqual(imported.rewriteRoles.map(r => r.id), ['shot-polish', 'polish', 'role-x', 'role-y'], '不完整的自定义角色被丢弃');
  assert.equal(imported.rewriteRoles.find(r => r.id === 'role-y').scope, undefined, '未知范围不保留');
  assert.deepEqual(sanitizeRewriteRoles('x'), null);
});

test('节点改写状态：最近 5 版、导入清洗', () => {
  let st = { roleId: 'screenwriter' };
  for (let i = 1; i <= 7; i++) st = pushVersion(st, { text: `第${i}版`, at: i, roleId: 'screenwriter' });
  assert.equal(st.history.length, MAX_VERSIONS);
  assert.equal(st.history[0].text, '第3版');
  assert.equal(st.index, 4);
  const clean = sanitizeStudioNode({ title: 't', rewrite: { ...st, index: 99, history: [...st.history, { text: 5 }] } });
  assert.equal(clean.rewrite.history.length, 5);
  assert.equal(clean.rewrite.index, 4);
  assert.equal(sanitizeRewriteState(null), null);
});

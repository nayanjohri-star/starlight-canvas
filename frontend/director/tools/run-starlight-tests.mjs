import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const standalone = ['verify-procedural-rig.mjs', 'verify-sample-at.mjs', 'verify-shot-authoring.mjs',
  'verify-timeline-extent.mjs', 'verify-camera-follow.mjs', 'verify-cuts.mjs', 'verify-foot-lock.mjs',
  'verify-scenes.mjs', 'verify-project.mjs', 'verify-project-resources.mjs', 'verify-ik.mjs',
  'verify-ik-entry-camera.mjs', 'verify-render-passes.mjs', 'verify-render-passes-video.mjs',
  'bus/verify-object-selection-locks.mjs'];
const files = [...new Set([...standalone, ...readdirSync('test').filter(file => /^verify-starlight-/.test(file) && !/browser/.test(file))])];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => `test/${file}`)],
  { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);

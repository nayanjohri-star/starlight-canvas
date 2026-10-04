import assert from 'node:assert/strict';
import { resolveStudioToast } from '../../src/studio-actions.js';
const copy = { en: 'fixture-en', ko: 'fixture-ko' };
for (const isKo of [false, true]) {
 const localize = (en, korean) => isKo ? korean : en;
 const select = (korean, ko) => ko(copy.en, copy.ko);
 assert.deepEqual(resolveStudioToast(select, isKo, localize), { message: copy.en, uiMessage: isKo ? copy.ko : copy.en });
 assert.deepEqual(resolveStudioToast(korean => korean ? copy.ko : copy.en, isKo, localize), { message: copy.en, uiMessage: isKo ? copy.ko : copy.en });
 assert.deepEqual(resolveStudioToast(copy.en, isKo, localize), { message: copy.en, uiMessage: copy.en });
}
console.log('PASS bus toast localization: the same producer preserves UI copy and captures English');

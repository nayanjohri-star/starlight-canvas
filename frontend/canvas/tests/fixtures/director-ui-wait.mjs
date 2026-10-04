// SPDX-License-Identifier: AGPL-3.0-or-later
import { setTimeout as delay } from 'node:timers/promises';

// Playwright waitForFunction polls a synchronous return value. A Promise is
// truthy even when it later resolves false. Evaluate awaits it before polling.
export async function waitUiCondition(target, predicate, arg, {
  timeout = 30000, interval = 50, description = 'actual browser condition',
} = {}) {
  const deadline = Date.now() + timeout;
  const expired = () => new Error(`${description} did not become true within ${timeout}ms`);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw expired();
    let timer;
    try {
      const value = await Promise.race([target.evaluate(predicate, arg),
        new Promise((_, reject) => { timer = setTimeout(() => reject(expired()), remaining); })]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    const pause = Math.min(interval, deadline - Date.now());
    if (pause > 0) await delay(pause);
  }
}

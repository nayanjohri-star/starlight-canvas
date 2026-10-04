// A CDP navigation acknowledgement can precede destruction of the old page.
// Arm the load listener first so selectors and observers cannot use that page.
export function afterPageLoad(ws, method, request, timeoutMs = 10000) {
  if (method !== 'Page.navigate' && method !== 'Page.reload') return request();
  let listener, timer;
  const loaded = new Promise((resolve, reject) => {
    listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve(); };
    ws.addEventListener('message', listener);
    timer = setTimeout(() => reject(new Error(`${method}: Page.loadEventFired deadline exceeded`)), timeoutMs);
  });
  return Promise.all([request(), loaded]).then(([response]) => response).finally(() => {
    clearTimeout(timer);
    ws.removeEventListener('message', listener);
  });
}

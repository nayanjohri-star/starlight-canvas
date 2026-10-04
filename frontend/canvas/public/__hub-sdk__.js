// 星盘画布宿主桥（iframe 侧）：为原版 3D 导演台插件提供 window.hub。
// 安全：仅接受 document.referrer 推断的父源 + e.source===parent 的消息；
// 会话 nonce 来自 URL；blob: URL ↔ xp-asset:// 令牌互换实现场景跨会话恢复。
(function () {
  'use strict';
  var NS = 'xp-hub';
  var qs = new URLSearchParams(location.search);
  var meta = { nodeId: qs.get('node') || '', nonce: qs.get('nonce') || '', locale: 'zh-CN', theme: 'dark', region: 'cn', width: innerWidth, height: innerHeight };
  // 父源：优先 document.referrer；本机代理发送 Referrer-Policy no-referrer 时，
  // 用孪生源推断（localhost ↔ 127.0.0.1，同协议同端口）。非本机部署则视为无宿主。
  var expectedParent = null;
  try { expectedParent = document.referrer ? new URL(document.referrer).origin : null; } catch (_) { expectedParent = null; }
  if (!expectedParent) {
    try {
      var self = new URL(location.origin);
      if (self.hostname === 'localhost') self.hostname = '127.0.0.1';
      else if (self.hostname === '127.0.0.1') self.hostname = 'localhost';
      else self = null;
      expectedParent = self ? self.origin : null;
    } catch (_) { expectedParent = null; }
  }

  var seq = 0, pending = new Map(), subs = { run: [], appChange: [], incoming: [], configChange: [], storageChange: [] };
  var agentHandler = null;
  var blobTokens = new Map();      // blob: URL → assetId（托管成功 / 恢复重建的同源绑定）
  var embedPromises = new Map();   // blob: URL → Promise<assetId|null>
  var readyResolve, ready = new Promise(function (r) { readyResolve = r; });
  var inited = false;

  function post(msg) {
    if (!parent || parent === window || !expectedParent) return;
    msg.ns = NS; msg.v = 1; msg.nodeId = meta.nodeId; msg.nonce = meta.nonce;
    parent.postMessage(msg, expectedParent);
  }
  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ kind: 'rpc', id: id, method: method, args: args });
      setTimeout(function () { var p = pending.get(id); if (p) { pending.delete(id); p.reject(new Error('host timeout')); } }, 30000);
    });
  }
  function fire(list, payload) { list.forEach(function (cb) { try { cb(payload); } catch (_) {} }); }

  // ---- blob URL 托管：iframe 内创建的 blob 经父页入库，换取 xp-asset:// 令牌 ----
  var origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    var u = origCreateObjectURL(blob);
    try {
      if (blob instanceof Blob && blob.size && !embedPromises.has(u) && !blobTokens.has(u)) {
        var pr = blob.arrayBuffer().then(function (buf) {
          return rpc('asset.embed', { bytes: buf, mime: blob.type }).then(function (r) {
            if (r && r.assetId) blobTokens.set(u, r.assetId);
            return r && r.assetId;
          });
        }).catch(function () { return null; });
        embedPromises.set(u, pr);
      }
    } catch (_) {}
    return u;
  };

  // 值内引用的本地 blob URL。要求 blob:<scheme>:// 形态——普通文本里的 "blob:" 字样不误伤。
  var BLOB_URL_RE = /blob:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'\\]+/g;
  function blobRefsOf(value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    var seen = new Set(), refs = [];
    (text.match(BLOB_URL_RE) || []).forEach(function (u) { if (!seen.has(u)) { seen.add(u); refs.push(u); } });
    return refs;
  }

  function tokenize(value) {
    // 把已托管 blob: URL 替换为 xp-asset://id（可跨会话恢复）
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    blobTokens.forEach(function (id, url) { if (text.indexOf(url) >= 0) text = text.split(url).join('xp-asset://' + id); });
    return typeof value === 'string' ? text : JSON.parse(text);
  }
  function detokenize(value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    var ids = [], seenIds = new Set();
    (text.match(/xp-asset:\/\/[A-Za-z0-9_-]+/g) || []).forEach(function (t) {
      var id = t.slice('xp-asset://'.length);
      if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
    });
    if (!ids.length) return Promise.resolve(value);
    return rpc('asset.bytes', { ids: ids }).then(function (map) {
      // 映射不完整 = 显式错误：绝不把含死 xp-asset 引用的场景静默交给插件
      var missing = ids.filter(function (id) { return !(map && map[id] && map[id].bytes != null); });
      if (missing.length) throw new Error('场景恢复失败：' + missing.length + ' 个引用素材的字节缺失（' + missing.join(', ') + '）');
      Object.keys(map).forEach(function (id) {
        var rec = map[id];
        var u = origCreateObjectURL(new Blob([rec.bytes], { type: rec.mime }));
        blobTokens.set(u, id);   // 恢复出的本地 URL 与令牌同源绑定：再次保存直接令牌化，不重复托管
        text = text.split('xp-asset://' + id).join(u);
      });
      return typeof value === 'string' ? text : JSON.parse(text);
    });
  }

  function toResource(item) {
    if (item && item.bytes) {
      var blob = new Blob([item.bytes], { type: item.mime || 'application/octet-stream' });
      var url = origCreateObjectURL(blob);   // 桥接素材：直接用原函数，不重复托管
      if (item.assetId) blobTokens.set(url, item.assetId);
      item.url = url; item.resourcePath = url; item.path = url;
      delete item.bytes;
    }
    return item;
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.ns !== NS) return;
    if (e.source !== parent || e.origin !== expectedParent) return;   // 严格父源校验
    if (d.nonce !== meta.nonce) return;                               // 所有父→子消息必须携带会话 nonce
    if (d.kind === 'init') {
      if (inited) return; inited = true;
      Object.assign(meta, d.payload || {});
      readyResolve(meta);
      fire(subs.appChange, { locale: meta.locale, theme: meta.theme, region: meta.region });
      return;
    }
    if (d.kind === 'rpc-res') {
      var p = pending.get(d.id); if (!p) return; pending.delete(d.id);
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'host error')); return;
    }
    if (d.kind === 'event') {
      var list = d.name === 'run' ? subs.run : d.name === 'incoming-change' ? subs.incoming : d.name === 'config-change' ? subs.configChange : subs.appChange;
      fire(list, d.payload); return;
    }
    if (d.kind === 'invoke' && agentHandler) {
      Promise.resolve()
        .then(function () { return agentHandler({ method: d.method, args: d.args || {} }); })
        .then(function (r) { post({ kind: 'invoke-res', id: d.id, ok: true, result: r }); })
        .catch(function (err) { post({ kind: 'invoke-res', id: d.id, ok: false, error: String(err && err.message || err) }); });
    }
  });

  window.hub = {
    ready: ready,
    onRun: function (cb) { subs.run.push(cb); return function () { subs.run = subs.run.filter(function (x) { return x !== cb; }); }; },
    app: {
      onChange: function (cb) { subs.appChange.push(cb); if (inited) cb({ locale: meta.locale, theme: meta.theme, region: meta.region }); return function () { subs.appChange = subs.appChange.filter(function (x) { return x !== cb; }); }; },
      get locale() { return meta.locale; }, get theme() { return meta.theme; }, get region() { return meta.region; },
    },
    canvas: {
      getCurrentNodeId: function () { return meta.nodeId; },   // 原版同步调用，必须返回字符串
      getIncomingResources: function (args) {
        return rpc('canvas.getIncomingResources', args || {}).then(function (items) { return (items || []).map(toResource); });
      },
      onIncomingChange: function (cb) { subs.incoming.push(cb); return function () { subs.incoming = subs.incoming.filter(function (x) { return x !== cb; }); }; },
      pickAsset: function (args) {
        return rpc('canvas.pickAsset', args || {}).then(function (items) { return (items || []).map(toResource); });
      },
      insertImageNode: function (args) { return exportRpc('canvas.insertImageNode', args); },
      insertVideoNode: function (args) { return exportRpc('canvas.insertVideoNode', args); },
      insertFileNode: function (args) { return exportRpc('canvas.insertFileNode', args); },
      get width() { return meta.width; }, get height() { return meta.height; },
    },
    storage: {
      get: function (key) { return rpc('storage.get', { key: key }).then(function (v) { return v == null ? v : detokenize(v); }); },
      set: function (key, value) {
        // 可恢复契约：值中引用的 blob: URL 必须全部完成托管并取得 xp-asset:// 令牌后才允许落盘；
        // 任一引用托管失败/不可用 → 拒绝本次保存，上一份可恢复存档不被坏数据覆盖。
        // 只等待本值实际引用的 embed——无关的进行中/已失败 embed 不会全局阻断保存。
        var refs = blobRefsOf(value);
        var waits = [];
        refs.forEach(function (u) { var p = embedPromises.get(u); if (p) waits.push(p); });
        return Promise.allSettled(waits).then(function () {
          var dead = refs.filter(function (u) { return !blobTokens.has(u); });
          if (dead.length) throw new Error('保存被拒绝：' + dead.length + ' 个场景引用的本地素材托管失败或不可用，无法生成可恢复的 xp-asset 引用（上一份可恢复存档已保留）');
          return rpc('storage.set', { key: key, value: tokenize(value) });
        });
      },
      onChange: function (cb) { subs.storageChange.push(cb); return function () { subs.storageChange = subs.storageChange.filter(function (x) { return x !== cb; }); }; },
    },
    config: {
      get: function (key) { return rpc('config.get', { key: key }); },
      set: function (key, value) { return rpc('config.set', { key: key, value: value }); },
      onChange: function (cb) { subs.configChange.push(cb); return function () { subs.configChange = subs.configChange.filter(function (x) { return x !== cb; }); }; },
    },
    files: {
      writeToPluginDir: function (a, b) {
        // 双签名：('name', Blob|bytes) 与原版实际使用的 ({path, source})
        var name, data;
        if (a && typeof a === 'object' && !(a instanceof Blob)) { name = a.path || a.name; data = a.source; }
        else { name = a; data = b; }
        // Blob 需先 resolve 成字节——postMessage 不能传递 Promise
        return Promise.resolve(data instanceof Blob ? data.arrayBuffer() : data)
          .then(function (bytes) {
            return rpc('files.writeToPluginDir', { name: name, bytes: bytes, mime: data && data.type })
              .then(function (res) {
                // 原 GLTF 加载器需要可用的 iframe 本地 URL：用原函数建 blob:，
                // 并映射到 assetId，composition 经 tokenize 可跨会话恢复
                var blob = data instanceof Blob ? data : new Blob([bytes], { type: (data && data.type) || 'application/octet-stream' });
                var u = origCreateObjectURL(blob);
                if (res && res.assetId) blobTokens.set(u, res.assetId);
                return { url: u, assetId: res && res.assetId, name: name };
              });
          });
      },
    },
    agent: {
      onInvoke: function (handler) { agentHandler = handler; return function () { agentHandler = null; }; },
      setEditorState: function (state) { return rpc('agent.setEditorState', { state: state }); },
    },
    ui: {
      notify: function (message, type) { return rpc('ui.notify', { message: message, type: type }); },
    },
    // 插件诊断日志：转发到 iframe 控制台（父页不收集、不落盘）
    log: function (level) {
      var args = [].slice.call(arguments, 1);
      try { (console[level] || console.log).apply(console, args); } catch (_) {}
    },
  };

  // 导出统一转字节：source 为 Blob/File → arrayBuffer；为 blob:/data: URL → 本 iframe 内 fetch 成字节。
  // postMessage 不能传 Promise，父页也不接受来历不明的字符串 URL。
  function exportRpc(method, args) {
    args = args || {};
    var src = args.source, mime = args.mime || (src && src.type) || undefined;
    var send = function (bytes, mt) {
      var out = {}; for (var k in args) out[k] = args[k];
      delete out.source; out.bytes = bytes; out.mime = mt || mime;
      return rpc(method, out);
    };
    if (src instanceof Blob) return src.arrayBuffer().then(function (b) { return send(b, src.type || mime); });
    if (typeof src === 'string' && (/^blob:/.test(src) || /^data:/.test(src)))
      return fetch(src).then(function (r) { return r.blob(); }).then(function (b) { return b.arrayBuffer().then(function (buf) { return send(buf, b.type || mime); }); });
    if (src instanceof ArrayBuffer) return send(src, mime);
    // TypedArray/DataView：只发视图自身范围——src.buffer 会把整个底层缓冲（含视图外字节）发出去
    if (ArrayBuffer.isView(src)) return send(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength), mime);
    return send(null, mime); // 其他形态交父页判定（会拒绝字符串 URL）
  }

  addEventListener('resize', function () { meta.width = innerWidth; meta.height = innerHeight; });
  addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !expectedParent) return;
    if (document.querySelector && document.querySelector('[role="dialog"],[aria-modal="true"]')) return;
    e.preventDefault();
    rpc('ui.close', {}).catch(function () {});
  });
  if (expectedParent) post({ kind: 'hello' });
  else readyResolve(meta); // 无父页宿主：本地预览模式，hub 退化为空实现
})();

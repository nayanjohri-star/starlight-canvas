// Keep one authoritative inspector form; only its placement changes. No cloned
// prompt fields, second submit handler or separate draft can diverge from it.
//
// Placement rules (stable by design):
//  · the floating editor hangs below the selected card (which drops its summary
//    rows while editing, so preview, ports and switch stay visible), horizontally
//    centred on it — it never flips to the left/right/above;
//  · typing, picking references and task updates only change its contents; its
//    position follows the node alone (pan/zoom/move);
//  · if the editor would not fit after the user clicks a node, the board is
//    panned once (after the pointer is released); the node header stays visible;
//  · "展开编辑" turns it into a large editor centred over the board.
const PREF_WIDTH = 640, PREF_HEIGHT = 580, MIN_HEIGHT = 220, COMFORT_HEIGHT = 400, GAP = 12;
const EXPANDED_WIDTH = 1000, EXPANDED_HEIGHT = 860, SETTLE_MS = 1500;

export function createNodeComposer({ board, store, box, closeButton }) {
  let node = null, pinned = false, expanded = false, frame = 0, previousSideWidth = null;
  let pendingPan = null, pointerDown = false, anchor = null, editingRoot = null, portGesture = false, fullCardFor = null, pressedNode = null;
  const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'composer-pin';
  pin.textContent = '固定到右侧'; pin.title = '在节点下方编辑 / 固定到右侧';
  closeButton.before(pin);
  let userSize = null, expandedSize = null, drag = null;
  try { const value = JSON.parse(localStorage.getItem('xp-composer-size')); if (Number.isFinite(value?.width) && Number.isFinite(value?.height)) userSize = { width: Math.max(420, Math.min(1200, value.width)), height: Math.max(MIN_HEIGHT, Math.min(1000, value.height)) }; } catch {}
  const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'composer-resize-handle';
  resize.textContent = '◢'; resize.title = '拖动调整编辑面板大小；方向键微调'; resize.setAttribute('aria-label', '调整编辑面板大小'); resize.hidden = true;
  document.getElementById('overlay-root').append(resize);
  function placeResize() {
    const r = box.getBoundingClientRect(); resize.style.left = `${r.right - 26}px`; resize.style.top = `${r.bottom - 26}px`;
  }
  function resizeTo(width, height) {
    const next = { width: Math.max(420, Math.min(1200, width)), height: Math.max(MIN_HEIGHT, Math.min(1000, height)) };
    if (expanded) { expandedSize = next; schedule(); return; }
    userSize = next;
    try { localStorage.setItem('xp-composer-size', JSON.stringify(userSize)); } catch {}
    schedule();
  }
  resize.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); const r = box.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, width: r.width, height: r.height };
    resize.setPointerCapture(e.pointerId);
  });
  resize.addEventListener('pointermove', e => { if (drag?.id === e.pointerId) resizeTo(drag.width + e.clientX - drag.x, drag.height + e.clientY - drag.y); });
  const stopResize = () => { drag = null; };
  resize.addEventListener('pointerup', stopResize); resize.addEventListener('pointercancel', stopResize); resize.addEventListener('lostpointercapture', stopResize);
  resize.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const r = box.getBoundingClientRect();
    resizeTo(r.width + (e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0), r.height + (e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0));
  });

  const boardArea = () => document.getElementById('board-wrap').getBoundingClientRect();
  function leftLimit(area) {
    const dock = document.getElementById('sidebar');
    const dockRight = dock && !dock.classList.contains('collapsed') && dock.getBoundingClientRect().width > 0 ? dock.getBoundingClientRect().right + 12 : area.left + 82;
    return Math.min(dockRight, area.right - 416);
  }
  // Keep the sticky submit row above the floating view bar whenever they share columns.
  function bottomLimit(area, left, width) {
    let limit = area.bottom - 16;
    const bar = document.getElementById('view-bar');
    if (bar && !bar.hidden && getComputedStyle(bar).display !== 'none') {
      const r = bar.getBoundingClientRect();
      if (r.width && r.left < left + width && r.right > left) limit = Math.min(limit, r.top - 10);
    }
    return limit;
  }
  function setBox(left, top, width, maxHeight, height = null) {
    box.style.width = `${width}px`; box.style.minWidth = `${width}px`;
    box.style.left = `${left}px`; box.style.top = `${top}px`; box.style.maxHeight = `${maxHeight}px`;
    if (height == null) box.style.removeProperty('height'); else box.style.height = `${height}px`;
  }
  function clearFloating() {
    for (const p of ['left', 'top', 'max-height', 'height', 'visibility']) box.style.removeProperty(p);
    board.minimapAvoid?.(null);
  }
  function syncExpandButtons(on) {
    for (const b of box.querySelectorAll('.composer-expand')) b.setAttribute('aria-pressed', String(on));
  }

  function update() {
    frame = 0;
    const eligible = node && store.node(node.id) === node && ['gen', 'image', 'text'].includes(node.type);
    const wide = innerWidth > 1100;
    const big = !!(eligible && expanded && wide);
    const floating = !!(eligible && !pinned && wide) || big;
    resize.hidden = !floating || box.classList.contains('collapsed');
    if (floating && !box.classList.contains('node-composer')) previousSideWidth = box.style.width || '360px';
    if (!floating && box.classList.contains('node-composer')) { box.style.width = previousSideWidth; box.style.minWidth = previousSideWidth; }
    box.classList.toggle('node-composer', floating);
    box.classList.toggle('composer-expanded', big);
    syncExpandButtons(big);
    pin.hidden = !eligible || !wide;   // 窄屏没有浮动编辑器，固定/跟随不适用
    pin.textContent = pinned ? '跟随节点' : '固定到右侧'; pin.setAttribute('aria-pressed', String(pinned));
    document.getElementById('inspector-resizer')?.classList.toggle('composer-resizer-hidden', floating);
    // While the editor floats below a card, the card drops its summary rows
    // (the editor shows them) so the editor can sit below the whole card without
    // covering its preview, ports or switch. The card is compacted only after the
    // pointer is released — the click that selected it has been delivered, so no
    // button or port moves under the pointer mid-click — and not at all when the
    // node was selected by pressing one of its ports (wiring) until the next click.
    const cardRoot = floating && !big ? document.querySelector(`.node[data-node="${CSS.escape(node.id)}"]`) : null;
    const keepFull = !!cardRoot && node.id === fullCardFor;
    const compactRoot = cardRoot && !keepFull && (editingRoot === cardRoot || !pointerDown) ? cardRoot : null;
    if (editingRoot !== compactRoot) {
      // A compacted card keeps reporting its full height (data-full-height) to placement and
      // arrangement, so nodes added meanwhile never land where the card expands back to.
      if (editingRoot) { editingRoot.classList.remove('composer-editing'); delete editingRoot.dataset.fullHeight; }
      if (compactRoot) { compactRoot.dataset.fullHeight = String(compactRoot.offsetHeight || ''); compactRoot.classList.add('composer-editing'); }
      // Re-measure the compacted card; after the first selection there is no settling window.
      if (compactRoot && anchor?.id === node.id) anchor = { id: node.id, height: 0, at: -Infinity, remeasure: true };
      editingRoot = compactRoot;
    }
    if (!floating) { clearFloating(); return; }
    const area = boardArea(), minX = leftLimit(area);
    if (big) {
      const width = Math.min(expandedSize?.width ?? EXPANDED_WIDTH, area.right - minX - 24);
      const top = area.top + 16;
      const height = Math.max(MIN_HEIGHT, Math.min(expandedSize?.height ?? EXPANDED_HEIGHT, bottomLimit(area, minX, area.right - minX) - top));
      setBox(minX + (area.right - minX - width) / 2, top, width, height, height);
      box.dataset.composerNode = node.id;
      board.minimapAvoid?.(box.getBoundingClientRect());
      placeResize();
      return;
    }
    const root = cardRoot;
    if (!root) return;
    // Still waiting for the pointer to be released before compacting: stay hidden
    // instead of showing the editor at a position that is about to change.
    const waiting = !keepFull && compactRoot !== cardRoot;
    if (waiting) { box.style.visibility = 'hidden'; return; }
    box.style.removeProperty('visibility');
    const rect = root.getBoundingClientRect();
    // The editor hangs below the whole (compact) card, so the card's preview,
    // ports and switch stay visible and clickable. The offset is fixed in board
    // units when the node is selected and may only grow during a short settling
    // window (a status row or preview still loading); afterwards typing, picking
    // media and status updates never move the editor. When space is short the
    // editor gets shorter: its content scrolls and the submit row stays pinned.
    const scale = board.view.scale || 1;
    const width = Math.min(userSize?.width ?? PREF_WIDTH, area.right - minX - 32);
    const left = Math.max(minX, Math.min(rect.left + rect.width / 2 - width / 2, area.right - width - 16));
    const limit = bottomLimit(area, left, width);
    const now = performance.now();
    if (anchor?.id !== node.id) anchor = { id: node.id, height: rect.height / scale, at: now };
    else if (anchor.remeasure) anchor = { id: node.id, height: rect.height / scale, at: -Infinity };
    else if (now - anchor.at < SETTLE_MS && rect.height / scale > anchor.height) anchor.height = rect.height / scale;
    // The submit row must stay visible: when less than the minimum height is left
    // below the card, rise just enough — never above the node header, so the
    // editor stays attached to its node.
    const headBottom = root.querySelector('.node-head')?.getBoundingClientRect().bottom ?? rect.top;
    const below = rect.top + anchor.height * scale + GAP;
    const top = keepFull ? below : userSize ? Math.max(area.top + 64, Math.min(below, limit - userSize.height)) : Math.max(headBottom, Math.min(below, limit - MIN_HEIGHT));
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(userSize?.height ?? PREF_HEIGHT, limit - top));
    setBox(left, top, width, maxHeight, userSize ? maxHeight : null);
    placeResize();
    box.dataset.composerNode = node.id;
    // One-time pan for a node selected by clicking it (not while wiring from a
    // port): make room for the editor without moving it away from the node and
    // without hiding the node header under the selection bar. Waits until the
    // pointer is up so it cannot disturb a drag.
    if (pendingPan === node.id && !pointerDown) {
      pendingPan = null;
      // Scroll only as far as needed for a comfortable editor, not its full height.
      const needed = Math.min(COMFORT_HEIGHT, box.scrollHeight || COMFORT_HEIGHT);
      const overflow = below + needed - limit;
      const shift = Math.min(overflow, rect.top - (area.top + 64));
      if (overflow > 0 && shift > 8) {
        board.view.y -= shift; board.applyView();
        return;   // applyView → onViewChange → schedule(): repositions from the new node rect
      }
    }
    board.minimapAvoid?.(box.getBoundingClientRect());
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  pin.addEventListener('click', () => {
    pinned = !pinned;
    if (pinned) { box.style.width = '380px'; box.style.minWidth = '380px'; expanded = false; }
    schedule();
  });
  box.addEventListener('composer-expand', () => { expanded = !expanded; schedule(); });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape' && expanded && !e.defaultPrevented && !e.isComposing) { e.stopPropagation(); expanded = false; schedule(); }
  });
  // A gesture that starts on a port (wiring) never pans the board or compacts the
  // card: nothing may shift under the pointer while the user connects nodes.
  const down = e => {
    pointerDown = true; portGesture = !!e.target?.closest?.('.port, .dot');
    pressedNode = e.target?.closest?.('.node[data-node]')?.dataset.node ?? null;
    if (portGesture) pendingPan = null;
    else if (fullCardFor) { if (fullCardFor === node?.id) pendingPan = node.id; fullCardFor = null; }   // now really selected: make room once
  };
  const up = () => { if (pointerDown) { pointerDown = false; schedule(); } };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  const offView = board.onViewChange(schedule);
  const offStore = store.onChange(schedule);
  window.addEventListener('resize', schedule);
  const size = new ResizeObserver(schedule); size.observe(document.getElementById('board-wrap')); size.observe(box);
  return {
    setNode(next) {
      if (next?.id !== node?.id) {
        // Scroll only when the user clicked this node itself; creating, focusing from the task list or
        // selecting in code never moves the canvas (repeated additions would otherwise keep scrolling it).
        pendingPan = !portGesture && next && pressedNode === next.id ? next.id : null;
        fullCardFor = portGesture ? next?.id ?? null : null;   // selection may land on the click after release
        anchor = null; if (!next) expanded = false;
      }
      node = next; if (!node) delete box.dataset.composerNode; schedule();
    },
    get expanded() { return expanded; },
    destroy() {
      resize.remove();
      offView(); offStore(); size.disconnect(); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
    },
  };
}

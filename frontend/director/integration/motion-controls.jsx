// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
export function MotionControls({ context, announce, disabled }) {
  const [open, setOpen] = useState(false), [preset, setPreset] = useState('walk');
  const [sourceUp, setSourceUp] = useState('Y'), [unitScale, setUnitScale] = useState(1);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const lock = useRef({ disabled: false, busy: false, mounted: true, epoch: 0 });
  if (disabled && !lock.current.disabled) lock.current.epoch++;
  lock.current.disabled = !!disabled;
  useEffect(() => { lock.current.mounted = true; return () => { lock.current.mounted = false; lock.current.epoch++; }; }, []);
  const blocked = () => lock.current.disabled || lock.current.busy || !lock.current.mounted;
  const locked = !!disabled || busy;
  async function perform(callback) {
    if (blocked()) return;
    const epoch = lock.current.epoch;
    lock.current.busy = true; setBusy(true);
    try { await callback(epoch); }
    catch (error) { if (lock.current.mounted) { setMessage(error.message); announce(error.message, true); } }
    finally { lock.current.busy = false; if (lock.current.mounted) setBusy(false); }
  }
  async function run(id, args, epoch) {
    if (lock.current.disabled || !lock.current.mounted || epoch !== lock.current.epoch)
      throw new Error('导出期间动作修改已暂停，请完成后重新导入或应用。');
    let result = await context.bus.run(id, args);
    if (result.ok && result.status === 'started' && result.jobId)
      result = await context.bus.run('job.await', { jobId: result.jobId, timeoutMs: 120000 });
    if (!result.ok) throw new Error(result.message || result.code || '动作未应用');
    if (!lock.current.mounted) return;
    setMessage('动作已应用，可撤销。路径修改后重新应用预设以更新走位。');
    announce('已应用所选人物的动作');
  }
  async function importFile(file) {
    if (!file) return;
    return perform(async epoch => {
      if (file.size > 30 * 1024 * 1024) { setMessage('动画超过30 MiB，请减少帧数后导入'); return; }
      const format = file.name.split('.').at(-1).toLowerCase();
      const args = { characterId: context.live.state.activeCharacterId, format, fps: context.live.state.timeline.fps,
        sourceUp, unitScale: Number(unitScale) };
      const text = format === 'bvh'; let source;
      if (text) source = await file.text();
      else {
        const bytes = new Uint8Array(await file.arrayBuffer()); let data = '';
        for (let at = 0; at < bytes.length; at += 32768) data += String.fromCharCode(...bytes.subarray(at, at + 32768));
        source = btoa(data);
      }
      await run('motion.importAnimation', { ...args, source, encoding: text ? 'text' : 'base64' }, epoch);
    });
  }
  return <><button data-testid="hosted-director-motion" disabled={locked} onClick={() => { if (!blocked()) setOpen(!open); }}>动作与导入</button>
    {open && <section className="hosted-gen-panel" aria-label="离线动作与兼容动画导入">
      <header><strong>所选人物的动作</strong><button onClick={() => setOpen(false)}>关闭</button></header>
      <p>原创动作在浏览器生成，不调用模型。先在走位轨道设置路径、速度与停顿，再应用行走。</p>
      <label>基本动作<select disabled={locked} value={preset} onChange={event => { if (!blocked()) setPreset(event.target.value); }}>
        <option value="idle">站立呼吸</option><option value="walk">行走</option><option value="wave">挥手</option>
      </select></label>
      <button data-testid="motion-apply-preset" disabled={locked} onClick={() => void perform(epoch => run('motion.applyPreset', {
        characterId: context.live.state.activeCharacterId, preset, frames: context.live.state.timeline.frameCount,
        fps: context.live.state.timeline.fps, usePath: true,
      }, epoch))}>应用到当前时长</button>
      <p>BVH、FBX 须有兼容骨架。NPZ 须为 canonical Y-up 米制；不支持的骨骼会列出缺失映射。</p>
      <label>来源向上轴<select disabled={locked} value={sourceUp} onChange={event => { if (!blocked()) setSourceUp(event.target.value); }}><option value="Y">Y-up</option><option value="Z">Z-up</option></select></label>
      <label>来源坐标转为米的倍率<input disabled={locked} type="number" min="0.0001" max="10000" step="0.01" value={unitScale} onChange={event => { if (!blocked()) setUnitScale(event.target.value); }} /></label>
      <label>导入动画<input data-testid="motion-import-file" disabled={locked} type="file" accept=".bvh,.fbx,.npz" onChange={event => {
        if (blocked()) return;
        const file = event.target.files?.[0]; event.target.value = ''; void importFile(file).catch(error => { setMessage(error.message); announce(error.message, true); });
      }} /></label>
      <p role="status">{message}</p>
    </section>}
  </>;
}

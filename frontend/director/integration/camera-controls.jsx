// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { quantizeDuration } from '../src/frame-clock.js';
import { normalizeFocus } from '../src/camera-focus.js';

export function CameraControls({ context, ports, announce, disabled }) {
  const [open, setOpen] = useState(false), [name, setName] = useState('新机位');
  const [busy, setBusy] = useState(false);
  const lock = useRef({ disabled: false, busy: false, mounted: true });
  lock.current.disabled = !!disabled;
  useEffect(() => { lock.current.mounted = true; return () => { lock.current.mounted = false; }; }, []);
  const blocked = () => lock.current.disabled || lock.current.busy || !lock.current.mounted;
  const locked = !!disabled || busy;
  const live = context.live.state, owner = ports.shotsDomain, doc = owner.authoringDocument();
  const library = doc.cameraLibrary, active = library.cameras.find(camera => camera.id === library.activeCameraId);
  const [seconds, setSeconds] = useState(String(live.timeline.frameCount / live.timeline.fps));
  const focus = normalizeFocus(owner.state().camera ?? live.shots.find(shot => shot.id === live.activeShotId)?.camera);
  const run = async (id, args) => {
    if (lock.current.disabled || !lock.current.mounted) throw new Error('当前正在导出，机位修改已暂停，请完成后重试。');
    const receipt = await context.bus.run(id, args);
    if (!receipt.ok) throw new Error(receipt.message || receipt.code || '操作失败');
    return receipt;
  };
  const action = callback => () => Promise.resolve().then(async () => {
    if (blocked()) return;
    lock.current.busy = true; setBusy(true);
    try { return await callback(); }
    catch (error) { if (lock.current.mounted) announce(error.message, true); }
    finally { lock.current.busy = false; if (lock.current.mounted) setBusy(false); }
  });
  return <><button data-testid="hosted-director-camera-controls" disabled={locked} onClick={() => { if (!blocked()) setOpen(!open); }}>机位与时间</button>
    {open && <section className="hosted-gen-panel" aria-label="机位与时间">
      <header><strong>机位与时间</strong><button onClick={() => setOpen(false)}>关闭</button></header>
      <label>帧率<select data-testid="director-fps" disabled={locked} value={live.timeline.fps} onChange={event => {
        const fps = Number(event.target.value); action(async () => { await run('shot.setFps', { fps });
          announce(quantizeDuration(live.timeline.frameCount / live.timeline.fps, fps).message); })();
      }}><option value={24}>24 fps</option><option value={30}>30 fps</option></select></label>
      <label>时间轴秒数<input data-testid="director-seconds" disabled={locked} type="number" min="1" max="30" step="0.01" value={seconds} onChange={event => { if (!blocked()) setSeconds(event.target.value); }} /></label>
      <button data-testid="director-apply-duration" disabled={locked} onClick={action(async () => {
        const feedback = quantizeDuration(Number(seconds), live.timeline.fps);
        await run('shot.setDuration', { seconds: Number(seconds) }); announce(feedback.message);
      })}>应用时长</button><p>当前 {live.timeline.frameCount} 帧 · {(live.timeline.frameCount / live.timeline.fps).toFixed(6)} 秒。镜头范围可在时间轴单独调整。</p>
      <label>输出分辨率<select data-testid="director-resolution" disabled={locked} value={ports.outputResolution} onChange={event => { if (!blocked()) ports.setOutputResolution(Number(event.target.value)); }}><option value={1080}>1080p</option><option value={720}>720p</option></select></label>
      <label>机位<select data-testid="director-camera-library" disabled={locked} value={library.activeCameraId ?? ''} onChange={event => {
        const cameraId = event.target.value; action(() => run('shot.selectCamera', { cameraId }))();
      }}>
        {!library.cameras.length && <option value="">暂无机位</option>}{library.cameras.map(camera => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
      </select></label>
      <label>机位名称<input disabled={locked} value={name} onChange={event => { if (!blocked()) setName(event.target.value); }} /></label>
      <div className="hosted-control-actions">
        <button disabled={locked} onClick={action(() => run('shot.saveCamera', { name }))}>保存当前取景为新机位</button>
        <button disabled={locked || !active} onClick={action(() => run('shot.saveCamera', { name: name || active.name, cameraId: active.id }))}>更新所选机位</button>
        <button disabled={locked || !active} onClick={action(() => run('shot.duplicateCamera', { cameraId: active.id }))}>复制机位</button>
        <button disabled={locked || !active} onClick={action(() => run('shot.removeCamera', { cameraId: active.id }))}>删除机位</button>
        <button disabled={locked || !active || !live.activeShotId} onClick={action(() => run('shot.bindCamera', { cameraId: active.id, shotId: live.activeShotId }))}>绑定当前镜头</button>
      </div>
      <label>焦平面距离（米）<input disabled={locked} type="number" min="0.05" max="10000" step="0.1" defaultValue={focus.focusDistance} key={`distance-${focus.focusDistance}`} onBlur={event => {
        const focusDistance = Number(event.target.value); action(() => run('shot.setFocus', { focusDistance }))();
      }} /></label>
      <label>光圈 f 值<input disabled={locked} type="number" min="0.7" max="32" step="0.1" defaultValue={focus.fStop} key={`aperture-${focus.fStop}`} onBlur={event => {
        const fStop = Number(event.target.value); action(() => run('shot.setFocus', { fStop }))();
      }} /></label>
      <label><input disabled={locked} type="checkbox" checked={focus.depthOfField} onChange={event => {
        const depthOfField = event.target.checked; action(() => run('shot.setFocus', { depthOfField }))();
      }} />在成片视角和导出中启用景深</label>
      <p>机位、对焦和时间轴修改均可撤销。自由编辑视角独立于成片机位。</p>
    </section>}
  </>;
}

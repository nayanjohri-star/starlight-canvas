// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { beginProposalPreview } from './proposal-preview.js';

export function ProposalControls({ session, getContext, persist, checkpoint, appContext, announce, disabled, onPreviewState }) {
  const models = session.textModels ?? [];
  const [open, setOpen] = useState(false), [kind, setKind] = useState('camera');
  const [model, setModel] = useState(models[0]?.id ?? ''), [instruction, setInstruction] = useState('');
  const [quote, setQuote] = useState(null), [proposal, setProposal] = useState(null);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null), previewRef = useRef(null);
  const lock = useRef({ disabled: false, pending: false, mounted: true, epoch: 0 });
  if (disabled && !lock.current.disabled && !previewRef.current) lock.current.epoch++;
  lock.current.disabled = !!disabled;
  const blocked = (allowPreview = false) => !lock.current.mounted || lock.current.pending
    || (!!previewRef.current && !allowPreview) || (lock.current.disabled && !previewRef.current);
  const fieldsBlocked = () => blocked() || lock.current.disabled;
  const actionsLocked = pending || (disabled && !preview);
  const discard = () => {
    const owned = previewRef.current;
    owned?.transaction.discard(); previewRef.current = null;
    setPreview(null); if (owned) onPreviewState(false);
  };
  useEffect(() => { lock.current.mounted = true; return () => {
    lock.current.mounted = false; lock.current.epoch++;
    if (previewRef.current) { previewRef.current.transaction.discard(); previewRef.current = null; onPreviewState(false); }
  }; }, []);
  const act = (callback, allowPreview = false) => async () => {
    if (blocked(allowPreview)) return;
    const epoch = lock.current.epoch;
    lock.current.pending = true; setPending(true);
    const check = () => {
      if (!lock.current.mounted || epoch !== lock.current.epoch || (lock.current.disabled && !(allowPreview && previewRef.current)))
        throw new Error('当前正在导出，提案操作已暂停，请完成后重试。');
    };
    try { await callback(check); }
    catch (error) { if (lock.current.mounted) { setMessage(error.message); announce(error.message, true); } }
    finally { lock.current.pending = false; if (lock.current.mounted) setPending(false); }
  };
  const prepare = async check => {
    const saved = await persist(); saved.check(); check();
    return { record: saved.record, check: saved.check, context: getContext(), checkpoint: checkpoint() };
  };
  return <><button disabled={disabled || pending} data-testid="hosted-director-proposals" onClick={act(async check => {
    if (open) { setOpen(false); return; }
    setOpen(true); const current = await prepare(check); current.check();
    const status = await session.client.request('proposal.status', { sceneRevision: current.record.rev, context: current.context });
    current.check(); check();
    if (status.proposal) setProposal(status.proposal);
    setMessage(status.blocked ? '上一笔提案请求结果未确认，已阻止重复调用。请在站点核对该笔账单。' : '填写要求后先查看本站报价，确认后才会调用模型。');
  })}>AI 运镜与动作</button>
    {open && <section className="hosted-gen-panel" aria-label="AI 运镜与动作提案">
      <header><strong>AI 运镜与动作提案</strong><button disabled={pending} onClick={() => { if (lock.current.pending || !lock.current.mounted) return; discard(); setOpen(false); }}>关闭</button></header>
      <fieldset disabled={Boolean(preview) || pending || disabled}>
      <label>提案类型<select value={kind} onChange={event => { if (fieldsBlocked()) return; setKind(event.target.value); setQuote(null); setConfirmed(false); }}><option value="camera">运镜与构图</option><option value="motion">人物姿态与走位</option></select></label>
      <label>本站文本模型<select value={model} onChange={event => { if (fieldsBlocked()) return; setModel(event.target.value); setQuote(null); setConfirmed(false); }}>
        {!models.length && <option value="">当前账号没有已验证文本模型</option>}{models.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
      </select></label>
      <label>你的要求<textarea value={instruction} onChange={event => { if (fieldsBlocked()) return; setInstruction(event.target.value); setQuote(null); setConfirmed(false); }} placeholder="例如：保持人物描述，为当前镜头设计从侧面推近的运镜" /></label>
      <button data-testid="proposal-quote" disabled={actionsLocked || !model || !instruction.trim()} onClick={act(async check => {
        const current = await prepare(check); current.check(); setProposal(null);
        const result = await session.client.request('proposal.quote', { kind, model, instruction,
          sceneRevision: current.record.rev, context: current.context });
        current.check(); check();
        setQuote({ ...result, check: current.check, checkpoint: current.checkpoint }); setConfirmed(false); setMessage(result.price.label);
      })}>查看预计费用</button>
      {quote && <><p>{quote.price.label}</p><label><input type="checkbox" checked={confirmed} disabled={!quote.canRequest} onChange={event => { if (!fieldsBlocked()) setConfirmed(event.target.checked); }} />我确认按此报价主动调用一次文本模型</label>
        <button data-testid="proposal-request" disabled={actionsLocked || !quote.canRequest || !confirmed} onClick={act(async check => {
          if (checkpoint() !== quote.checkpoint) throw new Error('场景已有修改，请重新查看报价');
          quote.check();
          const result = await session.client.request('proposal.request', { quoteId: quote.quoteId, confirmed: true });
          quote.check(); check();
          setProposal(result); setQuote(null); setConfirmed(false); setMessage('提案已返回，检查下方操作再应用。撤销不再调用模型。');
        })}>生成提案</button></>}
      </fieldset>
      <p role="status">{message}</p>
      {proposal && <><p>{proposal.reply}</p><ol>{proposal.commands.map((command, index) => <li key={index}><code>{command.id}</code><pre>{JSON.stringify(command.args, null, 2)}</pre></li>)}</ol>
        {proposal.rejected?.length > 0 && <p>拒绝的操作：{proposal.rejected.map(row => row.reason ?? row.message ?? String(row)).join('；')}</p>}
        <details><summary>模型原始回复</summary><pre>{proposal.rawText}</pre></details>
        {!preview && <button data-testid="proposal-preview" disabled={actionsLocked || !proposal.commands.length} onClick={act(async check => {
          const current = await prepare(check); current.check();
          const status = await session.client.request('proposal.status', { proposalId: proposal.proposalId,
            sceneRevision: current.record.rev, context: current.context });
          current.check(); check();
          if (!status.canApply || checkpoint() !== current.checkpoint) throw new Error('场景或提案已改变，未应用任何修改');
          onPreviewState(true);
          try {
            const value = { transaction: beginProposalPreview(appContext, proposal.commands), base: current };
            previewRef.current = value; setPreview(value);
          } catch (error) { onPreviewState(false); throw error; }
          setMessage('场景正在显示提案预览，尚未保存。确认应用或返回原场景。');
        })}>在场景中预览</button>}
        {preview && <><button data-testid="proposal-apply" disabled={pending} onClick={act(async check => {
          const status = await session.client.request('proposal.status', { proposalId: proposal.proposalId,
            sceneRevision: preview.base.record.rev, context: preview.base.context });
          check();
          if (!status.canApply) { discard(); throw new Error('场景修订已改变，预览已撤回'); }
          preview.transaction.apply(); previewRef.current = null; setPreview(null); onPreviewState(false);
          setProposal(null); await persist(); announce('提案已应用并保存，可一次撤销整批修改');
          setMessage('修改已应用，没有再次调用模型。');
        }, true)}>应用当前预览</button>
        <button data-testid="proposal-discard-preview" disabled={pending} onClick={() => { if (blocked(true)) return; discard(); setMessage('已返回原场景，提案仍可再次预览。'); }}>返回原场景</button></>}
        <button disabled={actionsLocked} onClick={() => { if (blocked(true)) return; discard(); setProposal(null); setMessage('提案已放弃，工程未改变。'); }}>放弃提案</button></>}
    </section>}
  </>;
}

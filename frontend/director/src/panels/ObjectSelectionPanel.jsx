import { useState } from 'react';
import { ko } from '../locale.js';
import { objectLockOwner } from '../scene-objects.js';
import { selectionHasLockedObjects } from '../object-selection.js';
import Foldout from './Foldout.jsx';

export function ObjectSelectionActions({ objects, selected, activeId, onAction, prefix = 'hierarchy-multiselect' }) {
	if (!selected.length) return null;
	const ids = selected.map(object => object.id);
	const locked = selectionHasLockedObjects(objects, ids);
	const subtreeLocked = selectionHasLockedObjects(objects, ids, true);
	const ownLocked = selected.some(object => object.locked === true);
	const inheritedOnly = locked && !ownLocked;
	const allHidden = selected.every(object => object.hidden === true);
	return <div className="object-selection-actions" aria-label={ko('Selected object actions', '선택한 오브젝트 작업', '所选对象操作')}>
		<button type="button" data-testid={`${prefix}-group`} disabled={selected.length < 2 || locked} onClick={() => onAction('group', ids, { parent: activeId })} title={ko('Group under the active object; movement carries children', '활성 오브젝트 아래 그룹화; 이동 시 함께 움직임', '以活动对象为父对象分组；移动时带动子对象')}>{ko('Group', '그룹화', '分组')}</button>
		<button type="button" data-testid={`${prefix}-ungroup`} disabled={locked || !selected.some(object => object.parent)} onClick={() => onAction('ungroup', ids)}>{ko('Ungroup', '그룹 해제', '解除分组')}</button>
		<button type="button" data-testid={`${prefix}-lock`} aria-pressed={locked} disabled={inheritedOnly} title={inheritedOnly ? ko('Select the locked parent to unlock it', '잠긴 부모를 선택해 잠금 해제', '请先选择锁定的父对象并解锁') : undefined} onClick={() => onAction('lock', ids, { locked: !ownLocked })}>{ownLocked ? ko('Unlock', '잠금 해제', '解锁') : inheritedOnly ? ko('Parent locked', '부모 잠김', '父级已锁定') : ko('Lock', '잠금', '锁定')}</button>
		<button type="button" data-testid={`${prefix}-hide`} disabled={locked} onClick={() => onAction('hide', ids, { hidden: !allHidden })}>{allHidden ? ko('Show', '표시', '显示') : ko('Hide', '숨기기', '隐藏')}</button>
		<button type="button" data-testid={`${prefix}-duplicate`} disabled={subtreeLocked} title={ko('Duplicate selected objects and their group children', '선택한 오브젝트와 그룹 자식 복제', '复制所选对象及其组内子对象')} onClick={() => onAction('duplicate', ids)}>{ko('Duplicate', '복제', '复制')}</button>
		<button type="button" data-testid={`${prefix}-delete`} disabled={subtreeLocked} title={ko('Delete selected objects; unselected children return to Props', '선택 항목 삭제; 선택하지 않은 자식은 소품으로 이동', '删除所选对象；未选中的子对象回到道具根目录')} onClick={() => onAction('delete', ids)}>{ko('Delete', '삭제', '删除')}</button>
	</div>;
}

const emptyTransform = () => ({ translation: ['0', '0', '0'], rotation: ['0', '0', '0'], scale: ['1', '1', '1'] });

export default function ObjectSelectionPanel({ objects, selected, onAction }) {
	const [values, setValues] = useState(emptyTransform);
	const locked = selectionHasLockedObjects(objects, selected.map(object => object.id), true);
	if (selected.length < 2) return null;
	const labels = { translation: ko('Move by (m)', '이동량 (m)', '相对平移（米）'), rotation: ko('Rotate each by (°)', '개별 회전량 (°)', '各对象旋转增量（度）'), scale: ko('Scale each by', '개별 크기 배수', '各对象缩放倍数') };
	const apply = () => onAction('transform', selected.map(object => object.id), Object.fromEntries(
		Object.entries(values).map(([kind, fields]) => [kind, fields.map(value => value.trim() === '' ? NaN : Number(value))]),
	));
	const keyDown = event => {
		if (event.isComposing || event.nativeEvent?.isComposing) return;
		if (event.key === 'Enter' || event.key === 'Escape') {
			event.preventDefault(); event.stopPropagation();
			if (event.key === 'Enter') apply();
			else setValues(emptyTransform());
			event.currentTarget.select();
		}
	};
	return <Foldout title={ko('Selected objects', '선택한 오브젝트', '所选对象')}>
		<div data-testid="object-multiselect-transform">
			<p role="status">{ko(`${selected.length} objects selected`, `${selected.length}개 선택`, `已选择 ${selected.length} 个对象`)}{locked && ko(' — unlock before editing', ' — 편집 전에 잠금 해제', '，请先解锁再编辑')}</p>
			<p className="inspector-hint">{ko('The active object is the grouping parent. Move preserves spacing; rotation and scale apply to each selected object, without orbiting children.', '활성 오브젝트가 그룹 부모입니다. 이동은 간격을 유지하고 회전과 크기는 각 선택 항목에 적용됩니다.', '活动对象是分组父对象。平移保持间距；旋转和缩放分别应用于每个所选对象，不使子对象绕父对象旋转。')}</p>
			<fieldset disabled={locked} className="object-edit-fields">
				{Object.entries(labels).map(([kind, label]) => <div className="object-selection-vector" key={kind}>
					<label>{label}</label>
					<div>{['X', 'Y', 'Z'].map((axis, index) => <label key={axis}>
						<span>{axis}</span>
						<input
							type="number" step={kind === 'rotation' ? '1' : '0.05'} min={kind === 'scale' ? '0.1' : undefined}
							data-testid={`object-selection-${kind === 'translation' ? '' : `${kind}-`}${axis.toLowerCase()}`}
							aria-label={`${label} ${axis}`} value={values[kind][index]}
							onChange={event => setValues(current => ({ ...current, [kind]: current[kind].map((value, i) => i === index ? event.target.value : value) }))}
							onKeyDown={keyDown}
						/>
					</label>)}</div>
				</div>)}
				<button type="button" className="btn" data-testid="object-selection-transform-apply" onClick={apply}>{ko('Apply to selection', '선택 항목에 적용', '应用于所选对象')}</button>
			</fieldset>
			{selected.map(object => objectLockOwner(object, objects)).filter(Boolean).length > 0 && <p className="inspector-hint">{ko('Use the hierarchy Lock button to unlock the object or its parent.', '계층의 잠금 버튼으로 오브젝트 또는 부모의 잠금을 해제하세요.', '请使用对象树中的解锁按钮解除对象或其父对象的锁定。')}</p>}
		</div>
	</Foldout>;
}

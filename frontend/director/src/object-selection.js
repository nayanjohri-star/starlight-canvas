import {
	createSceneObject, createCutoutObject, createMeshObject, duplicateCutoutOptions, duplicateMeshOptions,
	CUTOUT_KIND, MESH_KIND, descendantsOf, isEffectivelyLocked, updateSceneObject,
	sceneObjectIdFromHierarchy,
} from './scene-objects.js';

// Selection is UI state only; the objects domain remains the document owner.
export function hierarchySelectionFor(selection, id, { toggle = false, range = false, visibleIds = [] } = {}) {
	if (!sceneObjectIdFromHierarchy(id)) return { activeId: id, objectIds: [], anchorId: id };
	const current = selection.objectIds ?? [];
	let ids;
	if (range) {
		const anchor = visibleIds.indexOf(selection.anchorId ?? selection.activeId), end = visibleIds.indexOf(id);
		const span = anchor < 0 || end < 0 ? [id] : visibleIds.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
		ids = toggle ? [...new Set([...current, ...span])] : span;
	} else if (toggle) ids = current.includes(id) ? current.filter(row => row !== id) : [...current, id];
	else ids = [id];
	return { activeId: ids.includes(id) ? id : ids.at(-1) ?? 'props', objectIds: ids, anchorId: range ? selection.anchorId ?? id : id };
}

export function selectedObjectRoots(objects, ids) {
	const selected = new Set(ids);
	return objects.filter(object => selected.has(object.id) && !objects.some(parent => selected.has(parent.id) && descendantsOf(objects, parent.id).some(child => child.id === object.id)));
}

export function selectionHasLockedObjects(objects, ids, includeChildren = false) {
	const chosen = objects.filter(object => ids.includes(object.id));
	return chosen.some(object => isEffectivelyLocked(object, objects) || (includeChildren && descendantsOf(objects, object.id).some(child => isEffectivelyLocked(child, objects))));
}

export function duplicateObjectSelection(objects, ids) {
	const roots = selectedObjectRoots(objects, ids);
	const included = new Set(roots.flatMap(object => [object.id, ...descendantsOf(objects, object.id).map(child => child.id)]));
	const sources = objects.filter(object => included.has(object.id));
	if (selectionHasLockedObjects(objects, [...included])) throw new Error('所选对象或组内对象已锁定，请先解锁再复制。');
	const mapping = new Map();
	let draft = [...objects];
	for (const source of sources) {
		const copy = source.renderer === CUTOUT_KIND ? createCutoutObject(duplicateCutoutOptions(source), draft)
			: source.renderer === MESH_KIND ? createMeshObject(duplicateMeshOptions(source), draft)
				: createSceneObject(source.renderer, draft);
		if (!copy) throw new Error('所选对象无法复制。');
		mapping.set(source.id, copy.id);
		draft.push({ ...source, id: copy.id, name: copy.name, locked: false });
	}
	draft = draft.map(object => {
		if (!sources.some(source => mapping.get(source.id) === object.id)) return object;
		return { ...object, parent: mapping.get(object.parent) ?? object.parent };
	});
	for (const root of roots) {
		const copyId = mapping.get(root.id);
		draft = updateSceneObject(draft, copyId, { x: root.x + 0.5 });
	}
	return { objects: draft, ids: ids.map(id => mapping.get(id)).filter(Boolean) };
}

// A batch uses the same command transaction as number scrubbing. Any refusal
// cancels the complete batch, and one successful user action owns one undo.
function updateTogether(run, updates) {
	if (!updates.length) return null;
	const { txId } = run('run.begin', { id: 'object.update', args: updates[0] });
	try {
		for (const args of updates) run('run.update', { txId, args });
		return run('run.commit', { txId });
	} catch (error) {
		try { run('run.cancel', { txId }); } catch { /* A rejected update already cancels its transaction. */ }
		throw error;
	}
}

export function runObjectSelectionAction(run, objects, ids, action, options = {}) {
	const selected = objects.filter(object => ids.includes(object.id));
	if (selected.length !== new Set(ids).size || !selected.length) throw new Error('对象选择已变化，请重新选择。');
	if (action === 'lock') return { receipt: run('object.lock', { ids, locked: options.locked }) };
	if (selectionHasLockedObjects(objects, ids)) throw new Error('所选对象已锁定，请先解锁它或其父对象。');
	if (action === 'group') {
		const parent = options.parent ?? ids.at(-1);
		const children = ids.filter(id => id !== parent);
		if (!children.length) throw new Error('请至少选择两个对象进行分组。');
		if (children.some(id => descendantsOf(objects, id).some(child => child.id === parent))) throw new Error('活动对象不能位于所选子对象内部，请重新选择父对象。');
		return { receipt: run('object.group', { parent, children }) };
	}
	if (action === 'ungroup') return { receipt: run('object.ungroup', { children: ids }) };
	if (action === 'delete') return { receipt: run('object.remove', { ids }), ids: [] };
	if (action === 'duplicate') {
		const copy = duplicateObjectSelection(objects, ids);
		return { receipt: run('objects.replace', { objects: copy.objects }), ids: copy.ids };
	}
	if (action === 'hide') {
		const hidden = options.hidden ?? !selected.every(object => object.hidden === true);
		return { receipt: updateTogether(run, selected.map(object => ({ id: object.id, patch: { hidden } }))) };
	}
	if (action === 'transform') {
		const roots = new Set(selectedObjectRoots(objects, ids).map(object => object.id));
		const { translation = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = options;
		if (![...translation, ...rotation, ...scale].every(Number.isFinite) || scale.some(value => value <= 0)) throw new Error('请输入有效数字，缩放倍数须大于零。');
		const updates = selected.map(object => {
			const patch = {};
			['x', 'y', 'z'].forEach((axis, i) => { if (roots.has(object.id) && translation[i]) patch[axis] = (object[axis] ?? 0) + translation[i]; });
			['rotX', 'rot', 'rotZ'].forEach((axis, i) => { if (rotation[i]) patch[axis] = (object[axis] ?? 0) + rotation[i]; });
			['scaleX', 'scaleY', 'scaleZ'].forEach((axis, i) => { if (scale[i] !== 1) patch[axis] = (object[axis] ?? 1) * scale[i]; });
			return { id: object.id, patch };
		}).filter(args => Object.keys(args.patch).length);
		return { receipt: updateTogether(run, updates) };
	}
	throw new Error('不支持该对象操作。');
}

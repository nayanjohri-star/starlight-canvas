import assert from 'node:assert/strict';
import { objectSelectionFixture as objectsFixture } from './object-selection-fixture.mjs';
import { hierarchySelectionFor, runObjectSelectionAction } from '../../src/object-selection.js';
import { isEffectivelyLocked, serializeScene, loadScene } from '../../src/scene-objects.js';

const rows = ['object:cube', 'object:sphere', 'object:chair'];
let selection = hierarchySelectionFor({ activeId: 'props', objectIds: [] }, rows[0]);
selection = hierarchySelectionFor(selection, rows[2], { toggle: true });
assert.deepEqual(selection.objectIds, [rows[0], rows[2]]);
assert.equal(selection.activeId, rows[2]);
selection = hierarchySelectionFor(selection, rows[0], { range: true, visibleIds: rows });
assert.deepEqual(selection.objectIds, rows);
selection = hierarchySelectionFor(selection, rows[1], { toggle: true });
assert.deepEqual(selection.objectIds, [rows[0], rows[2]]);
assert.deepEqual(hierarchySelectionFor(selection, 'camera').objectIds, []);
console.log('PASS hierarchy Ctrl/Cmd toggle, Shift visible range, active object and non-object clearing');

const changed = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.ok(receipt.undo?.historyEntryId, JSON.stringify(receipt)); return receipt; };
{
	const f = objectsFixture();
	try {
		const perform = (action, ids, options) => runObjectSelectionAction(f.objects.run, f.objects.read(), ids, action, options);
		const before = structuredClone(f.objects.read()), depth = f.objects.documentStore.depths().past;
		const translated = perform('transform', ['cube', 'sphere'], { translation: [2, 1, -1], rotation: [0, 15, 0], scale: [2, 1, 1] });
		changed(translated.receipt);
		assert.equal(f.objects.documentStore.depths().past, depth + 1);
		for (const id of ['cube', 'sphere']) {
			const object = f.objects.read().find(row => row.id === id);
			assert.deepEqual([object.x, object.y, object.z, object.rot, object.scaleX], [2, 1, -1, 15, 2]);
		}
		assert.equal(f.run('edit.undo', { receiptId: translated.receipt.receiptId }).status, 'undone');
		assert.deepEqual(f.objects.read(), before);
		const grouped = perform('group', ['cube', 'sphere'], { parent: 'sphere' });
		changed(grouped.receipt);
		assert.equal(f.objects.read().find(row => row.id === 'cube').parent, 'sphere');
		const travel = perform('transform', ['cube', 'sphere'], { translation: [1, 0, 0] });
		changed(travel.receipt);
		assert.deepEqual(f.objects.read().filter(row => ['cube', 'sphere'].includes(row.id)).map(row => row.x), [1, 1], 'selected parent/child travel only once');
		const copy = perform('duplicate', ['sphere']);
		changed(copy.receipt);
		const copiedParent = f.objects.read().find(row => row.id === copy.ids[0]);
		const copiedChild = f.objects.read().find(row => row.parent === copiedParent.id);
		assert.ok(copiedChild, 'group children are included in duplication');
		assert.deepEqual([copiedParent.x, copiedChild.x], [1.5, 1.5]);
		assert.equal(f.run('edit.undo', { receiptId: copy.receipt.receiptId }).status, 'undone');
		assert.equal(f.objects.read().length, 3);
		const hidden = perform('hide', ['cube', 'sphere'], { hidden: true });
		changed(hidden.receipt);
		assert.equal(f.objects.read().filter(row => row.hidden).length, 2);
		assert.equal(f.run('edit.undo', { receiptId: hidden.receipt.receiptId }).status, 'undone');
		assert.equal(f.objects.read().some(row => row.hidden), false);
		const deleted = perform('delete', ['cube', 'sphere']);
		changed(deleted.receipt);
		assert.deepEqual(f.objects.read().map(row => row.id), ['chair']);
		assert.equal(f.run('edit.undo', { receiptId: deleted.receipt.receiptId }).status, 'undone');
		assert.equal(f.objects.read().length, 3);
		console.log('PASS batch transform/hide/group-copy/delete: one undo each, exact restore, grouped translation without double travel');
	} finally { f.dispose(); }
}
{
	const f = objectsFixture();
	try {
		changed(f.run('object.group', { parent: 'sphere', children: ['cube'] }));
		const lock = changed(f.run('object.lock', { ids: ['sphere'], locked: true }));
		assert.equal(isEffectivelyLocked(f.objects.read().find(row => row.id === 'cube'), f.objects.read()), true);
		const hierarchy = f.renderPanel('Hierarchy', {
			selectedId: 'object:sphere', selectedIds: ['object:cube', 'object:sphere'],
			sceneObjects: f.objects.read(), onSelect() {}, onObjectAction() {},
		});
		assert.match(hierarchy, /role="tree" aria-multiselectable="true"/);
		assert.match(hierarchy, /data-node-id="object:sphere"[^>]*data-locked="true"[^>]*aria-selected="true"/);
		assert.match(hierarchy, /data-testid="hierarchy-multiselect-delete" disabled=""/);
		const transform = f.renderPanel('Transform', { ...f.objects, sceneObjects: f.objects.read(), selectedSceneObject: f.objects.read().find(row => row.id === 'cube') });
		assert.match(transform, /<fieldset[^>]*disabled=""[^>]*data-testid="object-transform-fields"/);
		assert.match(transform, /data-testid="object-locked-notice"/);
		const batch = f.renderPanel('Selection', { objects: f.objects.read(), selected: f.objects.read().filter(row => ['cube', 'sphere'].includes(row.id)), onAction() {} });
		assert.match(batch, /<fieldset[^>]*disabled=""/);
		const saved = structuredClone(f.objects.read()), depth = f.objects.documentStore.depths().past;
		const forbidden = [
			['object.update', { id: 'cube', patch: { x: 3 } }],
			['object.set', { id: 'cube', set: { rotation: { x: 0, y: 10, z: 0 } } }],
			['object.set', { id: 'sphere', set: { scale: 2 } }],
			['object.rename', { id: 'cube', name: 'No rename' }],
			['object.update', { id: 'cube', patch: { hidden: true } }],
			['object.remove', { ids: ['sphere'] }],
			['object.duplicate', { objectId: 'cube' }],
			['object.ungroup', { children: ['cube'] }],
			['object.group', { parent: 'sphere', children: ['chair'] }],
			['object.add', { kind: 'cone', parent: 'sphere' }],
			['object.update', { id: 'sphere', patch: { locked: false, x: 4 } }],
		];
		for (const [id, args] of forbidden) {
			const receipt = f.run(id, args);
			assert.equal(receipt.ok, false, id);
			assert.equal(receipt.code, 'TARGET_NOT_READY', JSON.stringify(receipt));
			assert.deepEqual(f.objects.read(), saved, id);
			assert.equal(f.objects.documentStore.depths().past, depth, id);
		}
		assert.equal(f.objects.canReparentSceneObject('object:cube', 'props'), false);
		assert.equal(f.run('edit.undo', { receiptId: lock.receiptId }).status, 'undone');
		assert.equal(isEffectivelyLocked(f.objects.read().find(row => row.id === 'cube'), f.objects.read()), false);
		changed(f.run('object.lock', { ids: ['sphere'], locked: true }));
		const restored = loadScene(serializeScene(f.objects.read()));
		assert.equal(restored.status, 'valid');
		f.objects.load(restored.objects);
		assert.equal(isEffectivelyLocked(f.objects.read().find(row => row.id === 'cube'), f.objects.read()), true);
		assert.equal(f.run('object.update', { id: 'cube', patch: { x: 3 } }).ok, false, 'restored parent lock is enforced');
		assert.equal(f.run('object.lock', { ids: ['cube'], locked: false }).ok, true);
		assert.equal(isEffectivelyLocked(f.objects.read().find(row => row.id === 'cube'), f.objects.read()), true, 'child unlock does not unlock parent');
		changed(f.run('object.lock', { ids: ['sphere'], locked: false }));
		changed(f.run('object.update', { id: 'cube', patch: { x: 3 } }));
		console.log('PASS persisted parent locks, all edit doors, explicit unlocking, undo and scene reload');
	} finally { f.dispose(); }
}
{
	const f = objectsFixture();
	try {
		changed(f.run('object.group', { parent: 'sphere', children: ['cube'] }));
		changed(f.run('object.lock', { ids: ['cube'], locked: true }));
		const before = structuredClone(f.objects.read()), depth = f.objects.documentStore.depths().past;
		assert.throws(() => runObjectSelectionAction(f.objects.run, f.objects.read(), ['chair', 'sphere'], 'transform', { translation: [1, 0, 0] }), /锁定/);
		assert.deepEqual(f.objects.read(), before, 'later locked descendant refusal rolls back earlier batch updates');
		assert.equal(f.objects.documentStore.depths().past, depth);
		console.log('PASS child lock prevents parent translation; refused batches are fully cancelled');
	} finally { f.dispose(); }
}

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createCommandBus } from '../../src/command-bus.js';
import { createStudioAppActions } from '../../src/commands/index.js';
import * as objectCommands from '../../src/commands/objects.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';
import { createSceneObject } from '../../src/scene-objects.js';
import { createAppContext } from '../../src/app-context.js';

// Exercise the shipped object hook, domain, registry and bus without loading
// App's unrelated motion/renderer fixtures or requiring retired model assets.
const source = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const carried = source.slice(source.indexOf('export const ATTACH_BONE_ROWS'), source.indexOf('export const CAMERA_MOVE_LABELS_KO'));
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
	optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', plugins: [{
		name: 'object-selection-without-renderer', enforce: 'pre', load(id) {
			if (id.endsWith('/src/app-stage.jsx')) return `import * as THREE from 'three';
				import { SCENE_ATTACH_BONES } from './scene-objects.js';
				import { TRAIL_EFFECTOR_JOINTS } from './motion-trail.js';
				import { normalizeBoneName } from './poses.js';
				${carried}
				export const HIERARCHY_INSPECTOR_TITLES = {};
				export const sceneObjectNameDisplayKo = name => name;
				export const sceneRendererLabelKo = name => name;`;
		},
	}] });
let useObjects, AppContext;
const panels = {};
try {
	({ useObjects } = await server.ssrLoadModule('/src/domains/objects.js'));
	({ AppContext } = await server.ssrLoadModule('/src/app-context.js'));
	panels.Hierarchy = (await server.ssrLoadModule('/src/hierarchy-panel.jsx')).default;
	panels.Transform = (await server.ssrLoadModule('/src/panels/ObjectTransformPanel.jsx')).default;
	panels.Selection = (await server.ssrLoadModule('/src/panels/ObjectSelectionPanel.jsx')).default;
}
finally { await server.close(); }

export function objectSelectionFixture() {
	let bus, objects;
	const initial = ['cube', 'sphere', 'chair'].map(kind => createSceneObject(kind));
	const app = createAppContext({ state: { current: { objects: initial } }, getBus: () => bus, notify() {} });
	const scope = app.forRender({ startupScene: { objects: initial }, selectedHierarchyId: 'object:cube',
		get animatedSceneObjects() { return objects?.read() ?? initial; }, characters: [],
		attachFrameRef: { current: null }, propWorldRef: { current: null },
		setSelectedHierarchyId() {}, setInspectorActionsOpen() {}, markCraftAction() {},
		charIdFromHierarchyId: () => null,
	});
	function Mount() { objects = useObjects(scope); return null; }
	renderToStaticMarkup(createElement(Mount));
	const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
	const registry = createStudioAppActions({ ...app.actionPorts,
		state: () => ({ objects: objects.read(), characters: [], activeSceneId: host.sceneId, selectedObjectId: 'cube' }),
		duplicateSelectedSceneObject: objects.duplicateSelectedSceneObject,
		attachSceneObject: objects.attachSceneObject,
	}, { objects: objectCommands });
	const journal = createStudioCommandJournal({ host }), receipts = new Map();
	bus = createCommandBus({ registry, ports: {
		read: () => ({ host, revision: objects.documentStore.getSnapshot().revision }), journal: () => journal,
		recordAction: (_kind, fn) => app.recordAction('objects', fn), beginAction: () => objects.beginAction(),
		remember: receipt => receipts.set(receipt.receiptId, receipt), receipt: id => receipts.get(id),
		history: redo => app.historyEntry(redo), isRetained: receipt => Boolean(app.storeDomainForReceipt(receipt)),
		canUndo: receipt => app.historyEntry() === receipt.undo?.historyEntryId,
		undo: () => objects.stepHistory(false), redo: () => objects.stepHistory(true),
	} });
	return { objects, run: (...args) => bus.run(...args),
		renderPanel(name, props) { return renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(panels[name], props))); },
		dispose() { bus.dispose(); objects.dispose(); } };
}

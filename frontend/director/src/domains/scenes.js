import { useRef, useState } from "react";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { createDocumentStore } from "../document-store.js";
import { useDocumentDomain } from "../store/use-document-store.js";
import {
	SCENES_STORAGE_KEY,
	readSceneDocument,
	serializeSceneDocument,
	SCENES_VERSION,
	migrateStageFrames,
	activeSceneIndex,
	createSceneDocument,
	createSceneStage,
	addScene,
	duplicateScene,
	renameScene,
	removeScene,
} from "../scenes.js";
import {
	loadProjectSession,
	loadWorkflowGraph,
	createProjectDocument,
	storeProjectSession,
	verifyEmbeddedAsset,
	hasFileSystemAccess,
	pickProjectFileForSave,
	writeProjectFile,
	rememberRecentProject,
	downloadProjectFallback,
	PROJECT_EXTENSION,
	normalizeWorkflowGraph,
	storeWorkflowGraph,
	pickProjectFileForOpen,
	readProjectFile,
	openProjectFallback,
	readProjectDocument,
	requestHandlePermission,
	createWorkflowGraph,
	clearStoredProjectHandle,
} from "../project.js";
import { playgroundSceneUrl, fetchSceneProject } from "../playground.js";
import { openAssetDb, referencedAssetIds, getAsset, putAsset } from "../scene-assets.js";
import { internWorkflowOutputs, workflowOutputRefs, resolveWorkflowOutputs } from "../workflow/workflow-resources.js";
import { encodeMotionResource, decodeMotionResource, sha256Hex } from "../motion-resources.js";
import { openMotionDb, putMotion, sweepMotions } from "../motion-store.js";
import { resourceManifest } from "../project-resources.js";
import { isKo, ko } from "../locale.js";
import { track, bucketCount, bucketProjectAge } from "../analytics.js";
import { mergeProjectCustomPoses } from "../project-poses.js";
import { DEFAULT_WORKSPACE_LAYOUT, DEFAULT_DURATION_S, TIMELINE_FPS } from "../app-stage.jsx";
import { saveCustomPoses } from "../poses.js";
import { readShotAuthoringDocument } from "../shot-authoring.js";
import { initialShots } from "../cuts.js";
import { createIkState } from "../ardy/ik.js";

// The scene list and project identity share one history. Dirty is derived from
// the saved checkpoint, not an authored edit, and has its own non-history slice.
export function createScenesDomain(appContext, initial, name) {
	const ordered = rows => rows.map((scene, order) => ({ ...scene, order }));
	let native = createDocumentStore({ owned: { scenes: ordered(initial.scenes), project: { name, activeSceneId: initial.activeSceneId } } });
	const listeners = new Set();
	const notify = () => { for (const listener of listeners) listener(); };
	let release = native.subscribe(notify);
	const documentStore = {
		...Object.fromEntries(Object.keys(native).map(key => [key, (...args) => native[key](...args)])),
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
	};
	const dirtyStore = createDocumentStore({ owned: { projectDirty: false } });
	const projectProjection = { documentEpoch: null, disposed: false, listeners: new Set() };
	const read = () => documentStore.read("scenes"), metadata = () => documentStore.read("project");
	function write(rows) {
		return documentStore.write("scenes", before => {
			let next = typeof rows === "function" ? rows(before) : rows;
			// Generic collection set preserves array position until the owner
			// consumes an order intent. Semantic reorder uses this same path.
			for (const row of next.filter(row => before.find(item => item.id === row.id)?.order !== row.order)) {
				const index = next.findIndex(item => item.id === row.id);
				next = next.filter(item => item.id !== row.id);
				next.splice(Math.min(next.length, Math.max(0, Math.round(row.order ?? index))), 0, row);
			}
			for (let index = 0; index < next.length; index++) {
				const previous = before.find(row => row.id === next[index].id);
				if (previous && previous.name !== next[index].name) {
					const requested = next[index].name;
					next = next.map((row, i) => i === index ? { ...row, name: previous.name } : row);
					next = renameScene(next, index, requested);
				}
			}
			next = ordered(next);
			return JSON.stringify(next) === JSON.stringify(before) ? before : next;
		});
	}
	const publish = () => {
		appContext.publishScenes(read());
		appContext.shared.activeSceneIdRef.current = metadata().activeSceneId;
		if (appContext.live.state) appContext.patchLive({ scenes: read(), activeSceneId: metadata().activeSceneId });
		storeProjectSession(metadata().name);
		domain.persist?.();
		domain.refreshDirty?.();
	};
	const unsubscribe = documentStore.subscribe(publish);
	const domain = {
		documentStore, dirtyStore, read, write, metadata, projectProjection,
		"setScenes": write,
		beginAction: () => documentStore.beginAction("scenes"),
		canUndo: id => documentStore.canUndo(id),
		stepHistory: redo => Boolean((redo ? documentStore.redo : documentStore.undo)()),
		publish: state => write(state.scenes), commitDraft: write,
		document: () => ({ scenes: domain.snapshot(), project: { ...metadata(), name: metadata().name ?? "Untitled" } }),
		renameProject(name) {
			documentStore.write("project", before => before.name === name.trim() ? before : { ...before, name: name.trim() });
		},
		nameSaved(name) {
			if (metadata().name === name) return;
			const boundary = documentStore.beginAction("project");
			boundary.run(() => domain.renameProject(name));
			boundary.cancel({ restore: false });
		},
		// Session cache/file loads are explicit non-authored boundaries. They
		// retire scene history, just as opening a scene retired native history.
		replaceDocument(scenes, activeSceneId, name = metadata().name) {
			release(); native.dispose();
			native = createDocumentStore({ owned: { scenes: ordered(scenes), project: { name, activeSceneId } } });
			release = native.subscribe(notify); notify();
		},
		setDirty(value) {
			if (dirtyStore.read("projectDirty") === value) return;
			const boundary = dirtyStore.beginAction("projectDirty");
			boundary.run(() => dirtyStore.write("projectDirty", value));
			boundary.cancel({ restore: false });
		},
		dispose() { projectProjection.disposed = true; for (const listener of projectProjection.listeners) listener(); projectProjection.listeners.clear(); unregister(); unsubscribe(); release(); native.dispose(); dirtyStore.dispose(); listeners.clear(); },
	};
	const unregister = appContext.registerStoreDomain("scenes", domain);
	return domain;
}

export function useScenes(appContext) {
	const [domain] = useState(() => appContext.storeDomain("scenes") ?? createScenesDomain(appContext, appContext.shared.startup.document, loadProjectSession()?.name ?? null));
	const scenes = useDocumentDomain(domain.documentStore, "scenes");
	const { activeSceneId, name: projectName } = useDocumentDomain(domain.documentStore, "project");
	const projectDirty = useDocumentDomain(domain.dirtyStore, "projectDirty");
	const runtimeValues = useRef(new Map());
	const projectListeners = useRef(new Set());
	// A callback retained by an older render cannot publish completion for a
	// newly loaded document, even when both projects contain identical values.
	const renderDocumentEpoch = appContext.shared.studioDocumentEpochRef.current;
	async function runProject(id, args = {}) {
		const receipt = await appContext.bus.run(id, args);
		if (!receipt.ok) appContext.notify(receipt.message);
		return receipt;
	}
	async function runWithValue(id, key, value) {
		const token = crypto.randomUUID(); runtimeValues.current.set(token, value);
		try { return await runProject(id, { [key]: token }); }
		finally { runtimeValues.current.delete(token); }
	}

	const [sceneSaveError, setSceneSaveError] = useState(appContext.shared.startup.error);

	function snapshotActiveScene(sourceScenes = appContext.storeDomain("scenes")?.read() ?? appContext.live.scenes) {
		return sourceScenes.map((scene) => scene.id === appContext.shared.activeSceneIdRef.current
			? { ...scene, objects: appContext.shared.storeRef.current.objects, shotDocument: appContext.shared.shotDocumentRef.current, stage: appContext.shared.actorStageRef.current,
				...(appContext.storeDomain('motion') ? appContext.storeDomain('motion').document() : {}) }
			: scene);
	}

	function persistScenes(nextScenes, nextActiveSceneId) {
		if (appContext.shared.saveBlockedRef.current) return false;
		const motion = appContext.storeDomain('motion');
		if (motion?.pendingDraft?.()) {
			appContext.shared.dirtyRef.current = true;
			const epoch = appContext.shared.studioDocumentEpochRef?.current;
			motion.flushDraft().then(() => { if (epoch === appContext.shared.studioDocumentEpochRef?.current) persistScenes(snapshotActiveScene(), appContext.shared.activeSceneIdRef.current); })
				.catch(error => setSceneSaveError(`Motion draft not saved: ${error?.message ?? error}`));
			return false;
		}
		if (motion?.draftError?.()) { setSceneSaveError(`Motion draft not saved: ${motion.draftError().message}`); return false; }
		try {
			localStorage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument({
					version: SCENES_VERSION,
				activeSceneId: nextActiveSceneId,
				scenes: nextScenes,
			}));
			appContext.shared.dirtyRef.current = false;
			setSceneSaveError(null);
			if (appContext.shared.saveFailureToastRef.current) {
				appContext.shared.saveFailureToastRef.current = false;
				appContext.notify("");
			}
			return true;
		} catch (err) {
			const message = `Scenes not saved: ${err?.name || "StorageError"}`;
			setSceneSaveError(message);
			if (!appContext.shared.saveFailureToastRef.current) {
				appContext.shared.saveFailureToastRef.current = true;
				appContext.notify(message);
			}
			return false;
		}
	}

	/* ============================ project files ============================
	 * Game-engine workflow: the authoring state (scenes + cast + layers,
	 * workspace layout, custom poses) round-trips through a real
	 * `.cclayproject` file. localStorage stays as the always-on session
	 * cache; the file is the portable, user-owned document. */
	const [projectSaveState, setProjectSaveState] = useState("idle");

	const [projectMenuOpen, setProjectMenuOpen] = useState(false);

	const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);

	const [projectNameDialog, setProjectNameDialog] = useState(null);

	// A first-run author should choose a document (or explicitly start a named
	// local draft). Keep this as a light startup sheet so the studio remains
	// inspectable while the choice is pending; it never traps the topbar.
	// ?tutorial=camera opens the starter scene itself (#209), so the chooser is
	// suppressed the same way a ?scene= launch suppresses it.
	const [projectStartupOpen, setProjectStartupOpen] = useState(() => !appContext.shared.playgroundMode && !appContext.shared.cameraTutorialQuery && !playgroundSceneUrl(globalThis.location?.search) && !loadProjectSession()?.name);

	const [projectManifest, setProjectManifest] = useState({ items: [], totals: { embedded: 0, external: 0, missing: 0, bytes: 0 }, missing: [] });

	const [saveBlockedReasons, setSaveBlockedReasons] = useState(null);

	const [workflowRevision, setWorkflowRevision] = useState(0);

	function projectDocumentInput(name) {
		return {
			scenesDocument: {
				version: SCENES_VERSION,
				activeSceneId: appContext.shared.activeSceneIdRef.current,
				scenes: snapshotActiveScene(),
			},
			workspaceLayout: appContext.shared.projectStateRef.current.workspaceLayout,
			customPoses: appContext.shared.projectStateRef.current.customPoses,
			workflow: loadWorkflowGraph(),
			name,
		};
	}

	function collectProjectSnapshot(name) {
		return JSON.stringify(createProjectDocument(projectDocumentInput(name)));
	}

	function projectSaveIdentity() {
		return { documentEpoch: appContext.shared.studioDocumentEpochRef.current, clock: appContext.undoClock };
	}
	function captureProjectSave(name = domain.metadata().name ?? "导演工程", includeResources = true) {
		const input = structuredClone(projectDocumentInput(name));
		const fullSourceIdentities = includeResources ? new Map([...appContext.shared.motionFullRef.current].map(([id, clip]) => [id, clip?.sourceBytes])) : null;
		return { ...projectSaveIdentity(), input, snapshot: JSON.stringify(createProjectDocument(input)), ...(includeResources ? {
			motions: new Map(appContext.shared.projectMotionsRef.current),
			fullSourceIdentities,
			fullSources: new Map([...fullSourceIdentities].map(([id, source]) => [id, source?.slice(0)])) } : {}) };
	}
	async function collectProjectSerialized(name, frozen = null, check = () => {}) {
		const input = frozen?.input ?? projectDocumentInput(name);
		const sourceMotions = frozen?.motions ?? appContext.shared.projectMotionsRef.current;
		const fullSources = frozen?.fullSources ?? new Map([...appContext.shared.motionFullRef.current].map(([id, clip]) => [id, clip?.sourceBytes]));
		const fullSourceIdentities = frozen?.fullSourceIdentities ?? fullSources;
		const portable = await appContext.storeDomain('motion')?.portableDocument?.();
		check();
		const scenesDocument = {
			...input.scenesDocument,
			scenes: input.scenesDocument.scenes.map((scene) => ({
				...scene,
				stage: scene.stage
					? {
						...scene.stage,
						characters: (scene.stage.characters ?? []).map((character) => ({
							...character,
							motionRef: character.motionRef ? { ...character.motionRef } : character.motionRef,
						})),
					}
					: scene.stage,
			})),
		};
		const db = await openAssetDb();
		try {
			check();
			const ids = [...referencedAssetIds(scenesDocument.scenes)];
			const assets = await Promise.all(ids.map((id) => getAsset(db, id)));
			check();
			const workflowResult = await internWorkflowOutputs(input.workflow);
			check();
			const referencedMotionIds = new Set(
				scenesDocument.scenes.flatMap((scene) => (scene.stage?.characters ?? [])
					.map((character) => character.motionRef?.motionId?.toLowerCase())
					.filter(Boolean)),
			);
			const motions = [...sourceMotions.entries()]
				.filter(([id]) => referencedMotionIds.has(id) || scenesDocument.scenes.some(scene => scene.motion?.some(row => [row.take?.motionId, row.fullTake?.motionId].includes(id))))
				.map(([, record]) => record);
			const motionCache = new Map();
			for (const record of motions) motionCache.set(record.motionId.toLowerCase(), record);
			if (portable) {
				for (const record of portable.records) { motionCache.set(record.motionId, record); motions.push(record); appContext.shared.projectMotionsRef.current.set(record.motionId, record); }
				const active = scenesDocument.scenes.find(scene => scene.id === input.scenesDocument.activeSceneId);
				if (active) {
					active.motion = portable.motion;
					for (const character of active.stage?.characters ?? []) {
						const take = portable.motion.find(row => row.id === character.id)?.take;
						if (take?.motionId) character.motionRef = { ...(character.motionRef ?? {}), motionId: take.motionId };
					}
				}
			}
			for (const scene of scenesDocument.scenes) for (const character of scene.stage?.characters ?? []) {
				if (scene.id !== input.scenesDocument.activeSceneId || scene.motion?.find(row => row.id === character.id)?.take?.snapshot) continue;
				const sourceBytes = fullSources.get(character.id);
				if (!sourceBytes) continue;
				const sourceIdentity = fullSourceIdentities.get(character.id) ?? sourceBytes;
				let record = appContext.shared.motionEncodingCacheRef.current.get(sourceIdentity);
				// A frozen byte copy changes identity on every save. Keep the original
				// identity for reuse, but verify the captured content: that original
				// buffer may have been edited in place or a newer save may be cached.
				if (record) {
					const motionId = await sha256Hex(sourceBytes);
					check();
					if (record.motionId !== motionId) record = null;
				}
				if (!record) {
					record = await encodeMotionResource(sourceBytes, { prompt: character.motionRef?.prompt, sourceUrl: character.motionRef?.url });
					check();
					appContext.shared.motionEncodingCacheRef.current.set(sourceIdentity, record);
				}
				const cached = motionCache.get(record.motionId) ?? record;
				motionCache.set(record.motionId, cached);
				if (!motions.includes(cached)) motions.push(cached);
				appContext.shared.projectMotionsRef.current.set(record.motionId.toLowerCase(), cached);
				character.motionRef = { ...(character.motionRef || {}), motionId: cached.motionId };
			}
			const missingSnapshots = scenesDocument.scenes.flatMap(scene => (scene.motion ?? []).flatMap(row => ['take', 'fullTake'].flatMap(field => row[field]?.snapshot && !motionCache.has(row[field].motionId)
				? [{ kind: 'motion', sceneId: scene.id, characterId: row.id, field, id: row[field].motionId }] : [])));
			if (missingSnapshots.length) throw Object.assign(new Error('Project has missing motion snapshots'), { code: 'missing-resources', items: missingSnapshots });
			for (const record of motionCache.values()) {
				try { await decodeMotionResource(record); }
				catch (cause) { throw Object.assign(new Error(`Project motion ${record.motionId} is invalid: ${cause.message}`), { code: 'missing-resources', items: [{ kind: 'motion', id: record.motionId, cause: cause.code }] }); }
				check();
			}
			const allAssets = [...assets.filter(Boolean), ...workflowResult.assets];
			const validMotions = [...motionCache.values()];
			const nextInput = { ...input, scenesDocument, workflow: workflowResult.graph, assets: allAssets, motions: validMotions };
			const manifest = resourceManifest({ scenesDocument: nextInput.scenesDocument, workflow: nextInput.workflow, poseLibrary: nextInput.customPoses, assets: allAssets, motions: validMotions, workflowOutputRefs });
			setProjectManifest(manifest);
			if (manifest.missing.length || manifest.items.some(item => item.status === 'external')) {
				const error = new Error("Project has missing resources");
				error.code = "missing-resources";
				error.items = manifest.items.filter(item => item.status !== 'embedded');
				throw error;
			}
			try { const motionDb = await openMotionDb(); try { await Promise.all(validMotions.map(record => putMotion(motionDb, record))); } finally { motionDb.close(); } } catch (error) { console.warn("[cozyclay] could not cache motions", error); }
			check();
			return JSON.stringify(createProjectDocument({ ...nextInput, savedAt: Date.now() }), null, 2);
		} finally {
			db.close();
		}
	}

	function markProjectClean(name, snapshot, previousName) {
		appContext.shared.projectSnapshotRef.current = snapshot;
		if (domain.metadata().name === previousName) domain.nameSaved(name);
		refreshProjectDirty(false);
		storeProjectSession(domain.metadata().name);
	}

	function projectProblemsNotice(problems) {
		if (!Array.isArray(problems) || !problems.length) return "";
		const codes = [...new Set(problems.map((problem) => problem?.code).filter(Boolean))].join(", ");
		return isKo
			? ` · 포함된 자원 ${problems.length}개를 건너뛰었어요${codes ? ` (${codes})` : ""}`
			: ` · skipped ${problems.length} embedded resource${problems.length === 1 ? "" : "s"}${codes ? ` (${codes})` : ""}`;
	}

	async function rehydrateProjectAssets(project, warnings = []) {
		for (const warning of warnings) console.warn(`[cozyclay] ${warning}`);
		if (!project.assets.length) return;
		try {
			const db = await openAssetDb();
			try {
				const referenced = referencedAssetIds(project.scenesDocument.scenes);
				const results = await Promise.allSettled(project.assets.map(async (asset) => {
					if (!referenced.has(asset.id)) {
						console.warn(`[cozyclay] skipped embedded asset outside the project closure: ${asset.id}`);
						return;
					}
					if (!(await verifyEmbeddedAsset(asset))) {
						console.warn(`[cozyclay] skipped embedded asset with mismatched content address: ${asset.id}`);
						return;
					}
					await putAsset(db, asset);
				}));
				for (const result of results) if (result.status === "rejected") console.warn("[cozyclay] could not restore an embedded asset", result.reason);
			} finally {
				db.close();
			}
		} catch (error) {
			console.warn("[cozyclay] could not open the asset store for project restore", error);
		}
	}

	/** Save the project; the answer says what happened, for project.save:
	 * { saved, name, fileName, downloaded } or { saved: false, naming |
	 * cancelled | failure }. Every outcome is also shown to the user here. */
	async function saveProject(saveAs = false, explicitName = null, context = null) {
		if (!context) {
			const receipt = await runProject(saveAs ? "project.saveAs" : "project.save", explicitName === null ? {} : { name: explicitName });
			return receipt.ok ? { saved: true, ...receipt.output } : { saved: false, failure: receipt.code };
		}
		const currentName = domain.metadata().name;
		if (currentName === null && explicitName === null) {
			setProjectNameDialog({ kind: "save", initialName: "My Project" });
			return { saved: false, naming: true };
		}
		setProjectSaveState("saving");
		const name = (explicitName ?? currentName ?? "My Project").trim() || "My Project";
		const checkpoint = collectProjectSnapshot(name);
		let downloaded = false;
		try {
			const serialized = await collectProjectSerialized(name);
			context.check();
			let handle = appContext.shared.projectHandleRef.current;
			if (saveAs || !handle || !hasFileSystemAccess()) {
				if (hasFileSystemAccess()) {
					handle = await pickProjectFileForSave(name);
					appContext.shared.projectHandleRef.current = handle;
					await writeProjectFile(handle, serialized);
					await rememberRecentProject(handle, name);
				} else {
					downloadProjectFallback(serialized, name);
					downloaded = true;
				}
			} else {
				await writeProjectFile(handle, serialized);
			}
			context.check();
			markProjectClean(name, checkpoint, currentName);
			setSaveBlockedReasons(null);
			setProjectSaveState(domain.dirtyStore.read("projectDirty") ? "dirty" : "saved");
			track("project:saved", {
				object_count_bucket: bucketCount(appContext.shared.projectStateRef.current.sceneObjects?.length ?? 0),
				shot_count_bucket: bucketCount(appContext.shared.shots.length),
			});
			appContext.notify((isKo, ko) => isKo ? `프로젝트 저장됨: ${name}${PROJECT_EXTENSION}` : `Project saved: ${name}${PROJECT_EXTENSION}`);
			return { saved: true, name, fileName: downloaded ? `${name}${PROJECT_EXTENSION}` : appContext.shared.projectHandleRef.current?.name ?? `${name}${PROJECT_EXTENSION}`, downloaded };
		} catch (err) {
			if (err?.name === "AbortError") {
				setProjectSaveState(projectDirty ? "dirty" : "saved");
				return { saved: false, cancelled: true }; // user closed the picker
			}
			setProjectSaveState("error");
			if (err?.code === "missing-resources") setSaveBlockedReasons([{ code: err.code, items: err.items }]);
			else if (err?.code === "resources-too-large") setSaveBlockedReasons([err]);
			else appContext.notify(ko("Could not save the project", "프로젝트를 저장하지 못했어요"));
			return { saved: false, failure: err?.code ?? err?.name ?? "error" };
		}
	}

	function applyProject(project, authorized = false) {
		if (!authorized) return runWithValue("project.open", "projectToken", project);
		const checked = readSceneDocument(JSON.stringify(project.scenesDocument));
		if (!["valid", "migrated"].includes(checked.status)) throw new StudioProtocolError("INVALID_ARGUMENT", "Invalid project scene document.");
		project = { ...project, scenesDocument: checked.document };
		for (const scene of project.scenesDocument.scenes) if (scene.motion != null) appContext.storeDomain('motion')?.validateDocument?.(scene.motion);
		appContext.shared.studioDocumentEpochRef.current = crypto.randomUUID();
		appContext.shared.tutorialProjectEpochRef.current += 1;
		appContext.shared.tutorialSeedEpochRef.current = null;
		appContext.shared.setTutorialSeedPending(false);
		appContext.shared.setCameraTutorialHandoff(null);
		appContext.shared.exportShotIdRef.current = null;
		appContext.shared.projectMotionsRef.current = new Map((project.motions ?? []).map((record) => [record.motionId?.toLowerCase(), record]).filter(([id]) => id));
		const source = project.scenesDocument;
		openMotionDb().then(async (db) => { try { await Promise.all([...appContext.shared.projectMotionsRef.current.values()].map((record) => putMotion(db, record))); const ids = new Set((source?.scenes ?? []).flatMap((scene) => [
			...(scene.stage?.characters ?? []).map((character) => character.motionRef?.motionId?.toLowerCase()),
			...(scene.motion ?? []).flatMap(row => [row.take?.motionId, row.fullTake?.motionId]),
		]).filter(Boolean)); await sweepMotions(db, ids); } finally { db.close(); } }).catch(() => {});
		// A project FILE carries its own scene document and never passes the
		// storage reader, so the 20 fps → 24 fps clock migration is applied here
		// too — otherwise an older .cozyclay would open a sixth too fast.
		const doc = Number.isInteger(source.version) && source.version < SCENES_VERSION
			? { ...source, version: SCENES_VERSION, scenes: source.scenes.map((scene) => ({ ...scene, stage: migrateStageFrames(scene.stage) })) }
			: source;
		const mergedCustomPoses = mergeProjectCustomPoses(appContext.shared.customPoses, project.customPoses);
		domain.replaceDocument(doc.scenes, doc.activeSceneId, project.name);
		if (project.workspaceLayout) appContext.shared.setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...project.workspaceLayout });
		appContext.bus.run('cast.setCustomPoses', { poses: mergedCustomPoses });
		const resolvedWorkflow = resolveWorkflowOutputs(normalizeWorkflowGraph(project.workflow), new Map((project.assets ?? []).map((asset) => [asset.id, asset])));
		storeWorkflowGraph(resolvedWorkflow);
		saveCustomPoses(mergedCustomPoses);
		persistScenes(doc.scenes, doc.activeSceneId);
		openScene(doc.scenes[activeSceneIndex(doc.scenes, doc.activeSceneId)], doc.scenes);
		appContext.shared.projectSnapshotRef.current = collectProjectSnapshot(project.name);
		domain.pendingCheckpoint = { clock: appContext.undoClock, name: project.name };
		domain.setDirty(false);
		storeProjectSession(project.name);
		setProjectStartupOpen(false);
		// Whatever document this is, it is no longer the scene the tutorial opened
		// for itself; startCameraTutorial re-arms the flag after its own open.
		appContext.shared.tutorialStarterRef.current = false;
		setProjectManifest(resourceManifest({ scenesDocument: doc, workflow: resolvedWorkflow, poseLibrary: mergedCustomPoses, assets: project.assets ?? [], motions: appContext.shared.projectMotionsRef.current, workflowOutputRefs }));
		track("project:opened", { age_bucket: bucketProjectAge(Date.now() - (project.savedAt ?? Date.now())) });
		// Freeze the normalized incoming author document from its synchronous
		// owners. The App render has not yet published cast/shot/workspace refs;
		// those outgoing projections cannot be the hosted restore baseline.
		const activeSceneId = domain.metadata().activeSceneId;
		const incomingScenes = domain.read().map(scene => {
			if (scene.id !== activeSceneId) return scene;
			const stage = createSceneStage(scene.stage);
			return { ...scene,
				objects: appContext.storeDomain('objects')?.read() ?? scene.objects,
				shotDocument: appContext.storeDomain('shot')?.authoringDocument() ?? scene.shotDocument,
				stage: { ...stage, ...(appContext.storeDomain('stage')?.read() ?? {}),
					characters: (appContext.storeDomain('cast')?.read() ?? stage.characters).map(({ sessionMotion, ...entry }) => entry) },
				...(appContext.storeDomain('motion')?.document() ?? {}) };
		});
		const incomingIdentity = projectSaveIdentity();
		return { ...incomingIdentity, whenProjected(signal) {
			const projection = domain.projectProjection;
			return new Promise((resolve, reject) => {
				let timer;
				const cleanup = () => { clearTimeout(timer); projection.listeners.delete(check); signal?.removeEventListener('abort', check); };
				function check() {
					try {
						signal?.throwIfAborted();
						if (projection.disposed) throw Object.assign(new Error('工程所有者已关闭'), { code: 'session_closed' });
						if (incomingIdentity.documentEpoch !== projectSaveIdentity().documentEpoch) throw Object.assign(new Error('工程已切换，旧恢复已取消'), { code: 'document_changed' });
						if (projection.documentEpoch !== incomingIdentity.documentEpoch) return;
						cleanup(); resolve();
					} catch (error) { cleanup(); reject(error); }
				}
				projection.listeners.add(check); signal?.addEventListener('abort', check, { once: true });
				// Match the hosted RPC's 30-second failure budget. A missing render
				// signal is a visible restore failure, never a saved checkpoint.
				timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('工程界面恢复超时，请重新打开工程'), { code: 'restore_projection_timeout' })); }, 30000);
				check();
			});
		}, snapshot: JSON.stringify(createProjectDocument({
			scenesDocument: { version: SCENES_VERSION, activeSceneId, scenes: incomingScenes }, name: project.name,
			workspaceLayout: project.workspaceLayout ? { ...DEFAULT_WORKSPACE_LAYOUT, ...project.workspaceLayout } : appContext.shared.projectStateRef.current.workspaceLayout,
			// Unrelated operator poses are merged into the live library above,
			// but they are new project content and must remain dirty, not become
			// an acknowledged part of the older hosted record.
			customPoses: project.customPoses, workflow: resolvedWorkflow,
		})) };
	}

	/** Open a bundled starter scene as a fresh, saveable project. Used by the
	 * first-run dialog and by `npx cozyclay --scene <id>` (`?scene=`), which is
	 * how the landing-page tutorial hands people into the local studio. */
	async function openStarterScene(id, source = "starter", context = null) {
		const before = source === "tutorial" ? collectProjectSnapshot("Tutorial") : null;
		const epoch = appContext.shared.tutorialProjectEpochRef.current;
		const url = playgroundSceneUrl(`?scene=${encodeURIComponent(id)}`);
		const project = url ? await fetchSceneProject(url) : null;
		// A pending tutorial fetch has no authority over work authored/opened
		// while it was loading, including an unnamed project.
		if (source === "tutorial" && (epoch !== appContext.shared.tutorialProjectEpochRef.current || before !== collectProjectSnapshot("Tutorial"))) return false;
		if (!project) {
			appContext.notify(ko("That starter scene is not in this build", "이 빌드에는 그 시작 장면이 없어요"));
			return false;
		}
		context?.check();
		applyProject({ ...project, savedAt: null }, true);
		appContext.shared.projectHandleRef.current = null;
		track("scene:loaded", { scene_source: source });
		return true;
	}

	async function openProject(context = null) {
		if (!context) return runProject("project.open");
		try {
			let file = null;
			let handle = null;
			if (hasFileSystemAccess()) {
				handle = await pickProjectFileForOpen();
				file = await readProjectFile(handle);
			} else {
				file = await openProjectFallback();
			}
			if (!file) return false;
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				appContext.notify(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return false;
			}
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = handle;
			if (handle) await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			context.check();
			applyProject(result.project, true);
			setProjectStartupOpen(false);
			appContext.notify(`${isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
			return true;
		} catch (err) {
			if (err?.name === "AbortError") return false;
			if (err?.code) throw err;
			console.error("openProject failed", err);
			appContext.notify(ko("Could not open the project", "프로젝트를 열지 못했어요"));
			return false;
		}
	}

	/** Open a project from the browser dialog: a stored handle from the
	 * recents list or a file enumerated in the projects folder. */
	async function openProjectByHandle(handle, context = null) {
		if (!context) return runWithValue("project.open", "handleToken", handle);
		try {
			// A stored handle may have been demoted to "prompt" since the last
			// session (#51); this click is the user gesture that can re-grant it.
			if ((await requestHandlePermission(handle)) !== "granted") {
				appContext.notify(ko("Project access was not granted — allow access and try again.", "프로젝트 접근이 허용되지 않았어요. 접근을 허용하고 다시 시도해 주세요."));
				return false;
			}
			const file = await readProjectFile(handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				appContext.notify(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return false;
			}
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = handle;
			await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			context.check();
			applyProject(result.project, true);
			setProjectBrowserOpen(false);
			setProjectStartupOpen(false);
			appContext.notify(`${isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
			return true;
		} catch (err) {
			if (err?.code) throw err;
			console.error("openProjectByHandle failed", err);
			appContext.notify(ko("Could not open the project", "프로젝트를 열지 못했어요"));
			return false;
		}
	}

	function requestNewProject(authorized = false) {
		if (!authorized) return runProject("project.new");
		if ((appContext.actionPorts.projectPersistence?.getSnapshot().dirty ?? domain.dirtyStore.read("projectDirty")) && !window.confirm(ko("Discard unsaved changes and start a new project?", "저장되지 않은 변경사항을 버리고 새 프로젝트를 시작할까요?"))) return;
		setProjectNameDialog({ kind: "new", initialName: projectName ?? "My Project" });
	}

	function newProject(name, authorized = false) {
		if (!authorized) return runProject("project.new", typeof name === "string" ? { name } : {});
		if (typeof name !== "string") return requestNewProject(true);
		name = name.trim() || "My Project";
		setProjectNameDialog(null);
		appContext.shared.studioDocumentEpochRef.current = crypto.randomUUID();
		const fresh = createSceneDocument(ko("SCENE 01", "씬 01"));
		storeWorkflowGraph(createWorkflowGraph());
		domain.replaceDocument(fresh.scenes, fresh.activeSceneId, name);
		persistScenes(fresh.scenes, fresh.activeSceneId);
		openScene(fresh.scenes[0], fresh.scenes);
		appContext.shared.projectHandleRef.current = null;
		clearStoredProjectHandle();
		appContext.shared.projectSnapshotRef.current = collectProjectSnapshot(name);
		domain.setDirty(false);
		storeProjectSession(name);
		setProjectStartupOpen(false);
		appContext.shared.setFirstSuccessGuideOpen(true);
		domain.pendingCheckpoint = { clock: appContext.undoClock, name };
		appContext.notify(ko(`New project: ${name}`, `새 프로젝트: ${name}`));
		return true;
	}

	const [restoreOffer, setRestoreOffer] = useState(null);

	async function restoreStoredProject(record, context = null) {
		if (!context) return runWithValue("project.restore", "handleToken", record.handle);
		try {
			const file = await readProjectFile(record.handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) return false;
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = record.handle;
			await rehydrateProjectAssets(result.project, result.warnings);
			context.check();
			applyProject(result.project, true);
			appContext.notify(`${isKo ? `프로젝트 복원됨: ${result.project.name}` : `Project restored: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
			return true;
		} catch (error) {
			if (error?.code) throw error;
			console.warn("Could not restore the project; retaining the session cache.", error);
			return false;
		}
	}

	function flushScenes() {
		if (!appContext.shared.dirtyRef.current) return;
		persistScenes(snapshotActiveScene(), appContext.shared.activeSceneIdRef.current);
	}

	function restoredShotState(scene) {
		const restored = readShotAuthoringDocument(scene?.shotDocument ?? undefined);
		if (restored.state) return restored.state;
		const frameCount = DEFAULT_DURATION_S * TIMELINE_FPS;
		return { shots: initialShots(frameCount), waypoints: [], frameCount };
	}

	function openScene(scene, nextScenes) {
		appContext.shared.tutorialProjectEpochRef.current += 1;
		appContext.shared.tutorialSeedEpochRef.current = null;
		appContext.shared.setTutorialSeedPending(false);
		appContext.shared.setCameraTutorial(false);
		appContext.shared.setCameraTutorialHandoff(null);
		appContext.shared.exportShotIdRef.current = null;
		appContext.shared.studioSceneEpochRef.current = crypto.randomUUID();
		const shotState = restoredShotState(scene);
		const stage = createSceneStage(scene.stage);
		const objects = Array.isArray(scene.objects) ? scene.objects : [];
		const loaded = appContext.loadStoreDomains({ ...scene, stage, objects, shot: shotState, cast: stage.characters });
		if (!loaded.has("shot")) {
			appContext.shared.setShots(shotState.shots);
			appContext.shared.setTlFrameCount(shotState.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS);
		}
		appContext.shared.setRigMountEpoch((value) => value + 1);
		appContext.shared.setHasCharSheet(stage.hasCharSheet);
		if (!loaded.has("stage")) appContext.shared.stageDomain.load(stage);
		// The motion-layer buffer reloads from the scene's first character.
		const firstLayer = stage.characters[0]?.layer;
		appContext.shared.setWaypoints(firstLayer?.waypoints ?? shotState.waypoints ?? []);
		appContext.shared.setPromptClips(firstLayer?.promptClips?.map((clip) => ({ ...clip })) ?? []);
		// Takes belong to the room being left; restoreMotionRefs re-fetches the
		// incoming scene's, and a stale full take must never survive the switch.
		appContext.shared.motionFullRef.current.clear();
		appContext.shared.setSelectedPromptId(null);
		if (!loaded.has('motion')) { appContext.shared.ikStatesRef.current.clear(); appContext.shared.ikStateRef.current = createIkState(); }
		appContext.shared.loadedLayerCharRef.current = stage.characters[0]?.id ?? null;
		appContext.shared.setActiveCharacterId(stage.characters[0]?.id ?? null);
		appContext.shared.restoreMotionRefs(stage.characters);
		appContext.shared.setTlFrame(0);
		appContext.shared.setMovePlaying(false);
		appContext.shared.manualCameraOverrideRef.current = false;
		appContext.shared.setRailDraw(false);
		appContext.shared.setActiveWaypointId(null);
		appContext.shared.setPendingWaypointFrame(null);
		appContext.shared.setSelectedHierarchyId("shot");
		appContext.publishScenes(nextScenes);
		appContext.shared.activeSceneIdRef.current = scene.id;
		appContext.storeDomain("scenes")?.replaceDocument(nextScenes, scene.id);
		track("scene:loaded", { scene_source: "local" });
	}

	/** The scene controls' doors (the scene pill, the Hierarchy scene menu)
	 * into the shared registry; run_action reaches the same scene actions. */
	function selectSceneDocument(sceneId) { return appContext.shared.runStudioAction("scene.switch", { sceneId }); }

	function createSceneDocumentFromUi() { return appContext.shared.runStudioAction("scene.create"); }

	function duplicateSceneDocumentFromUi(sceneId) { return appContext.shared.runStudioAction("scene.duplicate", { sceneId }); }

	function renameSceneDocumentFromUi(sceneId, name) { return appContext.shared.runStudioAction("scene.rename", { sceneId, name }); }

	function deleteSceneDocumentFromUi(sceneId) { return appContext.shared.runStudioAction("scene.delete", { sceneId }); }

	function switchSceneDocument(sceneId) {
		if (sceneId === appContext.shared.activeSceneIdRef.current) return;
		const savedScenes = snapshotActiveScene();
		const target = savedScenes.find((scene) => scene.id === sceneId);
		if (!target) return;
		persistScenes(savedScenes, sceneId);
		openScene(target, savedScenes);
	}

	function addSceneDocument() {
		const savedScenes = snapshotActiveScene();
		const nextScenes = addScene(savedScenes);
		const target = nextScenes[nextScenes.length - 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
		track("scene:created", { scene_source: "ui" });
	}

	function duplicateSceneDocument(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = duplicateScene(savedScenes, index);
		const target = nextScenes[index + 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	function renameSceneDocument(sceneId, name) {
		const savedScenes = appContext.storeDomain("scenes")?.read() ?? snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = renameScene(savedScenes, index, name);
		appContext.storeDomain('scenes').write(nextScenes);
		persistScenes(nextScenes, appContext.shared.activeSceneIdRef.current);
	}

	function deleteSceneDocument(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0 || savedScenes.length <= 1) return;
		const nextScenes = removeScene(savedScenes, index);
		if (sceneId !== appContext.shared.activeSceneIdRef.current) {
			const owned = appContext.storeDomain("scenes");
			if (owned) owned.replaceDocument(nextScenes, appContext.shared.activeSceneIdRef.current);
			else {
				appContext.publishScenes(nextScenes);
				persistScenes(nextScenes, appContext.shared.activeSceneIdRef.current);
			}
			return;
		}
		const target = nextScenes[Math.min(index, nextScenes.length - 1)];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}
	function applyExternalScene(incoming) {
		if (!incoming || !Array.isArray(incoming.scenes)) return;
		const incomingActiveId = typeof incoming.activeSceneId === "string" ? incoming.activeSceneId : appContext.shared.activeSceneIdRef.current;
		const incomingScenes = incoming.scenes;
		const incomingScene = incomingScenes.find((scene) => scene?.id === incomingActiveId) ?? incomingScenes[0];
		if (!incomingScene?.id) return;
		const currentSnapshot = {
			version: SCENES_VERSION,
			activeSceneId: appContext.shared.activeSceneIdRef.current,
			scenes: snapshotActiveScene(),
		};
		if (JSON.stringify(currentSnapshot) === JSON.stringify({ version: SCENES_VERSION, activeSceneId: incomingActiveId, scenes: incomingScenes })) return;
		const nextScenes = incomingScenes;
		if (incomingScene.id !== appContext.shared.activeSceneIdRef.current) {
			openScene(incomingScene, nextScenes);
			return;
		}
		const currentScene = currentSnapshot.scenes.find((scene) => scene?.id === incomingScene.id);
		if (JSON.stringify(currentScene?.objects ?? []) !== JSON.stringify(incomingScene.objects ?? [])) {
			appContext.shared.objectsDomain.applyExternalObjects(incomingScene.objects);
		}
		const incomingStage = createSceneStage(incomingScene.stage);
		const currentStage = currentScene?.stage;
		if (JSON.stringify(currentStage ?? null) !== JSON.stringify(incomingStage)) {
			appContext.shared.castDomain.applyExternalCharacters(incomingStage.characters);
		}
		domain.replaceDocument(nextScenes, incomingScene.id);
	}
	function loadLiveScenes(args, authorized = false) {
		if (!authorized) {
			const receipt = appContext.bus.run("load_scenes", { document: args.document }, {
				origin: "mcp", host: appContext.ports.read().host, expectedRevision: appContext.ports.revision.current,
				...(args.confirmationToken ? { confirmationToken: args.confirmationToken } : {}),
			});
			return receipt.ok ? receipt.output : receipt;
		}
		if (!args.document || typeof args.document !== "object" || Array.isArray(args.document)) throw new Error("Invalid scene document");
		const loaded = readSceneDocument(JSON.stringify(args.document));
		if (loaded.status !== "valid" && loaded.status !== "migrated") throw new Error("Invalid scene document");
		const document = loaded.document;
		const target = document.scenes[activeSceneIndex(document.scenes, document.activeSceneId)];
		const live = appContext.live.state;
		live.persistScenes(document.scenes, document.activeSceneId);
		live.openScene(target, document.scenes);
		appContext.patchLive({ scenes: domain.read() });
		appContext.patchLive({ activeSceneId: domain.metadata().activeSceneId });
		appContext.patchLive({ objects: appContext.shared.storeRef.current.objects });
		appContext.patchLive({ characters: createSceneStage(target.stage).characters });
		appContext.publishCharacters(live.characters);
		return {
			sceneName: target.name,
			activeSceneId: document.activeSceneId,
			scenes: document.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
		};
	}
	function refreshProjectDirty(afterRender = true) {
		const projected = afterRender && renderDocumentEpoch === projectSaveIdentity().documentEpoch
			&& scenes === domain.read() && activeSceneId === domain.metadata().activeSceneId;
		const name = domain.metadata().name;
		const snapshot = collectProjectSnapshot(name);
		// App publishes the incoming shot/cast/workspace envelopes at render.
		// Checkpoint those, not the outgoing refs read inside the load action.
		// A real authored commit in between must never be declared saved.
		if (projected && domain.pendingCheckpoint) {
			const checkpoint = domain.pendingCheckpoint;
			domain.pendingCheckpoint = null;
			if (checkpoint.clock === appContext.undoClock && checkpoint.name === name) appContext.shared.projectSnapshotRef.current = snapshot;
		}
		const dirty = name !== null && snapshot !== appContext.shared.projectSnapshotRef.current;
		domain.setDirty(dirty);
		setProjectSaveState((current) => current === "saving" ? current : dirty ? "dirty" : "saved");
		for (const listener of projectListeners.current) listener({ snapshot, ...projectSaveIdentity() });
		if (projected) domain.projectProjection.documentEpoch = projectSaveIdentity().documentEpoch;
		for (const listener of domain.projectProjection.listeners) listener();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}
	domain.snapshot = snapshotActiveScene;
	domain.fileState = () => ({ name: domain.metadata().name, hasFile: Boolean(appContext.shared.projectHandleRef.current),
		fileAccess: hasFileSystemAccess(), gesture: globalThis.navigator?.userActivation?.isActive === true });
	domain.save = (args, context) => saveProject(args.saveAs, args.name ?? null, context);
	domain.serializeProject = collectProjectSerialized;
	domain.projectSaveIdentity = projectSaveIdentity;
	domain.captureProjectSave = captureProjectSave;
	domain.subscribeProject = listener => { projectListeners.current.add(listener); return () => projectListeners.current.delete(listener); };
	domain.loadScenes = args => loadLiveScenes(args, true);
	domain.projectAction = async (id, args, context) => {
		const runtime = key => {
			if (context.origin !== "ui") throw new StudioProtocolError("CAPABILITY_MISSING", "Runtime project handles belong to the UI.");
			const value = runtimeValues.current.get(args[key]);
			if (!value) throw new StudioProtocolError("STALE_TARGET", "The selected project is no longer available.");
			return value;
		};
		if (id === "project.browse") { setProjectStartupOpen(false); setProjectBrowserOpen(true); return; }
		if (id === "project.new") return newProject(args.name, true);
		if (id === "project.openStarter") return openStarterScene(args.id, args.source, context);
		if (id === "project.restore") return restoreStoredProject({ handle: runtime("handleToken") }, context);
		if (args.handleToken) return openProjectByHandle(runtime("handleToken"), context);
		if (args.projectToken) { applyProject(runtime("projectToken"), true); return true; }
		if (args.serialized !== undefined) {
			const result = readProjectDocument(args.serialized);
			if (!result.ok) throw new StudioProtocolError("INVALID_ARGUMENT", `Cannot open project: ${result.reason}`);
			await rehydrateProjectAssets(result.project, result.warnings);
			context.check();
			applyProject(result.project, true);
			appContext.shared.projectHandleRef.current = null;
			return true;
		}
		return openProject(context);
	};
	domain.persist = () => persistScenes(snapshotActiveScene(), domain.metadata().activeSceneId);
	domain.refreshDirty = () => refreshProjectDirty(false);
	return {
		...domain, applyExternalScene, loadLiveScenes, refreshProjectDirty,
		scenes, activeSceneId, sceneSaveError, snapshotActiveScene, persistScenes, projectName,
		projectDirty, setProjectDirty: domain.setDirty, projectSaveState, setProjectSaveState, projectMenuOpen,
		setProjectMenuOpen, projectBrowserOpen, setProjectBrowserOpen, projectNameDialog, setProjectNameDialog,
		projectStartupOpen, setProjectStartupOpen, projectManifest, setProjectManifest, saveBlockedReasons,
		setSaveBlockedReasons, workflowRevision, setWorkflowRevision, collectProjectSnapshot,
		collectProjectSerialized, projectProblemsNotice, rehydrateProjectAssets, saveProject, applyProject,
		openStarterScene: async (id, source = "starter") => (await runProject("project.openStarter", { id, source })).output?.opened === true,
		openProject, openProjectByHandle, requestNewProject, newProject, restoreOffer,
		setRestoreOffer, restoreStoredProject, flushScenes, openScene, selectSceneDocument,
		createSceneDocumentFromUi, duplicateSceneDocumentFromUi, renameSceneDocumentFromUi,
		deleteSceneDocumentFromUi, switchSceneDocument, addSceneDocument, duplicateSceneDocument,
		renameSceneDocument, deleteSceneDocument,
	};
}

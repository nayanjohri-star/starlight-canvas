import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { ZH_CN, chineseLabel } from "../src/locale-zh-cn.js";
import { viewportShortcut, resizeLayoutWithKey } from "../src/director-layout.js";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
async function locale(choice, unavailable = false) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem() { if (unavailable) throw new Error("unavailable"); return choice; },
	} });
	try {
		return await import(`${pathToFileURL(resolve("src/locale.js")).href}?ui-test=${encodeURIComponent(choice)}-${unavailable}`);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete globalThis.localStorage;
	}
}
for (const choice of [null, "invalid", "zh-CN"]) {
	const current = await locale(choice);
	assert.equal(current.LOCALE, "zh-CN");
	assert.equal(current.ko("Save", "저장"), "保存");
	assert.equal(current.ko("Subject 2", "인물 2"), "角色 2");
	assert.equal(current.ko("Camera", "카메라", "摄影机"), "摄影机");
}
assert.equal((await locale(null, true)).LOCALE, "zh-CN");
assert.equal((await locale("en")).ko("Save", "저장"), "Save");
assert.equal((await locale("ko")).ko("Save", "저장"), "저장");
for (const key of ["Move tool (W)", "Rotate tool (E)", "Scale tool (R)", "Save failed", "Hierarchy", "Inspector", "Animation", "Mirror pose", "Language", "Pose", "Camera", "Cancel export"]) {
	assert.ok(Object.hasOwn(ZH_CN, key), `missing primary Chinese UI label: ${key}`);
	assert.notEqual(chineseLabel(key), key);
}
assert.equal(chineseLabel("Camera note by the user"), "Camera note by the user");
assert.equal(chineseLabel("用户描述：保持我的 Camera 文本"), "用户描述：保持我的 Camera 文本");
assert.doesNotMatch(source("src/locale.js") + source("src/locale-zh-cn.js"), /MutationObserver|fetch\(|XMLHttpRequest/);

const editable = { closest: () => ({ tagName: "TEXTAREA" }) };
assert.equal(viewportShortcut({ code: "Space", shiftKey: true, target: editable }, false), null);
assert.equal(viewportShortcut({ code: "Space", shiftKey: true, isComposing: true }, false), null);
assert.equal(viewportShortcut({ code: "Space", shiftKey: true, ctrlKey: true }, false), null);
assert.equal(viewportShortcut({ code: "Space", shiftKey: true, defaultPrevented: true }, false), null);
assert.equal(viewportShortcut({ code: "Space", shiftKey: true, repeat: true }, false), null);
assert.equal(viewportShortcut({ code: "Space", shiftKey: true }, false), "maximize");
assert.equal(viewportShortcut({ key: "Escape" }, true), "restore");
assert.equal(viewportShortcut({ key: "Escape" }, false), null);
assert.equal(viewportShortcut({ code: "Space" }, false), null, "plain Space must remain playback");
const layout = { hierarchyWidth: 230, sidebarWidth: 300, timelineHeight: 150 };
const bounds = { width: 1366, height: 768 };
assert.equal(resizeLayoutWithKey(layout, "hierarchy", { key: "ArrowLeft", shiftKey: true }, bounds).hierarchyWidth, 220);
assert.equal(resizeLayoutWithKey(layout, "sidebar", { key: "ArrowRight", shiftKey: true }, bounds).sidebarWidth, 280);
assert.equal(resizeLayoutWithKey(layout, "timeline", { key: "ArrowUp" }, bounds).timelineHeight, 160);
assert.equal(resizeLayoutWithKey(layout, "timeline", { key: "Enter" }, bounds), null);
assert.deepEqual(layout, { hierarchyWidth: 230, sidebarWidth: 300, timelineHeight: 150 }, "resizing must not mutate prior layout");

const app = source("src/App.jsx"), styles = source("src/styles.css");
for (const item of ["<Canvas", "<HierarchyPanel", "<Timeline", "useHostedDirector(appContext", "get startupScene()", 'data-ui-locale={LOCALE}', 'data-viewport-maximized={viewportMaximized}', 'data-testid="maximize-viewport"']) assert.ok(app.includes(item), item);
for (const item of ["hierarchy", "inspector", "timeline"]) assert.ok(styles.includes(`data-${item}-collapsed="true"`));
assert.ok(styles.includes('data-viewport-maximized="true"'));
assert.doesNotMatch(app, /<AgentPanel\b|<FalMotionModal\b|<PromptBlocksPanel\b|<TakeBarPanel\b|\/v1\/motion\/me|href="\/workflow\/"/);
assert.match(app, /if \(window\.__STARLIGHT_DIRECTOR_HOSTED__\) return undefined;\s*let alive = true;/, "hosted UI must not probe the optional local GPU bridge");
const pose = source("src/panels/PosePanel.jsx");
assert.match(pose, /run\('character\.mirrorPose', \{ characterId: activeChar\.id \}\)/);
assert.doesNotMatch(pose, /<FalMotionCaptureCard/);
assert.doesNotMatch(source("src/panels/VideoCapturePanel.jsx"), /onClick=|fetch\(/);
assert.doesNotMatch(source("src/panels/RigControlPanel.jsx"), /onClick=\{runTrailRegeneration\}/);
assert.match(source("src/panels/SubjectsPanel.jsx"), /value=\{entry\.subject \?\? ""\}/);
assert.match(source("src/panels/SubjectsPanel.jsx"), /patch: \{ subject: event\.target\.value \}/);
assert.ok(source("src/settings-menu.jsx").includes('id: "zh-CN"'));
assert.ok(source("src/hierarchy-panel.jsx").includes('if (node.kind === "object") return node.label;'));
assert.ok(source("src/hierarchy-panel.jsx").includes('return name; // Scene names belong to the document'));
console.log(`starlight UI checks PASS (${Object.keys(ZH_CN).length} Chinese labels; locale, shortcut focus, layout and hosted entry boundaries)`);

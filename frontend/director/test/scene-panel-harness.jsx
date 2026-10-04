import { useState } from "react";
import { createRoot } from "react-dom/client";
import HierarchyPanel from "../src/hierarchy-panel.jsx";
import "../src/styles.css";

window.__sceneCalls = [];

function record(callback, ...args) {
	window.__sceneCalls.push([callback, ...args]);
}

window.confirm = (message) => {
	record("confirm", message);
	return true;
};

function ScenePanelHarness() {
	const [scenes, setScenes] = useState([
		{ id: "scene-a", name: "SCENE 01" },
		{ id: "scene-b", name: "골목 & 카페 <밤> 🎬" },
	]);
	const [activeSceneId, setActiveSceneId] = useState("scene-a");

	return (
		<main style={{ width: 320, height: 640 }}>
			<output aria-label="callback log">{JSON.stringify(window.__sceneCalls)}</output>
			<HierarchyPanel
				selectedId="shot"
				onSelect={() => {}}
				showB={false}
				motionFrames={0}
				ikMode={false}
				scenes={scenes}
				activeSceneId={activeSceneId}
				onSceneSelect={(id) => {
					record("select", id);
					setActiveSceneId(id);
				}}
				onSceneCreate={() => {
					record("create");
					setScenes((current) => [...current, { id: "scene-c", name: "SCENE 03" }]);
				}}
				onSceneDuplicate={(id) => {
					record("duplicate", id);
					setScenes((current) => [...current, { id: `${id}-copy`, name: "SCENE COPY" }]);
				}}
				onSceneRename={(id, name) => {
					record("rename", id, name);
					setScenes((current) => current.map((scene) => scene.id === id ? { ...scene, name } : scene));
				}}
				onSceneDelete={(id) => {
					record("delete", id);
					setScenes((current) => current.filter((scene) => scene.id !== id));
					setActiveSceneId("scene-a");
				}}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")).render(<ScenePanelHarness />);

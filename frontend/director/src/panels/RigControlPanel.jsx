import Foldout from "./Foldout.jsx";
import { useMotionCommands } from '../domains/motion.js';
import { ko, isKo } from "../locale.js";
import { HIERARCHY_INSPECTOR_TITLES } from "../app-stage.jsx";
import { PhysicsPanel } from "../ardy/physics-panel.jsx";
import { Field } from "../ui.jsx";
import ExtensionsNotice from "./ExtensionsNotice.jsx";

export default function RigControlPanel({
	isRigSelection, rigSelection, ikChains, ikFocus, footSnap, ikMode, toggleIkMode,
	collisionCleanupSupported, runFixCollisions, runFixCollisionsRange, motion, autoPhysicsRunning,
	physicsProgress, physicsPreview, physicsShow, physicsOptions, tlFrame, changePhysicsOptions,
	runAutoPhysics, showPhysicsPreview, applyPhysicsPreview, cancelPhysicsPreview, setTlFrame, ikEditTool,
	setIkEditTool, showTrails, setShowTrails, trailFalloffS, setTrailFalloffS, trailEdit, generationBusy,
	bridgeChecking, bridge, runTrailRegeneration, trailReadinessState, openMotionSetup, recheckMotionHealth,
}) {
	const { run } = useMotionCommands();
	return (
<Foldout hidden={!isRigSelection} title={ko("Rig Control", "리그 제어")}>
						<p className="inspector-hint">
							{rigSelection && rigSelection.token !== "rig"
							? (ko(`${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]} is the active control group.`, `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}이 활성 제어 그룹입니다.`, `当前控制部位：${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}。`))
							: ko("Choose a body group in the hierarchy, then manipulate its handle in the main view.", "계층에서 몸 그룹을 고른 뒤 메인 뷰의 핸들을 조작하세요.")}
						</p>
						<div className="inspector-status-grid">
						<span>{ko("Rig", "리그")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b>
						<span>{ko("Focus", "초점")}</span><b>{ikFocus ?? ko("None", "없음")}</b>
						<span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
						{ikMode ? ko("Finish rig editing", "리그 편집 끝내기") : ko("Edit rig with IK", "IK로 리그 편집")}
						</button>
						{/* Self-collision cleanup. Hidden outright on a rig whose capsule
						    proxies cannot be built: a button whose only answer is "not
						    supported" is worse than no button, and the hint below would
						    be describing something that cannot happen. */}
						{collisionCleanupSupported && (
							<>
								<button type="button" className="btn full" onClick={() => run('motion.fixCollisions', { scope: 'frame' })} disabled={!ikChains}>
								{ko("Fix body collisions (this frame)", "콜리전 수정 (이 프레임)")}
								</button>
								<button type="button" className="btn full" onClick={() => run('motion.fixCollisions', { scope: 'clip' })} disabled={!ikChains || !motion}>
								{ko("Fix body collisions (whole clip)", "콜리전 수정 (클립 전체)")}
								</button>
								<p className="inspector-hint">
								{ko("Pushes interpenetrating body parts apart with IK and keys the fix. Whole clip walks the loaded motion and keys only the frames that changed.", "콜리전 수정은 겹쳐 들어간 신체 파츠를 IK로 밀어내고 그 결과를 키로 남깁니다. 클립 전체는 로드된 모션을 훑으며 실제로 고쳐진 프레임만 키를 찍습니다.")}
								</p>
							</>
						)}
						{/* AutoPhysics needs the hips FK joint and the mass-model bones,
						    NOT the collision capsules — a rig without toe bases still
						    qualifies, so this button is deliberately outside the
						    collisionCleanupSupported gate. Unsupported rigs get an
						    explanatory toast from the handler. */}
						<PhysicsPanel ko={ko} disabled={!ikChains || !motion} running={autoPhysicsRunning} progress={physicsProgress}
							preview={physicsPreview} show={physicsShow} options={physicsOptions} frame={tlFrame} frames={motion?.frames ?? 1}
							onOptions={changePhysicsOptions} onRun={runAutoPhysics} onShow={showPhysicsPreview}
							onApply={applyPhysicsPreview} onCancel={cancelPhysicsPreview} onFrame={setTlFrame} />
						{/* GPU trajectory regeneration is an unconnected extension. */}
						{ikMode && motion && <ExtensionsNotice compact />}
					</Foldout>
	);
}

import { ko, isKo } from "../locale.js";
import { MotionReadiness } from "../motion-readiness-ui.jsx";
import { Field } from "../ui.jsx";
import { lineTrackLabel } from "../app-stage.jsx";
import { useMotionCommands } from '../domains/motion.js';

export default function TakeBarPanel({
	linePreviewUrl, takeSourceUrl, sceneDisabledReason, sceneMenuOpen, setSceneMenuOpen, refineDisabledReason,
	lineEditMode, enterRefineMode, readinessState, bridgeChecking, openMotionSetup, recheckMotionHealth,
	sceneGenerateDisabledReason, runArdy, sceneAgainDisabledReason, runSceneAgain, tlFrame, addSceneBlock,
	setToast, motion, preserveStrength, setPreserveStrength, waypointMode, preserveTracksLine, takeRecipe,
	takeVersions, loadTakeVersion, replayNotices,
}) {
	const { run } = useMotionCommands();
	return (
<div
				className="take-bar"
				data-line-preview={linePreviewUrl ? "true" : undefined}
				// The draft's url beside the take's own, so "the viewport swapped
				// but the take did not" is one comparison rather than an inference.
				data-line-preview-url={linePreviewUrl || undefined}
				data-take-source={takeSourceUrl || undefined}
			>
					<div className="take-modes" role="group" aria-label={ko("Take editing", "테이크 편집")}>
						{[
							{
								id: "scene",
								label: ko("Scene", "장면"),
								hint: ko("Kimodo — block it, redo it, extend it", "Kimodo — 새로 만들고, 다시 뽑고, 블록을 잇습니다"),
								reason: sceneDisabledReason(),
								active: sceneMenuOpen,
								onClick: () => setSceneMenuOpen((open) => !open),
							},
							{
								id: "refine",
								label: ko("Refine", "다듬기"),
								hint: ko("ProjFlow — grab the joint's path and pull", "ProjFlow — 관절 궤적을 잡아 끌어 다듬습니다"),
								reason: refineDisabledReason(),
								active: lineEditMode,
								onClick: enterRefineMode,
							},
						].map((entry) => (
							<div className="take-mode" key={entry.id}>
								<button
									type="button"
									className={"take-mode-btn" + (entry.active ? " active" : "") + (entry.reason ? " disabled" : "")}
									data-take-mode={entry.id}
									data-disabled-reason={entry.reason || undefined}
									aria-disabled={entry.reason ? "true" : undefined}
									aria-expanded={entry.id === "scene" ? sceneMenuOpen : undefined}
									title={entry.reason || entry.hint}
									onClick={entry.onClick}
								>
									{entry.label}
								</button>
								{/* The refusal is SAID, in place, before the click — never
								    only as a toast that arrives too late to teach anything. */}
								{entry.reason
									? <span className="take-mode-reason">{entry.reason}</span>
									: <span className="take-mode-hint">{entry.hint}</span>}
							</div>
						))}
					</div>
					{sceneMenuOpen && (
						<div className="take-scene-menu">
							<MotionReadiness state={readinessState} checking={bridgeChecking} onSetup={openMotionSetup} onRetry={recheckMotionHealth} />
							{[
								{ id: "new", label: ko("Start over", "새로 만들기"), reason: sceneGenerateDisabledReason(), onClick: () => runArdy({ fresh: true }) },
								{ id: "again", label: ko("Take it again", "다시 뽑기"), reason: sceneAgainDisabledReason(), onClick: runSceneAgain },
								{ id: "block", label: isKo ? `프레임 ${tlFrame}에 블록 추가` : `Add a block at frame ${tlFrame}`, reason: "", onClick: addSceneBlock },
							].map((action) => (
								<div className="take-scene-action" key={action.id}>
									<button
										type="button"
										className={"btn" + (action.reason ? " disabled" : "")}
										data-scene-action={action.id}
										data-disabled-reason={action.reason || undefined}
										aria-disabled={action.reason ? "true" : undefined}
										onClick={() => (action.reason ? setToast(action.reason) : action.onClick())}
									>
										{action.label}
									</button>
									{action.reason && <span className="take-mode-reason">{action.reason}</span>}
								</div>
							))}
							{/* Advanced: the two dials that decide how much of the loaded take a
							    regeneration keeps. Folded away because the default (half
							    preserved, whole body free) is the right answer almost
							    always, and a slider that is right by default should not be
							    the first thing on screen. */}
							{motion?.url && (
								<details className="take-scene-advanced">
									<summary>{ko("Advanced", "고급")}</summary>
									<Field label={ko("Keep the current take", "현재 테이크 유지")}>
										<div className="preserve-strength-row">
											<input
												type="range"
												data-preserve-strength
												min={0}
												max={1}
												step={0.05}
												value={preserveStrength}
												title={ko(
													"How hard the regeneration holds the loaded take outside the frames you edited.",
													"수정하지 않은 프레임에서 로드된 테이크를 얼마나 강하게 유지할지 정합니다.",
												)}
												onChange={(event) => setPreserveStrength(Number(event.target.value))}
											/>
											<span className="preserve-strength-value">{Math.round(preserveStrength * 100)}%</span>
										</div>
										{/* The two poles sit at the ends they actually mean: the
										    slider value IS the preserve strength, so 0 (left) is a
										    fresh take and 1 (right) holds the original hardest. */}
										<p className="inspector-hint preserve-strength-scale">
											<span>{ko("generate fresh", "새로 생성")}</span>
											<span>{ko("keep original", "원본 유지")}</span>
										</p>
										{/* Round 2 allows the pair the round-1 slider refused (contract
										    C3v2, paper 4.4), so this line no longer explains a disabled
										    control — it says which half of the take each authored surface
										    now owns. Only worth saying when preserving is actually on. */}
										{waypointMode && preserveStrength > 0 && (
											<p className="inspector-hint">
												{ko(
													"the drawn path replaces the root; the body keeps the take's style",
													"경로는 새로 그려지고, 동작 스타일은 원본을 유지해요",
												)}
											</p>
										)}
										{/* What the grouped mask will actually free. Empty whenever the
										    request would carry no `tracks`, and then nothing is said: the
										    whole-take wording above is already the truth. */}
										{preserveStrength > 0 && preserveTracksLine && (
											<p className="inspector-hint preserve-tracks-summary">{preserveTracksLine}</p>
										)}
									</Field>
									{takeRecipe && (
										<p className="inspector-hint take-recipe-summary">
											{/* A seedless recipe is an IMPORTED take: it checkpoints and reloads,
											    but it cannot be rebuilt or replayed, so the line says so rather
											    than printing "seed null". */}
											{isKo
												? `레시피 — 시드 ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "알 수 없음(불러온 테이크)"} · 블록 ${takeRecipe.blocks.length}개 · 다듬기 ${takeRecipe.lineEdits.length}개`
												: `Recipe — seed ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "unknown (imported take)"} · ${takeRecipe.blocks.length} block(s) · ${takeRecipe.lineEdits.length} refinement(s)`}
										</p>
									)}
								</details>
							)}
						</div>
					)}
					{/* Every successful run leaves a checkpoint here. Clicking one loads
					    that take back AND restores the recipe it was saved with; nothing
					    is ever dropped from the strip by loading, so an experiment can
					    always be walked back. */}
					{takeVersions.length > 0 && (
						<div className="take-version-strip" role="group" aria-label={ko("Take versions", "테이크 버전")}>
							{takeVersions.map((entry, index) => (
								<button
									type="button"
									key={entry.motionUrl}
									className={"take-version-chip" + (entry.motionUrl === takeSourceUrl ? " current" : "")}
									data-version-url={entry.motionUrl}
									data-version-current={entry.motionUrl === takeSourceUrl ? "true" : undefined}
									aria-pressed={entry.motionUrl === takeSourceUrl}
									title={`${entry.label} · ${new Date(entry.savedAt).toLocaleTimeString()}`}
									onClick={() => run('motion.loadVersion', { motionUrl: entry.motionUrl })}
								>
									<b>v{index + 1}</b>
									<small>{entry.label}</small>
								</button>
							))}
						</div>
					)}
					{/* C10's per-entry replay verdict. Non-blocking on purpose: the take
					    exists and is loaded, one refinement just did not survive the trip
					    onto it, and the artist decides whether that matters. */}
					{replayNotices.map((entry) => (
						<p className="replay-notice" key={`${entry.index}-${entry.track}`} data-replay-index={entry.index} data-replay-track={entry.track}>
							{entry.ok === false
								? (isKo
									? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 다시 적용되지 않았어요 — 나머지는 그대로 이어졌습니다${entry.error ? ` (${entry.error})` : ""}`
									: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) was not re-applied — the rest carried over${entry.error ? ` (${entry.error})` : ""}`)
								: (isKo
									? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 블록 경계에 걸쳐 있어요 — 결과가 이전과 조금 다를 수 있습니다`
									: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) straddles a block boundary — the result may differ slightly from before`)}
						</p>
					))}
				</div>
	);
}

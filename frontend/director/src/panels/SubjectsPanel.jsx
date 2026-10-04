import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { defaultCharacterTint } from "../app-stage.jsx";
import SubjectBox from "./SubjectBox.jsx";
import { useCastTransaction } from '../domains/cast.js';

export default function SubjectsPanel({
	isCharacterSelection, showB, characters, openStudio, posing,
}) {
	const { run, begin, commit, cancel } = useCastTransaction();
	return (
<Foldout hidden={!isCharacterSelection} title={showB ? ko("Subjects", "인물들") : ko("Subject", "인물")}>
						<div className={"subjects-row" + (showB ? "" : " single")} onBlur={commit} onPointerUp={commit} onPointerCancel={cancel}>
							{characters.map((entry, index) => entry.hidden ? null : (
								<div className="character-description" key={entry.id}>
								<SubjectBox
									key={entry.id}
									label={ko(`Subject ${index + 1}`, `인물 ${index + 1}`)}
									value={entry}
									onChange={(patch) => run('character.update', { characterId: entry.id, patch })}
									onPose={() => openStudio(entry.id)}
									posing={posing === entry.id}
									onRemove={index > 0 ? () => run('character.remove', { characterId: entry.id }) : undefined}
									color={entry.tint ?? defaultCharacterTint(entry, index)}
									/* A colour picker streams values while it is open, so the
									   whole picking session is one Ctrl+Z entry. */
									onColorEditStart={begin}
									onColorChange={(tint) => run('character.update', { characterId: entry.id, patch: { tint } })}
								/>
								<label htmlFor={`character-description-${entry.id}`}>{ko("Character description", "인물 설명", "角色描述")}</label>
								<textarea id={`character-description-${entry.id}`} data-testid={`character-description-${entry.id}`} value={entry.subject ?? ""}
									placeholder={ko("Describe your character; this text remains yours", "인물 설명을 입력하세요")}
									onFocus={begin} onChange={event => run('character.update', { characterId: entry.id, patch: { subject: event.target.value } })} />
								</div>
							))}
						</div>
						{!showB && (
							<button type="button" className="add-subject" onClick={() => run('cast.showExtras', { show: true })}>
								<span className="as-plus">＋</span>
								<span>{ko("Add second subject", "두 번째 인물 추가")}</span>
							</button>
						)}
					</Foldout>
	);
}

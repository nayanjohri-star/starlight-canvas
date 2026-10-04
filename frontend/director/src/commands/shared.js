// Helpers the command modules share. `ports` is the editor's one generic port
// object: its members are read at call time, so a run always reaches the
// latest handlers and `ports.state()` the synchronously published document.
import { StudioProtocolError } from "../studio-agent-protocol.js";

export const fail = (code, message) => { throw new StudioProtocolError(code, message); };

/** Ids of the rows added, changed or removed between two renders of a list. */
export const changedIds = (before, after) => [...new Set([
	...after.filter(row => !before.includes(row)).map(row => row.id),
	...before.filter(row => !after.some(next => next.id === row.id)).map(row => row.id),
])];

export const shotLabel = shot => `${shot.name} [${shot.startFrame}, ${shot.endFrame + 1})`;

export const shotOf = (ports, shotId) => ports.state().shots.find(shot => shot.id === shotId) ?? fail("STALE_TARGET", `Shot ${shotId} is not in this scene.`);

export const characterOf = (ports, characterId) => ports.state().characters.find(entry => entry.id === characterId)
	?? fail("STALE_TARGET", `Character ${characterId} is not in this scene.`);

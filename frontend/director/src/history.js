// Pure undo/redo stack and transaction coordinator. No scene knowledge and
// no React — node-importable so the transition invariants are unit-testable.

export const HISTORY_LIMIT = 50;

export function createHistory(present) {
	return { past: [], present, future: [] };
}

// `pushHistory` takes the NEW present. The reference-equality short-circuit
// is the coalescing primitive: `updateSceneObject` already returns the same
// array when nothing changed, so a no-op drag or a patch aimed at a deleted
// id can never create an entry.
export function pushHistory(history, next) {
	if (next === history.present) return history;
	const past = [...history.past, history.present];
	if (past.length > HISTORY_LIMIT) past.shift();
	return { past, present: next, future: [] };
}

export function undoHistory(history) {
	if (history.past.length === 0) return null;
	const present = history.past[history.past.length - 1];
	return {
		past: history.past.slice(0, -1),
		present,
		future: [history.present, ...history.future],
	};
}

export function redoHistory(history) {
	if (history.future.length === 0) return null;
	const [present, ...future] = history.future;
	return {
		past: [...history.past, history.present],
		present,
		future,
	};
}

export function canUndo(history) {
	return history.past.length > 0;
}

export function canRedo(history) {
	return history.future.length > 0;
}

// ---------------------------------------------------------------- tx ----
//
// `cancel` is teardown-only by contract: it must not call back into the
// coordinator (`endTransaction`/`settleTransaction`). The coordinator owns
// the close — it retires the token BEFORE running `cancel`, so a close
// attempted from inside `cancel` is inert (unit-asserted).

export function createTransactions() {
	return { current: null, nextToken: 1 };
}

// Settles any already-open transaction first: the previous owner's cancel
// runs and the close is owned by the coordinator, not by the new begin.
export function beginTransaction(tx, { owner, cancel }) {
	if (tx.current !== null) settleTransaction(tx);
	const token = tx.nextToken;
	tx.nextToken += 1;
	tx.current = { token, owner, cancel };
	return token;
}

export function isCurrentTransaction(tx, token) {
	return tx.current !== null && tx.current.token === token;
}

// False for a stale token — a resumed pointer stream after a settle is
// inert by construction rather than by hope.
export function endTransaction(tx, token) {
	if (!isCurrentTransaction(tx, token)) return false;
	tx.current = null;
	return true;
}

// Retires the token before running cancel, so a close attempted from
// inside cancel is inert; returns what the settle closed.
export function settleTransaction(tx) {
	if (tx.current === null) return null;
	const current = tx.current;
	tx.current = null;
	if (typeof current.cancel === "function") current.cancel();
	return { token: current.token, owner: current.owner };
}

import { chineseLabel } from "./locale-zh-cn.js";

// This hosted director starts in Chinese. A saved English or Korean choice
// remains authoritative. Only UI literals passed through ko() are translated;
// user prompts, project names and asset names are never passed through it.
const KEY = "cozyclay.locale";

function stored() {
	try {
		const value = localStorage.getItem(KEY);
		return ["zh-CN", "ko", "en"].includes(value) ? value : null;
	} catch {
		return null;
	}
}

export const LOCALE = stored() ?? "zh-CN";
export const isKo = LOCALE === "ko";
export const isZh = LOCALE === "zh-CN";
export const localeChosen = stored() !== null;

/** Pick the label for the active locale: ko("Frame", "프레임"). */
export function ko(en, koText, zhText) {
	return isKo ? (koText ?? en) : isZh ? (zhText ?? chineseLabel(en)) : en;
}

export function setLocale(next) {
	if (!["zh-CN", "ko", "en"].includes(next)) return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Storage may be unavailable; reloading keeps the safe Chinese default.
	}
	window.location.reload();
}

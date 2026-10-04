export const PWA_UPDATE_EVENT = "cozyclay:pwa-update-ready";

function announceUpdate(registration) {
	window.dispatchEvent(new CustomEvent(PWA_UPDATE_EVENT, { detail: registration }));
}

export function registerPwa() {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
	if (globalThis.__COZYCLAY_RUNTIME__?.distribution === "npm") {
		void navigator.serviceWorker.getRegistrations().then((registrations) => (
			Promise.all(registrations.map((registration) => registration.unregister()))
		));
		return;
	}

	let hasController = Boolean(navigator.serviceWorker.controller);
	let reloading = false;

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hasController) {
			hasController = true;
			return;
		}
		if (reloading) return;
		reloading = true;
		window.location.reload();
	});

	window.addEventListener("load", async () => {
		try {
			const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
				scope: import.meta.env.BASE_URL,
			});

			if (registration.waiting) announceUpdate(registration);
			registration.addEventListener("updatefound", () => {
				const worker = registration.installing;
				worker?.addEventListener("statechange", () => {
					if (worker.state === "installed" && navigator.serviceWorker.controller) {
						announceUpdate(registration);
					}
				});
			});
		} catch {
			return;
		}
	}, { once: true });
}

import { useState, useRef, useEffect } from "react";

export default function Foldout({ title, hidden, defaultOpen = true, openSignal = 0, children }) {
	const [open, setOpen] = useState(defaultOpen);
	const cardRef = useRef(null);
	// A collapsed panel must still be reachable from elsewhere: selecting a
	// prompt block on the timeline has to reveal the panel that edits it, or
	// the click looks like it did nothing. Opening alone is not enough — the
	// panel can sit below the fold of a long Inspector — so it is scrolled into
	// view as well. The signal only ever opens; it never closes a panel.
	useEffect(() => {
		if (openSignal <= 0) return undefined;
		setOpen(true);
		// One frame later: the body has to exist before it can be scrolled to.
		const raf = requestAnimationFrame(() => {
			cardRef.current?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(raf);
	}, [openSignal]);
	return (
		<section ref={cardRef} className={"card foldout" + (open ? " open" : "")} hidden={hidden}>
			<h3>
				<button type="button" className="foldout-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
					<span className="foldout-arrow" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
					<span className="foldout-title">{title}</span>
				</button>
			</h3>
			{open && <div className="foldout-body">{children}</div>}
		</section>
	);
}

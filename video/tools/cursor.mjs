// A visible mouse pointer for recordings. Playwright's mouse never moves the real pointer, so this
// draws one in the page that follows Playwright's mouse events and pulses on clicks.
export const CURSOR_SCRIPT = `(() => {
	if (window.__demoCursor || !document.body) return;
	const cursor = document.createElement("div");
	cursor.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.8 L13.2 17 L21.5 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>';
	Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", width: "26px", height: "30px", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.4))" });
	const ring = cursor.querySelector("span");
	Object.assign(ring.style, { position: "absolute", left: "-15px", top: "-15px", width: "36px", height: "36px", borderRadius: "50%", border: "3px solid rgba(139,108,255,.9)", opacity: "0", transform: "scale(.4)", transition: "opacity .35s, transform .35s" });
	document.body.appendChild(cursor);
	window.__demoCursor = cursor;
	const move = (event) => { cursor.style.transform = "translate(" + event.clientX + "px," + event.clientY + "px)"; };
	window.addEventListener("mousemove", move, true);
	window.addEventListener("pointermove", move, true);
	window.addEventListener("mousedown", (event) => {
		move(event);
		ring.style.transition = "none"; ring.style.opacity = "1"; ring.style.transform = "scale(.4)";
		requestAnimationFrame(() => { ring.style.transition = "opacity .45s, transform .45s"; ring.style.opacity = "0"; ring.style.transform = "scale(1.3)"; });
	}, true);
})();`;

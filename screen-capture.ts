import { remote } from "electron";
import { type App, Scope } from "obsidian";

// A drag smaller than this, in either direction, is taken as a click, which cancels.
const MIN_SELECTION_SIZE = 6;

// Takes a picture of the Obsidian window that shows `doc`, freezes it on screen, and lets the user
// drag a box around a formula. Resolves with the boxed part of the picture as a PNG, or null when
// the user cancels with Escape, a right-click or a plain click.
export async function selectScreenArea(app: App, doc: Document): Promise<Blob | null> {
	const capture = await electronWindowOf(doc).webContents.capturePage();
	if (capture.isEmpty()) {
		throw new Error("Obsidian returned an empty screenshot.");
	}

	const url = URL.createObjectURL(new Blob([capture.toPNG()], { type: "image/png" }));
	try {
		return await dragOverPicture(app, doc, url);
	} finally {
		URL.revokeObjectURL(url);
	}
}

// Every Obsidian window, popouts included, has its own copy of Electron's module that knows which
// window it belongs to.
function electronWindowOf(doc: Document) {
	const win = doc.win as Window & { require?: (id: "electron") => typeof import("electron") };
	try {
		return win.require?.("electron").remote.getCurrentWindow() ?? remote.getCurrentWindow();
	} catch {
		return remote.getCurrentWindow();
	}
}

function dragOverPicture(app: App, doc: Document, pictureUrl: string): Promise<Blob | null> {
	return new Promise((resolve, reject) => {
		const overlay = doc.body.createDiv({ cls: "mathlive-capture-overlay" });
		const picture = overlay.createEl("img", { cls: "mathlive-capture-picture", attr: { src: pictureUrl, alt: "" } });
		overlay.createDiv({ cls: "mathlive-capture-shade" });
		const box = overlay.createDiv({ cls: "mathlive-capture-box" });
		overlay.createDiv({
			cls: "mathlive-capture-hint",
			text: "Drag a box around the formula to scan it. Press Esc to cancel.",
		});

		let start: { x: number; y: number } | null = null;
		let current = { x: 0, y: 0 };
		let finished = false;

		const selection = () => {
			if (!start) {
				return null;
			}
			return {
				left: Math.min(start.x, current.x),
				top: Math.min(start.y, current.y),
				width: Math.abs(current.x - start.x),
				height: Math.abs(current.y - start.y),
			};
		};

		const finish = (result: Blob | null | Error) => {
			if (finished) {
				return;
			}
			finished = true;
			app.keymap.popScope(scope);
			doc.win.removeEventListener("keydown", onKeyDown, true);
			overlay.detach();
			if (result instanceof Error) {
				reject(result);
			} else {
				resolve(result);
			}
		};

		// A scope of its own keeps Obsidian's hotkeys, and Escape closing an open editor window,
		// away while the picture is up.
		const scope = new Scope();
		scope.register([], "Escape", () => {
			finish(null);
			return false;
		});
		app.keymap.pushScope(scope);
		// And typing away from the note under the picture.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		doc.win.addEventListener("keydown", onKeyDown, true);

		overlay.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			finish(null);
		});

		overlay.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			overlay.setPointerCapture(event.pointerId);
			start = { x: event.clientX, y: event.clientY };
			current = start;
			overlay.addClass("is-selecting");
			drawBox();
		});

		overlay.addEventListener("pointermove", (event) => {
			if (!start) {
				return;
			}
			current = { x: event.clientX, y: event.clientY };
			drawBox();
		});

		overlay.addEventListener("pointerup", (event) => {
			if (!start || event.button !== 0) {
				return;
			}
			current = { x: event.clientX, y: event.clientY };
			const area = selection();
			if (!area || area.width < MIN_SELECTION_SIZE || area.height < MIN_SELECTION_SIZE) {
				finish(null);
				return;
			}
			cropPicture(picture, overlay, area).then(finish, (error: unknown) =>
				finish(error instanceof Error ? error : new Error(String(error)))
			);
		});

		const drawBox = () => {
			const area = selection();
			if (!area) {
				return;
			}
			box.setCssProps({
				"--mathlive-capture-left": `${area.left}px`,
				"--mathlive-capture-top": `${area.top}px`,
				"--mathlive-capture-width": `${area.width}px`,
				"--mathlive-capture-height": `${area.height}px`,
			});
		};

		picture.addEventListener("error", () => finish(new Error("Couldn't show the screenshot.")));
	});
}

// Cuts the selected area out of the full-size picture. The picture has the screen's real pixels,
// which can be more than the window's CSS pixels on high-density screens or with zoom.
async function cropPicture(
	picture: HTMLImageElement,
	overlay: HTMLElement,
	area: { left: number; top: number; width: number; height: number }
): Promise<Blob> {
	await picture.decode();
	const scaleX = picture.naturalWidth / overlay.clientWidth;
	const scaleY = picture.naturalHeight / overlay.clientHeight;
	const sx = Math.max(0, Math.round(area.left * scaleX));
	const sy = Math.max(0, Math.round(area.top * scaleY));
	const width = Math.min(picture.naturalWidth - sx, Math.round(area.width * scaleX));
	const height = Math.min(picture.naturalHeight - sy, Math.round(area.height * scaleY));

	const canvas = createEl("canvas");
	canvas.width = Math.max(1, width);
	canvas.height = Math.max(1, height);
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Couldn't crop the screenshot.");
	}
	context.drawImage(picture, sx, sy, width, height, 0, 0, canvas.width, canvas.height);
	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't crop the screenshot."))), "image/png");
	});
}

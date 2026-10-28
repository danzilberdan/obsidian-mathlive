import { remote, shell } from "electron";
import { type App, Modal, Platform, Scope } from "obsidian";

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

// How long the window manager gets to take Obsidian off the screen before the picture is taken.
const HIDE_DELAY_MS = 350;
const MACOS_SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

// Whether the whole screen, other apps included, can be pictured: not by Obsidian versions without
// Electron's desktopCapturer, and on macOS only once Obsidian has Screen Recording access.
export async function wholeScreenAccess(): Promise<"ok" | "unsupported" | "needs-access"> {
	const { BrowserWindow, desktopCapturer, screen } = remote;
	if (!BrowserWindow || !desktopCapturer || !screen) {
		return "unsupported";
	}
	if (Platform.isMacOS && !(await hasMacScreenAccess())) {
		return "needs-access";
	}
	return "ok";
}

// Like selectScreenArea, but for anything on the screen, other apps included: Obsidian's windows
// step aside, the whole display Obsidian was on is pictured, and the box is drawn on a full-screen
// copy of that picture. Check wholeScreenAccess first.
export async function selectAnywhereOnScreen(doc: Document): Promise<Blob | null> {
	const { BrowserWindow, desktopCapturer, screen } = remote;
	if (!BrowserWindow || !desktopCapturer || !screen) {
		throw new Error("This version of Obsidian can't picture the screen.");
	}
	const win = electronWindowOf(doc);
	const display = screen.getDisplayMatching(win.getBounds());
	// Popouts step aside too, so nothing of Obsidian's covers what the user wants to scan.
	const hidden = BrowserWindow.getAllWindows().filter((other) => other.isVisible());
	let picture: import("electron").NativeImage | undefined;
	for (const other of hidden) {
		other.hide();
	}
	try {
		await sleep(HIDE_DELAY_MS);
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: {
				width: Math.round(display.size.width * display.scaleFactor),
				height: Math.round(display.size.height * display.scaleFactor),
			},
		});
		picture = (sources.find((source) => source.display_id === String(display.id)) ?? sources[0])?.thumbnail;
		if (!picture || picture.isEmpty()) {
			throw new Error("The screen picture came back empty.");
		}
		const area = await pickOnPicture(BrowserWindow, display.bounds, picture.toDataURL());
		if (!area) {
			return null;
		}
		const size = picture.getSize();
		const crop = picture.crop({
			x: Math.round(area.x * size.width),
			y: Math.round(area.y * size.height),
			width: Math.max(1, Math.round(area.width * size.width)),
			height: Math.max(1, Math.round(area.height * size.height)),
		});
		return new Blob([crop.toPNG()], { type: "image/png" });
	} finally {
		for (const other of hidden) {
			if (!other.isDestroyed()) {
				other.show();
			}
		}
		win.focus();
	}
}

// macOS only lets apps picture other apps with Screen Recording access. Asking for sources makes
// macOS show its own prompt the first time and lists Obsidian in System Settings.
async function hasMacScreenAccess(): Promise<boolean> {
	const status = remote.systemPreferences?.getMediaAccessStatus?.("screen");
	if (status === "granted") {
		return true;
	}
	if (status === "not-determined") {
		await remote.desktopCapturer?.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
	}
	return false;
}

// How to give Obsidian Screen Recording access on macOS, offered after a scan of Obsidian's own
// window.
export class ScreenAccessModal extends Modal {

	onOpen() {
		this.setTitle("Let Obsidian see other apps");
		this.contentEl.createEl("p", {
			text: "To scan formulas in other apps, macOS needs to give Obsidian Screen Recording access. MathLive only takes a picture when you start a scan, and only the box you draw is sent to the scanner.",
		});
		const steps = this.contentEl.createEl("ol");
		steps.createEl("li", { text: "Open System Settings -> Privacy & Security -> Screen Recording." });
		steps.createEl("li", { text: "Turn on Obsidian." });
		steps.createEl("li", { text: "Quit and reopen Obsidian. Scans from the screen then reach other apps too." });

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Not now" }).addEventListener("click", () => this.close());
		actions
			.createEl("button", { cls: "mod-cta", text: "Open System Settings" })
			.addEventListener("click", () => {
				void shell.openExternal(MACOS_SCREEN_SETTINGS);
				this.close();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// The full-screen window that shows the picture of the display and lets the user drag a box on it.
// It is a plain page with no access to Obsidian or Node, and answers with the box as fractions of
// the picture, or null when cancelled.
const PICKER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:#000;font-family:system-ui,sans-serif}
#picture{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
#shade{position:fixed;inset:0;background:rgba(0,0,0,.35)}
#box{display:none;position:fixed;outline:2px solid #7c5cff;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
#hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:8px;background:#fff;color:#222;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none}
body.selecting #shade,body.selecting #hint{display:none}body.selecting #box{display:block}
</style></head><body><img id="picture" alt=""><div id="shade"></div><div id="box"></div>
<div id="hint">Drag a box around the formula to scan it. Press Esc to cancel.</div></body></html>`;

// Runs inside the picker page. Kept as a string so it can't reach anything of the plugin's.
const PICKER_SCRIPT = `(src) => new Promise((resolve) => {
	const picture = document.getElementById("picture");
	const box = document.getElementById("box");
	let start = null;
	let current = null;
	const area = () => ({
		left: Math.min(start.x, current.x), top: Math.min(start.y, current.y),
		width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y),
	});
	const done = (result) => { window.onkeydown = window.onpointerdown = window.onpointermove = window.onpointerup = window.oncontextmenu = null; resolve(result); };
	picture.src = src;
	window.onkeydown = (event) => { if (event.key === "Escape") done(null); };
	window.oncontextmenu = (event) => { event.preventDefault(); done(null); };
	window.onpointerdown = (event) => {
		if (event.button !== 0) return;
		document.body.setPointerCapture(event.pointerId);
		start = current = { x: event.clientX, y: event.clientY };
		document.body.classList.add("selecting");
	};
	window.onpointermove = (event) => {
		if (!start) return;
		current = { x: event.clientX, y: event.clientY };
		const a = area();
		Object.assign(box.style, { left: a.left + "px", top: a.top + "px", width: a.width + "px", height: a.height + "px" });
	};
	window.onpointerup = (event) => {
		if (!start || event.button !== 0) return;
		current = { x: event.clientX, y: event.clientY };
		const a = area();
		if (a.width < ${MIN_SELECTION_SIZE} || a.height < ${MIN_SELECTION_SIZE}) return done(null);
		done({ x: a.left / innerWidth, y: a.top / innerHeight, width: a.width / innerWidth, height: a.height / innerHeight });
	};
})`;

interface PickedArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function pickOnPicture(
	BrowserWindow: NonNullable<typeof remote.BrowserWindow>,
	bounds: import("electron").Rectangle,
	pictureUrl: string
): Promise<PickedArea | null> {
	const picker = new BrowserWindow({
		...bounds,
		frame: false,
		show: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		enableLargerThanScreen: true,
		backgroundColor: "#000000",
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	try {
		// Above the menu bar, the dock and the taskbar.
		picker.setAlwaysOnTop(true, "screen-saver");
		await picker.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PICKER_PAGE));
		picker.show();
		picker.focus();
		const closed = new Promise<null>((resolve) => picker.once("closed", () => resolve(null)));
		const picked = picker.webContents.executeJavaScript(`(${PICKER_SCRIPT})(${JSON.stringify(pictureUrl)})`, true);
		const area = await Promise.race([picked, closed]);
		return isPickedArea(area) ? area : null;
	} finally {
		if (!picker.isDestroyed()) {
			picker.destroy();
		}
	}
}

function isPickedArea(value: unknown): value is PickedArea {
	const area = value as Partial<PickedArea> | null;
	return (
		typeof area?.x === "number" &&
		typeof area.y === "number" &&
		typeof area.width === "number" &&
		typeof area.height === "number"
	);
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

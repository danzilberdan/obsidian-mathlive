import type { MathfieldElement } from "mathlive";
import { App, Modal, Notice, Platform, requestUrl, setIcon } from "obsidian";
import type { PhoneLink, PhoneWindow } from "./phone-link";
import qrcode from "qrcode-generator";
import {
	afterCloudScan,
	askForAccount,
	buildMultipartBody,
	createMathfield,
	ensureCanScan,
	errorCode,
	serverDetail,
	scanImageToLatex,
	scannerHeaders,
	scannerAddress,
	ScanError,
	type ScanTarget,
} from "./mathlive-shared";
import type { PluginSettings } from "./settings";

// Draw formula: a window with a drawing pad, and beside it a QR code that pairs a phone or tablet
// (the website's /draw page). Each drawing is read by the scanner's handwriting models as a free
// preview; inserting the formula costs one scan. The pad reads through a short draw session that
// ends with the window. The phone stays paired (phone-link.ts): while this window is open its
// previews show here and its formula goes into this window's formula; otherwise into whichever
// formula is open. With Self-hosted scanner on, there's only the pad, read by the user's own scanner.

type Point = [number, number];
type Stroke = { points: Point[]; width: number };
type Frame = { x: number; y: number; width: number; height: number; scale: number };

// Read the drawing this long after the pen lifts.
const READ_AFTER_MS = 800;
const INK = 3;
// What the handwriting models read best (the website's phone page does the same).
const MARGIN = 24;
const MIN_SIDE = 300;
const MAX_SIDE = 1024;
const MAX_ASPECT = 2;

// Where the picture of the strokes comes from: cropped to them with a margin, at most twice as
// wide as tall (or tall as wide), and 300 to 1024 pixels a side.
export function frameFor(strokes: Stroke[]): Frame | null {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const stroke of strokes) {
		const half = stroke.width / 2;
		for (const [x, y] of stroke.points) {
			left = Math.min(left, x - half);
			top = Math.min(top, y - half);
			right = Math.max(right, x + half);
			bottom = Math.max(bottom, y + half);
		}
	}
	if (!Number.isFinite(left)) {
		return null;
	}
	let width = right - left + 2 * MARGIN;
	let height = bottom - top + 2 * MARGIN;
	if (width > height * MAX_ASPECT) {
		height = width / MAX_ASPECT;
	} else if (height > width * MAX_ASPECT) {
		width = height / MAX_ASPECT;
	}
	const scale = Math.min(MAX_SIDE / Math.max(width, height), Math.max(MIN_SIDE / Math.min(width, height), 1));
	return { x: (left + right) / 2 - width / 2, y: (top + bottom) / 2 - height / 2, width, height, scale };
}

function trace(context: CanvasRenderingContext2D, stroke: Stroke) {
	const [first, ...rest] = stroke.points;
	if (!first) {
		return;
	}
	context.lineWidth = stroke.width;
	context.beginPath();
	context.moveTo(first[0], first[1]);
	if (rest.length === 0) {
		context.lineTo(first[0] + 0.01, first[1]);
	}
	for (const [x, y] of rest) {
		context.lineTo(x, y);
	}
	context.stroke();
}

// Dark ink on white, sized for the models.
async function drawingPng(strokes: Stroke[]): Promise<Blob | null> {
	const frame = frameFor(strokes);
	if (!frame) {
		return null;
	}
	const canvas = createEl("canvas");
	canvas.width = Math.round(frame.width * frame.scale);
	canvas.height = Math.round(frame.height * frame.scale);
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.setTransform(frame.scale, 0, 0, frame.scale, -frame.x * frame.scale, -frame.y * frame.scale);
	context.strokeStyle = "#000000";
	context.lineCap = "round";
	context.lineJoin = "round";
	for (const stroke of strokes) {
		trace(context, stroke);
	}
	return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

interface Session {
	id: string;
}

// Open windows, so unloading the plugin can end their sessions.
const openWindows = new Set<DrawModal>();

export function endDrawSessions() {
	for (const modal of Array.from(openWindows)) {
		modal.endSession();
	}
}

export interface DrawOptions {
	settings: PluginSettings;
	phoneLink: PhoneLink;
	// Where the formula goes.
	target: ScanTarget;
	// Where formulas from the phone go once the target has closed, such as the note in use now.
	fallback?: () => ScanTarget | null;
}

// Opens the Draw formula window, after getting a key (a trial, or by connecting) when needed.
export async function openDrawWindow(app: App, options: DrawOptions): Promise<void> {
	const resume = () => {
		if (options.target.isOpen()) {
			void openDrawWindow(app, options);
		}
	};
	if (!(await ensureCanScan(options.settings, resume))) {
		return;
	}
	new DrawModal(app, options).open();
}

export class DrawModal extends Modal implements PhoneWindow {
	private strokes: Stroke[] = [];
	private current: Stroke | null = null;
	private pad?: HTMLCanvasElement;
	private mathfield?: MathfieldElement;
	private hintEl?: HTMLElement;
	private phoneEl?: HTMLElement;
	private insertButton?: HTMLButtonElement;
	private session: Session | null = null;
	private opening: Promise<Session | null> | null = null;
	private readTimer: number | null = null;
	// Answers that arrive after the drawing changed again are dropped.
	private readNumber = 0;
	private shown = false;
	private inserting = false;
	private stopWatchingPhone: (() => void) | null = null;
	private readonly onResize = () => this.redraw();

	constructor(app: App, private readonly options: DrawOptions) {
		super(app);
	}

	private get settings() {
		return this.options.settings;
	}

	private get cloud() {
		return !this.settings.useLocalInference;
	}

	private url(path: string) {
		return scannerAddress(this.settings) + path;
	}

	private get headers() {
		return scannerHeaders(this.settings, "drawing");
	}

	onOpen() {
		this.shown = true;
		this.setTitle("Draw formula");
		this.modalEl.addClass("mathlive-draw-modal");
		const layout = this.contentEl.createDiv({ cls: "mathlive-draw-layout" });
		const main = layout.createDiv({ cls: "mathlive-draw-main" });

		this.pad = main.createEl("canvas", { cls: "mathlive-draw-pad", attr: { "aria-label": "Drawing pad" } });
		this.pad.addEventListener("pointerdown", (event) => this.onPointerDown(event));
		this.pad.addEventListener("pointermove", (event) => this.onPointerMove(event));
		this.pad.addEventListener("pointerup", () => this.onPointerUp());
		this.pad.addEventListener("pointercancel", () => this.onPointerUp());

		const preview = main.createDiv({ cls: "mathlive-draw-preview" });
		this.mathfield = createMathfield({ initialValue: "", inline: false });
		this.mathfield.addClass("mathlive-draw-field");
		this.mathfield.addEventListener("input", () => this.updateInsertButton());
		preview.appendChild(this.mathfield);
		this.hintEl = main.createDiv({ cls: "mathlive-draw-hint", text: "Draw a formula with your mouse, pen or finger." });

		const actions = main.createDiv({ cls: "mathlive-draw-actions" });
		const button = (text: string, icon: string, onClick: () => void, cta = false) => {
			const el = actions.createEl("button", { cls: cta ? "mod-cta" : "", attr: { type: "button" } });
			setIcon(el.createSpan({ cls: "mathlive-btn-icon" }), icon);
			el.createSpan({ text });
			el.addEventListener("click", onClick);
			return el;
		};
		button("Undo", "undo-2", () => this.undo());
		button("Clear", "eraser", () => this.clear());
		this.insertButton = button("Insert", "corner-down-left", () => void this.insert(), true);
		this.updateInsertButton();
		this.scope.register(["Mod"], "Enter", () => {
			void this.insert();
			return false;
		});

		openWindows.add(this);
		if (this.cloud) {
			// The paired phone's previews and formulas come to this window while it's open.
			this.options.phoneLink.window = this;
			if (!Platform.isMobile) {
				this.phoneEl = layout.createDiv({ cls: "mathlive-draw-phone" });
				this.stopWatchingPhone = this.options.phoneLink.onChange(() => this.renderPhone());
				this.renderPhone();
			}
		}

		this.contentEl.win.addEventListener("resize", this.onResize);
		// Size the pad once the window has its size.
		this.contentEl.win.requestAnimationFrame(() => this.redraw());
	}

	onClose() {
		this.shown = false;
		this.contentEl.win.removeEventListener("resize", this.onResize);
		if (this.readTimer !== null) {
			window.clearTimeout(this.readTimer);
			this.readTimer = null;
		}
		this.stopWatchingPhone?.();
		this.stopWatchingPhone = null;
		if (this.options.phoneLink.window === this) {
			this.options.phoneLink.window = null;
		}
		openWindows.delete(this);
		this.endSession();
	}

	// Ends the pad's session on the server.
	endSession() {
		const session = this.session;
		this.session = null;
		if (session) {
			void requestUrl({
				url: this.url(`/draw/sessions/${session.id}/close`),
				method: "POST",
				headers: this.headers,
				throw: false,
			}).catch(() => null);
		}
	}

	// --- Drawing ---

	private point(event: PointerEvent): Point {
		const box = this.pad?.getBoundingClientRect();
		return [event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0)];
	}

	private onPointerDown(event: PointerEvent) {
		if (!this.pad || event.button > 0) {
			return;
		}
		this.pad.setPointerCapture(event.pointerId);
		this.cancelRead();
		this.current = { points: [this.point(event)], width: INK };
		this.paintStroke(this.current);
	}

	private onPointerMove(event: PointerEvent) {
		if (!this.current) {
			return;
		}
		const events = event.getCoalescedEvents?.() ?? [event];
		for (const each of events.length > 0 ? events : [event]) {
			this.current.points.push(this.point(each));
		}
		this.paintStroke(this.current);
	}

	private onPointerUp() {
		if (!this.current) {
			return;
		}
		this.strokes.push(this.current);
		this.current = null;
		this.scheduleRead();
	}

	private paintStroke(stroke: Stroke) {
		const context = this.pad?.getContext("2d");
		if (!this.pad || !context) {
			return;
		}
		context.strokeStyle = this.pad.win.getComputedStyle(this.pad).color;
		context.lineCap = "round";
		context.lineJoin = "round";
		trace(context, stroke);
	}

	// Draws every stroke again at the screen's resolution, such as after a resize or Undo.
	private redraw() {
		const pad = this.pad;
		const context = pad?.getContext("2d");
		if (!pad || !context) {
			return;
		}
		const ratio = pad.win.devicePixelRatio || 1;
		const box = pad.getBoundingClientRect();
		pad.width = Math.round(box.width * ratio);
		pad.height = Math.round(box.height * ratio);
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, box.width, box.height);
		for (const stroke of this.strokes) {
			this.paintStroke(stroke);
		}
	}

	private undo() {
		this.strokes.pop();
		this.redraw();
		if (this.strokes.length === 0) {
			this.clear();
			return;
		}
		this.scheduleRead();
	}

	private clear() {
		this.strokes = [];
		this.redraw();
		this.cancelRead();
		this.readNumber++;
		if (this.mathfield) {
			this.mathfield.value = "";
		}
		this.setHint("Draw a formula with your mouse, pen or finger.");
		this.updateInsertButton();
	}

	private cancelRead() {
		if (this.readTimer !== null) {
			window.clearTimeout(this.readTimer);
			this.readTimer = null;
		}
	}

	private scheduleRead() {
		this.cancelRead();
		this.readTimer = window.setTimeout(() => {
			this.readTimer = null;
			void this.readDrawing();
		}, READ_AFTER_MS);
	}

	private setHint(text: string) {
		this.hintEl?.setText(text);
	}

	private updateInsertButton() {
		if (this.insertButton) {
			this.insertButton.disabled = this.inserting || !this.mathfield?.value.trim();
		}
	}

	private showLatex(latex: string) {
		if (!this.mathfield) {
			return;
		}
		this.mathfield.value = latex;
		this.setHint("");
		this.updateInsertButton();
	}

	private async readDrawing() {
		const number = ++this.readNumber;
		const image = await drawingPng(this.strokes);
		if (!image || number !== this.readNumber) {
			return;
		}
		this.setHint("Reading…");
		try {
			const latex = this.cloud ? await this.recognize(image) : await scanImageToLatex(this.settings, image, "drawing");
			if (number === this.readNumber && this.shown && latex !== null) {
				this.showLatex(latex);
			}
		} catch (error) {
			if (number !== this.readNumber || !this.shown) {
				return;
			}
			const failure = error instanceof ScanError ? error.failure : "unavailable";
			if (failure === "auth" || failure === "no_scans_left") {
				this.setHint("");
				askForAccount(this.settings, failure, () => this.scheduleRead());
			} else if (failure === "no_math") {
				this.setHint("Keep drawing: no formula found yet.");
			} else {
				this.setHint(error instanceof DrawError ? error.message : "Couldn't read the drawing. Check your connection.");
			}
		}
	}

	// A free preview from the cloud scanner's handwriting models.
	private async recognize(image: Blob, retried = false): Promise<string | null> {
		const session = await this.ensureSession();
		if (!session) {
			return null;
		}
		const { body, contentType } = await buildMultipartBody("file", image);
		const res = await requestUrl({
			url: this.url(`/draw/sessions/${session.id}/recognize`),
			method: "POST",
			contentType,
			headers: this.headers,
			body,
			throw: false,
		});
		if (res.status === 410 && !retried) {
			// The session ended, such as after sitting idle: start another and try again.
			this.sessionEnded(session.id);
			return await this.recognize(image, true);
		}
		if (res.status >= 400) {
			throw drawFailure(res);
		}
		const latex = (res.json as { latex?: unknown }).latex;
		if (typeof latex !== "string") {
			throw new DrawError("Couldn't read the drawing. Try again.");
		}
		return latex;
	}

	// --- Inserting ---

	private insertFormula(latex: string, fromPhone: boolean) {
		const target = this.options.target.isOpen() ? this.options.target : this.options.fallback?.();
		if (!target?.isOpen()) {
			new Notice(this.options.target.closedMessage);
			return;
		}
		target.insert(latex);
		if (fromPhone) {
			new Notice("Formula from your phone added. Your phone stays paired: draw there any time.");
		}
	}

	// --- The paired phone ---

	phonePreview(latex: string) {
		if (!this.shown) {
			return;
		}
		this.cancelRead();
		this.readNumber++;
		this.showLatex(latex);
	}

	phoneInserted(latex: string) {
		this.insertFormula(latex, true);
		if (this.shown) {
			this.close();
		}
	}

	private async insert() {
		const latex = this.mathfield?.value.trim() ?? "";
		if (!latex || this.inserting) {
			return;
		}
		if (!this.cloud || !this.session) {
			// Nothing was read by the cloud scanner, such as LaTeX typed into the preview: free.
			this.insertFormula(latex, false);
			this.close();
			return;
		}
		const session = this.session;
		this.inserting = true;
		this.updateInsertButton();
		try {
			const res = await requestUrl({
				url: this.url(`/draw/sessions/${session.id}/insert`),
				method: "POST",
				contentType: "application/json",
				headers: this.headers,
				body: JSON.stringify({ latex }),
				throw: false,
			});
			const code = errorCode(res);
			if (res.status === 200 || code === "nothing_to_insert" || res.status === 410) {
				// Charged, or nothing drawn was read so it's free. The server ended the session.
				if (res.status === 200) {
					afterCloudScan(this.settings);
				} else {
					this.endSession();
				}
				this.session = null;
				this.insertFormula(latex, false);
				this.close();
				return;
			}
			if (code === "no_scans_left" || code === "invalid_api_key" || code === "missing_api_key") {
				askForAccount(this.settings, code === "no_scans_left" ? "no_scans_left" : "auth", () => void this.insert());
				return;
			}
			new Notice(drawFailure(res).message);
		} catch (error) {
			console.error("MathLive: couldn't insert the drawn formula:", error);
			new Notice("Couldn't reach MathLive. Check your connection and try again.");
		} finally {
			this.inserting = false;
			this.updateInsertButton();
		}
	}

	// --- The session and the phone ---

	private ensureSession(): Promise<Session | null> {
		if (this.session) {
			return Promise.resolve(this.session);
		}
		if (!this.opening) {
			this.opening = this.openSession().finally(() => {
				this.opening = null;
			});
		}
		return this.opening;
	}

	private async openSession(): Promise<Session | null> {
		let res;
		try {
			res = await requestUrl({ url: this.url("/draw/sessions"), method: "POST", headers: this.headers, throw: false });
		} catch (error) {
			console.error("MathLive: couldn't start drawing:", error);
			throw new DrawError("Couldn't reach MathLive. Check your connection.");
		}
		const code = errorCode(res);
		if (code === "no_scans_left" || code === "invalid_api_key" || code === "missing_api_key") {
			askForAccount(this.settings, code === "no_scans_left" ? "no_scans_left" : "auth", () => {
				if (this.shown) {
					this.scheduleRead();
				}
			});
			return null;
		}
		const reply = res.status === 200 ? (res.json as Partial<Session>) : null;
		if (!reply || typeof reply.id !== "string") {
			throw new DrawError(
				res.status === 404 ? "This scanner can't read drawings." : "Couldn't start drawing. Try again in a minute."
			);
		}
		this.session = { id: reply.id };
		if (!this.shown) {
			// The window closed while the session opened.
			this.endSession();
			return null;
		}
		return this.session;
	}

	private sessionEnded(id: string) {
		if (this.session?.id === id) {
			this.session = null;
		}
	}

	private renderPhone() {
		const el = this.phoneEl;
		if (el) {
			renderPhonePanel(el, this.options.phoneLink, "this formula");
		}
	}
}

// The phone side of Draw formula: a QR code that pairs a phone, or the phone that's paired.
// `into` says where the phone's formulas go, such as "this formula".
export function renderPhonePanel(el: HTMLElement, link: PhoneLink, into: string) {
	el.empty();
	el.createDiv({ cls: "mathlive-draw-phone-title", text: "Draw on your phone or tablet" });
	const box = el.createDiv({ cls: "mathlive-draw-qr-box" });
	const note = el.createDiv({ cls: "mathlive-draw-phone-note" });
	const pairing = link.pairing;
	if (pairing) {
		box.addClass("is-connected");
		setIcon(box.createDiv({ cls: "mathlive-draw-connected-icon" }), "smartphone");
		note.setText(
			`Paired with ${pairing.device ? `your ${pairing.device}` : "your phone"}. Draw there and tap Insert: it goes into ${into}.`
		);
		const actions = el.createDiv({ cls: "mathlive-draw-phone-actions" });
		const unpair = actions.createEl("button", { text: "Unpair", attr: { type: "button" } });
		unpair.addEventListener("click", () => void link.unpair());
		return;
	}
	const waiting = link.pendingCode;
	if (waiting) {
		renderQr(box, waiting.phoneUrl);
		note.setText("Scan once with your phone's camera. It stays paired, so next time just draw. Nothing to install.");
		return;
	}
	box.addClass("is-loading");
	note.setText("Making a code…");
	link.newCode().then(
		() => {
			if (el.isConnected) {
				renderPhonePanel(el, link, into);
			}
		},
		(error: unknown) => {
			if (!el.isConnected) {
				return;
			}
			box.removeClass("is-loading");
			box.addClass("is-ended");
			note.setText(error instanceof Error ? error.message : "Couldn't make a code. Try again.");
			const again = el.createEl("button", { text: "Try again", attr: { type: "button" } });
			again.addEventListener("click", () => renderPhonePanel(el, link, into));
		}
	);
}

// Pairs a phone from the settings, or shows the one paired.
export class PairPhoneModal extends Modal {
	private stop: (() => void) | null = null;

	constructor(app: App, private readonly link: PhoneLink) {
		super(app);
	}

	onOpen() {
		this.setTitle("Draw on your phone or tablet");
		this.modalEl.addClass("mathlive-pair-modal");
		const panel = this.contentEl.createDiv({ cls: "mathlive-draw-phone" });
		let wasPaired = this.link.pairing !== null;
		const render = () => {
			renderPhonePanel(panel, this.link, "the formula you have open, or at the cursor");
			const paired = this.link.pairing !== null;
			if (paired && !wasPaired) {
				this.contentEl.createDiv({
					cls: "mathlive-draw-phone-note",
					text: "Done. On the phone, add the page to your home screen to open it any time.",
				});
			}
			wasPaired = paired;
		};
		this.stop = this.link.onChange(render);
		render();
	}

	onClose() {
		this.stop?.();
		this.contentEl.empty();
	}
}

class DrawError extends Error {}

function drawFailure(res: { status: number; json: unknown }): Error {
	const code = errorCode(res);
	switch (code) {
		case "no_scans_left":
			return new ScanError("no_scans_left", "No scans left.");
		case "invalid_api_key":
		case "missing_api_key":
			return new ScanError("auth", "The API key was refused.");
		case "no_math":
			return new ScanError("no_math", "No formula found yet.");
		case "preview_limit":
			return new DrawError("That's a lot of tries for one formula. Insert it, or clear the pad and start again.");
		case "rate_limited":
			return new DrawError("Drawing a bit fast for the scanner. Wait a moment.");
		case "daily_limit":
			return new DrawError(serverDetail(res) ?? "That's today's limit for drawing. It starts over at midnight UTC.");
	}
	return new DrawError("Couldn't read the drawing. Try again.");
}

// The QR code as an SVG, made here so no image is fetched from anywhere.
function renderQr(parent: HTMLElement, url: string) {
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();
	const count = qr.getModuleCount();
	const quiet = 4;
	const size = count + quiet * 2;
	const svg = parent.createSvg("svg", {
		cls: "mathlive-draw-qr",
		attr: { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "QR code to draw on your phone", "data-url": url },
	});
	svg.createSvg("rect", { cls: "mathlive-draw-qr-bg", attr: { width: size, height: size } });
	let path = "";
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (qr.isDark(row, col)) {
				path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
			}
		}
	}
	svg.createSvg("path", { cls: "mathlive-draw-qr-ink", attr: { d: path } });
}

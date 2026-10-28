import type { MathfieldElement } from "mathlive";
import { App, Modal, Notice, Platform, requestUrl, setIcon } from "obsidian";
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
	scannerAddress,
	ScanError,
	type ScanTarget,
} from "./mathlive-shared";
import type { PluginSettings } from "./settings";

// Draw formula: a window with a drawing pad, and beside it a QR code that opens the same drawing
// on a phone (the website's /draw page). Each drawing is read by the scanner's handwriting models
// as a free preview; inserting the formula costs one scan. The phone's previews and inserts reach
// this window through a long poll with requestUrl, which stops when the session ends.
// With Self-hosted scanner on, there's only the pad, read by the user's own scanner.

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
// After a network error, wait this long before listening again.
const RETRY_AFTER_MS = 2000;

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

interface DrawEvent {
	type: "phone_connected" | "preview" | "inserted" | "out_of_scans" | "closed";
	latex?: string;
	source?: "pad" | "phone" | "photo";
}

interface WaitReply {
	events: DrawEvent[];
	next: number;
	closed: boolean;
}

interface Session {
	id: string;
	phoneUrl: string;
}

// Windows whose phone may still send formulas after the window closed, so unloading the plugin
// can end them.
const listening = new Set<DrawModal>();

export function endDrawSessions() {
	for (const modal of Array.from(listening)) {
		modal.endSession();
	}
}

export interface DrawOptions {
	settings: PluginSettings;
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

export class DrawModal extends Modal {
	private strokes: Stroke[] = [];
	private current: Stroke | null = null;
	private pad?: HTMLCanvasElement;
	private mathfield?: MathfieldElement;
	private hintEl?: HTMLElement;
	private phoneEl?: HTMLElement;
	private insertButton?: HTMLButtonElement;
	private session: Session | null = null;
	private opening: Promise<Session | null> | null = null;
	// The session being listened to; listening stops when it changes.
	private listeningTo: string | null = null;
	private readTimer: number | null = null;
	// Answers that arrive after the drawing changed again are dropped.
	private readNumber = 0;
	private shown = false;
	private phoneInserted = false;
	private inserting = false;
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
		return { "Api-Key": this.settings.apiKey ?? "" };
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

		if (this.cloud && !Platform.isMobile) {
			this.phoneEl = layout.createDiv({ cls: "mathlive-draw-phone" });
		}
		if (this.cloud) {
			void this.ensureSession();
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
		// After the phone inserted a formula, it may keep drawing: keep listening for it until the
		// session ends. Otherwise closing the window ends the session.
		if (!this.phoneInserted) {
			this.endSession();
		}
	}

	// Stops listening and tells the server, which tells the phone.
	endSession() {
		listening.delete(this);
		const session = this.session;
		this.session = null;
		this.listeningTo = null;
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
			const latex = this.cloud ? await this.recognize(image) : await scanImageToLatex(this.settings, image);
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
			new Notice(
				this.phoneInserted
					? "Formula from your phone added."
					: "Formula from your phone added. Keep drawing on your phone to add more."
			);
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
				this.listeningTo = null;
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
		this.renderPhone({ kind: "loading" });
		let res;
		try {
			res = await requestUrl({ url: this.url("/draw/sessions"), method: "POST", headers: this.headers, throw: false });
		} catch (error) {
			console.error("MathLive: couldn't start drawing:", error);
			this.renderPhone({ kind: "error", message: "Couldn't reach MathLive. Check your connection." });
			throw new DrawError("Couldn't reach MathLive. Check your connection.");
		}
		const code = errorCode(res);
		if (code === "no_scans_left" || code === "invalid_api_key" || code === "missing_api_key") {
			this.renderPhone({ kind: "error", message: "Get more scans to keep drawing." });
			askForAccount(this.settings, code === "no_scans_left" ? "no_scans_left" : "auth", () => {
				if (this.shown) {
					void this.ensureSession();
				}
			});
			return null;
		}
		const reply = res.status === 200 ? (res.json as Partial<Session>) : null;
		if (!reply || typeof reply.id !== "string" || typeof reply.phoneUrl !== "string") {
			const message =
				res.status === 404 ? "This scanner can't read drawings." : "Couldn't start drawing. Try again in a minute.";
			this.renderPhone({ kind: "error", message });
			throw new DrawError(message);
		}
		if (!this.shown) {
			// The window closed while the session opened.
			this.session = { id: reply.id, phoneUrl: reply.phoneUrl };
			this.endSession();
			return null;
		}
		this.session = { id: reply.id, phoneUrl: reply.phoneUrl };
		this.renderPhone({ kind: "code", url: reply.phoneUrl });
		void this.listen(this.session);
		return this.session;
	}

	private async listen(session: Session) {
		this.listeningTo = session.id;
		listening.add(this);
		let after = 0;
		while (this.listeningTo === session.id) {
			let res;
			try {
				res = await requestUrl({
					url: this.url(`/draw/sessions/${session.id}/wait?after=${after}`),
					headers: this.headers,
					throw: false,
				});
			} catch {
				await sleep(RETRY_AFTER_MS);
				continue;
			}
			if (this.listeningTo !== session.id) {
				return;
			}
			if (res.status === 410 || res.status === 403) {
				this.sessionEnded(session.id);
				return;
			}
			if (res.status !== 200) {
				await sleep(RETRY_AFTER_MS);
				continue;
			}
			const reply = res.json as WaitReply;
			after = reply.next;
			for (const event of reply.events) {
				this.onEvent(event);
			}
			if (reply.closed) {
				this.sessionEnded(session.id);
				return;
			}
		}
	}

	private onEvent(event: DrawEvent) {
		switch (event.type) {
			case "phone_connected":
				if (this.shown) {
					this.renderPhone({ kind: "connected" });
				}
				break;
			case "preview":
				if (this.shown && event.latex) {
					this.cancelRead();
					this.readNumber++;
					this.showLatex(event.latex);
				}
				break;
			case "inserted":
				if (event.source !== "pad" && event.latex) {
					this.insertFormula(event.latex, true);
					this.phoneInserted = true;
					afterCloudScan(this.settings);
					if (this.shown) {
						this.close();
					}
				}
				break;
			case "out_of_scans":
				askForAccount(this.settings, "no_scans_left", () => {});
				break;
			case "closed":
				break;
		}
	}

	private sessionEnded(id: string) {
		if (this.session?.id !== id) {
			return;
		}
		this.session = null;
		this.listeningTo = null;
		listening.delete(this);
		if (this.shown) {
			this.renderPhone({ kind: "ended" });
		}
	}

	private renderPhone(
		state:
			| { kind: "loading" }
			| { kind: "code"; url: string }
			| { kind: "connected" }
			| { kind: "ended" }
			| { kind: "error"; message: string }
	) {
		const el = this.phoneEl;
		if (!el) {
			return;
		}
		el.empty();
		el.createDiv({ cls: "mathlive-draw-phone-title", text: "Draw on your phone or tablet" });
		const box = el.createDiv({ cls: "mathlive-draw-qr-box" });
		const note = el.createDiv({ cls: "mathlive-draw-phone-note" });
		switch (state.kind) {
			case "loading":
				box.addClass("is-loading");
				note.setText("Making a code…");
				break;
			case "code":
				renderQr(box, state.url);
				note.setText("Scan with your phone's camera. Nothing to install, no sign-in.");
				break;
			case "connected": {
				box.addClass("is-connected");
				setIcon(box.createDiv({ cls: "mathlive-draw-connected-icon" }), "smartphone");
				note.setText("Phone connected. Draw there, or keep drawing here.");
				break;
			}
			case "ended":
			case "error": {
				box.addClass("is-ended");
				note.setText(state.kind === "ended" ? "This code has ended." : state.message);
				const again = el.createEl("button", { text: "Show a new code", attr: { type: "button" } });
				again.addEventListener("click", () => void this.ensureSession().catch(() => null));
				break;
			}
		}
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

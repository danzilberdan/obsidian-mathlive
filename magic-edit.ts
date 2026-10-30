// Magic edit: the user types or says what to change in a formula, and the MathLive server has an
// AI rewrite its LaTeX. A box opens under the formula with a text field and a mic; the result
// replaces the formula, and Undo puts the old one back. Costs a scan only when the formula changes.
import { Notice, Platform, requestUrl, setIcon } from "obsidian";
import { ensureCanScan, errorCode, scanAccountHooks, scannerAddress, scannerHeaders } from "./mathlive-shared";
import type { PluginSettings } from "./settings";

const EDIT_TIMEOUT_MS = 45_000;
// Recordings stop on their own after this long; an instruction is a sentence or two.
const MAX_RECORDING_MS = 60_000;
// Loudest moment, as RMS of the samples, below which a recording is taken to have no speech and is
// never sent. Speech into a laptop mic peaks well above 0.05; a quiet room stays under 0.005.
const SPEECH_LEVEL = 0.012;
const PLACEHOLDER = "Type or say a change, like “square it”";

// The formula a Magic edit changes.
export interface MagicEditTarget {
	settings: PluginSettings;
	getLatex(): string;
	setLatex(latex: string): void;
	// False once the formula has closed, so a late answer has nowhere to go.
	isOpen(): boolean;
	// Shimmers while the AI works.
	busyEl?: HTMLElement;
}

class EditError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

interface EditAnswer {
	latex: string;
	done: boolean;
	note: string;
	heard: string;
}

type Instruction = { text: string } | { audio: Blob };

async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

async function requestEdit(settings: PluginSettings, latex: string, instruction: Instruction): Promise<EditAnswer> {
	const body =
		"text" in instruction
			? { latex, instruction: instruction.text }
			: { latex, audio: await blobToBase64(instruction.audio), audio_type: instruction.audio.type };
	let timer = 0;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new EditError("timeout", "The edit took too long.")), EDIT_TIMEOUT_MS);
	});
	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url: scannerAddress(settings) + "/edit",
				method: "POST",
				contentType: "application/json",
				headers: scannerHeaders(settings),
				body: JSON.stringify(body),
				throw: false,
			}),
			timeout,
		]);
	} catch (error) {
		if (error instanceof EditError) {
			throw error;
		}
		throw new EditError("unavailable", error instanceof Error ? error.message : String(error));
	} finally {
		window.clearTimeout(timer);
	}
	if (res.status >= 400) {
		const code = errorCode(res) ?? (res.status === 404 || res.status === 405 ? "edit_unavailable" : "unavailable");
		let detail = "";
		try {
			const value = (res.json as { detail?: unknown } | null)?.detail;
			detail = typeof value === "string" ? value : "";
		} catch {
			// Not JSON, like a self-hosted scanner's 404 page.
		}
		throw new EditError(code, detail || `Edit failed with status ${res.status}.`);
	}
	let answer: Partial<EditAnswer> | null;
	try {
		answer = res.json as Partial<EditAnswer> | null;
	} catch {
		answer = null;
	}
	if (typeof answer?.latex !== "string" || typeof answer.done !== "boolean") {
		throw new EditError("unavailable", "The edit came back without a formula.");
	}
	return {
		latex: answer.latex,
		done: answer.done,
		note: typeof answer.note === "string" ? answer.note : "",
		heard: typeof answer.heard === "string" ? answer.heard : "",
	};
}

function failureMessage(code: string, error: unknown): string {
	switch (code) {
		case "edit_unavailable":
		case "voice_unavailable":
			return "This scanner can't do Magic edit. Turn off Self-hosted scanner in Settings → MathLive to use the MathLive scanner.";
		case "rate_limited":
			return "Too many edits in a short time. Wait a minute and try again. Nothing was charged.";
		case "timeout":
		case "unavailable":
			return "Couldn't reach MathLive. Check your connection and try again. Nothing was charged.";
	}
	// The server's own words, which say what went wrong and that nothing was charged.
	return error instanceof Error && error.message ? error.message : "Couldn't edit the formula. Try again.";
}

// Records from the microphone and watches the level, so a recording without speech is never sent.
class Recorder {
	private chunks: Blob[] = [];
	private peak = 0;
	private frame = 0;
	private readonly started = Date.now();

	private constructor(
		private readonly win: Window,
		private readonly stream: MediaStream,
		private readonly recorder: MediaRecorder,
		private readonly context: AudioContext,
		private readonly analyser: AnalyserNode,
		private readonly onTick: (level: number, elapsedMs: number) => void,
		private readonly onLimit: () => void
	) {
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) {
				this.chunks.push(event.data);
			}
		});
		recorder.start();
		this.tick();
	}

	static async start(
		win: Window,
		onTick: (level: number, elapsedMs: number) => void,
		onLimit: () => void
	): Promise<Recorder> {
		const stream = await win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		// Opus in WebM on desktop; Safari and the iPhone app record AAC in MP4.
		const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) =>
			MediaRecorder.isTypeSupported(type)
		);
		const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
		const context = new AudioContext();
		const analyser = context.createAnalyser();
		analyser.fftSize = 1024;
		context.createMediaStreamSource(stream).connect(analyser);
		return new Recorder(win, stream, recorder, context, analyser, onTick, onLimit);
	}

	private tick() {
		const samples = new Float32Array(this.analyser.fftSize);
		this.analyser.getFloatTimeDomainData(samples);
		let sum = 0;
		for (const sample of samples) {
			sum += sample * sample;
		}
		const level = Math.sqrt(sum / samples.length);
		this.peak = Math.max(this.peak, level);
		const elapsed = Date.now() - this.started;
		this.onTick(level, elapsed);
		if (elapsed >= MAX_RECORDING_MS) {
			this.onLimit();
			return;
		}
		this.frame = this.win.requestAnimationFrame(() => this.tick());
	}

	// The recording, or null when nothing in it was loud enough to be speech.
	async stop(): Promise<Blob | null> {
		const stopped = new Promise<void>((resolve) => this.recorder.addEventListener("stop", () => resolve(), { once: true }));
		if (this.recorder.state !== "inactive") {
			this.recorder.stop();
		}
		await stopped;
		this.release();
		if (this.peak < SPEECH_LEVEL || this.chunks.length === 0) {
			return null;
		}
		return new Blob(this.chunks, { type: this.recorder.mimeType || "audio/webm" });
	}

	cancel() {
		if (this.recorder.state !== "inactive") {
			this.recorder.stop();
		}
		this.release();
	}

	private release() {
		this.win.cancelAnimationFrame(this.frame);
		this.stream.getTracks().forEach((track) => track.stop());
		void this.context.close().catch(() => undefined);
	}
}

// The box: a text field, a mic and an apply button, with a line under them that says what
// happened and offers Undo. `onClose` runs when Escape is pressed.
export class MagicEditBox {
	readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly micButton: HTMLButtonElement;
	private readonly applyButton: HTMLButtonElement;
	private readonly meter: HTMLElement;
	private readonly status: HTMLElement;
	private recorder: Recorder | null = null;
	private busy = false;
	private closed = false;
	// Formulas before each edit, newest last, for Undo.
	private readonly history: string[] = [];

	constructor(
		parent: HTMLElement,
		private readonly target: MagicEditTarget,
		private readonly onClose?: () => void
	) {
		this.el = parent.createDiv({ cls: "mathlive-magic-edit" });
		const row = this.el.createDiv({ cls: "mathlive-magic-edit-row" });
		setIcon(row.createSpan({ cls: "mathlive-magic-edit-icon" }), "wand-sparkles");
		this.input = row.createEl("input", {
			cls: "mathlive-magic-edit-input",
			attr: {
				type: "text",
				placeholder: PLACEHOLDER,
				enterkeyhint: "go",
			},
		});
		this.meter = row.createDiv({ cls: "mathlive-magic-edit-meter" });
		this.meter.createDiv();
		this.micButton = row.createEl("button", {
			cls: "mathlive-magic-edit-mic clickable-icon",
			attr: { type: "button", "aria-label": "Speak the change" },
		});
		setIcon(this.micButton, "mic");
		this.applyButton = row.createEl("button", {
			cls: "mathlive-magic-edit-apply clickable-icon",
			attr: { type: "button", "aria-label": "Apply" },
		});
		setIcon(this.applyButton, "corner-down-left");
		this.status = this.el.createDiv({ cls: "mathlive-magic-edit-status" });

		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && !event.ctrlKey && !event.metaKey) {
				event.preventDefault();
				event.stopPropagation();
				if (this.recorder) {
					void this.finishRecording();
				} else {
					this.submitTyped();
				}
			} else if (event.key === "Escape" && this.onClose) {
				event.preventDefault();
				event.stopPropagation();
				this.onClose();
			}
		});
		this.micButton.addEventListener("click", () => {
			if (this.recorder) {
				void this.finishRecording();
			} else {
				void this.startRecording();
			}
		});
		this.applyButton.addEventListener("click", () => {
			if (this.recorder) {
				void this.finishRecording();
			} else {
				this.submitTyped();
			}
		});
	}

	focus() {
		this.input.focus();
	}

	// Closes the box the way Escape does.
	dismiss() {
		if (this.onClose) {
			this.onClose();
		} else {
			this.close();
		}
	}

	// Stops listening. The box can be thrown away afterwards.
	close() {
		this.closed = true;
		this.recorder?.cancel();
		this.recorder = null;
		this.target.busyEl?.removeClass("mathlive-is-scanning");
	}

	private setBusy(busy: boolean) {
		this.busy = busy;
		this.el.toggleClass("is-busy", busy);
		this.input.disabled = busy;
		this.micButton.disabled = busy;
		this.applyButton.disabled = busy;
		this.target.busyEl?.toggleClass("mathlive-is-scanning", busy);
	}

	private showStatus(text: string, kind: "info" | "error" = "info", undo = false) {
		this.status.empty();
		this.status.toggleClass("is-error", kind === "error");
		if (text) {
			this.status.createSpan({ cls: "mathlive-magic-edit-status-text", text });
		}
		if (undo && this.history.length > 0) {
			const button = this.status.createEl("button", {
				cls: "mathlive-magic-edit-undo",
				text: "Undo",
				attr: { type: "button" },
			});
			button.addEventListener("click", () => this.undo());
		}
	}

	private undo() {
		const previous = this.history.pop();
		if (previous === undefined || !this.target.isOpen()) {
			return;
		}
		this.target.setLatex(previous);
		this.showStatus("Undone.", "info", true);
		this.focus();
	}

	private submitTyped() {
		const text = this.input.value.trim();
		if (!text) {
			this.showStatus("Type what to change, or click the mic and say it.");
			this.focus();
			return;
		}
		void this.run({ text });
	}

	private async startRecording() {
		if (this.busy) {
			return;
		}
		if (!this.target.settings.useLocalInference && !this.target.settings.apiKey?.trim()) {
			// Get a key first, so nobody talks only to be asked to connect.
			if (!(await ensureCanScan(this.target.settings, () => void this.startRecording()))) {
				return;
			}
		}
		try {
			this.recorder = await Recorder.start(
				this.el.win,
				(level, elapsed) => {
					this.meter.firstElementChild?.toggleClass("is-loud", level >= SPEECH_LEVEL);
					this.meter.setCssProps({ "--mathlive-magic-level": `${Math.min(1, level * 8)}` });
					this.showStatus(`Listening… ${Math.floor(elapsed / 1000)} s. Click the mic again or press Enter when you're done.`);
				},
				() => void this.finishRecording()
			);
		} catch (error) {
			console.error("MathLive: couldn't use the microphone:", error);
			const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
			this.showStatus(
				denied
					? Platform.isMacOS
						? "MathLive can't use the microphone. Allow Obsidian in System Settings → Privacy & Security → Microphone, then try again."
						: "MathLive can't use the microphone. Allow microphone access for Obsidian, then try again."
					: "No microphone found. Type the change instead.",
				"error"
			);
			return;
		}
		if (this.closed) {
			this.recorder.cancel();
			this.recorder = null;
			return;
		}
		this.el.addClass("is-recording");
		this.micButton.setAttribute("aria-label", "Stop and apply");
		setIcon(this.micButton, "square");
		this.input.placeholder = "Listening…";
	}

	private async finishRecording() {
		const recorder = this.recorder;
		if (!recorder) {
			return;
		}
		this.recorder = null;
		this.el.removeClass("is-recording");
		this.micButton.setAttribute("aria-label", "Speak the change");
		setIcon(this.micButton, "mic");
		this.input.placeholder = PLACEHOLDER;
		const audio = await recorder.stop();
		if (this.closed) {
			return;
		}
		if (!audio) {
			this.showStatus("I didn't hear anything. Check your microphone, or type the change.", "error");
			this.focus();
			return;
		}
		await this.run({ audio });
	}

	private async run(instruction: Instruction) {
		if (this.busy || this.closed) {
			return;
		}
		const resume = () => void this.run(instruction);
		if (!(await ensureCanScan(this.target.settings, resume))) {
			return;
		}
		const before = this.target.getLatex();
		this.setBusy(true);
		this.showStatus("text" in instruction ? "Editing…" : "Listening to what you said…");
		let answer: EditAnswer;
		try {
			answer = await requestEdit(this.target.settings, before, instruction);
		} catch (error) {
			this.setBusy(false);
			if (this.closed) {
				return;
			}
			const code = error instanceof EditError ? error.code : "unavailable";
			console.error("MathLive: magic edit failed:", error);
			const account = scanAccountHooks();
			const accountProblem = code === "missing_api_key" || code === "invalid_api_key" || code === "no_scans_left";
			if (accountProblem && !this.target.settings.useLocalInference && account) {
				this.showStatus("");
				account.needsAccount(code === "no_scans_left" ? "no_scans_left" : "auth", resume);
				return;
			}
			this.showStatus(failureMessage(code, error), "error", true);
			this.focus();
			return;
		}
		this.setBusy(false);
		if (this.closed) {
			return;
		}
		if (!this.target.isOpen()) {
			new Notice("The formula was closed before the edit finished.");
			return;
		}
		// What was understood from a recording, so a mishearing is easy to spot.
		const heard = answer.heard ? `“${answer.heard.replace(/[.!]+$/, "")}” ` : "";
		if (!answer.done) {
			this.showStatus(heard + (answer.note || "I couldn't tell what to change. Try saying it another way."), "error", true);
			this.focus();
			return;
		}
		if (answer.latex.trim() === before.trim()) {
			this.showStatus(heard + "The formula already looks like that.", "info", true);
			this.focus();
			return;
		}
		this.history.push(before);
		this.target.setLatex(answer.latex);
		this.input.value = "";
		this.showStatus(heard + "Done.", "info", true);
		this.focus();
		if (!this.target.settings.useLocalInference) {
			scanAccountHooks()?.afterScan();
		}
	}
}

// Opens Magic edit in a box floating under `anchor`, such as a formula in a note. Closes on Escape
// or a click outside it (or on `trigger`, the button that opened it), and when the formula goes
// away. With `host`, such as the editor window, the box floats inside it so it belongs to that
// window and never changes its size.
export function openMagicEditPopover(
	anchor: HTMLElement,
	target: MagicEditTarget,
	options: { host?: HTMLElement; trigger?: HTMLElement; onClose?: () => void } = {}
): MagicEditBox {
	const doc = anchor.doc;
	const { host, trigger } = options;
	doc.querySelectorAll(".mathlive-magic-edit-popover").forEach((open) => open.dispatchEvent(new CustomEvent("mathlive-close")));
	const popover = (host ?? doc.body).createDiv({ cls: "mathlive-magic-edit-popover" });
	popover.toggleClass("is-inside", Boolean(host));
	let box: MagicEditBox | null = null;
	const close = () => {
		if (!popover.isConnected) {
			return;
		}
		box?.close();
		popover.remove();
		doc.removeEventListener("mousedown", onOutside, true);
		doc.win.removeEventListener("resize", close);
		options.onClose?.();
	};
	const onOutside = (event: MouseEvent) => {
		const clicked = event.target;
		if (clicked instanceof Node && (popover.contains(clicked) || anchor.contains(clicked) || trigger?.contains(clicked))) {
			return;
		}
		close();
	};
	box = new MagicEditBox(popover, { ...target, isOpen: () => target.isOpen() && popover.isConnected }, close);
	popover.addEventListener("mathlive-close", close);

	const rect = anchor.getBoundingClientRect();
	const frame = host?.getBoundingClientRect() ?? {
		left: 0,
		top: 0,
		width: doc.documentElement.clientWidth,
		height: doc.documentElement.clientHeight,
	};
	const width = Math.min(420, frame.width - 16);
	const left = Math.max(8, Math.min(rect.left - frame.left, frame.width - width - 8));
	const below = rect.bottom - frame.top + 6;
	const top = below + 90 > frame.height ? Math.max(8, rect.top - frame.top - 96) : below;
	popover.setCssProps({
		"--mathlive-magic-left": `${left}px`,
		"--mathlive-magic-top": `${top}px`,
		"--mathlive-magic-width": `${width}px`,
	});
	doc.addEventListener("mousedown", onOutside, true);
	doc.win.addEventListener("resize", close);
	box.focus();
	return box;
}

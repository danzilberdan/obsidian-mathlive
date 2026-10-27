import type { MathfieldElement } from "mathlive";
import { type App, type Menu, Notice, requestUrl, setIcon } from "obsidian";
import { FONT_FILES } from "./mathlive-fonts";
import { ScreenAccessModal, selectAnywhereOnScreen, selectScreenArea, wholeScreenAccess } from "./screen-capture";
import { DEFAULT_SETTINGS, type PluginSettings } from "./settings";

type MathfieldElementCtor = typeof import("mathlive")["MathfieldElement"];
let mathfieldElementCtor: MathfieldElementCtor | null = null;
let mathliveLoadPromise: Promise<MathfieldElementCtor> | null = null;
const fontDocuments = new WeakSet<Document>();

// Registers MathLive's bundled fonts with the FontFace API. MathLive skips its own font
// loading because styles.css sets --ML__static-fonts.
export function registerMathliveFonts(doc: Document) {
	if (fontDocuments.has(doc)) {
		return;
	}
	fontDocuments.add(doc);

	for (const [family, source, styleName, weight] of FONT_FILES) {
		const face = new FontFace(family, `url("${source}") format("woff2")`, {
			display: "swap",
			style: styleName,
			weight,
		});
		doc.fonts.add(face);
	}
}

function shouldSuppressMathliveImportError(args: unknown[]): boolean {
	const [firstArg] = args;

	if (Array.isArray(firstArg)) {
		return firstArg.some(
			(entry) =>
				typeof entry === "string" &&
				(entry.includes("getFileUrl") || entry.includes("node_modules/mathlive/dist/mathlive"))
		);
	}

	if (typeof firstArg === "string") {
		return (
			firstArg.includes("Can't use relative paths to specify assets location") ||
			firstArg.includes('Invalid URL "./fonts"') ||
			firstArg.includes("source file location could not be determined")
		);
	}

	return false;
}

async function loadMathfieldElement(): Promise<MathfieldElementCtor> {
	if (mathfieldElementCtor) {
		return mathfieldElementCtor;
	}

	if (!mathliveLoadPromise) {
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			if (shouldSuppressMathliveImportError(args)) {
				return;
			}
			originalConsoleError(...args);
		};

		mathliveLoadPromise = import(
			/* webpackMode: "eager" */ "mathlive"
		)
			.then((mathliveModule) => {
				mathfieldElementCtor = mathliveModule.MathfieldElement;
				return mathfieldElementCtor;
			})
			.finally(() => {
				console.error = originalConsoleError;
			});
	}

	return mathliveLoadPromise;
}

export interface ParsedSelection {
	initialLatex: string;
	resultRenderTemplate: (result: string) => string;
}

export interface MathfieldConfig {
	initialValue: string;
	inline: boolean;
	id?: string;
	onInput?: (value: string) => void;
}

export const CLOUD_OCR_AUTH_NOTICE = "Open Settings → MathLive and click Connect to scan images.";

// What scanning needs from the plugin's account: a key before the first scan, and a way to ask
// the user to connect when the scanner refuses one. Set by the plugin while it is loaded.
export interface ScanAccount {
	ensureKey(resume: () => void): Promise<boolean>;
	needsAccount(reason: "auth" | "no_scans_left", resume: () => void): void;
	afterScan(): void;
}

let scanAccount: ScanAccount | null = null;

export function setScanAccount(account: ScanAccount | null) {
	scanAccount = account;
}

export async function ensureMathfieldElementRegistered(doc: Document = activeDocument) {
	const loaded = await loadMathfieldElement();
	registerMathliveFonts(doc);

	if (customElements.get("math-field") === undefined) {
		customElements.define("math-field", loaded);
	}

	// After the plugin is disabled and enabled again (or updated), the tag stays bound to the
	// class from the first load, and only that class can be constructed.
	const MathfieldElement = customElements.get("math-field") as MathfieldElementCtor;
	MathfieldElement.fontsDirectory = null;
	MathfieldElement.soundsDirectory = null;
	mathfieldElementCtor = MathfieldElement;
}

export function parseMathSelection(
	selectionText: string,
	inline: boolean
): ParsedSelection {
	if (selectionText.length === 0) {
		const wrapper = inline ? "$" : "$$";
		return {
			resultRenderTemplate: (result) =>
				result.length > 0 ? `${wrapper}${result}${wrapper}` : "",
			initialLatex: "",
		};
	}

	const mathPreviewStartIndex = selectionText.indexOf("$$");
	if (mathPreviewStartIndex >= 0) {
		const mathPreviewEndIndex = selectionText.indexOf(
			"$$",
			mathPreviewStartIndex + 2
		);
		if (mathPreviewEndIndex >= 0) {
			return {
				resultRenderTemplate: (result) =>
					selectionText.substring(0, mathPreviewStartIndex) +
					"$$" +
					result +
					"$$" +
					selectionText.substring(mathPreviewEndIndex + 2, selectionText.length),
				initialLatex: selectionText.substring(
					mathPreviewStartIndex + 2,
					mathPreviewEndIndex
				),
			};
		}
	}

	const mathInlineStartIndex = selectionText.indexOf("$");
	if (mathInlineStartIndex >= 0) {
		const mathInlineEndIndex = selectionText.indexOf("$", mathInlineStartIndex + 1);
		if (mathInlineEndIndex >= 0) {
			return {
				resultRenderTemplate: (result) =>
					selectionText.substring(0, mathInlineStartIndex) +
					"$" +
					result +
					"$" +
					selectionText.substring(mathInlineEndIndex + 1, selectionText.length),
				initialLatex: selectionText.substring(
					mathInlineStartIndex + 1,
					mathInlineEndIndex
				),
			};
		}
	}

	return {
		resultRenderTemplate: (result) => result,
		initialLatex: selectionText,
	};
}

// The $...$ or $$...$$ formula around an offset in the text, if there is one.
export function findEnclosingMath(text: string, offset: number): { from: number; to: number } | null {
	let inlineStart: number | null = null;
	let blockStart: number | null = null;

	for (let index = 0; index < text.length; ) {
		if (text[index] !== "$" || isEscapedDollar(text, index)) {
			index += 1;
			continue;
		}

		const isBlockDelimiter = text[index + 1] === "$";
		if (blockStart !== null) {
			if (isBlockDelimiter) {
				const end = index + 2;
				if (offset > blockStart && offset < end) {
					return { from: blockStart, to: end };
				}
				blockStart = null;
				index = end;
				continue;
			}

			index += 1;
			continue;
		}

		if (inlineStart !== null) {
			const end = index + 1;
			if (offset > inlineStart && offset < end) {
				return { from: inlineStart, to: end };
			}
			inlineStart = null;
			index = end;
			continue;
		}

		if (isBlockDelimiter) {
			blockStart = index;
			index += 2;
			continue;
		}

		inlineStart = index;
		index += 1;
	}

	return null;
}

function isEscapedDollar(text: string, index: number) {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		backslashCount += 1;
	}

	return backslashCount % 2 === 1;
}

// Shows a menu under the button that opened it. A formula with focus keeps Escape to itself, so
// listen for it before the formula does, or the menu can't be closed from the keyboard.
export function showMenuBelow(menu: Menu, button: HTMLElement) {
	const doc = button.doc;
	const closeOnEscape = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		menu.hide();
	};
	doc.addEventListener("keydown", closeOnEscape, true);
	button.setAttr("aria-expanded", "true");
	menu.onHide(() => {
		doc.removeEventListener("keydown", closeOnEscape, true);
		button.setAttr("aria-expanded", "false");
	});

	const rect = button.getBoundingClientRect();
	menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width }, doc);
}

// MathLive has one virtual keyboard. When it moves to another container while it is showing, the
// space it made at the bottom of the old one stays behind, so close it first.
export function moveVirtualKeyboard(container: HTMLElement) {
	const keyboard = window.mathVirtualKeyboard;
	if (keyboard.container === container) {
		return;
	}
	if (keyboard.visible) {
		keyboard.hide();
	}
	keyboard.container = container;
}

export function createMathfield(config: MathfieldConfig): MathfieldElement {
	if (!mathfieldElementCtor) {
		throw new Error("MathLive was not initialized before creating a math-field.");
	}

	const mfe = new mathfieldElementCtor();
	// styles.css targets this class, since the scorecard's CSS check rejects the math-field type selector.
	mfe.addClass("mathlive-field");
	if (config.id) {
		mfe.id = config.id;
	}
	mfe.defaultMode = config.inline ? "inline-math" : "math";
	mfe.value = config.initialValue;

	if (!config.inline) {
		mfe.addEventListener("keydown", (event: KeyboardEvent) => {
			if (
				event.key !== "Enter" ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.shiftKey
			) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			mfe.executeCommand("addRowAfter");
		});
	}

	if (config.onInput) {
		mfe.addEventListener("input", () => {
			config.onInput?.(mfe.value);
		});
	}

	return mfe;
}

const SCAN_FAILED_NOTICE = "Couldn't scan the image. Check your connection and try again.";
export const NO_SCANS_LEFT_NOTICE = "You've used all your free scans. Open Settings → MathLive to upgrade to unlimited scans.";
const NO_MATH_NOTICE = "No math found in this image. Try cropping closer to the formula. Nothing was charged.";
const EMPTY_CLIPBOARD_NOTICE = "No image found in clipboard.";
const BAD_IMAGE_NOTICE = "MathLive couldn't read this image. Copy the formula as a screenshot and try again.";

// The scanner never sends a bigger image to a model, so there's no point uploading one.
const MAX_UPLOAD_SIDE = 1600;
// The scanner gives up on a scan after 18 seconds, so a reply this late means the request is lost.
const SCAN_TIMEOUT_MS = 25000;
// A scan that fails this fast never reached a model (a dropped connection, a restarting server),
// so it is worth one more try before bothering the user.
const QUICK_FAILURE_MS = 5000;

type ScanFailure = "auth" | "no_scans_left" | "no_math" | "bad_image" | "unavailable";

class ScanError extends Error {
	constructor(readonly failure: ScanFailure, message: string) {
		super(message);
	}
}

async function readClipboardImageBlob(): Promise<Blob | null> {
	const clipboardItems = await navigator.clipboard.read();
	for (const item of clipboardItems) {
		for (const type of item.types) {
			if (type.startsWith("image/")) {
				return await item.getType(type);
			}
		}
	}

	return null;
}

// Scales big screenshots down before upload, which makes scans on slow connections much faster.
// Anything the browser can't decode goes up unchanged and the scanner decides.
async function shrinkImage(image: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(image);
	} catch {
		return image;
	}

	try {
		const longest = Math.max(bitmap.width, bitmap.height);
		if (longest <= MAX_UPLOAD_SIDE) {
			return image;
		}

		const scale = MAX_UPLOAD_SIDE / longest;
		const canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			return image;
		}
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve) => {
			canvas.toBlob((blob) => resolve(blob ?? image), "image/png");
		});
	} finally {
		bitmap.close();
	}
}

export async function buildMultipartBody(
	fieldName: string,
	file: Blob
): Promise<{ body: ArrayBuffer; contentType: string }> {
	const boundary = `----MathLiveBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	const encoder = new TextEncoder();
	const head = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="${fieldName}"; filename="image"\r\n` +
			`Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`
	);
	const content = new Uint8Array(await file.arrayBuffer());
	const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

	const body = new Uint8Array(head.length + content.length + tail.length);
	body.set(head, 0);
	body.set(content, head.length);
	body.set(tail, head.length + content.length);

	return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(new ScanError("unavailable", `Scan timed out after ${ms} ms.`));
		}, ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

// The scanner answers errors with {detail, code}. Older scanners send only detail, and the
// self-hosted one sends neither, so the status decides when there's no code.
export function errorCode(res: { json: unknown }): string | null {
	try {
		const body = res.json as { code?: unknown } | null;
		return typeof body?.code === "string" ? body.code : null;
	} catch {
		return null;
	}
}

function scanFailure(status: number, code: string | null): ScanFailure {
	switch (code) {
		case "missing_api_key":
		case "invalid_api_key":
			return "auth";
		case "no_scans_left":
			return "no_scans_left";
		case "no_math":
			return "no_math";
		case "no_image":
		case "not_an_image":
		case "image_too_small":
			return "bad_image";
	}
	return status < 500 ? "auth" : "unavailable";
}

async function requestScan(address: string, apiKey: string, image: Blob): Promise<string> {
	const { body, contentType } = await buildMultipartBody("file", image);
	let res;
	try {
		res = await withTimeout(
			requestUrl({
				url: address + "/predict/",
				method: "POST",
				contentType,
				headers: {
					"Api-Key": apiKey,
				},
				body,
				throw: false,
			}),
			SCAN_TIMEOUT_MS
		);
	} catch (error) {
		if (error instanceof ScanError) {
			throw error;
		}
		throw new ScanError("unavailable", error instanceof Error ? error.message : String(error));
	}

	if (res.status >= 400) {
		throw new ScanError(
			scanFailure(res.status, errorCode(res)),
			`OCR request failed with status ${res.status}.`
		);
	}

	let latex: unknown;
	try {
		latex = res.json;
	} catch {
		latex = null;
	}
	if (typeof latex !== "string") {
		throw new ScanError("unavailable", "OCR response did not contain LaTeX.");
	}

	return latex;
}

// The MathLive scanner, or the user's own one when Self-hosted scanner is on.
export function scannerAddress(settings: PluginSettings): string {
	if (settings.useLocalInference) {
		return (settings.localInferenceUrl.trim() || DEFAULT_SETTINGS.localInferenceUrl).replace(/\/+$/, "");
	}
	return (settings.cloudScannerUrl || DEFAULT_SETTINGS.cloudScannerUrl).replace(/\/+$/, "");
}

export async function scanImageToLatex(
	settings: PluginSettings,
	imageData: Blob
): Promise<string> {
	const address = scannerAddress(settings);

	const image = await shrinkImage(imageData);
	const apiKey = settings.apiKey ?? "";
	const started = Date.now();
	try {
		return await requestScan(address, apiKey, image);
	} catch (error) {
		const quick = Date.now() - started < QUICK_FAILURE_MS;
		if (!(error instanceof ScanError) || error.failure !== "unavailable" || !quick) {
			throw error;
		}
		console.warn("MathLive: scan failed quickly, trying once more.", error);
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		return await requestScan(address, apiKey, image);
	}
}

// A notice with one button, such as Retry. Clicking the button closes the notice.
export function noticeWithButton(message: string, label: string, onClick: () => void, duration = 10000) {
	const notice = new Notice(
		createFragment((frag) => {
			frag.appendText(message + " ");
			const button = frag.createEl("button", { cls: "mathlive-notice-retry", text: label });
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				notice.hide();
				onClick();
			});
		}),
		duration
	);
}

// How long a scan runs before the progress notice starts counting the seconds.
const SHOW_SECONDS_AFTER_MS = 2000;

// A notice that stays up, with a moving bar and a seconds count, for as long as a scan runs, so a
// slow scan never looks like nothing is happening. `busyEl`, such as the formula being filled,
// shimmers meanwhile. Returns how to take it all down.
export function startScanProgress(message: string, busyEl?: HTMLElement): () => void {
	const row = createDiv({ cls: "mathlive-scan-progress-row" });
	setIcon(row.createSpan({ cls: "mathlive-scan-progress-icon" }), "sparkles");
	row.createSpan({ cls: "mathlive-scan-progress-text", text: message });
	const time = row.createSpan({ cls: "mathlive-scan-progress-time" });
	const bar = createDiv({ cls: "mathlive-scan-progress-bar" });
	bar.createDiv();
	const notice = new Notice(
		createFragment((frag) => {
			frag.append(row, bar);
		}),
		0
	);
	bar.closest(".notice")?.addClass("mathlive-scan-progress");
	const started = Date.now();
	const timer = window.setInterval(() => {
		const elapsed = Date.now() - started;
		if (elapsed >= SHOW_SECONDS_AFTER_MS) {
			time.setText(`${Math.floor(elapsed / 1000)} s`);
		}
	}, 250);
	busyEl?.addClass("mathlive-is-scanning");
	return () => {
		window.clearInterval(timer);
		busyEl?.removeClass("mathlive-is-scanning");
		notice.hide();
	};
}

function showScanFailure(message: string, retry?: () => void) {
	if (!retry) {
		new Notice(message, 10000);
		return;
	}
	noticeWithButton(message, "Retry", retry, 15000);
}

// Where a scan's LaTeX goes: a formula, or the cursor in a note.
export interface ScanTarget {
	settings: PluginSettings;
	// False once the formula or note has closed, so a late scan has nowhere to go.
	isOpen(): boolean;
	insert(latex: string): void;
	addedMessage: string;
	closedMessage: string;
	// Shimmers while the scan runs, such as the formula being filled.
	busyEl?: HTMLElement;
}

export function mathfieldScanTarget(options: {
	settings: PluginSettings;
	mathfield: MathfieldElement;
	onValueChange?: (value: string) => void;
}): ScanTarget {
	const { settings, mathfield, onValueChange } = options;
	return {
		settings,
		isOpen: () => mathfield.isConnected,
		insert: (latex) => {
			mathfield.value += latex;
			onValueChange?.(mathfield.value);
		},
		busyEl: mathfield,
		addedMessage: "Scan added to the formula",
		closedMessage: "The formula was closed before the scan finished. Open it and scan again.",
	};
}

// The cloud scanner needs a key, so get one (a trial, or by connecting) before the user picks an
// image. `resume` starts the scan over once the user has connected.
export async function ensureCanScan(settings: PluginSettings, resume: () => void): Promise<boolean> {
	if (settings.useLocalInference || settings.apiKey?.trim()) {
		return true;
	}
	if (scanAccount) {
		return await scanAccount.ensureKey(resume);
	}
	new Notice(CLOUD_OCR_AUTH_NOTICE, 10000);
	return false;
}

async function scanInto(target: ScanTarget, image: Blob): Promise<boolean> {
	const { settings } = target;

	const done = startScanProgress("Reading the formula…", target.busyEl);
	try {
		const latex = await scanImageToLatex(settings, image).finally(done);
		// The formula may have closed or re-rendered while the scan ran.
		if (!target.isOpen()) {
			new Notice(target.closedMessage);
			return false;
		}
		target.insert(latex);
		new Notice(target.addedMessage);
		if (!settings.useLocalInference) {
			scanAccount?.afterScan();
		}
		return true;
	} catch (error) {
		const failure = error instanceof ScanError ? error.failure : "unavailable";
		console.error("MathLive: scan failed:", error);

		// Once the user has connected or paid, the same image is scanned again.
		const resume = () => {
			if (target.isOpen()) {
				void scanInto(target, image);
			}
		};
		if ((failure === "auth" || failure === "no_scans_left") && !settings.useLocalInference && scanAccount) {
			scanAccount.needsAccount(failure, resume);
		} else if (failure === "auth" && !settings.useLocalInference) {
			showScanFailure(CLOUD_OCR_AUTH_NOTICE);
		} else if (failure === "no_scans_left") {
			showScanFailure(NO_SCANS_LEFT_NOTICE);
		} else if (failure === "no_math") {
			showScanFailure(NO_MATH_NOTICE);
		} else if (failure === "bad_image") {
			showScanFailure(BAD_IMAGE_NOTICE);
		} else {
			// The retry keeps the image, so it works even after the clipboard has changed.
			showScanFailure(SCAN_FAILED_NOTICE, resume);
		}
		return false;
	}
}

export async function appendLatexFromClipboardImage(
	options: {
		settings: PluginSettings;
		mathfield: MathfieldElement;
		onValueChange?: (value: string) => void;
	},
	// Offered instead when the clipboard has no image.
	scanScreenArea?: () => void
): Promise<boolean> {
	const resume = () => {
		if (options.mathfield.isConnected) {
			void appendLatexFromClipboardImage(options, scanScreenArea);
		}
	};
	if (!(await ensureCanScan(options.settings, resume))) {
		return false;
	}

	let image: Blob | null;
	try {
		image = await readClipboardImageBlob();
	} catch (error) {
		console.error("MathLive: couldn't read the clipboard:", error);
		image = null;
	}
	if (!image) {
		showEmptyClipboard(scanScreenArea);
		return false;
	}

	return await scanInto(mathfieldScanTarget(options), image);
}

function showEmptyClipboard(scanScreenArea?: () => void) {
	if (!scanScreenArea) {
		new Notice(EMPTY_CLIPBOARD_NOTICE);
		return;
	}
	noticeWithButton(EMPTY_CLIPBOARD_NOTICE + " You can also select the formula on screen.", "Select on screen", scanScreenArea);
}

// Lets the user drag a box around a formula on the screen and scans it. With "Scan other apps"
// on, the box can go anywhere on the screen; otherwise, or where the screen can't be pictured, it
// goes in Obsidian's window. `hideWhileSelecting` hides something, like the editor window, from a
// picture of Obsidian's window and returns how to show it again.
export async function scanScreenAreaInto(
	app: App,
	target: ScanTarget,
	doc: Document,
	hideWhileSelecting?: () => () => void
): Promise<boolean> {
	const resume = () => {
		if (target.isOpen()) {
			void scanScreenAreaInto(app, target, doc, hideWhileSelecting);
		}
	};
	if (!(await ensureCanScan(target.settings, resume))) {
		return false;
	}

	let image: Blob | null;
	try {
		image = await pickOnScreen(app, target.settings, doc, hideWhileSelecting);
	} catch (error) {
		console.error("MathLive: couldn't take a screenshot:", error);
		new Notice("MathLive couldn't take a screenshot of the screen.");
		return false;
	}
	if (!image || !target.isOpen()) {
		return false;
	}

	return await scanInto(target, image);
}

let screenAccessHinted = false;

async function pickOnScreen(
	app: App,
	settings: PluginSettings,
	doc: Document,
	hideWhileSelecting?: () => () => void
): Promise<Blob | null> {
	if (settings.scanOtherApps) {
		const access = await wholeScreenAccess();
		if (access === "ok") {
			return await selectAnywhereOnScreen(doc);
		}
		if (access === "needs-access" && !screenAccessHinted) {
			screenAccessHinted = true;
			noticeWithButton(
				"This scan can only reach Obsidian's window. To scan other apps too, macOS needs to let Obsidian record the screen.",
				"Show me how",
				() => new ScreenAccessModal(app).open(),
				15000
			);
		}
	}

	const show = hideWhileSelecting?.();
	try {
		if (show) {
			// Let the window repaint without it before the picture is taken.
			await nextFrames(doc, 2);
		}
		return await selectScreenArea(app, doc);
	} finally {
		show?.();
	}
}

function nextFrames(doc: Document, count: number): Promise<void> {
	return new Promise((resolve) => {
		const step = () => {
			if (count-- <= 0) {
				resolve();
				return;
			}
			doc.win.requestAnimationFrame(step);
		};
		step();
	});
}

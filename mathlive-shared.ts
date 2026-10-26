import type { MathfieldElement } from "mathlive";
import { type Menu, Notice, requestUrl } from "obsidian";
import { FONT_FILES } from "./mathlive-fonts";
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

export const CLOUD_OCR_AUTH_NOTICE =
	'Open Settings -> MathLive and configure your API key. If you use cloud OCR, make sure your remote account is funded. More info is available in settings.';

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
const NO_SCANS_LEFT_NOTICE =
	"You've used all your free scans. Open Settings -> MathLive to upgrade to unlimited scans.";
const NO_MATH_NOTICE = "No math found in this image. Try cropping closer to the formula. Nothing was charged.";
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

async function buildMultipartBody(
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
function errorCode(res: { json: unknown }): string | null {
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

export async function scanImageToLatex(
	settings: PluginSettings,
	imageData: Blob
): Promise<string> {
	let address = "https://mathlive-ocr.danz.blog";
	if (settings.useLocalInference) {
		address = (settings.localInferenceUrl.trim() || DEFAULT_SETTINGS.localInferenceUrl).replace(/\/+$/, "");
	}

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

function showScanFailure(message: string, retry?: () => void) {
	if (!retry) {
		new Notice(message, 10000);
		return;
	}

	const notice = new Notice(
		createFragment((frag) => {
			frag.appendText(message + " ");
			const button = frag.createEl("button", { cls: "mathlive-notice-retry", text: "Retry" });
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				notice.hide();
				retry();
			});
		}),
		15000
	);
}

async function scanAndAppend(
	options: {
		settings: PluginSettings;
		mathfield: MathfieldElement;
		onValueChange?: (value: string) => void;
	},
	image: Blob
): Promise<boolean> {
	const { settings, mathfield, onValueChange } = options;

	try {
		new Notice("Scanning math image");
		const latex = await scanImageToLatex(settings, image);
		// The formula may have closed or re-rendered while the scan ran.
		if (!mathfield.isConnected) {
			new Notice("The formula was closed before the scan finished. Open it and scan again.");
			return false;
		}
		mathfield.value += latex;
		onValueChange?.(mathfield.value);
		new Notice("Scan added to the formula");
		return true;
	} catch (error) {
		const failure = error instanceof ScanError ? error.failure : "unavailable";
		console.error("MathLive: scan failed:", error);

		if (failure === "auth" && !settings.useLocalInference) {
			showScanFailure(CLOUD_OCR_AUTH_NOTICE);
		} else if (failure === "no_scans_left") {
			showScanFailure(NO_SCANS_LEFT_NOTICE);
		} else if (failure === "no_math") {
			showScanFailure(NO_MATH_NOTICE);
		} else if (failure === "bad_image") {
			showScanFailure(BAD_IMAGE_NOTICE);
		} else {
			// The retry keeps the image, so it works even after the clipboard has changed.
			showScanFailure(SCAN_FAILED_NOTICE, () => {
				if (mathfield.isConnected) {
					void scanAndAppend(options, image);
				}
			});
		}
		return false;
	}
}

export async function appendLatexFromClipboardImage(options: {
	settings: PluginSettings;
	mathfield: MathfieldElement;
	onValueChange?: (value: string) => void;
}): Promise<boolean> {
	const { settings } = options;

	if (!settings.useLocalInference && !settings.apiKey) {
		new Notice(CLOUD_OCR_AUTH_NOTICE, 10000);
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
		new Notice("No image found in clipboard.");
		return false;
	}

	return await scanAndAppend(options, image);
}

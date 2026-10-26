import type { MathfieldElement } from "mathlive";
import { Notice, requestUrl } from "obsidian";
import { FONT_FILES } from "./mathlive-fonts";
import type { PluginSettings } from "./settings";

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
	const MathfieldElement = await loadMathfieldElement();
	registerMathliveFonts(doc);
	MathfieldElement.fontsDirectory = null;
	MathfieldElement.soundsDirectory = null;

	if (customElements.get("math-field") === undefined) {
		customElements.define("math-field", MathfieldElement);
	}
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

function isCloudOcrAuthorizationError(error: unknown): boolean {
	return error instanceof Error && error.message === CLOUD_OCR_AUTH_NOTICE;
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

export async function scanImageToLatex(
	settings: PluginSettings,
	imageData: Blob
): Promise<string> {
	let address = "https://mathlive-ocr.danz.blog";
	if (settings.useLocalInference) {
		address = "http://localhost:8502";
	}

	const { body, contentType } = await buildMultipartBody("file", imageData);
	const res = await requestUrl({
		url: address + "/predict/",
		method: "POST",
		contentType,
		headers: {
			"Api-Key": settings.apiKey ?? "",
		},
		body,
		throw: false,
	});

	if (res.status >= 400 && res.status < 500) {
		throw new Error(CLOUD_OCR_AUTH_NOTICE);
	}

	if (res.status >= 500) {
		throw new Error(`OCR request failed with status ${res.status}.`);
	}

	const latex: unknown = res.json;
	if (typeof latex !== "string") {
		throw new Error("OCR response did not contain LaTeX.");
	}

	return latex;
}

export async function appendLatexFromClipboardImage(options: {
	settings: PluginSettings;
	mathfield: MathfieldElement;
	onValueChange?: (value: string) => void;
}): Promise<boolean> {
	const { settings, mathfield, onValueChange } = options;

	if (!settings.useLocalInference && !settings.apiKey) {
		new Notice(CLOUD_OCR_AUTH_NOTICE, 10000);
		return false;
	}

	try {
		const imageBlob = await readClipboardImageBlob();
		if (!imageBlob) {
			new Notice("No image found in clipboard.");
			return false;
		}

		new Notice("Scanning math image");
		const latex = await scanImageToLatex(settings, imageBlob);
		mathfield.value += latex;
		onValueChange?.(mathfield.value);
		new Notice("Scan added to the formula");
		return true;
	} catch (error) {
		if (!settings.useLocalInference && isCloudOcrAuthorizationError(error)) {
			new Notice(CLOUD_OCR_AUTH_NOTICE, 10000);
			return false;
		}

		console.error("Error reading clipboard or uploading image:", error);
		new Notice("Couldn't scan the image. Check your connection and try again.");
		return false;
	}
}

import type { MathfieldElement } from "mathlive";
import { Notice } from "obsidian";
import { FONT_FILES } from "./mathlive-fonts";
import type { PluginSettings } from "./settings";

const MATHLIVE_FONT_STYLE_ID = "mathlive-static-fonts";
type MathfieldElementCtor = typeof import("mathlive")["MathfieldElement"];
let mathfieldElementCtor: MathfieldElementCtor | null = null;
let mathliveLoadPromise: Promise<MathfieldElementCtor> | null = null;

function ensureStaticMathliveFonts() {
	document.documentElement.style.setProperty("--ML__static-fonts", "true");

	if (document.getElementById(MATHLIVE_FONT_STYLE_ID)) {
		return;
	}

	const style = document.createElement("style");
	style.id = MATHLIVE_FONT_STYLE_ID;
	style.textContent = FONT_FILES.map(
		([family, source, styleName, weight]) =>
			`@font-face{font-display:swap;font-family:${family};font-style:${styleName};font-weight:${weight};src:url("${source}") format("woff2")}`
	).join("");
	document.head.appendChild(style);
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

export async function ensureMathfieldElementRegistered() {
	const MathfieldElement = await loadMathfieldElement();
	ensureStaticMathliveFonts();
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

	const mfe = document.createElement("math-field") as MathfieldElement;
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
	if (!(error instanceof Error)) {
		return false;
	}

	if (error.message === CLOUD_OCR_AUTH_NOTICE) {
		return true;
	}

	if (/status 4\d\d/.test(error.message)) {
		return true;
	}

	// Some browser/Electron fetch failures never expose the 4xx response and only surface
	// a generic network error to the plugin. Treat those cloud OCR failures as auth/setup
	// guidance rather than falling back to the console-only notice.
	return error.name === "TypeError" && /Failed to fetch|Load failed|NetworkError/i.test(error.message);
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

export async function scanImageToLatex(
	settings: PluginSettings,
	imageData: Blob
): Promise<string> {
	let address = "https://mathlive-ocr.danz.blog";
	if (settings.useLocalInference) {
		address = "http://localhost:8502";
	}

	const formData = new FormData();
	formData.append("file", imageData);

	let res: Response;
	try {
		res = await fetch(address + "/predict/", {
			headers: {
				"Api-key": settings.apiKey ?? "",
			},
			method: "POST",
			body: formData,
		});
	} catch (error) {
		if (!settings.useLocalInference && isCloudOcrAuthorizationError(error)) {
			throw new Error(CLOUD_OCR_AUTH_NOTICE);
		}
		throw error;
	}

	if (!res.ok) {
		if (res.status >= 400 && res.status < 500) {
			throw new Error(CLOUD_OCR_AUTH_NOTICE);
		}

		throw new Error(`OCR request failed with status ${res.status}.`);
	}

	return await res.json();
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
		new Notice("Got scan result for MathJax");
		return true;
	} catch (error) {
		if (!settings.useLocalInference && isCloudOcrAuthorizationError(error)) {
			new Notice(CLOUD_OCR_AUTH_NOTICE, 10000);
			return false;
		}

		console.error("Error reading clipboard or uploading image:", error);
		new Notice("Failed to scan image. See console for details.");
		return false;
	}
}

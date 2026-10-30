import type { MathfieldElement } from "mathlive";
import { type App, type Menu, Notice, Platform, requestUrl, setIcon } from "obsidian";
import { FONT_FILES } from "./mathlive-fonts";
import { DEFAULT_SETTINGS, type PluginSettings } from "./settings";
import { attachShorthands } from "./shorthands";

// Set at build time from manifest.json (webpack.config.js).
declare const MATHLIVE_VERSION: string;

// Scan from screen pictures Obsidian's window through Electron, which only the desktop app has. Its
// module is loaded on first use, so the plugin also loads on phones and tablets.
export const CAN_SCAN_SCREEN = Platform.isDesktopApp && !Platform.isMobile;
const loadScreenCapture = () => import(/* webpackMode: "eager" */ "./screen-capture");

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

// For other AI features that cost a scan, like Magic edit.
export function scanAccountHooks(): ScanAccount | null {
	return scanAccount;
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
// `alignStart` lines the menu up with the button's left edge instead of starting at its right.
let shownMenu: Menu | null = null;

// Hides the menu showMenuBelow last opened, if it is still open. Obsidian hands a just-opened menu
// the keyboard a moment later, so an Escape pressed in between reaches the window under it.
export function hideShownMenu(): boolean {
	if (!shownMenu) {
		return false;
	}
	shownMenu.hide();
	return true;
}

export function showMenuBelow(menu: Menu, button: HTMLElement, alignStart = false) {
	const doc = button.doc;
	shownMenu = menu;
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
	button.parentElement?.addClass("mathlive-menu-open");
	menu.onHide(() => {
		button.parentElement?.removeClass("mathlive-menu-open");
		if (shownMenu === menu) {
			shownMenu = null;
		}
		doc.removeEventListener("keydown", closeOnEscape, true);
		button.setAttr("aria-expanded", "false");
	});

	const rect = button.getBoundingClientRect();
	const width = alignStart ? undefined : rect.width;
	menu.showAtPosition({ x: rect.left, y: rect.bottom + (alignStart ? 4 : 0), width }, doc);
}

// MathLive has one virtual keyboard. When it moves to another container while it is showing, the
// space it made at the bottom of the old one stays behind, so close it first.
export function moveVirtualKeyboard(container: HTMLElement) {
	const keyboard = window.mathVirtualKeyboard;
	if (keyboard.container === container) {
		return;
	}
	if (keyboard.visible) {
		try {
			keyboard.hide();
		} catch (error) {
			// Its window has closed. Moving it still has to happen, or the keyboard button stops
			// working everywhere (#23): the move drops the old keyboard, and the next one is new.
			console.warn("MathLive: couldn't close the math keyboard", error);
		}
	}
	keyboard.container = container;
}

// MathLive's keyboard can't be closed once its window is gone, and then stops opening anywhere
// (#23). So move it back to the main window when a popout window closes.
export function releaseVirtualKeyboardFrom(doc: Document, mainContainer: HTMLElement) {
	if (window.mathVirtualKeyboard.container?.doc === doc) {
		moveVirtualKeyboard(mainContainer);
	}
}

type PopoutWindow = Window & { CSSStyleSheet: typeof CSSStyleSheet };
const cssText = (sheet: CSSStyleSheet) => Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");

// MathLive styles each formula with stylesheets made in the main window, which a popout window
// can't use, so formulas there drew without their layout: the ☰ button covered the keyboard
// button (#23). Formulas in a popout get copies made in that window.
let mathfieldCss: string[] | undefined;
const popoutStylesheets = new WeakMap<Window, CSSStyleSheet[]>();

function styleMathfieldInPopout(mfe: MathfieldElement) {
	const win = mfe.win as PopoutWindow;
	if (win === window || !mfe.shadowRoot || !mathfieldElementCtor) {
		return;
	}
	// A formula that was never in a popout still has MathLive's own stylesheets.
	mathfieldCss ??= Array.from(new mathfieldElementCtor().shadowRoot?.adoptedStyleSheets ?? [], cssText);
	let sheets = popoutStylesheets.get(win);
	if (!sheets) {
		sheets = mathfieldCss.map((css) => {
			const sheet = new win.CSSStyleSheet();
			sheet.replaceSync(css);
			return sheet;
		});
		popoutStylesheets.set(win, sheets);
	}
	mfe.shadowRoot.adoptedStyleSheets = sheets;
}

// MathLive makes room for its keyboard by adding the keyboard's height to the main window's bottom
// padding, and puts back what was there when the keyboard closes. When a close is missed, the blank
// strip stays, and the next keyboard adds its height on top of it. So after every change, make the
// padding exactly the room the keyboard showing now needs, or none.
export function fitVirtualKeyboardSpace() {
	const keyboard = window.mathVirtualKeyboard as typeof window.mathVirtualKeyboard & {
		originalContainerBottomPadding?: string | null;
	};
	const body = window.document.body;
	keyboard.originalContainerBottomPadding = "";
	const plate = keyboard.visible && keyboard.container === body ? body.querySelector<HTMLElement>(".ML__keyboard .MLK__plate") : null;
	const space = plate ? `${Math.max(plate.offsetHeight - 1, 0)}px` : "";
	if (body.style.paddingBottom !== space) {
		body.style.paddingBottom = space;
	}
}

// The math keyboard's stylesheets go on the main window's document, so a keyboard shown in a
// popout window gets copies in that window's document.
export function styleVirtualKeyboardInPopout() {
	const keyboard = window.mathVirtualKeyboard;
	const doc = keyboard.container?.doc;
	const mainDoc = window.document;
	if (!keyboard.visible || !doc || doc === mainDoc) {
		return;
	}
	const win = doc.win as PopoutWindow;
	const present = new Set(Array.from(doc.adoptedStyleSheets, cssText));
	const copies: CSSStyleSheet[] = [];
	for (const sheet of mainDoc.adoptedStyleSheets) {
		const css = cssText(sheet);
		if (present.has(css)) {
			continue;
		}
		const copy = new win.CSSStyleSheet();
		copy.replaceSync(css);
		copies.push(copy);
		present.add(css);
	}
	if (copies.length > 0) {
		doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, ...copies];
	}
}

// On phones and tablets a tap on the math keyboard, above all on its 123 / abc / αβγ tabs, could
// take the focus from the formula, so the next key went nowhere. The keyboard's taps are watched in
// every window a formula is edited in, and a formula that loses the focus during one takes it back.
const KEYBOARD_TAP_MS = 800;
let lastKeyboardTap = 0;
const keyboardTapWatchers = new Map<Document, () => void>();

function watchKeyboardTaps(doc: Document) {
	if (keyboardTapWatchers.has(doc)) {
		return;
	}
	const onTap = (event: Event) => {
		const target = event.target as Element | null;
		if (!target?.closest?.(".ML__keyboard")) {
			return;
		}
		lastKeyboardTap = Date.now();
		// MathLive switches tabs on pointerdown. The touch and mouse events after it would move the
		// focus to the tab, which can't hold it.
		if (event.type !== "pointerdown" && target.closest("[data-layer]")) {
			event.preventDefault();
		}
	};
	const options = { capture: true, passive: false };
	for (const type of ["pointerdown", "touchstart", "mousedown"]) {
		doc.addEventListener(type, onTap, options);
	}
	keyboardTapWatchers.set(doc, () => {
		for (const type of ["pointerdown", "touchstart", "mousedown"]) {
			doc.removeEventListener(type, onTap, options);
		}
	});
}

// When the plugin unloads.
export function stopWatchingKeyboardTaps() {
	for (const stop of keyboardTapWatchers.values()) {
		stop();
	}
	keyboardTapWatchers.clear();
}

function keepFocusOnKeyboardTaps(mfe: MathfieldElement) {
	mfe.addEventListener("focus", () => watchKeyboardTaps(mfe.doc));
	mfe.addEventListener("blur", () => {
		if (Date.now() - lastKeyboardTap > KEYBOARD_TAP_MS || !window.mathVirtualKeyboard.visible || !mfe.isConnected) {
			return;
		}
		const selection = mfe.selection;
		mfe.focus();
		mfe.selection = selection;
	});
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
	mfe.addEventListener("mount", () => styleMathfieldInPopout(mfe));
	closeMenuFromOutside(mfe);
	attachShorthands(mfe);
	keepFocusOnKeyboardTaps(mfe);

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

// MathLive puts an open ☰ or right-click menu inside a clear layer over the window, and removes
// both when the menu closes. A click on that layer is how MathLive itself closes the menu.
// Returns whether a menu was open.
export function closeMathfieldMenu(mfe: MathfieldElement): boolean {
	const layer = mfe.shadowRoot?.querySelector(".ui-menu-container")?.parentElement;
	layer?.dispatchEvent(new MouseEvent("click"));
	return Boolean(layer);
}

// Inside a note that layer only covers the formula, and once focus leaves the menu it doesn't hear
// Escape. So while a menu may be open, a click anywhere outside it or Escape closes it.
function closeMenuFromOutside(mfe: MathfieldElement) {
	let stop: (() => void) | null = null;
	const watch = () => {
		if (stop) {
			return;
		}
		const doc = mfe.doc;
		const onPointerDown = (event: PointerEvent) => {
			const path = event.composedPath();
			if (path.some((target) => (target as Element).classList?.contains("ui-menu-container"))) {
				return;
			}
			stop?.();
			// ☰ again closes the menu rather than opening it once more.
			const toggle = mfe.shadowRoot?.querySelector("[part=menu-toggle]");
			if (closeMathfieldMenu(mfe) && toggle && path.includes(toggle)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}
			stop?.();
			// Only the menu closes, not the formula.
			if (closeMathfieldMenu(mfe)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("keydown", onKeyDown, true);
		stop = () => {
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeyDown, true);
			stop = null;
		};
	};
	// MathLive stops these events inside the formula, so listen on the way in.
	mfe.addEventListener("pointerdown", watch, true);
	mfe.addEventListener("contextmenu", watch, true);
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

// "limited": too many scans in a minute or a day; the message is the server's own.
type ScanFailure = "auth" | "no_scans_left" | "no_math" | "bad_image" | "limited" | "unavailable";

export class ScanError extends Error {
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

// Scales big screenshots and photos down before upload, which makes scans on slow connections much
// faster, and turns formats the scanner may not read, like a phone's HEIC photo, into ones it does.
// Photos stay JPEG, which is far smaller than PNG for them. Anything the browser can't decode goes
// up unchanged and the scanner decides.
async function shrinkImage(image: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(image);
	} catch {
		return image;
	}

	try {
		const longest = Math.max(bitmap.width, bitmap.height);
		const readable = ["image/png", "image/jpeg", "image/webp"].includes(image.type);
		if (longest <= MAX_UPLOAD_SIDE && readable) {
			return image;
		}

		const scale = Math.min(1, MAX_UPLOAD_SIDE / longest);
		const canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			return image;
		}
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const photo = image.type === "image/jpeg" || image.type === "image/heic" || image.type === "image/heif";
		return await new Promise<Blob>((resolve) => {
			canvas.toBlob((blob) => resolve(blob ?? image), photo ? "image/jpeg" : "image/png", 0.9);
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

// The server's explanation of an error, if it sent one.
export function serverDetail(res: { json: unknown }): string | null {
	try {
		const body = res.json as { detail?: unknown } | null;
		return typeof body?.detail === "string" ? body.detail : null;
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
		case "rate_limited":
		case "daily_limit":
			return "limited";
	}
	return status < 500 ? "auth" : "unavailable";
}

async function requestScan(address: string, headers: Record<string, string>, image: Blob): Promise<string> {
	const { body, contentType } = await buildMultipartBody("file", image);
	let res;
	try {
		res = await withTimeout(
			requestUrl({
				url: address + "/predict/",
				method: "POST",
				contentType,
				headers,
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
		const failure = scanFailure(res.status, errorCode(res));
		throw new ScanError(
			failure,
			(failure === "limited" && serverDetail(res)) || `OCR request failed with status ${res.status}.`
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

// Where a scanned image came from, so the scan log can tell how people scan.
export type ImageSource = "clipboard" | "screen" | "photo" | "note-image" | "drawing";

// What kind of device asks, so the scan log can count scans from phones and tablets. Only the
// MathLive scanner gets it, never a self-hosted one.
export function devicePlatform(): string {
	if (Platform.isIosApp) {
		return Platform.isTablet ? "ipados" : "ios";
	}
	if (Platform.isAndroidApp) {
		return Platform.isTablet ? "android-tablet" : "android";
	}
	return Platform.isMacOS ? "macos" : Platform.isWin ? "windows" : Platform.isLinux ? "linux" : "desktop";
}

// The headers of every request to the scanner: the key, and for the MathLive scanner the device
// kind, the plugin version and where the image came from.
export function scannerHeaders(settings: PluginSettings, source?: ImageSource): Record<string, string> {
	const headers: Record<string, string> = { "Api-Key": settings.apiKey ?? "" };
	if (!settings.useLocalInference) {
		headers["X-MathLive-Platform"] = devicePlatform();
		headers["X-MathLive-Version"] = MATHLIVE_VERSION;
		if (source) {
			headers["X-MathLive-Source"] = source;
		}
	}
	return headers;
}

export async function scanImageToLatex(
	settings: PluginSettings,
	imageData: Blob,
	source?: ImageSource
): Promise<string> {
	const address = scannerAddress(settings);

	const image = await shrinkImage(imageData);
	const headers = scannerHeaders(settings, source);
	const started = Date.now();
	try {
		return await requestScan(address, headers, image);
	} catch (error) {
		const quick = Date.now() - started < QUICK_FAILURE_MS;
		if (!(error instanceof ScanError) || error.failure !== "unavailable" || !quick) {
			throw error;
		}
		console.warn("MathLive: scan failed quickly, trying once more.", error);
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		return await requestScan(address, headers, image);
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

// Puts a formula at the cursor of a math field, or replaces it when the field is empty.
export function insertIntoMathfield(mathfield: MathfieldElement, latex: string) {
	if (!mathfield.value.trim()) {
		mathfield.value = latex;
		return;
	}
	mathfield.insert(latex, { insertionMode: "insertAfter", selectionMode: "after", format: "latex" });
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

// When the cloud scanner refuses the key: asks the user to connect or get more scans, and runs
// `resume` once they have.
export function askForAccount(settings: PluginSettings, failure: "auth" | "no_scans_left", resume: () => void) {
	if (!settings.useLocalInference && scanAccount) {
		scanAccount.needsAccount(failure, resume);
	} else {
		showScanFailure(failure === "auth" ? CLOUD_OCR_AUTH_NOTICE : NO_SCANS_LEFT_NOTICE);
	}
}

// After a cloud scan was charged: refreshes the scans left, warning when they run low.
export function afterCloudScan(settings: PluginSettings) {
	if (!settings.useLocalInference) {
		scanAccount?.afterScan();
	}
}

async function scanInto(target: ScanTarget, image: Blob, source: ImageSource): Promise<boolean> {
	const { settings } = target;

	const done = startScanProgress("Reading the formula…", target.busyEl);
	try {
		const latex = await scanImageToLatex(settings, image, source).finally(done);
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
				void scanInto(target, image, source);
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
		} else if (failure === "limited" && error instanceof Error) {
			showScanFailure(error.message);
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

	return await scanInto(mathfieldScanTarget(options), image, "clipboard");
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

	return await scanInto(target, image, "screen");
}

// Opens the device's image picker: on a phone or tablet it offers the camera and the photo
// library. Resolves with the picked image, or null when the user cancels.
function pickImage(doc: Document): Promise<File | null> {
	return new Promise((resolve) => {
		const input = doc.body.createEl("input", { type: "file", cls: "mathlive-image-picker", attr: { accept: "image/*" } });
		const finish = (file: File | null) => {
			input.remove();
			resolve(file);
		};
		input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
		input.addEventListener("cancel", () => finish(null), { once: true });
		input.click();
	});
}

// Scans a photo the user takes or picks. The picker opens first, straight from the tap, because
// phones only open it from one; a key is got after that if needed.
export async function scanPhotoInto(target: ScanTarget, doc: Document): Promise<boolean> {
	const image = await pickImage(doc);
	if (!image || !target.isOpen()) {
		return false;
	}
	return await scanImageInto(target, image, "photo");
}

// Scans an image the plugin already has, such as one embedded in a note.
export async function scanImageInto(target: ScanTarget, image: Blob, source: ImageSource): Promise<boolean> {
	const resume = () => {
		if (target.isOpen()) {
			void scanImageInto(target, image, source);
		}
	};
	if (!(await ensureCanScan(target.settings, resume))) {
		return false;
	}
	return await scanInto(target, image, source);
}

let screenAccessHinted = false;

async function pickOnScreen(
	app: App,
	settings: PluginSettings,
	doc: Document,
	hideWhileSelecting?: () => () => void
): Promise<Blob | null> {
	const { ScreenAccessModal, selectAnywhereOnScreen, selectScreenArea, wholeScreenAccess } = await loadScreenCapture();
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

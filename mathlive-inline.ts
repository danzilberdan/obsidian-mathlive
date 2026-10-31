import type { Text } from "@codemirror/state";
import {
	EditorSelection,
	EditorState,
	Extension,
	Prec,
	RangeSetBuilder,
	StateField,
	Transaction,
} from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	keymap,
	type KeyBinding,
	WidgetType,
} from "@codemirror/view";
import type { MathfieldElement } from "mathlive";
import { type App, Menu, setIcon } from "obsidian";
import {
	appendLatexFromClipboardImage,
	mathfieldScanTarget,
	type ScanTarget,
	scanScreenAreaInto,
	scanPhotoInto,
	CAN_SCAN_SCREEN,
	createMathfield,
	moveVirtualKeyboard,
	showMenuBelow,
	insertIntoMathfield,
} from "./mathlive-shared";
import { openMagicEditPopover } from "./magic-edit";
import { toMathJaxLatex } from "./mathjax-latex";
import type { PluginSettings } from "./settings";

interface WidgetConfig {
	from: number;
	to: number;
}

interface MathRange {
	from: number;
	to: number;
	isInline: boolean;
}

interface MathFieldEntry {
	mfe: HTMLElement;
	from: number;
	to: number;
	isInline: boolean;
}

export const AUTHOR_URL = "https://danz.blog";

export interface WidgetHooks {
	app: App;
	getSettings: () => PluginSettings;
	// The account entry in the ✨ menu: Connect, or nothing once connected.
	accountAction: () => { title: string; run: () => void } | undefined;
	openEditorWindow: (view: EditorView, position: number, inline: boolean) => void;
	openGuide: () => void;
	// True while the note shows formulas as LaTeX instead of editors.
	showsRawLatex: () => boolean;
	// Opens Draw formula for this target.
	drawFormula: (target: ScanTarget) => void;
	// Opens Find a formula; `insert` puts the picked one in place and says whether it could.
	findFormula: (insert: (latex: string) => boolean) => void;
}

class MathLiveWidget extends WidgetType {
	constructor(
		private readonly config: WidgetConfig,
		private equation: string,
		private readonly isInline: boolean,
		private readonly hooks: WidgetHooks,
		// Whether a selection in the note covers the whole formula.
		private readonly selected = false
	) {
		super();
	}

	eq(other: MathLiveWidget): boolean {
		return (
			other instanceof MathLiveWidget &&
			other.config.from === this.config.from &&
			other.config.to === this.config.to &&
			other.equation === this.equation &&
			other.isInline === this.isInline &&
			other.selected === this.selected
		);
	}

	ignoreEvent(): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = createDiv();
		const mfe = createMathfield({
			initialValue: this.equation,
			inline: this.isInline,
		});

		wrapper.appendChild(mfe);
		wrapper.addClass("obsidian-mathlive-codemirror-wrapper");
		wrapper.addClass("cm-line");
		mfe.addClass("obsidian-mathlive-codemirror-math-field");
		mfe.defaultMode = this.isInline ? "inline-math" : "math";
		mfe.dataset.from = `${this.config.from}`;
		mfe.dataset.to = `${this.config.to}`;
		mfe.dataset.initialValue = this.equation;

		this.style(wrapper);
		this.bindInputHandlers(wrapper, mfe, view);

		return wrapper;
	}

	updateDOM(dom: HTMLElement): boolean {
		const wrapper = dom as HTMLDivElement;
		const mfe = wrapper.getElementsByTagName("math-field")[0] as MathfieldElement | undefined;
		if (!mfe) {
			return false;
		}

		this.style(wrapper);
		mfe.defaultMode = this.isInline ? "inline-math" : "math";
		mfe.dataset.from = `${this.config.from}`;
		mfe.dataset.to = `${this.config.to}`;

		const activeElement = wrapper.doc.activeElement;
		const isFocused =
			activeElement === mfe ||
			(activeElement instanceof Node && mfe.contains(activeElement));

		if (!isFocused && mfe.value !== this.equation) {
			mfe.value = this.equation;
			mfe.dataset.initialValue = this.equation;
			mfe.dataset.hasUnsavedChanges = "false";
		}

		return true;
	}

	private style(wrapper: HTMLDivElement) {
		const settings = this.hooks.getSettings();
		wrapper.toggleClass("is-selected", this.selected);

		if (!settings.enableInlineEditorMode) {
			wrapper.addClass("hidden");
			return;
		}

		wrapper.removeClass("hidden");
		if (this.isInline) {
			wrapper.addClass("inline");
			this.changeCSSClass(settings.enableInlineMathWidgets, wrapper, "hidden");
			return;
		}

		wrapper.removeClass("inline");
		this.changeCSSClass(settings.enableBlockMathWidgets, wrapper, "hidden");
	}

	private changeCSSClass(enabled: boolean, element: HTMLElement, className: string) {
		if (enabled) {
			element.removeClass(className);
			return;
		}

		element.addClass(className);
	}

	private bindInputHandlers(
		wrapper: HTMLDivElement,
		mfe: MathfieldElement,
		view: EditorView
	) {
		// The note gets LaTeX that Obsidian's MathJax can draw.
		const dispatchChange = (value: string) => {
			const newValue = toMathJaxLatex(value);
			const from = Number.parseInt(mfe.dataset.from ?? "", 10);
			const to = Number.parseInt(mfe.dataset.to ?? "", 10);
			if (Number.isNaN(from) || Number.isNaN(to)) {
				return;
			}

			view.dispatch({
				changes: {
					from,
					to,
					insert: newValue,
				},
			});

			this.equation = newValue;
			mfe.dataset.to = `${from + newValue.length}`;
			mfe.dataset.initialValue = newValue;
			mfe.dataset.hasUnsavedChanges = "false";
		};

		const refocusMathfield = () => {
			window.setTimeout(() => {
				try {
					mfe.focus();
					mfe.position = mfe.lastOffset;
				} catch {
					// Ignore transient focus failures if the widget was re-rendered.
				}
			}, 0);
		};

		const scanOptions = () => ({
			settings: this.hooks.getSettings(),
			mathfield: mfe,
			onValueChange: (value: string) => {
				dispatchChange(value);
				refocusMathfield();
			},
		});
		// A box on the screen on desktop, a photo on phones and tablets.
		const scanScreenArea = () => {
			void scanScreenAreaInto(this.hooks.app, mathfieldScanTarget(scanOptions()), mfe.doc);
		};
		const scanPhoto = () => {
			void scanPhotoInto(mathfieldScanTarget(scanOptions()), mfe.doc);
		};
		const scanClipboardImage = () => {
			void appendLatexFromClipboardImage(scanOptions(), CAN_SCAN_SCREEN ? scanScreenArea : undefined);
		};
		const drawFormula = () => this.hooks.drawFormula(mathfieldScanTarget(scanOptions()));
		const findFormula = () => {
			this.hooks.findFormula((latex) => {
				if (!mfe.isConnected) {
					return false;
				}
				insertIntoMathfield(mfe, latex);
				dispatchChange(mfe.value);
				refocusMathfield();
				return true;
			});
		};

		// Magic edit changes the formula from a typed or spoken instruction, in a box under it.
		const magicEdit = () => {
			openMagicEditPopover(wrapper, {
				settings: this.hooks.getSettings(),
				getLatex: () => mfe.value,
				setLatex: (latex) => {
					mfe.value = latex;
					dispatchChange(mfe.value);
				},
				isOpen: () => mfe.isConnected,
				busyEl: mfe,
			});
		};

		// Two buttons after each formula: ✨ fills it in or changes it with AI and holds the other
		// actions, and Expand opens the editor window. On full-line formulas they sit inside the
		// input, beside MathLive's keyboard and ☰ buttons.
		const buttons = wrapper.createDiv({ cls: "obsidian-mathlive-widget-buttons" });
		// Tabbing onto a button shows the buttons. Done here rather than with CSS :has(), which the
		// community scorecard flags as slow.
		buttons.addEventListener("focusin", (event) => {
			buttons.toggleClass("mathlive-keyboard-focus", (event.target as HTMLElement).matches(":focus-visible"));
		});
		buttons.addEventListener("focusout", () => buttons.removeClass("mathlive-keyboard-focus"));
		const addButton = (cls: string, icon: string, label: string, attr: Record<string, string> = {}) => {
			const button = buttons.createEl("button", {
				cls: `obsidian-mathlive-widget-button ${cls} clickable-icon`,
				attr: { type: "button", "aria-label": label, ...attr },
			});
			setIcon(button, icon);
			button.addEventListener("mousedown", (event) => {
				// Keep the cursor where it is.
				event.preventDefault();
			});
			return button;
		};
		const aiButton = addButton("obsidian-mathlive-widget-ai-button", "sparkles", "AI fill", { "aria-haspopup": "menu" });
		aiButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.showMenu(aiButton, magicEdit, scanClipboardImage, CAN_SCAN_SCREEN ? scanScreenArea : scanPhoto, drawFormula, findFormula);
		});
		const expandButton = addButton("obsidian-mathlive-widget-expand-button", "maximize-2", "Expand");
		expandButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const from = Number.parseInt(mfe.dataset.from ?? `${this.config.from}`, 10);
			this.hooks.openEditorWindow(view, from, this.isInline);
		});

		if (this.hooks.getSettings().immediateInlineUpdate) {
			mfe.addEventListener("input", () => {
				if (this.equation !== toMathJaxLatex(mfe.value)) {
					dispatchChange(mfe.value);
				}
			});
		} else {
			mfe.addEventListener("input", () => {
				mfe.dataset.hasUnsavedChanges = "true";
			});

			mfe.addEventListener("blur", () => {
				if (mfe.dataset.hasUnsavedChanges !== "true") {
					return;
				}

				if (toMathJaxLatex(mfe.value) !== this.equation) {
					dispatchChange(mfe.value);
				}
				mfe.dataset.hasUnsavedChanges = "false";
			});
		}

		mfe.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}

			mfe.value = mfe.dataset.initialValue ?? "";
			mfe.dataset.hasUnsavedChanges = "false";
			mfe.blur();
			event.preventDefault();
			event.stopPropagation();
		});

		// On touch screens, where nothing hovers, an inline formula shows its buttons only while it
		// is being edited (styles.css), so a note full of formulas isn't full of buttons. A tap on a
		// button keeps the formula focused; the ✨ menu keeps them while it is open.
		mfe.addEventListener("focus", () => wrapper.addClass("mathlive-editing"));
		mfe.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (mfe.doc.activeElement !== mfe) {
					wrapper.removeClass("mathlive-editing");
				}
			}, 300);
		});

		mfe.addEventListener("focus", () => {
			// The keyboard opens in the window this formula is in.
			moveVirtualKeyboard(mfe.doc.body);
			// Hides Obsidian's drawing of formulas while one is edited, which only the formulas that
			// are editable all the time need.
			if (!this.hooks.getSettings().editOnlyAtCursor) {
				updateEditingBodyClass(mfe.doc, this.isInline, true);
			}
		});

		mfe.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (!isFocusInMathField(mfe.doc)) {
					updateEditingBodyClass(mfe.doc, true, false);
					updateEditingBodyClass(mfe.doc, false, false);
				}
			}, 0);
		});

		const exitToEditor = (cursorPos: number) => {
			const docLen = view.state.doc.length;
			if (cursorPos < 0 || cursorPos > docLen) {
				return;
			}

			view.dispatch({ selection: EditorSelection.single(cursorPos) });
			view.focus();
		};

		wrapper.addEventListener(
			"keydown",
			(event: KeyboardEvent) => {
				const settings = this.hooks.getSettings();
				const activeElement = wrapper.doc.activeElement;
				const isFocused =
					activeElement === mfe ||
					(activeElement instanceof Node && mfe.contains(activeElement));
				if (!isFocused || !settings.arrowKeyNavigation) {
					return;
				}

				const from = Number.parseInt(mfe.dataset.from ?? `${this.config.from}`, 10);
				const to = Number.parseInt(mfe.dataset.to ?? `${this.config.to}`, 10);
				// Just outside the formula's hidden LaTeX; for a block, the end of the line above or
				// the start of the line below.
				const docLength = view.state.doc.length;
				const posBefore = this.isInline ? from - 1 : Math.max(0, from - 3);
				const posAfter = this.isInline ? to + 1 : Math.min(docLength, to + 3);
				const atStart = mfe.position === 0;
				const atEnd = mfe.position === mfe.lastOffset;

				if (event.key === "ArrowLeft" && atStart) {
					event.preventDefault();
					event.stopPropagation();
					exitToEditor(posBefore);
					return;
				}

				if (event.key === "ArrowRight" && atEnd) {
					event.preventDefault();
					event.stopPropagation();
					exitToEditor(posAfter);
					return;
				}

				const info = mfe.getElementInfo?.(mfe.position);
				const atOutermost = info?.depth === 0;

				if (event.key === "ArrowUp" && atOutermost) {
					event.preventDefault();
					event.stopPropagation();
					exitToEditor(posBefore);
					return;
				}

				if (event.key === "ArrowDown" && atOutermost) {
					event.preventDefault();
					event.stopPropagation();
					exitToEditor(posAfter);
				}
			},
			true
		);
	}

	// What ✨ can do for this formula, then help and the account.
	private showMenu(
		button: HTMLElement,
		magicEdit: () => void,
		scanClipboardImage: () => void,
		scanScreenOrPhoto: () => void,
		drawFormula: () => void,
		findFormula: () => void
	) {
		const accountItem = this.hooks.accountAction();
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Magic edit").setIcon("wand-sparkles").onClick(magicEdit));
		menu.addItem((item) => item.setTitle("Find a formula").setIcon("search").onClick(findFormula));
		menu.addItem((item) =>
			item.setTitle("Scan clipboard image").setIcon("image-plus").onClick(scanClipboardImage)
		);
		menu.addItem((item) =>
			CAN_SCAN_SCREEN
				? item.setTitle("Scan from screen").setIcon("scan").onClick(scanScreenOrPhoto)
				: item.setTitle("Scan a photo").setIcon("camera").onClick(scanScreenOrPhoto)
		);
		menu.addItem((item) => item.setTitle("Draw formula").setIcon("pencil-line").onClick(drawFormula));
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("What MathLive can do").setIcon("compass").onClick(() => this.hooks.openGuide())
		);
		if (accountItem) {
			menu.addItem((item) => item.setTitle(accountItem.title).setIcon("log-in").onClick(accountItem.run));
		}

		showMenuBelow(menu, button);
	}
}

function isFocusInMathField(doc: Document): boolean {
	const active = doc.activeElement as HTMLElement | null;
	if (active?.closest?.("math-field")) {
		return true;
	}

	if (active?.getRootNode() instanceof ShadowRoot) {
		const host = (active.getRootNode() as ShadowRoot).host;
		if (host?.tagName === "MATH-FIELD") {
			return true;
		}
	}

	return false;
}

function updateEditingBodyClass(doc: Document, isInline: boolean, isEditing: boolean) {
	const className = isInline ? "mathlive-editing-inline" : "mathlive-editing-block";
	doc.body.toggleClass(className, isEditing);
}

function getMathFieldEntries(view: EditorView): MathFieldEntry[] {
	const list = view.dom.querySelectorAll("math-field[data-from][data-to]");
	const entries: MathFieldEntry[] = [];
	for (const mfe of Array.from(list)) {
		const from = Number.parseInt(mfe.getAttribute("data-from") ?? "", 10);
		const to = Number.parseInt(mfe.getAttribute("data-to") ?? "", 10);
		if (Number.isNaN(from) || Number.isNaN(to)) {
			continue;
		}

		const wrapper = mfe.closest(".obsidian-mathlive-codemirror-wrapper");
		const isInline = wrapper?.classList.contains("inline") ?? false;
		entries.push({
			mfe: mfe as HTMLElement,
			from,
			to,
			isInline,
		});
	}

	return entries;
}

function focusMathfield(entry: MathFieldEntry, atStart: boolean) {
	const mfe = entry.mfe as MathfieldElement;

	const applyFocus = () => {
		if (!entry.mfe.isConnected) {
			return;
		}

		try {
			mfe.focus();
			mfe.position = atStart ? 0 : mfe.lastOffset;
		} catch {
			window.setTimeout(() => {
				if (!entry.mfe.isConnected) {
					return;
				}
				mfe.focus();
				mfe.position = atStart ? 0 : mfe.lastOffset;
			}, 0);
		}
	};

	window.requestAnimationFrame(applyFocus);
}

function tryEnter(
	view: EditorView,
	match: (entry: MathFieldEntry, head: number, doc: Text) => boolean,
	atStart: boolean
): boolean {
	if (isFocusInMathField(view.dom.doc)) {
		return false;
	}

	const head = view.state.selection.main.head;
	const doc = view.state.doc;

	for (const entry of getMathFieldEntries(view)) {
		if (!match(entry, head, doc)) {
			continue;
		}

		focusMathfield(entry, atStart);
		return true;
	}

	return false;
}

function arrowEnterBinding(
	key: string,
	match: (entry: MathFieldEntry, head: number, doc: Text) => boolean,
	atStart: boolean,
	getSettings: () => PluginSettings
): KeyBinding {
	return {
		key,
		// With text selected the keys act on the selection: a selected formula gets deleted.
		run: (view) =>
			!getSettings().arrowKeyNavigation || !view.state.selection.main.empty
				? false
				: tryEnter(view, match, atStart),
	};
}

// Where the cursor sits just before and just after a formula, outside its hidden LaTeX. For a
// full-line formula that is the end of the line above and the start of the line below.
function edgesOf(entry: MathFieldEntry) {
	return entry.isInline
		? { before: entry.from - 1, after: entry.to + 1 }
		: { before: entry.from - 3, after: entry.to + 3 };
}

// Arrow keys, Backspace and Delete next to a formula go into it instead of over it.
function enterMathLiveOnArrow(getSettings: () => PluginSettings): Extension {
	const enterAtEdge = (key: string, edge: "before" | "after"): KeyBinding =>
		arrowEnterBinding(key, (entry, head) => head === edgesOf(entry)[edge], edge === "before", getSettings);
	// A full-line formula right below or above the cursor's line.
	const enterBlockNextTo = (key: string, below: boolean): KeyBinding =>
		arrowEnterBinding(
			key,
			(entry, head, doc) => {
				if (entry.isInline) {
					return false;
				}
				const line = doc.lineAt(head).number;
				return below
					? doc.lineAt(Math.max(0, entry.from - 2)).number === line + 1
					: doc.lineAt(Math.min(doc.length, entry.to + 2)).number === line - 1;
			},
			below,
			getSettings
		);

	return Prec.highest(
		keymap.of([
			enterAtEdge("ArrowRight", "before"),
			enterAtEdge("Delete", "before"),
			enterAtEdge("ArrowLeft", "after"),
			enterAtEdge("Backspace", "after"),
			enterBlockNextTo("ArrowDown", true),
			enterBlockNextTo("ArrowUp", false),
		])
	);
}

function isEscapedDollar(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		backslashCount += 1;
	}

	return backslashCount % 2 === 1;
}

// Replaces fenced code blocks and inline code with spaces, keeping every offset, so a `$`
// inside code never becomes a math widget (#25).
export function maskCodeRegions(doc: string): string {
	const chars = doc.split("");
	const blank = (from: number, to: number) => {
		for (let index = from; index < to; index += 1) {
			if (chars[index] !== "\n") {
				chars[index] = " ";
			}
		}
	};

	let fence: { marker: string; length: number } | null = null;
	for (let lineStart = 0; lineStart <= doc.length; ) {
		let lineEnd = doc.indexOf("\n", lineStart);
		if (lineEnd === -1) {
			lineEnd = doc.length;
		}
		const line = doc.slice(lineStart, lineEnd);

		if (fence) {
			const closing = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line);
			if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
				fence = null;
			}
			blank(lineStart, lineEnd);
		} else {
			const opening = /^[\s>]*(`{3,}|~{3,})/.exec(line);
			if (opening) {
				fence = { marker: opening[1][0], length: opening[1].length };
				blank(lineStart, lineEnd);
			} else {
				for (let index = 0; index < line.length; ) {
					if (line[index] !== "`") {
						index += 1;
						continue;
					}

					let runEnd = index;
					while (line[runEnd] === "`") {
						runEnd += 1;
					}
					const run = line.slice(index, runEnd);
					let close = line.indexOf(run, runEnd);
					while (close !== -1 && line[close + run.length] === "`") {
						close = line.indexOf(run, close + run.length + 1);
					}
					if (close === -1) {
						index = runEnd;
						continue;
					}

					blank(lineStart + index, lineStart + close + run.length);
					index = close + run.length;
				}
			}
		}

		lineStart = lineEnd + 1;
	}

	return chars.join("");
}

function collectMathRangesFromDoc(source: string): MathRange[] {
	const doc = maskCodeRegions(source);
	const ranges: MathRange[] = [];
	let inlineStart: number | null = null;
	let blockStart: number | null = null;

	for (let index = 0; index < doc.length; ) {
		if (doc[index] !== "$" || isEscapedDollar(doc, index)) {
			index += 1;
			continue;
		}

		const isBlockDelimiter = doc[index + 1] === "$";
		if (blockStart !== null) {
			if (isBlockDelimiter) {
				ranges.push({ from: blockStart, to: index, isInline: false });
				blockStart = null;
				index += 2;
				continue;
			}

			index += 1;
			continue;
		}

		if (inlineStart !== null) {
			ranges.push({ from: inlineStart, to: index, isInline: true });
			inlineStart = null;
			index += 1;
			continue;
		}

		if (isBlockDelimiter) {
			blockStart = index + 2;
			index += 2;
			continue;
		}

		inlineStart = index + 1;
		index += 1;
	}

	return ranges;
}

// The text a formula's editor stands in for, delimiters included, so the LaTeX never shows next
// to it. A $$ block that shares its lines with other text can't be hidden that way and keeps its
// editor under the source.
function sourceRange(range: MathRange, doc: Text): { from: number; to: number } | null {
	if (range.isInline) {
		return { from: range.from - 1, to: range.to + 1 };
	}
	const from = range.from - 2;
	const to = range.to + 2;
	if (doc.lineAt(from).from !== from || doc.lineAt(to).to !== to) {
		return null;
	}
	return { from, to };
}

// Whether the cursor is in a formula or right next to it: on its $, or for a full-line formula on
// the line above or below.
function hasCursorIn(state: Transaction["state"], range: MathRange): boolean {
	const delimiter = range.isInline ? 1 : 3;
	return state.selection.ranges.some(
		(selection) => selection.head >= range.from - delimiter && selection.head <= range.to + delimiter
	);
}

function buildDecorations(state: Transaction["state"], hooks: WidgetHooks): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const settings = hooks.getSettings();
	if (!settings.enableInlineEditorMode || hooks.showsRawLatex()) {
		return builder.finish();
	}

	// Obsidian's CM math node names vary across versions, so scanning the buffer
	// is more reliable here than matching syntax-tree node names.
	for (const range of collectMathRangesFromDoc(state.doc.toString())) {
		if (!(range.isInline ? settings.enableInlineMathWidgets : settings.enableBlockMathWidgets)) {
			continue;
		}
		if (settings.editOnlyAtCursor && !hasCursorIn(state, range)) {
			continue;
		}
		const equation = state.sliceDoc(range.from, range.to);
		const source = sourceRange(range, state.doc);
		const selected =
			source !== null &&
			state.selection.ranges.some(
				(selection) => !selection.empty && selection.from <= source.from && selection.to >= source.to
			);
		const widget = new MathLiveWidget(
			{ from: range.from, to: range.to },
			equation,
			range.isInline,
			hooks,
			selected
		);

		if (source) {
			builder.add(source.from, source.to, Decoration.replace({ widget, block: !range.isInline }));
			continue;
		}

		// Put the widget after the block, outside Obsidian's own math decoration.
		const anchor = Math.min(state.doc.length, range.to + 2);
		builder.add(anchor, anchor, Decoration.widget({ widget, block: true, side: 1 }));
	}

	return builder.finish();
}

export function createInlineMathEditorExtension(hooks: WidgetHooks): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildDecorations(state, hooks);
		},
		update(_oldState: DecorationSet, transaction: Transaction): DecorationSet {
			return buildDecorations(transaction.state, hooks);
		},
		provide(field) {
			return [
				// Above Obsidian's own math rendering, which would show the LaTeX around the cursor.
				Prec.highest(EditorView.decorations.from(field)),
				// The cursor steps over a formula as one piece and never lands in its hidden LaTeX.
				EditorView.atomicRanges.of((view) => view.state.field(field)),
				keepSelectionOutsideFormulas(field),
				enterMathLiveOnArrow(hooks.getSettings),
			];
		},
	});
}

interface FormulaSpan {
	// The formula's hidden LaTeX, delimiters included.
	from: number;
	to: number;
	// Where the cursor stops before and after it. A full-line formula's lines take no cursor, so
	// these are the end of the line above and the start of the line below.
	before: number;
	after: number;
	isInline: boolean;
}

function formulaSpans(state: EditorState, decorations: DecorationSet): FormulaSpan[] {
	const spans: FormulaSpan[] = [];
	const length = state.doc.length;
	for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
		if (cursor.from === cursor.to) {
			continue;
		}
		const isInline = !(cursor.value.spec as { block?: boolean }).block;
		spans.push({
			from: cursor.from,
			to: cursor.to,
			before: isInline || cursor.from === 0 ? cursor.from : cursor.from - 1,
			after: isInline || cursor.to === length ? cursor.to : cursor.to + 1,
			isInline,
		});
	}
	return spans;
}

// Moves a selection end that landed inside a formula (moving up or down can) out of it, on the side
// it was heading to, so the cursor is always before or after a formula and a selection holds either
// all of it or none of it.
function snapOutOf(spans: FormulaSpan[], position: number, forward: boolean): number {
	for (const span of spans) {
		if (position > span.before && position < span.after) {
			return forward ? span.after : span.before;
		}
	}
	return position;
}

function keepSelectionOutsideFormulas(field: StateField<DecorationSet>): Extension {
	return EditorState.transactionFilter.of((tr) => {
		const decorations = tr.startState.field(field, false);
		if (!decorations || decorations.size === 0) {
			return tr;
		}

		if (!tr.docChanged) {
			// Only the user's own moves: the plugin itself puts the cursor in a formula to open it
			// in the editor window.
			if (!tr.selection || !tr.isUserEvent("select")) {
				return tr;
			}
			const spans = formulaSpans(tr.startState, decorations);
			const old = tr.startState.selection;
			let moved = false;
			const ranges = tr.selection.ranges.map((range, index) => {
				const previous = old.ranges[index] ?? old.main;
				const forward = range.head >= previous.head;
				const head = snapOutOf(spans, range.head, forward);
				const anchor = range.empty ? head : snapOutOf(spans, range.anchor, range.anchor > range.head);
				if (head === range.head && anchor === range.anchor) {
					return range;
				}
				moved = true;
				return EditorSelection.range(anchor, head);
			});
			if (!moved) {
				return tr;
			}
			return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }];
		}

		// Deleting or typing over a selected full-line formula takes its lines, not the line break
		// before them, so the lines around it stay apart.
		const selection = tr.startState.selection;
		if (selection.ranges.length !== 1 || selection.main.empty || !(tr.isUserEvent("delete") || tr.isUserEvent("input"))) {
			return tr;
		}
		const { from, to } = selection.main;
		const block = formulaSpans(tr.startState, decorations).find(
			(span) => !span.isInline && span.before === from && span.before < span.from && span.to < to
		);
		if (!block) {
			return tr;
		}
		let inserted = "";
		let matches = true;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
			if (fromA !== from || toA !== to) {
				matches = false;
			}
			inserted = text.toString();
		});
		if (!matches) {
			return tr;
		}
		return {
			changes: { from: block.from, to, insert: inserted },
			selection: EditorSelection.cursor(block.from + inserted.length),
			userEvent: tr.annotation(Transaction.userEvent),
			scrollIntoView: true,
		};
	});
}

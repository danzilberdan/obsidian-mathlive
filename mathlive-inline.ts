import type { Text } from "@codemirror/state";
import {
	EditorSelection,
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
	scanScreenAreaInto,
	createMathfield,
	moveVirtualKeyboard,
	showMenuBelow,
} from "./mathlive-shared";
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
}

class MathLiveWidget extends WidgetType {
	constructor(
		private readonly config: WidgetConfig,
		private equation: string,
		private readonly isInline: boolean,
		private readonly hooks: WidgetHooks
	) {
		super();
	}

	eq(other: MathLiveWidget): boolean {
		return (
			other instanceof MathLiveWidget &&
			other.config.from === this.config.from &&
			other.config.to === this.config.to &&
			other.equation === this.equation &&
			other.isInline === this.isInline
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
		const dispatchChange = (newValue: string) => {
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
		const scanScreenArea = () => {
			void scanScreenAreaInto(this.hooks.app, mathfieldScanTarget(scanOptions()), mfe.doc);
		};
		const scanClipboardImage = () => {
			void appendLatexFromClipboardImage(scanOptions(), scanScreenArea);
		};

		// Two buttons after each formula: ✨ fills it in with AI and holds the other actions, and
		// Expand opens the editor window.
		// On full-line formulas they sit inside the input, beside MathLive's keyboard and ☰ buttons.
		const buttons = wrapper.createDiv({ cls: "obsidian-mathlive-widget-buttons" });
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
			this.showMenu(aiButton, scanClipboardImage, scanScreenArea);
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
				if (this.equation !== mfe.value) {
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

				const newValue = mfe.value;
				if (newValue !== this.equation) {
					dispatchChange(newValue);
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

		mfe.addEventListener("focus", () => {
			// The keyboard opens in the window this formula is in.
			moveVirtualKeyboard(mfe.doc.body);
			updateEditingBodyClass(mfe.doc, this.isInline, true);
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
				const posBefore = this.isInline ? from - 1 : to;
				const posAfter = this.isInline ? from : to + 3;
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
	private showMenu(button: HTMLElement, scanClipboardImage: () => void, scanScreenArea: () => void) {
		const accountItem = this.hooks.accountAction();
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Scan clipboard image").setIcon("image-plus").onClick(scanClipboardImage)
		);
		menu.addItem((item) =>
			item.setTitle("Scan from screen").setIcon("scan").onClick(scanScreenArea)
		);
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
		run: (view) => (!getSettings().arrowKeyNavigation ? false : tryEnter(view, match, atStart)),
	};
}

function enterMathLiveOnArrow(getSettings: () => PluginSettings): Extension {
	return Prec.highest(
		keymap.of([
			arrowEnterBinding(
				"ArrowRight",
				(entry, head) => head === (entry.isInline ? entry.from - 1 : entry.to + 2),
				true,
				getSettings
			),
			arrowEnterBinding(
				"ArrowLeft",
				(entry, head) => head === (entry.isInline ? entry.from : entry.to + 3),
				false,
				getSettings
			),
			{
				key: "ArrowDown",
				run: (view) => {
					const settings = getSettings();
					if (!settings.arrowKeyNavigation || isFocusInMathField(view.dom.doc)) {
						return false;
					}

					const doc = view.state.doc;
					const blockEntries = () => getMathFieldEntries(view).filter((entry) => !entry.isInline);
					const owningLine = (entry: MathFieldEntry) =>
						doc.lineAt(Math.min(entry.to + 2, doc.length)).number;
					const entryForOwningLine = (lineNo: number) =>
						blockEntries().find((entry) => owningLine(entry) === lineNo) ?? null;
					const nextOwningLineAfter = (lineNo: number) => {
						let best: number | null = null;
						for (const entry of blockEntries()) {
							const line = owningLine(entry);
							if (line <= lineNo) {
								continue;
							}
							if (best === null || line < best) {
								best = line;
							}
						}
						return best;
					};
					const enterMathLiveForOwningLine = (lineNo: number) => {
						const entry = entryForOwningLine(lineNo);
						if (!entry) {
							return false;
						}

						focusMathfield(entry, true);
						return true;
					};

					const before = view.state.selection.main;
					const next = view.moveVertically(before, true);
					const moved = next.head !== before.head || next.anchor !== before.anchor;

					if (moved) {
						const beforeLine = doc.lineAt(before.head).number;
						const afterLine = doc.lineAt(next.head).number;

						if (afterLine !== beforeLine) {
							const skippedLine = nextOwningLineAfter(beforeLine);
							if (skippedLine !== null && skippedLine < afterLine) {
								const pos = doc.line(skippedLine).from;
								view.dispatch({
									selection: view.state.selection.replaceRange(
										EditorSelection.cursor(pos)
									),
									scrollIntoView: true,
								});
								return true;
							}

							if (enterMathLiveForOwningLine(beforeLine)) {
								return true;
							}
						}

						view.dispatch({
							selection: view.state.selection.replaceRange(next),
							scrollIntoView: true,
						});
						return true;
					}

					return enterMathLiveForOwningLine(doc.lineAt(before.head).number);
				},
			},
			arrowEnterBinding(
				"ArrowUp",
				(entry, head, doc) => {
					if (entry.isInline) {
						return false;
					}

					return (
						doc.lineAt(head).number ===
						doc.lineAt(Math.min(entry.to + 3, doc.length)).number
					);
				},
				false,
				getSettings
			),
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

function buildDecorations(state: Transaction["state"], hooks: WidgetHooks): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const settings = hooks.getSettings();
	if (!settings.enableInlineEditorMode) {
		return builder.finish();
	}

	// Obsidian's CM math node names vary across versions, so scanning the buffer
	// is more reliable here than matching syntax-tree node names.
	for (const range of collectMathRangesFromDoc(state.doc.toString())) {
		const equation = state.sliceDoc(range.from, range.to);
		const widget = new MathLiveWidget(
			{ from: range.from, to: range.to },
			equation,
			range.isInline,
			hooks
		);

		if (!range.isInline) {
			if (!settings.enableBlockMathWidgets) {
				continue;
			}
			// Put widget at the end of the math block so it appears below the formula
			// and safely outside Obsidian's folding Decoration.replace region.
			const anchor = Math.min(state.doc.length, range.to + 2);
			builder.add(
				anchor,
				anchor,
				Decoration.widget({
					widget,
					block: true,
					side: 1,
				})
			);
			continue;
		}

		if (settings.enableInlineMathWidgets) {
			// Put widget at the end of the inline math so it appears after the formula
			// and safely outside Obsidian's folding Decoration.replace region.
			const anchor = Math.min(state.doc.length, range.to + 1);
			builder.add(
				anchor,
				anchor,
				Decoration.widget({
					widget,
					side: 1,
				})
			);
		}
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
			return [EditorView.decorations.from(field), enterMathLiveOnArrow(hooks.getSettings)];
		},
	});
}

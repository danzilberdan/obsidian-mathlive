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
import { createMathfield } from "./mathlive-shared";
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

class MathLiveWidget extends WidgetType {
	constructor(
		private readonly config: WidgetConfig,
		private equation: string,
		private readonly isInline: boolean,
		private readonly getSettings: () => PluginSettings
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
		const wrapper = document.createElement("div");
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

		const activeElement = document.activeElement;
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
		const settings = this.getSettings();

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

		if (this.getSettings().immediateInlineUpdate) {
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
			updateEditingBodyClass(this.isInline, true);
		});

		mfe.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (!isFocusInMathField()) {
					updateEditingBodyClass(true, false);
					updateEditingBodyClass(false, false);
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
				const settings = this.getSettings();
				const activeElement = document.activeElement;
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
}

function isFocusInMathField(): boolean {
	const active = document.activeElement as HTMLElement | null;
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

function updateEditingBodyClass(isInline: boolean, isEditing: boolean) {
	const className = isInline ? "mathlive-editing-inline" : "mathlive-editing-block";

	if (isEditing) {
		document.body.addClass(className);
		return;
	}

	document.body.removeClass(className);
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
	if (isFocusInMathField()) {
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
					if (!settings.arrowKeyNavigation || isFocusInMathField()) {
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

function collectMathRangesFromDoc(doc: string): MathRange[] {
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

function buildDecorations(
	state: Transaction["state"],
	getSettings: () => PluginSettings
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const settings = getSettings();
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
			getSettings
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

export function createInlineMathEditorExtension(
	getSettings: () => PluginSettings
): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildDecorations(state, getSettings);
		},
		update(_oldState: DecorationSet, transaction: Transaction): DecorationSet {
			return buildDecorations(transaction.state, getSettings);
		},
		provide(field) {
			return [EditorView.decorations.from(field), enterMathLiveOnArrow(getSettings)];
		},
	});
}

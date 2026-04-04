import { syntaxTree } from "@codemirror/language";
import {
	Extension,
	RangeSetBuilder,
	StateField,
	Transaction,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
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

class MathLiveWidget extends WidgetType {
	constructor(
		private readonly config: WidgetConfig,
		private readonly equation: string,
		private readonly isInline: boolean,
		private readonly getSettings: () => PluginSettings
	) {
		super();
	}

	eq(other: MathLiveWidget): boolean {
		return other.config.from === this.config.from && other.isInline === this.isInline;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.addClass("mathlive-editor-widget");
		wrapper.addClass(this.isInline ? "inline" : "block");
		wrapper.addClass("cm-line");

		const mfe = createMathfield({
			initialValue: this.equation,
			inline: this.isInline,
		});
		mfe.addClass("mathlive-editor-field");
		mfe.dataset.from = `${this.config.from}`;
		mfe.dataset.to = `${this.config.to}`;
		mfe.dataset.initialValue = this.equation;
		this.bindInputHandlers(mfe, view);

		wrapper.appendChild(mfe);
		this.applySettings(wrapper, mfe);
		return wrapper;
	}

	updateDOM(dom: HTMLElement, _view: EditorView): boolean {
		const wrapper = dom as HTMLDivElement;
		wrapper.toggleClass("inline", this.isInline);
		wrapper.toggleClass("block", !this.isInline);

		const mfe = wrapper.querySelector("math-field") as MathfieldElement | null;
		if (!mfe) {
			return false;
		}

		this.applySettings(wrapper, mfe);
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

	ignoreEvent(): boolean {
		return true;
	}

	private applySettings(wrapper: HTMLElement, mfe: MathfieldElement) {
		const settings = this.getSettings();
		const enabled = settings.enableInlineEditorMode &&
			(this.isInline
				? settings.enableInlineMathWidgets
				: settings.enableBlockMathWidgets);
		wrapper.toggleClass("hidden", !enabled);
		mfe.readOnly = !enabled;
	}

	private bindInputHandlers(mfe: MathfieldElement, view: EditorView) {
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

			mfe.dataset.to = `${from + newValue.length}`;
			mfe.dataset.initialValue = newValue;
			mfe.dataset.hasUnsavedChanges = "false";
		};

		mfe.addEventListener("input", () => {
			if (this.getSettings().immediateInlineUpdate) {
				dispatchChange(mfe.value);
				return;
			}

			mfe.dataset.hasUnsavedChanges = "true";
		});

		mfe.addEventListener("blur", () => {
			if (
				!this.getSettings().immediateInlineUpdate &&
				mfe.dataset.hasUnsavedChanges === "true"
			) {
				dispatchChange(mfe.value);
			}
		});

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
	}
}

function isEscapedDollar(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		backslashCount += 1;
	}

	return backslashCount % 2 === 1;
}

function collectMathRangesFromSyntaxTree(state: Transaction["state"]): MathRange[] {
	const ranges: MathRange[] = [];
	let begin = -1;
	let end = -1;
	let isInline = false;

	syntaxTree(state).iterate({
		enter(node) {
			const name = node.type.name;
			if (name.includes("formatting-math-begin")) {
				if (name.includes("math-block")) {
					begin = node.from + 2;
					isInline = false;
				} else {
					begin = node.from + 1;
					isInline = true;
				}
			}

			if (name.includes("formatting-math-end") && begin !== -1) {
				end = node.from;
				ranges.push({
					from: begin,
					to: end,
					isInline,
				});
				begin = -1;
				end = -1;
				isInline = false;
			}
		},
	});

	return ranges;
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
				ranges.push({
					from: blockStart,
					to: index,
					isInline: false,
				});
				blockStart = null;
				index += 2;
				continue;
			}

			index += 1;
			continue;
		}

		if (inlineStart !== null) {
			ranges.push({
				from: inlineStart,
				to: index,
				isInline: true,
			});
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

function collectMathRanges(state: Transaction["state"]): MathRange[] {
	const syntaxTreeRanges = collectMathRangesFromSyntaxTree(state);
	if (syntaxTreeRanges.length > 0) {
		return syntaxTreeRanges;
	}

	// Fallback for Obsidian builds whose CM math node names differ.
	return collectMathRangesFromDoc(state.doc.toString());
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

	for (const range of collectMathRanges(state)) {
		const equation = state.sliceDoc(range.from, range.to);
		const widget = new MathLiveWidget(
			{ from: range.from, to: range.to },
			equation,
			range.isInline,
			getSettings
		);

		if (range.isInline && settings.enableInlineMathWidgets) {
			builder.add(
				Math.max(0, range.from - 1),
				Math.max(0, range.from - 1),
				Decoration.widget({
					widget,
					side: 1,
				})
			);
		}

		if (!range.isInline && settings.enableBlockMathWidgets) {
			builder.add(
				range.to + 2,
				range.to + 2,
				Decoration.widget({
					widget,
					block: true,
					side: 10,
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
			return EditorView.decorations.from(field);
		},
	});
}

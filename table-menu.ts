import { App, Modal, Setting, finishRenderMath, loadMathJax, renderMath } from "obsidian";
import type { MathfieldElement } from "mathlive";
import { DEFAULT_TABLE_OPTIONS, defaultColumnFormat, tableLatex, type TableKind, type TableOptions } from "./tables";

type MenuItem = MathfieldElement["menuItems"][number];

// Tables in a formula: the "Insert array…" and "Insert table" items next to MathLive's
// "Insert matrix", and items that add or remove a horizontal line (\hline) at the caret's row.
// MathLive itself draws \hline only with scripts/patch-mathlive.mjs, which also adds the
// toggleHlineAbove and toggleHlineBelow commands.

export class InsertTableModal extends Modal {
	private options: TableOptions;
	private previewEl!: HTMLElement;
	private fieldsEl!: HTMLElement;
	private columnFormatEdited = false;

	constructor(
		app: App,
		kind: TableKind,
		private readonly onInsert: (latex: string) => void
	) {
		super(app);
		this.options = { ...DEFAULT_TABLE_OPTIONS, kind };
	}

	onOpen() {
		this.modalEl.addClass("mathlive-table-modal");
		this.setTitle("Insert table");
		const { contentEl } = this;

		new Setting(contentEl).setName("Type").addDropdown((dropdown) =>
			dropdown
				.addOption("array", "Array")
				.addOption("synthetic-division", "Synthetic division")
				.addOption("tabular-integration", "Tabular integration by parts")
				.setValue(this.options.kind)
				.onChange((value) => {
					this.options.kind = value as TableKind;
					this.renderFields();
				})
		);
		this.fieldsEl = contentEl.createDiv();
		this.previewEl = contentEl.createDiv({ cls: "mathlive-table-preview" });

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.insert())
		);
		this.scope.register([], "Enter", (event) => {
			event.preventDefault();
			this.insert();
		});
		this.renderFields();
		// Obsidian loads MathJax only when a note shows a formula. The preview needs it.
		void loadMathJax().then(() => this.renderPreview());
	}

	onClose() {
		this.contentEl.empty();
	}

	private insert() {
		const latex = tableLatex(this.options);
		this.close();
		this.onInsert(latex);
	}

	private number(name: string, desc: string, get: () => number, set: (value: number) => void, min: number, max: number) {
		new Setting(this.fieldsEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(min);
				text.inputEl.max = String(max);
				text.setValue(String(get())).onChange((value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
						set(parsed);
						this.renderPreview();
					}
				});
			});
	}

	private toggle(name: string, desc: string, get: () => boolean, set: (value: boolean) => void) {
		new Setting(this.fieldsEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle.setValue(get()).onChange((value) => {
					set(value);
					this.renderPreview();
				})
			);
	}

	private renderFields() {
		this.fieldsEl.empty();
		const o = this.options;
		switch (o.kind) {
			case "array": {
				this.number("Rows", "", () => o.rows, (v) => (o.rows = v), 1, 20);
				let formatInput: HTMLInputElement | null = null;
				this.number("Columns", "", () => o.columns, (v) => {
					o.columns = v;
					if (!this.columnFormatEdited && formatInput) {
						o.columnFormat = defaultColumnFormat(v);
						formatInput.value = o.columnFormat;
					}
				}, 1, 20);
				new Setting(this.fieldsEl)
					.setName("Column format")
					.setDesc("Use l, c or r to align a column left, center or right. Use | for a vertical line. Example: c|rrr.")
					.addText((text) => {
						formatInput = text.inputEl;
						text.setValue(o.columnFormat).onChange((value) => {
							this.columnFormatEdited = true;
							o.columnFormat = value.replace(/[^lcr|:]/g, "") || defaultColumnFormat(o.columns);
							this.renderPreview();
						});
					});
				this.toggle("Line under the first row", "Adds \\hline under a header row.", () => o.headerLine, (v) => (o.headerLine = v));
				break;
			}
			case "synthetic-division":
				this.number("Degree", "The degree of the polynomial that you divide.", () => o.degree, (v) => (o.degree = v), 1, 10);
				this.toggle("Powers of x", "Adds a header row with x², x¹, x⁰ above the coefficients.", () => o.powersHeader, (v) => (o.powersHeader = v));
				break;
			case "tabular-integration":
				this.number("Rows", "The number of derivative rows, down to 0.", () => o.steps, (v) => (o.steps = v), 2, 12);
				this.toggle("Term column", "Adds a column for each term of the answer.", () => o.termColumn, (v) => (o.termColumn = v));
				break;
		}
		this.renderPreview();
	}

	private renderPreview() {
		this.previewEl.empty();
		try {
			this.previewEl.appendChild(renderMath(tableLatex(this.options).replace(/#\?/g, "\\square"), true));
			void finishRenderMath();
		} catch {
			this.previewEl.createEl("code", { text: tableLatex(this.options) });
		}
	}
}

let tableApp: App | null = null;

// Set by the plugin while it is loaded. The menu items need the app to open the modal.
export function setTableMenuApp(app: App | null) {
	tableApp = app;
}

// MathLive keeps its model private. The menu only reads the name of the innermost environment.
function environmentAtCaret(mfe: MathfieldElement): string | undefined {
	const internal = mfe as unknown as { _mathfield?: { model?: { parentEnvironment?: { environmentName?: string } } } };
	return internal._mathfield?.model?.parentEnvironment?.environmentName;
}

const TABLE_ENVIRONMENTS = new Set(["array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix"]);

function openInsertTable(mfe: MathfieldElement, kind: TableKind) {
	if (!tableApp) {
		return;
	}
	// The modal takes the focus. Put the caret back where it was before the table goes in.
	const selection = mfe.selection;
	new InsertTableModal(tableApp, kind, (latex) => {
		mfe.focus();
		mfe.selection = selection;
		mfe.insert(latex, { format: "latex", selectionMode: "placeholder" });
	}).open();
}

export function tableMenuItems(mfe: MathfieldElement): MenuItem[] {
	const editable = () => mfe.isSelectionEditable;
	const inTable = () => editable() && TABLE_ENVIRONMENTS.has(environmentAtCaret(mfe) ?? "");
	return [
		{
			label: "Insert array…",
			id: "mathlive-plugin-insert-array",
			visible: editable,
			onMenuSelect: () => openInsertTable(mfe, "array"),
		},
		{
			label: "Insert table",
			id: "mathlive-plugin-insert-table",
			visible: editable,
			submenu: [
				{
					label: "Synthetic division…",
					id: "mathlive-plugin-insert-synthetic-division",
					onMenuSelect: () => openInsertTable(mfe, "synthetic-division"),
				},
				{
					label: "Tabular integration by parts…",
					id: "mathlive-plugin-insert-tabular-integration",
					onMenuSelect: () => openInsertTable(mfe, "tabular-integration"),
				},
			],
		},
		{
			label: "Line above this row",
			id: "mathlive-plugin-toggle-hline-above",
			visible: inTable,
			onMenuSelect: () => mfe.executeCommand("toggleHlineAbove" as never),
		},
		{
			label: "Line below this row",
			id: "mathlive-plugin-toggle-hline-below",
			visible: inTable,
			onMenuSelect: () => mfe.executeCommand("toggleHlineBelow" as never),
		},
	];
}

// Puts the table items right after MathLive's "Insert matrix".
export function addTableMenuItems(mfe: MathfieldElement) {
	const items = mfe.menuItems;
	if (items.some((item) => "id" in item && item.id === "mathlive-plugin-insert-array")) {
		return;
	}
	const matrix = items.findIndex((item) => "id" in item && item.id === "insert-matrix");
	const at = matrix >= 0 ? matrix + 1 : items.length;
	mfe.menuItems = [...items.slice(0, at), ...tableMenuItems(mfe), ...items.slice(at)];
}

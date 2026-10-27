import {
	App,
	Editor,
	type EditorPosition,
	Modal,
	Platform,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	setIcon,
	type KeymapEventHandler,
	MarkdownView,
	Menu,
	Notice,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { MathfieldElement } from "mathlive";
import { ACCOUNT_URL, AUTHOR_URL, createInlineMathEditorExtension } from "./mathlive-inline";
import {
	createMathfield,
	ensureMathfieldElementRegistered,
	registerMathliveFonts,
	appendLatexFromClipboardImage,
	findEnclosingMath,
	mathfieldScanTarget,
	scanAnywhereOnScreenInto,
	scanScreenAreaInto,
	type ScanTarget,
	moveVirtualKeyboard,
	parseMathSelection,
	showMenuBelow,
} from "./mathlive-shared";
import { convertPdfToNotes, isPdf } from "./pdf-notes";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";

const CLOUD_ACCESS_STATUS_URL = "https://mathlive.danz.blog/ocr/access-status";
const BODY_CLASSES = [
	"mathlive-hide-rendered-inline",
	"mathlive-hide-rendered-block",
	"mathlive-hide-mathjax-inline",
	"mathlive-hide-mathjax-block",
	"mathlive-inline-widgets-active",
	"mathlive-block-widgets-active",
];

export default class MathLivePlugin extends Plugin {
	settings: PluginSettings;
	private cloudAccessStatusPromise: Promise<boolean | null> | null = null;
	private cachedCloudAccessStatus: boolean | null | undefined = undefined;
	// Where a scan from the screen goes when the hotkey is pressed outside a note, like in a PDF.
	private lastNoteView: MarkdownView | null = null;

	async onload() {
		await ensureMathfieldElementRegistered();
		await this.loadSettings();
		this.warmCloudAccessStatus();

		this.addCommand({
			id: 'open-modal',
			name: 'Add full-line math',
			editorCallback: (editor: Editor) => {
				new MathLiveModal(this.app, editor, this).open();
			}
		});
		
		this.addCommand({
			id: 'open-modal-inline',
			name: 'Add inline math',
			editorCallback: (editor: Editor) => {
				new MathLiveModal(this.app, editor, this, true).open();
			}
		});
		this.addCommand({
			id: "scan-screen-area",
			name: "Scan formula from screen",
			callback: () => {
				void this.scanScreenAreaIntoNote();
			},
		});
		this.addCommand({
			id: "scan-anywhere-on-screen",
			name: "Scan formula from anywhere on screen, including other apps",
			callback: () => {
				void this.scanScreenAreaIntoNote(true);
			},
		});
		this.addCommand({
			id: "convert-pdf-to-notes",
			name: "Convert PDF to notes",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				void convertPdfToNotes(this.app, this.settings, isPdf(active) ? active : undefined);
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!isPdf(file)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle("Convert to notes with MathLive")
						.setIcon("file-text")
						.onClick(() => void convertPdfToNotes(this.app, this.settings, file))
				);
			})
		);
		this.addRibbonIcon("scan", "Scan formula from screen", () => {
			void this.scanScreenAreaIntoNote();
		});
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastNoteView = leaf.view;
				}
			})
		);

		this.registerEditorExtension(
			createInlineMathEditorExtension({
				app: this.app,
				getSettings: () => this.settings,
				shouldShowUpgradeButton: () => this.shouldShowUpgradeButton(),
				openEditorWindow: (view, position, inline) => this.openEditorWindowAt(view, position, inline),
			})
		);
		this.addSettingTab(new MathliveSettingTab(this.app, this));
		this.registerEvent(
			this.app.workspace.on("window-open", (workspaceWindow) => {
				registerMathliveFonts(workspaceWindow.doc);
				this.updateMathJaxVisibility();
			})
		);
		this.updateMathJaxVisibility();
		this.app.workspace.onLayoutReady(() => {
			this.lastNoteView = this.app.workspace.getActiveViewOfType(MarkdownView);
			this.app.workspace.updateOptions();
		});
	}

	onunload() {
		for (const doc of this.getOpenDocuments()) {
			doc.body.removeClasses(BODY_CLASSES);
		}
		this.app.workspace.updateOptions();
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	// The main window plus any popout windows that are open.
	private getOpenDocuments(): Document[] {
		const docs = new Set<Document>([this.app.workspace.containerEl.doc]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.view.containerEl.doc);
		});
		return Array.from(docs);
	}

	async saveSettings(options?: { refreshCloudAccessStatus?: boolean }) {
		await this.saveData(this.settings);
		if (options?.refreshCloudAccessStatus) {
			this.invalidateCloudAccessStatus();
			this.warmCloudAccessStatus();
		}
		this.updateMathJaxVisibility();
		this.app.workspace.updateOptions();
	}

	private invalidateCloudAccessStatus() {
		this.cloudAccessStatusPromise = null;
		this.cachedCloudAccessStatus = undefined;
	}

	private warmCloudAccessStatus() {
		if (this.settings.useLocalInference || !this.settings.apiKey?.trim()) {
			this.cachedCloudAccessStatus = null;
			return;
		}

		void this.loadCloudAccessStatus();
	}

	private async loadCloudAccessStatus(): Promise<boolean | null> {
		if (this.settings.useLocalInference || !this.settings.apiKey?.trim()) {
			this.cachedCloudAccessStatus = null;
			return null;
		}

		if (this.cachedCloudAccessStatus !== undefined) {
			return this.cachedCloudAccessStatus;
		}

		if (!this.cloudAccessStatusPromise) {
			const apiKey = this.settings.apiKey.trim();
			this.cloudAccessStatusPromise = requestUrl({
				url: CLOUD_ACCESS_STATUS_URL,
				headers: {
					"Api-Key": apiKey,
				},
				throw: false,
			})
				.then((response) => {
					if (response.status >= 400) {
						throw new Error(
							`Cloud access status request failed with status ${response.status}.`
						);
					}

					const payload = response.json as {
						hasUnlimitedAccess?: unknown;
					};
					return payload.hasUnlimitedAccess === true;
				})
				.catch((error) => {
					console.warn("Could not determine MathLive cloud access status.", error);
					return null;
				})
				.finally(() => {
					this.cloudAccessStatusPromise = null;
				});
		}

		this.cachedCloudAccessStatus = await this.cloudAccessStatusPromise;
		return this.cachedCloudAccessStatus;
	}

	// Opens the editor window on the formula that contains the position.
	private openEditorWindowAt(view: EditorView, position: number, inline: boolean) {
		let editor: Editor | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(view.dom)) {
				editor = leaf.view.editor;
			}
		});
		if (!editor) {
			return;
		}

		editor.setCursor(editor.offsetToPos(position));
		new MathLiveModal(this.app, editor, this, inline).open();
	}

	// The note the hotkey was pressed in, or the one used last when it was pressed somewhere else,
	// so a formula in a PDF next to a note can be scanned into that note.
	private findNoteForScan(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) {
			return active;
		}
		const last = this.lastNoteView;
		if (last?.file && last.containerEl.isConnected) {
			return last;
		}
		const leaf = this.app.workspace.getLeavesOfType("markdown")[0];
		return leaf?.view instanceof MarkdownView ? leaf.view : null;
	}

	async scanScreenAreaIntoNote(anywhere = false) {
		const view = this.findNoteForScan();
		if (!view?.file) {
			new Notice("Open a note first, so the scanned formula has somewhere to go.");
			return;
		}

		const file = view.file;
		const target: ScanTarget = {
			settings: this.settings,
			isOpen: () => view.file === file && view.containerEl.isConnected,
			insert: (latex) => insertScannedMath(view.editor, latex),
			addedMessage: "Scanned formula added to the note",
			closedMessage: "The note was closed before the scan finished. Open it and scan again.",
		};
		if (anywhere) {
			await scanAnywhereOnScreenInto(this.app, target, activeDocument);
		} else {
			await scanScreenAreaInto(this.app, target, activeDocument);
		}
	}

	async shouldShowUpgradeButton(): Promise<boolean> {
		return (await this.loadCloudAccessStatus()) === false;
	}

	updateMathJaxVisibility() {
		const editorOn = this.settings.enableInlineEditorMode;
		// While MathLive inline widgets are on, Obsidian's inline MathJax must not sit above them in
		// the hit-testing stack — the first click would hit mjx, exit math-edit state, and remove the widget.
		const hideInlineInEditor =
			editorOn &&
			(this.settings.hideRenderedInlineMath || this.settings.enableInlineMathWidgets);
		const hideBlockInEditor =
			editorOn &&
			(this.settings.hideRenderedBlockMath || this.settings.enableBlockMathWidgets);

		for (const doc of this.getOpenDocuments()) {
			doc.body.toggleClass("mathlive-hide-mathjax-inline", hideInlineInEditor);
			doc.body.toggleClass("mathlive-hide-mathjax-block", hideBlockInEditor);
			doc.body.toggleClass("mathlive-hide-rendered-inline", hideInlineInEditor);
			doc.body.toggleClass("mathlive-hide-rendered-block", hideBlockInEditor);
			doc.body.toggleClass(
				"mathlive-inline-widgets-active",
				editorOn && this.settings.enableInlineMathWidgets
			);
			doc.body.toggleClass(
				"mathlive-block-widgets-active",
				editorOn && this.settings.enableBlockMathWidgets
			);
		}
	}

}

export class MathliveSettingTab extends PluginSettingTab {
  plugin: MathLivePlugin;

  constructor(app: App, plugin: MathLivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
	const { containerEl } = this;

	containerEl.empty();

	containerEl.createEl("p", {
		cls: "mathlive-settings-intro",
		text: "MathLive has two features: a visual formula editor, which is free and works offline, and an image scanner that turns a formula screenshot into LaTeX.",
	});

	new Setting(containerEl).setName("Image scanner").setHeading();

	new Setting(containerEl)
		.setName("API key")
		.setDesc(
			createFragment((frag) => {
				frag.appendText(
					"The cloud scanner needs a MathLive account. Free accounts include 10 scans, and unlimited scanning is a paid plan. Scanned images are sent to mathlive.danz.blog. Create an account and API key at "
				);
				frag.createEl("a", {
					text: "mathlive.danz.blog",
					href: "https://mathlive.danz.blog",
				});
				frag.appendText(".");
			})
		)
		.addText(tc => tc.setValue(this.plugin.settings.apiKey ?? "").onChange(async val => {
			this.plugin.settings.apiKey = val;
			await this.plugin.saveSettings({ refreshCloudAccessStatus: true })
		}))

	new Setting(containerEl)
		.setName("Scan from screen")
		.setDesc(
			"Drag a box around a formula anywhere in Obsidian, such as in a PDF or an image, and its LaTeX goes in your note at the cursor. Start it from the scan icon in the left ribbon, or give the scan command a hotkey. To scan a formula in another app, such as a browser, use the command that scans anywhere on screen."
		);

	new Setting(containerEl)
		.setName("Self-hosted scanner")
		.setDesc("Send scans to a scanner you run yourself instead of the cloud. Free, but needs Docker and some technical setup.")
		.addToggle(toggle => toggle.setValue(this.plugin.settings.useLocalInference).onChange(async val => {
			this.plugin.settings.useLocalInference = val;
			await this.plugin.saveSettings({ refreshCloudAccessStatus: true })
		}));

	new Setting(containerEl)
		.setName("Self-hosted scanner address")
		.setDesc("Where your scanner runs, for example on another computer in your network.")
		.addText(tc => tc
			.setPlaceholder(DEFAULT_SETTINGS.localInferenceUrl)
			.setValue(this.plugin.settings.localInferenceUrl)
			.onChange(async val => {
				this.plugin.settings.localInferenceUrl = val.trim();
				await this.plugin.saveSettings()
			}));

	new Setting(containerEl).setName("Inline editor").setHeading();

	new Setting(containerEl)
		.setName("Enable inline editor mode")
		.setDesc("Render editable MathLive widgets directly in the editor for existing math expressions.")
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.enableInlineEditorMode).onChange(async (val) => {
				this.plugin.settings.enableInlineEditorMode = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Enable inline math widgets")
		.setDesc("Show MathLive widgets for `$...$` expressions when inline editor mode is enabled.")
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.enableInlineMathWidgets).onChange(async (val) => {
				this.plugin.settings.enableInlineMathWidgets = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Enable block math widgets")
		.setDesc("Show MathLive widgets for `$$...$$` expressions when inline editor mode is enabled.")
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.enableBlockMathWidgets).onChange(async (val) => {
				this.plugin.settings.enableBlockMathWidgets = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Hide rendered inline math")
		.setDesc(
			"When inline MathLive widgets are enabled, inline MathJax in the editor is always hidden so clicks reach the widget (otherwise MathJax sits on top and the first click dismisses editing). When widgets are off, this only toggles hiding MathJax for $…$ in Live Preview."
		)
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.hideRenderedInlineMath).onChange(async (val) => {
				this.plugin.settings.hideRenderedInlineMath = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Hide rendered block math")
		.setDesc(
			"When block MathLive widgets are enabled, block MathJax in the editor is always hidden for the same reason as inline (click-through). When block widgets are off, this only toggles hiding MathJax for $$…$$ in Live Preview."
		)
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.hideRenderedBlockMath).onChange(async (val) => {
				this.plugin.settings.hideRenderedBlockMath = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Update inline widgets immediately")
		.setDesc("When disabled, inline widget edits update the Markdown source on blur instead of on every input.")
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.immediateInlineUpdate).onChange(async (val) => {
				this.plugin.settings.immediateInlineUpdate = val;
				await this.plugin.saveSettings();
			})
		);

	new Setting(containerEl)
		.setName("Arrow key navigation between editor and widgets")
		.setDesc("Use arrow keys at math boundaries to enter or exit MathLive widgets.")
		.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.arrowKeyNavigation).onChange(async (val) => {
				this.plugin.settings.arrowKeyNavigation = val;
				await this.plugin.saveSettings();
			})
		);
  }
}

class MathLiveModal extends Modal {
	renderedResult?: string
	editor: Editor
	plugin: MathLivePlugin
	mfe?: MathfieldElement
	inline: boolean 
	resultRenderTemplate: (res: string) => string
	private insertHotkey?: KeymapEventHandler
	private replaceFrom?: EditorPosition
	private replaceTo?: EditorPosition
	
	constructor(app: App, editor: Editor, plugin: MathLivePlugin, inline=false) {
		super(app);
		this.editor = editor
		this.plugin = plugin
		this.inline = inline;
	}

	onOpen() {
		const modalContent = this.contentEl;

		this.initHeader()

		this.insertHotkey = this.scope.register(["Mod"], "Enter", () => {
			this.close();
			return false;
		});

		this.initMathlive(modalContent)
		
		const actionsContainer = modalContent.createDiv({ cls: "mathlive-modal-actions" });
		this.initImageScanner(actionsContainer)
		this.initSubmitButton(actionsContainer)
	}

	initMathlive(modalContent: Element) {
		const mathliveModalRoot = modalContent.parentElement?.parentElement
		mathliveModalRoot?.addClass("mathlive-modal-root")
		const keyboardContainer = createDiv()
		keyboardContainer.addClass("virt-keyboard")
		mathliveModalRoot?.append(keyboardContainer)

		const selectionTarget = this.resolveSelectionTarget();
		this.replaceFrom = selectionTarget.from;
		this.replaceTo = selectionTarget.to;
		const parseResult = parseMathSelection(selectionTarget.text, this.inline);
		const {initialLatex, resultRenderTemplate} = parseResult;
		this.resultRenderTemplate = resultRenderTemplate

		this.renderedResult = resultRenderTemplate(initialLatex);

		this.mfe = createMathfield({
			initialValue: initialLatex,
			inline: this.inline,
			id: "mathlive-modal-field",
			onInput: (value) => {
				this.renderedResult = resultRenderTemplate(value);
			},
		});
		// Inline-math mode doesn't scroll long formulas in the modal (#21). The note still gets
		// inline math, because resultRenderTemplate decides the $ or $$ delimiters.
		this.mfe.defaultMode = "math";
		this.mfe.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			this.close();
		}, { capture: true });
		moveVirtualKeyboard(keyboardContainer)

		modalContent.addClass("mathlive-modal-content");
		modalContent.appendChild(this.mfe);
		this.focusFormulaWhenShown();
	}

	// Obsidian focuses the window's first button as it opens, and MathLive can't take focus until
	// the window has finished appearing, so keep focusing the formula until it sticks.
	private focusFormulaWhenShown() {
		const win = this.contentEl.win;
		const doc = this.contentEl.doc;
		const deadline = Date.now() + 1000;
		const tryFocus = () => {
			if (!this.mfe?.isConnected || doc.activeElement === this.mfe) {
				return;
			}
			this.mfe.focus();
			if (Date.now() < deadline) {
				win.requestAnimationFrame(tryFocus);
			}
		};
		tryFocus();
	}

	private resolveSelectionTarget() {
		const selectionText = this.editor.getSelection();
		const from = this.editor.getCursor("from");
		const to = this.editor.getCursor("to");

		if (selectionText.length > 0) {
			return { text: selectionText, from, to };
		}

		const cursor = this.editor.getCursor();
		const enclosingRange = this.findEnclosingMathRange(cursor);
		if (!enclosingRange) {
			return { text: "", from, to };
		}

		return {
			text: this.editor.getRange(enclosingRange.from, enclosingRange.to),
			from: enclosingRange.from,
			to: enclosingRange.to,
		};
	}

	private findEnclosingMathRange(cursor: EditorPosition) {
		const range = findEnclosingMath(this.editor.getValue(), this.editor.posToOffset(cursor));
		if (!range) {
			return null;
		}
		return { from: this.editor.offsetToPos(range.from), to: this.editor.offsetToPos(range.to) };
	}

	initHeader() {
		this.setTitle(this.inline ? "Edit inline math" : "Edit math block");
		this.titleEl.addClass("mathlive-modal-title");

		// A div like Obsidian's own close button, so Obsidian doesn't focus it when the window opens.
		const menuButton = createDiv({
			cls: "mathlive-modal-menu-trigger clickable-icon",
			attr: {
				role: "button",
				"aria-label": "More options",
				"aria-haspopup": "menu",
			},
		});
		setIcon(menuButton, "more-vertical");
		// Next to the title, where Obsidian also puts the close button.
		this.titleEl.insertAdjacentElement("afterend", menuButton);
		menuButton.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.showMenu(menuButton);
		});
	}

	private async showMenu(button: HTMLElement) {
		const settings = this.plugin.settings;
		const needsSignIn = !settings.useLocalInference && !settings.apiKey?.trim();
		const canUpgrade = !needsSignIn && (await this.plugin.shouldShowUpgradeButton());

		const menu = new Menu();
		if (needsSignIn || canUpgrade) {
			menu.addItem((item) =>
				item
					.setTitle(needsSignIn ? "Sign in to scan images" : "Upgrade for more scans")
					.setIcon("user")
					.onClick(() => window.open(ACCOUNT_URL))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Made by Dan Zilberman")
				.setIcon("external-link")
				.onClick(() => window.open(AUTHOR_URL))
		);
		showMenuBelow(menu, button);
	}

	initSubmitButton(actions: HTMLElement) {
		const submitButton = actions.createEl("button", {
			cls: "submit mathlive-action-btn mod-cta",
			attr: { type: "button" },
		});
		submitButton.createSpan({ cls: "mathlive-btn-title", text: "Insert into note" });
		submitButton.createEl("kbd", {
			cls: "mathlive-btn-hint",
			text: Platform.isMacOS ? "⌘ Enter" : "Ctrl+Enter",
		});
		submitButton.addEventListener("click", () => this.close());
	}

	initImageScanner(actions: HTMLElement) {
		const group = actions.createDiv({ cls: "mathlive-scan-actions" });
		const addButton = (cls: string, icon: string, title: string, onClick: () => void) => {
			const button = group.createEl("button", {
				cls: `${cls} mathlive-action-btn`,
				attr: { type: "button" },
			});
			setIcon(button.createSpan({ cls: "mathlive-btn-icon" }), icon);
			button.createSpan({ cls: "mathlive-btn-title", text: title });
			button.addEventListener("click", onClick);
		};
		addButton("scan-button", "image-plus", "Scan clipboard image", () => {
			void this.onImageScanRequest();
		});
		addButton("scan-screen-button", "scan", "Scan from screen", () => {
			void this.onScreenScanRequest();
		});
	}

	private scanTarget(mathfield: MathfieldElement) {
		return {
			settings: this.plugin.settings,
			mathfield,
			onValueChange: (value: string) => {
				this.renderedResult = this.resultRenderTemplate(value);
			},
		};
	}

	async onImageScanRequest() {
		if (!this.mfe) {
			return;
		}

		await appendLatexFromClipboardImage(this.scanTarget(this.mfe), () => {
			void this.onScreenScanRequest();
		});
	}

	// Hides this window while the user picks the formula, so it isn't in the way.
	async onScreenScanRequest() {
		if (!this.mfe) {
			return;
		}

		const mathfield = this.mfe;
		await scanScreenAreaInto(this.app, mathfieldScanTarget(this.scanTarget(mathfield)), this.containerEl.doc, () => {
			this.containerEl.hide();
			return () => this.containerEl.show();
		});
		if (mathfield.isConnected) {
			this.focusFormulaWhenShown();
		}
	}

	onClose() {
		// Give the keyboard back to the note, or formulas there would open it inside this closed window.
		moveVirtualKeyboard(this.contentEl.doc.body);
		if (this.insertHotkey) {
			this.scope.unregister(this.insertHotkey);
			this.insertHotkey = undefined;
		}
		if (this.renderedResult === undefined || !this.replaceFrom || !this.replaceTo) {
			return;
		}

		this.editor.replaceRange(this.renderedResult, this.replaceFrom, this.replaceTo);
		// Leave the cursor after the inserted math so typing can continue (#22).
		const endOffset = this.editor.posToOffset(this.replaceFrom) + this.renderedResult.length;
		this.editor.setCursor(this.editor.offsetToPos(endOffset));
	}
}

// Puts scanned LaTeX at the cursor: as a math block on an empty line, as inline math in text,
// and as it is inside a formula that's already there.
function insertScannedMath(editor: Editor, latex: string) {
	const cursor = editor.getCursor();
	const offset = editor.posToOffset(cursor);
	let text: string;
	if (findEnclosingMath(editor.getValue(), offset)) {
		text = latex;
	} else if (editor.getLine(cursor.line).trim() === "") {
		text = `$$\n${latex}\n$$`;
	} else {
		text = `$${latex}$`;
	}
	editor.replaceRange(text, cursor);
	editor.setCursor(editor.offsetToPos(offset + text.length));
}

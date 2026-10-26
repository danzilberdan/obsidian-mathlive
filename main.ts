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
} from "obsidian";
import type { MathfieldElement } from "mathlive";
import { createInlineMathEditorExtension } from "./mathlive-inline";
import {
	createMathfield,
	ensureMathfieldElementRegistered,
	registerMathliveFonts,
	appendLatexFromClipboardImage,
	parseMathSelection,
} from "./mathlive-shared";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";

const CLOUD_ACCESS_STATUS_URL = "https://mathlive-ocr.danz.blog/access-status";
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
		this.registerEditorExtension(
			createInlineMathEditorExtension(
				() => this.settings,
				() => this.shouldShowUpgradeButton()
			)
		);
		this.addSettingTab(new MathliveSettingTab(this.app, this));
		this.registerEvent(
			this.app.workspace.on("window-open", (workspaceWindow) => {
				registerMathliveFonts(workspaceWindow.doc);
				this.updateMathJaxVisibility();
			})
		);
		this.updateMathJaxVisibility();
		this.app.workspace.onLayoutReady(() => this.app.workspace.updateOptions());
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
					"The cloud scanner needs a MathLive account. Free accounts include 10 scans, and unlimited scanning is a paid plan. Scanned images are sent to mathlive-ocr.danz.blog. Create an account and API key at "
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
	private menuOutsideListener?: (e: MouseEvent) => void
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

		const header = this.initHeader(modalContent)
		this.initOverflowMenu(header)

		this.insertHotkey = this.scope.register(["Mod"], "Enter", () => {
			this.close();
			return false;
		});

		this.initMathlive(modalContent)
		
		const actionsContainer = modalContent.createDiv({ cls: "mathlive-modal-actions" });
		this.initSubmitButton(actionsContainer)
		this.initImageScanner(actionsContainer)
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
		window.mathVirtualKeyboard.container = keyboardContainer

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
		const doc = this.editor.getValue();
		const cursorOffset = this.editor.posToOffset(cursor);
		let inlineStart: number | null = null;
		let blockStart: number | null = null;

		for (let index = 0; index < doc.length; ) {
			if (doc[index] !== "$" || this.isEscapedDollar(doc, index)) {
				index += 1;
				continue;
			}

			const isBlockDelimiter = doc[index + 1] === "$";
			if (blockStart !== null) {
				if (isBlockDelimiter) {
					const end = index + 2;
					if (cursorOffset > blockStart && cursorOffset < end) {
						return {
							from: this.editor.offsetToPos(blockStart),
							to: this.editor.offsetToPos(end),
						};
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
				if (cursorOffset > inlineStart && cursorOffset < end) {
					return {
						from: this.editor.offsetToPos(inlineStart),
						to: this.editor.offsetToPos(end),
					};
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

	private isEscapedDollar(text: string, index: number) {
		let backslashCount = 0;
		for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
			backslashCount += 1;
		}

		return backslashCount % 2 === 1;
	}

	initHeader(modalContent: Element) {
		const header = modalContent.createDiv({ cls: "header mathlive-modal-header" });
		header.createEl("h2", {
			text: this.inline ? "Edit inline math" : "Edit math block",
			cls: "mathlive-modal-title"
		});
		return header;
	}

	initOverflowMenu(header: HTMLElement) {
		const wrap = header.createDiv({ cls: "mathlive-modal-menu" });
		const trigger = wrap.createEl("button", {
			cls: "mathlive-modal-menu-trigger",
			attr: {
				type: "button",
				"aria-label": "More options",
				"aria-expanded": "false",
				"aria-haspopup": "true",
			},
		});
		setIcon(trigger, "more-vertical");

		const dropdown = wrap.createDiv({ cls: "mathlive-modal-menu-dropdown" });
		const link = dropdown.createEl("a", {
			cls: "mathlive-modal-menu-item external-link",
			text: "Made by Dan Zilberman",
			href: "https://danz.blog",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener noreferrer");

		const closeMenu = () => {
			dropdown.addClass("mathlive-modal-menu-dropdown--hidden");
			trigger.setAttr("aria-expanded", "false");
			if (this.menuOutsideListener) {
				wrap.doc.removeEventListener("click", this.menuOutsideListener);
				this.menuOutsideListener = undefined;
			}
		};

		const openMenu = () => {
			dropdown.removeClass("mathlive-modal-menu-dropdown--hidden");
			trigger.setAttr("aria-expanded", "true");
			window.setTimeout(() => {
				this.menuOutsideListener = (e: MouseEvent) => {
					if (!wrap.contains(e.target as Node)) {
						closeMenu();
					}
				};
				wrap.doc.addEventListener("click", this.menuOutsideListener);
			}, 0);
		};

		trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			if (dropdown.hasClass("mathlive-modal-menu-dropdown--hidden")) {
				openMenu();
			} else {
				closeMenu();
			}
		});

		dropdown.addClass("mathlive-modal-menu-dropdown--hidden");
	}

	initSubmitButton(modalContent: Element) {
		const row = window.createDiv({ cls: "mathlive-button-row" });
		const submitButton = row.createEl("button", {
			cls: "submit mathlive-action-btn",
			attr: { type: "button" },
		});
		
		const iconSpan = submitButton.createSpan({ cls: "mathlive-btn-icon" });
		setIcon(iconSpan, "check");
		
		const textWrap = submitButton.createDiv({ cls: "mathlive-btn-text-wrap" });
		textWrap.createSpan({
			cls: "mathlive-btn-title",
			text: "Insert into note",
		});
		textWrap.createSpan({
			cls: "mathlive-btn-hint",
			text: Platform.isMacOS ? "⌘ Enter" : "Ctrl+Enter",
		});
		
		submitButton.addEventListener("click", () => this.close());
		modalContent.appendChild(row);
	}

	initImageScanner(modalContent: Element) {
		const row = window.createDiv({ cls: "mathlive-button-row" });
		const scan = row.createEl("button", {
			cls: "scan-button mathlive-action-btn",
			attr: { type: "button" },
		});
		
		const iconSpan = scan.createSpan({ cls: "mathlive-btn-icon" });
		setIcon(iconSpan, "image-plus");
		
		const textWrap = scan.createDiv({ cls: "mathlive-btn-text-wrap" });
		textWrap.createSpan({
			cls: "mathlive-btn-title",
			text: "Add LaTeX from clipboard image",
		});
		textWrap.createSpan({
			cls: "mathlive-btn-desc",
			text: "Paste a formula screenshot as editable math",
		});
		
		scan.addEventListener("click", () => {
			void this.onImageScanRequest();
		});

		modalContent.appendChild(row);
	}

	async onImageScanRequest() {
		if (!this.mfe) {
			return;
		}

		await appendLatexFromClipboardImage({
			settings: this.plugin.settings,
			mathfield: this.mfe,
			onValueChange: (value) => {
				this.renderedResult = this.resultRenderTemplate(value);
			},
		});
	}

	onClose() {
		if (this.menuOutsideListener) {
			this.contentEl.doc.removeEventListener("click", this.menuOutsideListener);
			this.menuOutsideListener = undefined;
		}
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

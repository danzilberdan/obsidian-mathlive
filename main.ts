import {
	App,
	Editor,
	type EditorPosition,
	MarkdownFileInfo,
	Modal,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	type KeymapEventHandler,
} from "obsidian";
import type { MathfieldElement } from "mathlive";
import { createInlineMathEditorExtension } from "./mathlive-inline";
import {
	createMathfield,
	ensureMathfieldElementRegistered,
	appendLatexFromClipboardImage,
	parseMathSelection,
} from "./mathlive-shared";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";

const CLOUD_ACCESS_STATUS_URL = "https://mathlive-ocr.danz.blog/access-status";

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
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
				new MathLiveModal(this.app, editor, this).open();
			}
		});
		
		this.addCommand({
			id: 'open-modal-inline',
			name: 'Add inline math',
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
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
		this.updateMathJaxVisibility();
		this.app.workspace.onLayoutReady(() => this.app.workspace.updateOptions());
	}

	onunload() {
		document.body.removeClass("mathlive-hide-rendered-inline");
		document.body.removeClass("mathlive-hide-rendered-block");
		document.body.removeClass("mathlive-hide-mathjax-inline");
		document.body.removeClass("mathlive-hide-mathjax-block");
		document.body.removeClass("mathlive-inline-widgets-active");
		document.body.removeClass("mathlive-block-widgets-active");
		this.app.workspace.updateOptions();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			this.cloudAccessStatusPromise = fetch(CLOUD_ACCESS_STATUS_URL, {
				headers: {
					"Api-Key": apiKey,
				},
			})
				.then(async (response) => {
					if (!response.ok) {
						throw new Error(
							`Cloud access status request failed with status ${response.status}.`
						);
					}

					const payload = (await response.json()) as {
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

		document.body.toggleClass("mathlive-hide-mathjax-inline", hideInlineInEditor);
		document.body.toggleClass("mathlive-hide-mathjax-block", hideBlockInEditor);
		document.body.toggleClass("mathlive-hide-rendered-inline", hideInlineInEditor);
		document.body.toggleClass("mathlive-hide-rendered-block", hideBlockInEditor);
		document.body.toggleClass(
			"mathlive-inline-widgets-active",
			editorOn && this.settings.enableInlineMathWidgets
		);
		document.body.toggleClass(
			"mathlive-block-widgets-active",
			editorOn && this.settings.enableBlockMathWidgets
		);
	}

}

export class MathliveSettingTab extends PluginSettingTab {
  plugin: MathLivePlugin;

  constructor(app: App, plugin: MathLivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

	const title = document.createElement('h2')
	title.textContent = 'Obsidian Mathlive'
	title.setCssStyles({
		fontSize: '28px'
	})
	containerEl.appendChild(title);
    
	const intro = `This plugins currently has 2 main features, visual formula editor, and image to MathJax scanner.
The MathJax image scanner is available for free when self hosting.
In addition, there is a cloud option that requires no setup.

* Self hosting the image scanner may require technical knowledge of docker and requires background processing resources. For most people, the cloud options is better.`
	const introEl = document.createElement('p');
	introEl.textContent = intro;
	introEl.style.whiteSpace = 'pre-wrap'
	containerEl.appendChild(introEl);

	new Setting(containerEl);
	const cloudTitle = document.createElement('h2')
	cloudTitle.textContent = 'Cloud Settings'
	cloudTitle.setCssStyles({
		fontSize: '24px'
	})
	containerEl.appendChild(cloudTitle);

	new Setting(containerEl)
		.setName('API key')
		.addText(tc => tc.setValue(this.plugin.settings.apiKey ?? "").onChange(async val => {
			this.plugin.settings.apiKey = val;
			await this.plugin.saveSettings({ refreshCloudAccessStatus: true })
		}))
    
	const homepageLink = document.createElement('a')
	homepageLink.href = 'https://mathlive.danz.blog'
	homepageLink.text = 'Create an API key here'
	containerEl.appendChild(homepageLink)

	const cloudHelp = document.createElement('p');
	cloudHelp.textContent = 'If cloud OCR returns any 4xx error, open these settings, configure your API key, and make sure your remote account is funded.';
	cloudHelp.style.whiteSpace = 'pre-wrap';
	containerEl.appendChild(cloudHelp);

	new Setting(containerEl);

	const selfHostTitle = document.createElement('h2')
	selfHostTitle.textContent = 'Self Hosting Settings'
	selfHostTitle.setCssStyles({
		fontSize: '24px'
	})
	containerEl.appendChild(selfHostTitle);

	new Setting(containerEl)
		.setName('Self hosted')
		.addToggle(toggle => toggle.setValue(this.plugin.settings.useLocalInference).onChange(async val => {
			this.plugin.settings.useLocalInference = val;
			await this.plugin.saveSettings({ refreshCloudAccessStatus: true })
		}));

	new Setting(containerEl);
	const editorModeTitle = document.createElement("h2");
	editorModeTitle.textContent = "Inline Editor Mode";
	editorModeTitle.setCssStyles({
		fontSize: "24px",
	});
	containerEl.appendChild(editorModeTitle);

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
		const keyboardContainer = window.createEl('div')
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
		this.mfe.focus();
		setTimeout(() => this.mfe?.focus(), 10)
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
		const title = header.createEl("h2", { 
			text: this.inline ? "Edit Inline Math" : "Edit Math Block", 
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
				document.removeEventListener("click", this.menuOutsideListener);
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
				document.addEventListener("click", this.menuOutsideListener);
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
			document.removeEventListener("click", this.menuOutsideListener);
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
	}
}

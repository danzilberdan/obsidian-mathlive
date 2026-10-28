import {
	App,
	Editor,
	type EditorPosition,
	Modal,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	requireApiVersion,
	setIcon,
	type TextComponent,
	type KeymapEventHandler,
	MarkdownView,
	Menu,
	type ItemView,
	TFile,
	type View,
	Notice,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { MathfieldElement } from "mathlive";
import { CloudAccount } from "./account";
import { createInlineMathEditorExtension } from "./mathlive-inline";
import {
	createMathfield,
	ensureMathfieldElementRegistered,
	registerMathliveFonts,
	appendLatexFromClipboardImage,
	findEnclosingMath,
	mathfieldScanTarget,
	scanScreenAreaInto,
	setScanAccount,
	type ScanTarget,
	moveVirtualKeyboard,
	parseMathSelection,
} from "./mathlive-shared";
import { endDrawSessions, openDrawWindow } from "./draw";
import { convertPdfToNotes, isPdf } from "./pdf-notes";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";
import { GuideModal } from "./guide";
import { WelcomeModal } from "./welcome";
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
	account: CloudAccount;
	// Where a scan from the screen goes when the hotkey is pressed outside a note, like in a PDF.
	private lastNoteView: MarkdownView | null = null;
	// Switched from a note's ⋮ menu, and not saved.
	private showRawLatex = false;
	private pdfViewsWithButton = new WeakSet<View>();

	async onload() {
		await ensureMathfieldElementRegistered();
		await this.loadSettings();
		this.account = new CloudAccount(this);
		setScanAccount(this.account);
		void this.account.refreshStatus();
		// The website sends the browser here after the user approves connecting this device.
		this.registerObsidianProtocolHandler("mathlive-auth", (params) => {
			void this.account.handleReturn(params);
		});
		// Plans bought in the browser show up when the user comes back.
		this.registerDomEvent(window, "focus", () => this.account.refreshIfStale());

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
			id: "draw-formula",
			name: "Draw formula",
			callback: () => {
				void this.drawFormulaIntoNote();
			},
		});
		this.addCommand({
			id: "open-guide",
			name: "Open the guide",
			callback: () => this.openGuide(),
		});
		this.addCommand({
			id: "toggle-raw-latex",
			name: "Show raw LaTeX in notes, or editors again",
			callback: () => this.toggleRawLatex(),
		});
		this.addCommand({
			id: "convert-pdf-to-notes",
			name: "Convert PDF to notes",
			callback: () => this.convertPdf(),
		});
		// The note's ⋮ menu switches its formulas to LaTeX for a while, and back.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				if (source !== "more-options" || !(file instanceof TFile) || file.extension !== "md" || !this.settings.enableInlineEditorMode) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle(this.showRawLatex ? "Show formulas as editors" : "Show raw LaTeX")
						.setIcon(this.showRawLatex ? "sigma" : "code")
						.setSection("view")
						.onClick(() => this.toggleRawLatex())
				);
			})
		);
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
		// One ✨ in the ribbon for what MathLive does anywhere in Obsidian. A formula's own ✨ has what
		// it can do for that formula.
		this.addRibbonIcon("sparkles", "MathLive", (event) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Scan formula from screen").setIcon("scan").onClick(() => void this.scanScreenAreaIntoNote())
			);
			menu.addItem((item) =>
				item.setTitle("Draw formula").setIcon("pencil-line").onClick(() => void this.drawFormulaIntoNote())
			);
			menu.addItem((item) =>
				item.setTitle("Convert a PDF to notes").setIcon("file-text").onClick(() => this.convertPdf())
			);
			menu.showAtMouseEvent(event);
		});
		// Every open PDF gets a button in its header, where people look when they have a PDF open.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.addPdfButtons()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.addPdfButtons()));
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
				accountAction: () => this.account.menuAction(),
				openEditorWindow: (view, position, inline) => this.openEditorWindowAt(view, position, inline),
				openGuide: () => this.openGuide(),
				showsRawLatex: () => this.showRawLatex,
				drawFormula: (target) => void openDrawWindow(this.app, { settings: this.settings, target, fallback: () => this.noteScanTarget() }),
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
			this.addPdfButtons();
			if (!this.settings.welcomeShown) {
				this.settings.welcomeShown = true;
				void this.saveSettings();
				new WelcomeModal(this.app, this.account, () => this.openEditorFromWelcome(), () => this.openGuide()).open();
			}
		});
	}

	// Everything MathLive does, with buttons to try each part.
	openGuide() {
		new GuideModal(this.app, {
			account: this.account,
			addFormula: () => this.openEditorFromWelcome(),
			scanFromScreen: () => void this.scanScreenAreaIntoNote(),
			drawFormula: () => void this.drawFormulaIntoNote(),
			convertPdf: () => this.convertPdf(),
		}).open();
	}

	// Converts the open PDF, or asks which one.
	convertPdf() {
		const active = this.app.workspace.getActiveFile();
		void convertPdfToNotes(this.app, this.settings, isPdf(active) ? active : undefined);
	}

	private addPdfButtons() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view.getViewType() !== "pdf" || this.pdfViewsWithButton.has(view)) {
				return;
			}
			this.pdfViewsWithButton.add(view);
			const button = (view as ItemView).addAction("file-text", "Convert to notes with MathLive", () => {
				const file = (view as ItemView & { file?: TFile | null }).file;
				void convertPdfToNotes(this.app, this.settings, isPdf(file) ? file : undefined);
			});
			// A labelled button, not just an icon, so it's seen.
			button.addClass("mathlive-pdf-convert-action");
			button.createSpan({ cls: "mathlive-pdf-convert-label", text: "Convert to notes" });
			this.register(() => button.remove());
		});
	}

	// "Try the editor" in the welcome window: a full-line formula at the cursor of the open note.
	private openEditorFromWelcome() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastNoteView;
		if (!view?.editor) {
			new Notice("Open a note first, then try the editor from the command palette.");
			return;
		}
		new MathLiveModal(this.app, view.editor, this).open();
	}

	onunload() {
		endDrawSessions();
		setScanAccount(null);
		this.account.cancelConnect();
		for (const doc of this.getOpenDocuments()) {
			doc.body.removeClasses(BODY_CLASSES);
		}
		this.app.workspace.updateOptions();
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		if (saved && saved.welcomeShown === undefined) {
			// Updated from a version without the welcome window: this isn't a new user.
			this.settings.welcomeShown = true;
		}
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
		// The server addresses are only saved when changed, so a later build's addresses reach everyone.
		const data: Partial<PluginSettings> = { ...this.settings };
		if (data.cloudScannerUrl === DEFAULT_SETTINGS.cloudScannerUrl) delete data.cloudScannerUrl;
		if (data.websiteUrl === DEFAULT_SETTINGS.websiteUrl) delete data.websiteUrl;
		await this.saveData(data);
		if (options?.refreshCloudAccessStatus) {
			this.account.invalidateStatus();
			void this.account.refreshStatus();
		}
		this.updateMathJaxVisibility();
		this.app.workspace.updateOptions();
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

	// The cursor of the note a scan or drawing goes into, or null when no note is open.
	noteScanTarget(): ScanTarget | null {
		const view = this.findNoteForScan();
		if (!view?.file) {
			return null;
		}
		const file = view.file;
		return {
			settings: this.settings,
			isOpen: () => view.file === file && view.containerEl.isConnected,
			insert: (latex) => insertScannedMath(view.editor, latex),
			addedMessage: "Scanned formula added to the note",
			closedMessage: "The note was closed before the scan finished. Open it and scan again.",
		};
	}

	async scanScreenAreaIntoNote() {
		const target = this.noteScanTarget();
		if (!target) {
			new Notice("Open a note first, so the scanned formula has somewhere to go.");
			return;
		}
		await scanScreenAreaInto(this.app, target, activeDocument);
	}

	// Until switched back or Obsidian restarts, notes show formulas as LaTeX the Obsidian way.
	toggleRawLatex() {
		this.showRawLatex = !this.showRawLatex;
		this.updateMathJaxVisibility();
		this.app.workspace.updateOptions();
	}

	async drawFormulaIntoNote() {
		const target = this.noteScanTarget();
		if (!target) {
			new Notice("Open a note first, so the drawn formula has somewhere to go.");
			return;
		}
		await openDrawWindow(this.app, {
			settings: this.settings,
			target: { ...target, closedMessage: "The note was closed. Open it and draw the formula again." },
			fallback: () => this.noteScanTarget(),
		});
	}

	updateMathJaxVisibility() {
		const editorOn = this.settings.enableInlineEditorMode && !this.showRawLatex;
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

type SettingRow = {
	name: string;
	desc: string | DocumentFragment;
	addControl: (setting: Setting) => void;
	visible?: () => boolean;
};

type SettingSection = {
	heading?: string;
	rows: SettingRow[];
};

const SETTINGS_INTRO = "MathLive has two features: a visual formula editor, which is free and works offline, and an image scanner that turns a formula screenshot into LaTeX.";

type BooleanSettingKey = {
	[K in keyof PluginSettings]: PluginSettings[K] extends boolean ? K : never;
}[keyof PluginSettings];

export class MathliveSettingTab extends PluginSettingTab {
  plugin: MathLivePlugin;
  private accountEl: HTMLElement | null = null;
  private stopListening: (() => void) | null = null;
  private apiKeyText: TextComponent | null = null;

  constructor(app: App, plugin: MathLivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian 1.13+ builds the tab from these, which also puts the settings in its settings search.
  getSettingDefinitions(): SettingDefinitionItem[] {
	this.stopListening?.();
	this.stopListening = this.plugin.account.onChange(() => this.redraw());
	const intro: SettingDefinitionItem = {
		name: "",
		searchable: false,
		render: (setting: Setting) => {
			setting.settingEl.empty();
			setting.settingEl.addClass("mathlive-settings-intro-row");
			setting.settingEl.createEl("p", { cls: "mathlive-settings-intro", text: SETTINGS_INTRO });
		},
	};
	return [
		intro,
		...this.sections().map((section): SettingDefinitionItem => ({
			type: "group",
			heading: section.heading,
			items: section.rows.map(row => ({
				name: row.name,
				desc: row.desc,
				visible: row.visible,
				render: (setting: Setting) => row.addControl(setting),
			})),
		})),
	];
  }

  // Older Obsidian versions call display() instead.
  display(): void {
	const { containerEl } = this;

	containerEl.empty();

	containerEl.createEl("p", {
		cls: "mathlive-settings-intro",
		text: SETTINGS_INTRO,
	});

	for (const section of this.sections()) {
		if (section.heading) {
			new Setting(containerEl).setName(section.heading).setHeading();
		}
		for (const row of section.rows) {
			if (row.name === "Account") {
				// The account row redraws by itself while connecting, so the rest of the tab keeps its state.
				this.accountEl = containerEl.createDiv();
				this.stopListening?.();
				this.stopListening = this.plugin.account.onChange(() => this.renderAccount(row));
				this.renderAccount(row);
				continue;
			}
			row.addControl(new Setting(containerEl).setName(row.name).setDesc(row.desc));
		}
	}
  }

  hide(): void {
	this.stopListening?.();
	this.stopListening = null;
  }

  private renderAccount(row: SettingRow) {
	const el = this.accountEl;
	if (!el?.isConnected) {
		return;
	}
	el.empty();
	if (row.visible?.() === false) {
		return;
	}
	row.addControl(new Setting(el).setName(row.name));
  }

  private sections(): SettingSection[] {
	// Read this.plugin.settings when a row is drawn, not now: Obsidian may keep these definitions
	// across reopenings of the tab while the settings object is replaced.
	const toggle = (key: BooleanSettingKey) => (setting: Setting) => {
		setting.addToggle(tc => tc.setValue(this.plugin.settings[key]).onChange(async val => {
			this.plugin.settings[key] = val;
			await this.plugin.saveSettings();
		}));
	};

	return [
		{
			rows: [
				{
					name: "Guide",
					desc: "Everything MathLive can do, with a button to try each part.",
					addControl: setting => {
						setting.addButton((button) => button.setButtonText("Open the guide").onClick(() => this.plugin.openGuide()));
					},
				},
			],
		},
		{
			heading: "Image scanner",
			rows: [
				{
					name: "Account",
					desc: "",
					visible: () => !this.plugin.settings.useLocalInference,
					addControl: setting => this.addAccountControls(setting),
				},
				{
					name: "Scan other apps",
					desc: "Scan from screen lets you drag a box around a formula anywhere on your screen, in Obsidian or in another app such as a browser or PDF reader, and its LaTeX goes in your note at the cursor. Start it from ✨ in the left ribbon, ✨ next to a formula, or a hotkey. Turn this off to only scan inside Obsidian's window.",
					addControl: toggle("scanOtherApps"),
				},
			],
		},
		{
			heading: "Inline editor",
			rows: [
				{
					name: "Enable inline editor mode",
					desc: "Render editable MathLive widgets directly in the editor for existing math expressions.",
					addControl: toggle("enableInlineEditorMode"),
				},
				{
					name: "Enable inline math widgets",
					desc: "Show MathLive widgets for `$...$` expressions when inline editor mode is enabled.",
					addControl: toggle("enableInlineMathWidgets"),
				},
				{
					name: "Enable block math widgets",
					desc: "Show MathLive widgets for `$$...$$` expressions when inline editor mode is enabled.",
					addControl: toggle("enableBlockMathWidgets"),
				},
				{
					name: "Hide rendered inline math",
					desc: "When inline MathLive widgets are enabled, inline MathJax in the editor is always hidden so clicks reach the widget (otherwise MathJax sits on top and the first click dismisses editing). When widgets are off, this only toggles hiding MathJax for $…$ in Live Preview.",
					addControl: toggle("hideRenderedInlineMath"),
				},
				{
					name: "Hide rendered block math",
					desc: "When block MathLive widgets are enabled, block MathJax in the editor is always hidden for the same reason as inline (click-through). When block widgets are off, this only toggles hiding MathJax for $$…$$ in Live Preview.",
					addControl: toggle("hideRenderedBlockMath"),
				},
				{
					name: "Update inline widgets immediately",
					desc: "When disabled, inline widget edits update the Markdown source on blur instead of on every input.",
					addControl: toggle("immediateInlineUpdate"),
				},
				{
					name: "Arrow key navigation between editor and widgets",
					desc: "Use arrow keys at math boundaries to enter or exit MathLive widgets.",
					addControl: toggle("arrowKeyNavigation"),
				},
			],
		},
		{
			heading: "Advanced",
			rows: [
				{
					name: "API key",
					desc: createFragment((frag) => {
						frag.appendText(
							"Instead of connecting, paste a key from your account page. Most people don't need this. Scanned images are sent to mathlive.danz.blog; see "
						);
						frag.createEl("a", {
							text: "mathlive.danz.blog",
							href: this.plugin.account.siteUrl("/account"),
						});
						frag.appendText(".");
					}),
					addControl: setting => {
						setting.addText((tc) =>
							(this.apiKeyText = tc)
								.setValue(this.plugin.settings.apiKeySource === null ? (this.plugin.settings.apiKey ?? "") : "")
								.setPlaceholder(this.plugin.settings.apiKeySource === "device" ? "Connected, no key needed" : "")
								.onChange(async (val) => {
									await this.plugin.account.setPastedKey(val.trim() || null);
								})
						);
					},
				},
				{
					name: "Self-hosted scanner",
					desc: "Send scans to a scanner you run yourself instead of the cloud. Free, but needs Docker and some technical setup.",
					addControl: setting => {
						setting.addToggle(toggle => toggle.setValue(this.plugin.settings.useLocalInference).onChange(async val => {
							this.plugin.settings.useLocalInference = val;
							await this.plugin.saveSettings({ refreshCloudAccessStatus: true });
							// The account only matters for the cloud scanner.
							this.refreshAccount();
						}));
					},
				},
				{
					name: "Self-hosted scanner address",
					desc: "Where your scanner runs, for example on another computer in your network.",
					addControl: setting => {
						setting.addText(tc => tc
							.setPlaceholder(DEFAULT_SETTINGS.localInferenceUrl)
							.setValue(this.plugin.settings.localInferenceUrl)
							.onChange(async val => {
								this.plugin.settings.localInferenceUrl = val.trim();
								await this.plugin.saveSettings()
							}));
					},
				},
			],
		},
	];
  }

  // display() keeps its own account container; the declarative tab redraws through update().
  private refreshAccount() {
	if (this.accountEl?.isConnected) {
		const account = this.sections()[1].rows[0];
		this.renderAccount(account);
	} else {
		this.redraw();
	}
  }

  private redraw() {
	if (requireApiVersion("1.13.0")) {
		this.update();
	}
  }

  private addAccountControls(setting: Setting) {
	const account = this.plugin.account;
	setting.setDesc(account.describe());
	setting.settingEl.addClass("mathlive-account-setting");
	if (account.isConnecting()) {
		setting
			.addButton((button) =>
				button.setButtonText("Open the page again").onClick(() => window.open(account.connectUrl()))
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => account.cancelConnect()));
	} else if (account.isConnected()) {
		if (account.status && !account.status.hasUnlimitedAccess) {
			setting.addButton((button) =>
				button.setButtonText("Upgrade").onClick(() => window.open(account.siteUrl("/pricing")))
			);
		}
		setting
			.addButton((button) =>
				button.setButtonText("Manage").onClick(() => window.open(account.siteUrl("/account")))
			)
			.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					await account.disconnect();
					// The API key field may have shown the key that was just removed.
					this.apiKeyText?.setValue("");
				})
			);
	} else {
		setting.addButton((button) =>
			button
				.setButtonText("Connect")
				.setCta()
				.onClick(() => void account.connect())
		);
	}
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
	private stopListening?: () => void
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
		this.initFooter(modalContent)
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
	}

	// Under the buttons: the scans left with a way to get more, and the guide.
	private initFooter(modalContent: HTMLElement) {
		const footer = modalContent.createDiv({ cls: "mathlive-modal-footer" });
		const account = this.plugin.account;
		const render = () => {
			footer.empty();
			const plan = footer.createDiv({ cls: "mathlive-modal-plan" });
			setIcon(plan.createSpan({ cls: "mathlive-btn-icon" }), "gem");
			plan.createSpan({ cls: "mathlive-modal-plan-text", text: account.planLine() });
			const next = account.planAction();
			if (next) {
				const link = plan.createEl("a", { cls: "mathlive-modal-plan-action", text: next.title, href: "#" });
				link.addEventListener("click", (event) => {
					event.preventDefault();
					next.run();
				});
			}
			const guide = footer.createEl("a", { cls: "mathlive-modal-guide-link", href: "#" });
			setIcon(guide.createSpan({ cls: "mathlive-btn-icon" }), "compass");
			guide.createSpan({ text: "Learn what MathLive can do" });
			guide.addEventListener("click", (event) => {
				event.preventDefault();
				this.plugin.openGuide();
			});
		};
		this.stopListening = account.onChange(render);
		render();
		void account.getStatus();
	}

	initSubmitButton(actions: HTMLElement) {
		const submitButton = actions.createEl("button", {
			cls: "submit mathlive-action-btn mod-cta",
			attr: { type: "button" },
		});
		submitButton.createSpan({ cls: "mathlive-btn-title", text: "Insert" });
		submitButton.createEl("kbd", {
			cls: "mathlive-btn-hint",
			text: Platform.isMacOS ? "⌘ Enter" : "Ctrl+Enter",
		});
		submitButton.addEventListener("click", () => this.close());
	}

	initImageScanner(actions: HTMLElement) {
		const group = actions.createDiv({ cls: "mathlive-scan-actions" });
		// Small icons, named by their tooltips.
		const addButton = (cls: string, icon: string, title: string, onClick: () => void) => {
			const button = group.createEl("button", {
				cls: `${cls} mathlive-action-btn mathlive-ai-btn`,
				attr: { type: "button", "aria-label": title },
			});
			setIcon(button.createSpan({ cls: "mathlive-btn-icon" }), icon);
			button.addEventListener("click", onClick);
		};
		addButton("scan-button", "image-plus", "Scan clipboard image", () => {
			void this.onImageScanRequest();
		});
		addButton("scan-screen-button", "scan", "Scan from screen", () => {
			void this.onScreenScanRequest();
		});
		addButton("draw-button", "pencil-line", "Draw formula", () => {
			void this.onDrawRequest();
		});
	}

	// The drawn formula is added to the one in this window.
	async onDrawRequest() {
		if (!this.mfe) {
			return;
		}
		const target = mathfieldScanTarget(this.scanTarget(this.mfe));
		await openDrawWindow(this.app, {
			settings: this.plugin.settings,
			target: { ...target, closedMessage: "The editor window was closed. Open it and draw the formula again." },
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
		this.stopListening?.();
		this.stopListening = undefined;
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

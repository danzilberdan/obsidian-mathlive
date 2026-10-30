import {
	App,
	Editor,
	type EditorPosition,
	Modal,
	Platform,
	Scope,
	Plugin,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	requireApiVersion,
	setIcon,
	type TextComponent,
	type TextAreaComponent,
	type KeymapEventHandler,
	MarkdownView,
	Menu,
	type ItemView,
	TFile,
	type View,
	Notice,
	SuggestModal,
	getLinkpath,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { MathfieldElement } from "mathlive";
import { CloudAccount } from "./account";
import { createInlineMathEditorExtension } from "./mathlive-inline";
import {
	createMathfield,
	insertIntoMathfield,
	ensureMathfieldElementRegistered,
	registerMathliveFonts,
	appendLatexFromClipboardImage,
	findEnclosingMath,
	mathfieldScanTarget,
	scanScreenAreaInto,
	scanPhotoInto,
	scanImageInto,
	CAN_SCAN_SCREEN,
	setScanAccount,
	type ScanTarget,
	releaseVirtualKeyboardFrom,
	styleVirtualKeyboardInPopout,
	fitVirtualKeyboardSpace,
	moveVirtualKeyboard,
	parseMathSelection,
	closeMathfieldMenu,
	hideShownMenu,
	showMenuBelow,
	noticeWithButton,
} from "./mathlive-shared";
import { type MagicEditBox, openMagicEditPopover } from "./magic-edit";
import { toMathJaxLatex } from "./mathjax-latex";
import { endDrawSessions, openDrawWindow } from "./draw";
import { FormulaSearchModal } from "./formula-search";
import { convertPdfToNotes, isPdf } from "./pdf-notes";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";
import { GuideModal } from "./guide";
import { WelcomeModal } from "./welcome";
import {
	LATEX_SUITE_ID,
	PRESET_SHORTHANDS,
	QUICK_LATEX_ID,
	formatShorthands,
	isPluginEnabled,
	parseShorthands,
	readQuickLatexShorthands,
	setActiveShorthands,
	shorthandSourceExtension,
} from "./shorthands";
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
		window.mathVirtualKeyboard.addEventListener("virtual-keyboard-toggle", styleVirtualKeyboardInPopout);
		this.register(() => window.mathVirtualKeyboard.removeEventListener("virtual-keyboard-toggle", styleVirtualKeyboardInPopout));
		window.mathVirtualKeyboard.addEventListener("virtual-keyboard-toggle", fitVirtualKeyboardSpace);
		window.mathVirtualKeyboard.addEventListener("geometrychange", fitVirtualKeyboardSpace);
		this.register(() => {
			window.mathVirtualKeyboard.removeEventListener("virtual-keyboard-toggle", fitVirtualKeyboardSpace);
			window.mathVirtualKeyboard.removeEventListener("geometrychange", fitVirtualKeyboardSpace);
		});
		await this.loadSettings();
		this.applyShorthands();
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
		if (CAN_SCAN_SCREEN) {
			this.addCommand({
				id: "scan-screen-area",
				name: "Scan formula from screen",
				callback: () => {
					void this.scanScreenAreaIntoNote();
				},
			});
		}
		this.addCommand({
			id: "scan-photo",
			name: Platform.isMobile ? "Scan formula from a photo" : "Scan formula from an image file",
			callback: () => {
				void this.scanPhotoIntoNote();
			},
		});
		this.addCommand({
			id: "scan-note-image",
			name: "Scan formula from an image in this note",
			callback: () => {
				void this.scanNoteImage();
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
			id: "find-formula",
			name: "Find a formula",
			callback: () => this.findFormula(),
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
		// An image file, from the file list or an image's own menu, is scanned into the open note.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!isImage(file)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle("Scan formula with MathLive")
						.setIcon("scan-text")
						.onClick(() => void this.scanImageFileIntoNote(file))
				);
			})
		);
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				const image =
					info instanceof MarkdownView ? this.noteImages(info).find((each) => each.line === editor.getCursor().line) : undefined;
				if (image) {
					menu.addItem((item) =>
						item
							.setTitle("Scan this image with MathLive")
							.setIcon("scan-text")
							.setSection("insert")
							.onClick(() => void this.scanEmbeddedImage(info as MarkdownView, image))
					);
				}
				menu.addItem((item) =>
					item
						.setTitle("Find a formula")
						.setIcon("search")
						.setSection("insert")
						.onClick(() => this.findFormula(editor))
				);
			})
		);
		// One ✨ in the ribbon for what MathLive does anywhere in Obsidian. A formula's own ✨ has what
		// it can do for that formula.
		this.addRibbonIcon("sparkles", "MathLive", (event) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Find a formula").setIcon("search").onClick(() => this.findFormula())
			);
			if (CAN_SCAN_SCREEN) {
				menu.addItem((item) =>
					item.setTitle("Scan formula from screen").setIcon("scan").onClick(() => void this.scanScreenAreaIntoNote())
				);
			} else {
				menu.addItem((item) =>
					item.setTitle("Scan a photo").setIcon("camera").onClick(() => void this.scanPhotoIntoNote())
				);
				menu.addItem((item) =>
					item.setTitle("Scan an image in this note").setIcon("scan-text").onClick(() => void this.scanNoteImage())
				);
			}
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
				findFormula: (insert) => this.openFormulaSearch(insert),
			})
		);
		this.registerEditorExtension(shorthandSourceExtension());
		this.addSettingTab(new MathliveSettingTab(this.app, this));
		this.registerEvent(
			this.app.workspace.on("window-open", (workspaceWindow) => {
				registerMathliveFonts(workspaceWindow.doc);
				this.updateMathJaxVisibility();
			})
		);
		this.registerEvent(
			this.app.workspace.on("window-close", (workspaceWindow) => {
				releaseVirtualKeyboardFrom(workspaceWindow.doc, this.app.workspace.containerEl.doc.body);
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
			void this.offerQuickLatexImport();
		});
	}

	// Shorthands typed in source mode would expand twice next to Quick Latex or Latex Suite, which
	// expand their own, so "auto" leaves typed LaTeX to them.
	shorthandsInSourceMode(): boolean {
		const mode = this.settings.shorthandsInSource;
		if (mode !== "auto") {
			return mode === "on";
		}
		return !isPluginEnabled(this.app, QUICK_LATEX_ID) && !isPluginEnabled(this.app, LATEX_SUITE_ID);
	}

	applyShorthands() {
		setActiveShorthands({
			preset: this.settings.shorthandPreset,
			custom: this.settings.shorthands,
			inSourceMode: () => this.shorthandsInSourceMode(),
		});
	}

	// Adds Quick Latex's shorthands from this vault to MathLive's own. Returns how many were new.
	async importQuickLatexShorthands(): Promise<number> {
		const found = await readQuickLatexShorthands(this.app);
		const preset = parseShorthands(PRESET_SHORTHANDS);
		const own = parseShorthands(this.settings.shorthands);
		let added = 0;
		for (const [key, snippet] of found) {
			// Quick Latex saves its default list too; those come from the preset instead.
			if (preset.get(key) === snippet || own.has(key)) {
				continue;
			}
			own.set(key, snippet);
			added += 1;
		}
		this.settings.shorthands = formatShorthands(own);
		this.settings.shorthandPreset = true;
		await this.saveSettings();
		return added;
	}

	// Once per vault: someone who used Quick Latex here can bring their shorthands along.
	private async offerQuickLatexImport() {
		if (this.settings.quickLatexImportOffered) {
			return;
		}
		const pluginDir = `${this.app.vault.configDir}/plugins/${QUICK_LATEX_ID}`;
		if (!(await this.app.vault.adapter.exists(pluginDir))) {
			return;
		}
		this.settings.quickLatexImportOffered = true;
		await this.saveSettings();
		const found = await readQuickLatexShorthands(this.app);
		const message =
			found.size > 0
				? `Coming from Quick Latex? Import your ${shorthandCount(found.size)} into MathLive's editor.`
				: "Coming from Quick Latex? Use its shorthands, like al for α, in MathLive's editor.";
		noticeWithButton(message, "Import", () => void this.importAndReport(), 30000);
	}

	async importAndReport() {
		const added = await this.importQuickLatexShorthands();
		const stillOn = isPluginEnabled(this.app, QUICK_LATEX_ID)
			? " Quick Latex keeps handling typed LaTeX while it is on."
			: "";
		new Notice(
			(added > 0
				? `Imported ${shorthandCount(added)}, and turned on Quick Latex's defaults.`
				: "Turned on Quick Latex's shorthands.") +
				" Type one in a formula and press Space." +
				stillOn
		);
	}

	// Everything MathLive does, with buttons to try each part.
	openGuide() {
		new GuideModal(this.app, {
			account: this.account,
			addFormula: () => this.openEditorFromWelcome(),
			scanFromScreen: () => void (CAN_SCAN_SCREEN ? this.scanScreenAreaIntoNote() : this.scanPhotoIntoNote()),
			drawFormula: () => void this.drawFormulaIntoNote(),
			convertPdf: () => this.convertPdf(),
			findFormula: () => this.findFormula(),
		}).open();
	}

	// Find a formula in the library and put it at the cursor of the open note, or of `editor`.
	findFormula(editor?: Editor) {
		const target = editor ?? (this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastNoteView)?.editor;
		if (!target) {
			new Notice("Open a note first, then find a formula to put in it.");
			return;
		}
		const selection = target.getSelection().trim();
		this.openFormulaSearch(
			(latex) => {
				insertScannedMath(target, latex);
				return true;
			},
			selection.length <= 80 && !selection.includes("$") ? selection : ""
		);
	}

	openFormulaSearch(insert: (latex: string) => boolean, initialQuery = "") {
		new FormulaSearchModal(this.app, this.settings, this.account, insert, initialQuery).open();
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
		this.applyShorthands();
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

	// The phone's camera or photo library, or a file picker on a computer.
	async scanPhotoIntoNote() {
		const target = this.noteScanTarget();
		if (!target) {
			new Notice("Open a note first, so the scanned formula has somewhere to go.");
			return;
		}
		await scanPhotoInto(target, activeDocument);
	}

	// The images embedded in a note, read from its text so a photo attached a moment ago counts.
	noteImages(view: MarkdownView): NoteImage[] {
		const note = view.file;
		if (!note) {
			return [];
		}
		const images: NoteImage[] = [];
		const editor = view.editor;
		for (let line = 0; line < editor.lineCount(); line++) {
			const text = editor.getLine(line);
			for (const match of text.matchAll(EMBED_PATTERN)) {
				const link = match[1] ?? match[2];
				if (!link || /^[a-z]+:/i.test(link)) {
					continue;
				}
				let path = link;
				try {
					path = decodeURIComponent(link);
				} catch {
					// Not URL-encoded.
				}
				const file = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(path), note.path);
				if (isImage(file)) {
					images.push({ file, line, embed: match[0] });
				}
			}
		}
		return images;
	}

	// The image on the cursor's line, the only image, or one the user picks from the note.
	async scanNoteImage() {
		const view = this.findNoteForScan();
		if (!view?.file) {
			new Notice("Open a note with an image first.");
			return;
		}
		const images = this.noteImages(view);
		if (images.length === 0) {
			new Notice("This note has no images. Attach a photo to it first, or scan one straight from the camera.");
			return;
		}
		const atCursor = images.find((image) => image.line === view.editor.getCursor().line);
		if (atCursor || images.length === 1) {
			await this.scanEmbeddedImage(view, atCursor ?? images[0]);
			return;
		}
		new NoteImageModal(this.app, images, (image) => void this.scanEmbeddedImage(view, image)).open();
	}

	// The formula goes on its own lines under the image, so the photo and its LaTeX stay together.
	async scanEmbeddedImage(view: MarkdownView, image: NoteImage) {
		const note = view.file;
		if (!note) {
			return;
		}
		const blob = await this.readImage(image.file);
		if (!blob) {
			return;
		}
		const target: ScanTarget = {
			settings: this.settings,
			isOpen: () => view.file === note && view.containerEl.isConnected,
			insert: (latex) => insertMathUnderEmbed(view.editor, image, latex),
			addedMessage: "Scanned formula added under the image",
			closedMessage: "The note was closed before the scan finished. Open it and scan again.",
		};
		await scanImageInto(target, blob, "note-image");
	}

	// From the file list or an image's menu: under the image if the open note shows it, else at the
	// note's cursor.
	async scanImageFileIntoNote(file: TFile) {
		const view = this.findNoteForScan();
		const embedded = view ? this.noteImages(view).find((image) => image.file === file) : undefined;
		if (view && embedded) {
			await this.scanEmbeddedImage(view, embedded);
			return;
		}
		const target = this.noteScanTarget();
		if (!target) {
			new Notice("Open a note first, so the scanned formula has somewhere to go.");
			return;
		}
		const blob = await this.readImage(file);
		if (blob) {
			await scanImageInto(target, blob, "note-image");
		}
	}

	private async readImage(file: TFile): Promise<Blob | null> {
		try {
			const data = await this.app.vault.readBinary(file);
			return new Blob([data], { type: IMAGE_TYPES[file.extension.toLowerCase()] ?? "" });
		} catch (error) {
			console.error("MathLive: couldn't read the image:", error);
			new Notice(`MathLive couldn't open ${file.name}.`);
			return null;
		}
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
		// With formulas editable only at the cursor, Obsidian's drawing of the others stays, and a
		// click on one puts the cursor in it.
		const editorOn =
			this.settings.enableInlineEditorMode && !this.showRawLatex && !this.settings.editOnlyAtCursor;
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

const shorthandCount = (count: number) => `${count} ${count === 1 ? "shorthand" : "shorthands"}`;

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
					visible: () => CAN_SCAN_SCREEN,
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
				{
					name: "Edit only the formula at the cursor",
					desc: "Formulas look like the rest of your note until the cursor is in one. Then that formula gets a MathLive editor next to it. Click a formula or move the cursor into it to edit it.",
					addControl: toggle("editOnlyAtCursor"),
				},
			],
		},
		{
			heading: "Shorthands",
			rows: [
				{
					name: "Quick Latex shorthands",
					desc: "In a formula, type a shorthand and press Space: al becomes α, sq a square root, bb \\mathbb, and so on, as in Quick Latex.",
					addControl: toggle("shorthandPreset"),
				},
				{
					name: "Your shorthands",
					desc: "One per line, in Quick Latex's format: rr:::\\mathbb{R}; Use #cursor to mark where the cursor goes. Yours win over the defaults.",
					addControl: setting => {
						let input: TextAreaComponent | null = null;
						setting.addTextArea(text => {
							input = text;
							text.inputEl.rows = 6;
							text.inputEl.addClass("mathlive-shorthands-input");
							text
								.setPlaceholder("rr:::\\mathbb{R};\nvec:::\\vec{#cursor};")
								.setValue(this.plugin.settings.shorthands)
								.onChange(async (value) => {
									this.plugin.settings.shorthands = value;
									await this.plugin.saveSettings();
								});
						});
						setting.addButton(button => button
							.setButtonText("Import from Quick Latex")
							.setTooltip("Adds the shorthands Quick Latex saved in this vault")
							.onClick(async () => {
								await this.plugin.importAndReport();
								input?.setValue(this.plugin.settings.shorthands);
							}));
					},
				},
				{
					name: "Shorthands in typed LaTeX",
					desc: "Also expand shorthands when typing LaTeX between $ signs in the note. Automatic leaves typed LaTeX to Quick Latex or Latex Suite when either is on, so a shorthand never expands twice.",
					addControl: setting => {
						setting.addDropdown(dropdown => dropdown
							.addOption("auto", "Automatic")
							.addOption("on", "On")
							.addOption("off", "Off")
							.setValue(this.plugin.settings.shorthandsInSource)
							.onChange(async (value) => {
								this.plugin.settings.shorthandsInSource = value as PluginSettings["shorthandsInSource"];
								await this.plugin.saveSettings();
							}));
					},
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
	private magicEdit?: MagicEditBox
	private menuEscape?: Scope
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
		// Escape closes the ✨ AI fill menu or MathLive's ☰ menu first, then the window.
		const menuEscape = new Scope(this.scope);
		menuEscape.register([], "Escape", () => {
			if (hideShownMenu()) {
				return false;
			}
			if (!this.mfe || !closeMathfieldMenu(this.mfe)) {
				this.close();
			}
			return false;
		});
		this.app.keymap.pushScope(menuEscape);
		this.menuEscape = menuEscape;
		
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
				this.renderedResult = resultRenderTemplate(toMathJaxLatex(value));
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
			// Something opened over the window, such as Find a formula, has the focus now.
			const active = doc.activeElement;
			if (active && active !== doc.body && !this.modalEl.contains(active)) {
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
			const links = footer.createDiv({ cls: "mathlive-modal-links" });
			const find = links.createEl("a", { cls: "mathlive-modal-link find-formula-link", href: "#" });
			setIcon(find.createSpan({ cls: "mathlive-btn-icon" }), "search");
			find.createSpan({ text: "Find a formula" });
			find.addEventListener("click", (event) => {
				event.preventDefault();
				this.onFindFormulaRequest();
			});
			const guide = links.createEl("a", { cls: "mathlive-modal-link mathlive-modal-guide-link", href: "#" });
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
		// Phones and tablets usually have no keyboard to press it on.
		if (!Platform.isMobile) {
			submitButton.createEl("kbd", {
				cls: "mathlive-btn-hint",
				text: Platform.isMacOS ? "⌘ Enter" : "Ctrl+Enter",
			});
		}
		submitButton.addEventListener("click", () => this.close());
	}

	// One ✨ AI fill button, like a formula's in a note, with each AI action named in its menu.
	initImageScanner(actions: HTMLElement) {
		const group = actions.createDiv({ cls: "mathlive-scan-actions" });
		const button = group.createEl("button", {
			cls: "mathlive-ai-fill-button mathlive-action-btn mathlive-ai-btn",
			attr: { type: "button", "aria-haspopup": "menu" },
		});
		setIcon(button.createSpan({ cls: "mathlive-btn-icon" }), "sparkles");
		button.createSpan({ cls: "mathlive-btn-title", text: "AI fill" });
		setIcon(button.createSpan({ cls: "mathlive-btn-icon mathlive-btn-chevron" }), "chevron-down");
		button.addEventListener("click", () => {
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Magic edit").setIcon("wand-sparkles").onClick(() => {
					if (!this.magicEdit) {
						this.toggleMagicEdit(button);
					}
				})
			);
			menu.addItem((item) =>
				item.setTitle("Find a formula").setIcon("search").onClick(() => this.onFindFormulaRequest())
			);
			menu.addItem((item) =>
				item.setTitle("Scan clipboard image").setIcon("image-plus").onClick(() => {
					void this.onImageScanRequest();
				})
			);
			menu.addItem((item) =>
				CAN_SCAN_SCREEN
					? item.setTitle("Scan from screen").setIcon("scan").onClick(() => {
							void this.onScreenScanRequest();
						})
					: item.setTitle("Scan a photo").setIcon("camera").onClick(() => {
							void this.onPhotoScanRequest();
						})
			);
			menu.addItem((item) =>
				item.setTitle("Draw formula").setIcon("pencil-line").onClick(() => {
					void this.onDrawRequest();
				})
			);
			showMenuBelow(menu, button, true);
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

	// Magic edit floats over the window, under the formula, like it does in a note, so the window
	// keeps its size. The button opens and closes it.
	private toggleMagicEdit(button: HTMLElement) {
		if (this.magicEdit) {
			this.magicEdit.dismiss();
			return;
		}
		const mathfield = this.mfe;
		if (!mathfield) {
			return;
		}
		this.magicEdit = openMagicEditPopover(
			mathfield,
			{
				settings: this.plugin.settings,
				getLatex: () => mathfield.value,
				setLatex: (latex) => {
					mathfield.value = latex;
					this.renderedResult = this.resultRenderTemplate(toMathJaxLatex(latex));
				},
				isOpen: () => mathfield.isConnected,
				busyEl: mathfield,
			},
			{
				host: this.modalEl,
				trigger: button,
				onClose: () => {
					this.magicEdit = undefined;
					this.app.keymap.popScope(escape);
				},
			}
		);
		// Escape closes the box first, then the window.
		const escape = new Scope(this.scope);
		escape.register([], "Escape", () => {
			this.magicEdit?.dismiss();
			return false;
		});
		this.app.keymap.pushScope(escape);
	}

	private scanTarget(mathfield: MathfieldElement) {
		return {
			settings: this.plugin.settings,
			mathfield,
			onValueChange: (value: string) => {
				this.renderedResult = this.resultRenderTemplate(toMathJaxLatex(value));
			},
		};
	}

	async onImageScanRequest() {
		if (!this.mfe) {
			return;
		}

		await appendLatexFromClipboardImage(
			this.scanTarget(this.mfe),
			CAN_SCAN_SCREEN ? () => void this.onScreenScanRequest() : undefined
		);
	}

	async onPhotoScanRequest() {
		const mathfield = this.mfe;
		if (!mathfield) {
			return;
		}
		await scanPhotoInto(mathfieldScanTarget(this.scanTarget(mathfield)), this.containerEl.doc);
		if (mathfield.isConnected) {
			this.focusFormulaWhenShown();
		}
	}

	// Puts a formula from the library at the cursor in this window's formula.
	onFindFormulaRequest() {
		const mathfield = this.mfe;
		if (!mathfield) {
			return;
		}
		this.plugin.openFormulaSearch((latex) => {
			if (!mathfield.isConnected) {
				return false;
			}
			insertIntoMathfield(mathfield, latex);
			this.renderedResult = this.resultRenderTemplate(mathfield.value);
			this.focusFormulaWhenShown();
			return true;
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
		this.magicEdit?.dismiss();
		if (this.mfe) {
			closeMathfieldMenu(this.mfe);
		}
		if (this.menuEscape) {
			this.app.keymap.popScope(this.menuEscape);
			this.menuEscape = undefined;
		}
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
function insertScannedMath(editor: Editor, scanned: string) {
	const latex = toMathJaxLatex(scanned);
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

interface NoteImage {
	file: TFile;
	line: number;
	// The embed as written, such as ![[photo.jpg]], to find it again if lines move.
	embed: string;
}

// ![[image.png]] or ![[image.png|300]], and ![alt](image.png).
const EMBED_PATTERN = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]|!\[[^\]]*\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	heic: "image/heic",
	heif: "image/heif",
	avif: "image/avif",
};

function isImage(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() in IMAGE_TYPES;
}

// Under the image's line as a full-line formula. The note may have changed during the scan, so the
// image is looked for again near where it was; if it's gone, the formula goes at the cursor.
function insertMathUnderEmbed(editor: Editor, image: NoteImage, scanned: string) {
	let line = -1;
	for (let distance = 0; distance < editor.lineCount() && line < 0; distance++) {
		for (const candidate of [image.line - distance, image.line + distance]) {
			if (candidate >= 0 && candidate < editor.lineCount() && editor.getLine(candidate).includes(image.embed)) {
				line = candidate;
				break;
			}
		}
	}
	if (line < 0) {
		insertScannedMath(editor, scanned);
		return;
	}
	const text = `\n\n$$\n${toMathJaxLatex(scanned)}\n$$`;
	const end = { line, ch: editor.getLine(line).length };
	editor.replaceRange(text, end);
	editor.setCursor(editor.offsetToPos(editor.posToOffset(end) + text.length));
}

// Picks one of a note's images to scan.
class NoteImageModal extends SuggestModal<NoteImage> {
	constructor(app: App, private images: NoteImage[], private onPick: (image: NoteImage) => void) {
		super(app);
		this.setPlaceholder("Scan which image?");
	}

	getSuggestions(query: string): NoteImage[] {
		const words = query.toLowerCase();
		return this.images.filter((image) => image.file.name.toLowerCase().includes(words));
	}

	renderSuggestion(image: NoteImage, el: HTMLElement) {
		el.createDiv({ text: image.file.name });
		el.createEl("small", { text: `Line ${image.line + 1}` });
	}

	onChooseSuggestion(image: NoteImage) {
		this.onPick(image);
	}
}

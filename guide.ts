import { App, Modal, setIcon } from "obsidian";
import type { CloudAccount } from "./account";
import { AUTHOR_URL } from "./mathlive-inline";

// What the guide's buttons do, from the plugin.
export interface GuideActions {
	account: CloudAccount;
	addFormula(): void;
	scanFromScreen(): void;
	convertPdf(): void;
}

// Everything MathLive does, one section each, with a button to try it. Opens from the welcome
// window, the ✨ menu next to formulas, the editor window and the settings tab, so people who came
// for one feature find the rest.
export class GuideModal extends Modal {
	private stopListening: (() => void) | null = null;

	constructor(app: App, private readonly actions: GuideActions) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-guide-modal");
		this.setTitle("What MathLive can do");
		this.stopListening = this.actions.account.onChange(() => this.render());
		void this.actions.account.getStatus();
		this.render();
	}

	private render() {
		const { contentEl } = this;
		const scroll = contentEl.querySelector(".mathlive-guide")?.scrollTop ?? 0;
		contentEl.empty();
		const guide = contentEl.createDiv({ cls: "mathlive-guide" });

		const section = (icon: string, title: string, text: string, button?: { text: string; run: () => void; cta?: boolean }) => {
			const el = guide.createDiv({ cls: "mathlive-guide-section" });
			setIcon(el.createDiv({ cls: "mathlive-guide-icon" }), icon);
			const body = el.createDiv({ cls: "mathlive-guide-body" });
			body.createEl("h3", { text: title });
			body.createEl("p", { text });
			if (button) {
				const buttonEl = body.createEl("button", { text: button.text, cls: button.cta ? "mod-cta" : "" });
				buttonEl.addEventListener("click", () => {
					this.close();
					button.run();
				});
			}
			return body;
		};

		section(
			"square-function",
			"Edit formulas as you see them",
			"Click any $…$ or $$…$$ formula in a note and type. Fractions, roots and matrices appear as you write, and the note keeps plain LaTeX. Free, and works offline."
		);
		section(
			"plus-square",
			"Add a formula",
			"Run “Add full-line math” or “Add inline math” from the command palette, or give them a hotkey in Settings → Hotkeys.",
			{ text: "Add a formula now", run: () => this.actions.addFormula() }
		);
		section(
			"sparkles",
			"AI fill: scan a formula instead of typing it",
			"Click ✨ next to any formula, or in the editor window. Scan a screenshot from your clipboard, or draw a box around a formula anywhere on your screen: a PDF, a website, a video, another app. The LaTeX lands in your formula, ready to edit.",
			{ text: "Scan from screen", run: () => this.actions.scanFromScreen(), cta: true }
		);
		section(
			"maximize-2",
			"Expand for a bigger editor",
			"The ⤢ button next to a formula opens it in the editor window, with room for long formulas, the math keyboard and the scan buttons. Ctrl+Enter puts it back in the note."
		);
		section(
			"keyboard",
			"Math keyboard",
			"Greek letters, operators and matrices without remembering LaTeX. Open it from the ✨ menu, or with the keyboard icon on full-line formulas."
		);
		section(
			"file-text",
			"Turn a PDF into notes",
			"Lecture slides, papers or handwritten pages become a Markdown note with every formula as editable LaTeX. Open a PDF and click “Convert to notes” at its top right, or use the note icon in the left ribbon.",
			{ text: "Convert a PDF", run: () => this.actions.convertPdf() }
		);

		const plan = section("gem", "Your scans", this.actions.account.planDetail());
		const next = this.actions.account.planAction();
		if (next) {
			const buttonEl = plan.createEl("button", { text: next.title, cls: "mod-cta" });
			buttonEl.addEventListener("click", () => next.run());
		}

		const footer = guide.createDiv({ cls: "mathlive-guide-footer" });
		footer.appendText("Open this guide again from the ✨ menu next to any formula. Made by ");
		footer.createEl("a", { text: "Dan Zilberman", href: AUTHOR_URL });
		footer.appendText(".");
		guide.scrollTop = scroll;
	}

	onClose() {
		this.stopListening?.();
		this.stopListening = null;
		this.contentEl.empty();
	}
}

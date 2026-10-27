import { App, Modal, Setting } from "obsidian";
import type { CloudAccount } from "./account";

// Shown once, right after MathLive is installed: what it does and how to start.
export class WelcomeModal extends Modal {
	constructor(
		app: App,
		private readonly account: CloudAccount,
		private readonly tryEditor: () => void,
		private readonly openGuide: () => void
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-welcome-modal");
		this.setTitle("Welcome to MathLive");
		const { contentEl } = this;
		contentEl.empty();

		const list = contentEl.createEl("ul", { cls: "mathlive-welcome-list" });
		const item = (title: string, text: string) => {
			const li = list.createEl("li");
			li.createEl("strong", { text: title });
			li.createSpan({ text: ` ${text}` });
		};
		item(
			"Edit formulas visually.",
			"Click any $…$ or $$…$$ formula in a note and type: fractions, roots and matrices appear as you write. It's free and works offline."
		);
		item(
			"Fill formulas with AI.",
			"Click ✨ next to a formula to scan a screenshot, or draw a box around a formula anywhere on your screen, even in another app. Your first scans need no account."
		);
		item(
			"Expand for more room.",
			"The ⤢ button next to a formula opens a bigger editor with the math keyboard."
		);
		item(
			"Turn PDFs into notes.",
			"Right-click a PDF to convert its pages into Markdown with editable LaTeX."
		);

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Connect account").onClick(() => {
					this.close();
					void this.account.connect();
				})
			)
			.addButton((button) =>
				button.setButtonText("See everything").onClick(() => {
					this.close();
					this.openGuide();
				})
			)
			.addButton((button) =>
				button
					.setButtonText("Try the editor")
					.setCta()
					.onClick(() => {
						this.close();
						this.tryEditor();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

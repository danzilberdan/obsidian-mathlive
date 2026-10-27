import { App, Modal, Setting } from "obsidian";
import type { CloudAccount } from "./account";

// Shown once, right after MathLive is installed: what it does and how to start.
export class WelcomeModal extends Modal {
	constructor(
		app: App,
		private readonly account: CloudAccount,
		private readonly tryEditor: () => void
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
			"Add a formula.",
			"Run “Add full-line math” or “Add inline math” from the command palette, or give them a hotkey."
		);
		item(
			"Scan a formula from an image.",
			"Copy a screenshot of a formula and click Scan in the editor, or use the scan icon in the left ribbon to select it on screen. Your first scans need no account."
		);

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Connect account").onClick(() => {
					this.close();
					void this.account.connect();
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

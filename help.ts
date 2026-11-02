import { App, Modal, Platform, finishRenderMath, loadMathJax, renderMath, setIcon } from "obsidian";
import { HelpIndex, type HelpEntry } from "./help-search";
import docsIndex from "./help/mathlive-docs.json";
import topicsIndex from "./help/topics.json";

// Help for people new to LaTeX and to MathLive: a getting-started list, and a "How do I…" search
// over hand-written topics and an index of the MathLive docs, made once by
// scripts/build-help-index.mjs. Searching runs on the device: nothing is sent anywhere. Each answer
// says what to type or press, and links to the exact section of the docs, or runs the feature.

export const DOCS_URL = "https://mathlive.io/mathfield/";

// What topics with an action do, from the plugin.
export interface HelpActions {
	run(action: string): void;
}

let index: HelpIndex | null = null;

export function helpIndex(): HelpIndex {
	if (!index) {
		const topics = (topicsIndex.entries as Omit<HelpEntry, "kind">[]).map((entry) => ({ kind: "topic" as const, ...entry }));
		index = new HelpIndex([...topics, ...(docsIndex.entries as HelpEntry[])]);
	}
	return index;
}

// MathLive's own commands, as Obsidian's MathJax writes them, for the previews.
const MATHJAX_EQUIVALENTS: [RegExp, string][] = [
	[/\\placeholder\{\}/g, "\\square"],
	[/\\differentialD/g, "\\mathrm{d}"],
	[/\\imaginaryI/g, "\\mathrm{i}"],
	[/\\imaginaryJ/g, "\\mathrm{j}"],
	[/\\exponentialE/g, "\\mathrm{e}"],
	[/\\([NZQRCP])(?![a-zA-Z])/g, "\\mathbb{$1}"],
	[/\\doubleprime/g, "\\prime\\prime"],
	[/\\char"24/g, "\\$"],
	[/\\coloneq/g, ":="],
	[/\\questeq/g, "\\stackrel{?}{=}"],
	[/\\operatorname\*/g, "\\operatorname"],
];

function renderPreview(latex: string, parent: HTMLElement) {
	let tex = latex;
	for (const [pattern, replacement] of MATHJAX_EQUIVALENTS) {
		tex = tex.replace(pattern, replacement);
	}
	try {
		const math = renderMath(tex, false);
		// MathJax shows commands it doesn't know in red; the LaTeX itself reads better.
		if (math.querySelector("mjx-merror")) {
			parent.createEl("code", { text: latex });
			return;
		}
		parent.appendChild(math);
	} catch {
		parent.createEl("code", { text: latex });
	}
}

export class HelpModal extends Modal {
	private inputEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private shown: HelpEntry[] = [];
	private selected = 0;

	constructor(
		app: App,
		private readonly actions: HelpActions,
		private readonly initialQuery = ""
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-help-modal");
		this.setTitle("MathLive help");
		const { contentEl } = this;

		const search = contentEl.createDiv({ cls: "mathlive-help-search" });
		setIcon(search.createSpan({ cls: "mathlive-help-search-icon" }), "search");
		this.inputEl = search.createEl("input", {
			type: "search",
			attr: {
				placeholder: "How to… write a fraction, make a matrix, type α",
				"aria-label": "Search the help",
				spellcheck: "false",
				enterkeyhint: "search",
			},
		});
		this.inputEl.value = this.initialQuery;
		this.inputEl.addEventListener("input", () => this.render());
		this.inputEl.addEventListener("keydown", (event) => this.onKey(event));

		this.resultsEl = contentEl.createDiv({ cls: "mathlive-help-results", attr: { role: "listbox" } });

		const links = contentEl.createDiv({ cls: "mathlive-help-links" });
		const link = (icon: string, text: string, run: () => void) => {
			const el = links.createEl("a", { cls: "mathlive-help-link", href: "#" });
			setIcon(el.createSpan({ cls: "mathlive-help-link-icon" }), icon);
			el.createSpan({ text });
			el.addEventListener("click", (event) => {
				event.preventDefault();
				run();
			});
		};
		link("compass", "What MathLive can do", () => this.runAction("guide"));
		link("keyboard", "All keyboard shortcuts", () => this.openUrl(`${DOCS_URL}reference/keybindings/`));
		link("book-open", "All LaTeX commands", () => this.openUrl(`${DOCS_URL}reference/commands/`));

		this.render();
		// Previews need MathJax, which Obsidian loads only once something asks for it.
		void loadMathJax().then(() => this.render());
		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	private render() {
		const query = this.inputEl.value;
		const scroll = this.resultsEl.scrollTop;
		this.resultsEl.empty();
		const searching = query.trim().length > 0;
		this.shown = searching ? helpIndex().search(query) : helpIndex().basics();
		this.selected = Math.min(this.selected, Math.max(0, this.shown.length - 1));
		if (!searching) {
			this.resultsEl.createDiv({ cls: "mathlive-help-heading", text: "Getting started" });
		} else if (this.shown.length === 0) {
			const empty = this.resultsEl.createDiv({ cls: "mathlive-help-empty" });
			empty.createDiv({ text: "Nothing found. Try other words, like “arrow” or “matrix”." });
			const all = empty.createEl("a", { text: "Search the MathLive docs", href: "#" });
			all.addEventListener("click", (event) => {
				event.preventDefault();
				this.openUrl(DOCS_URL);
			});
		}
		this.shown.forEach((entry, i) => this.renderEntry(entry, i));
		void finishRenderMath();
		this.resultsEl.scrollTop = searching ? 0 : scroll;
	}

	private renderEntry(entry: HelpEntry, i: number) {
		const item = this.resultsEl.createDiv({
			cls: "mathlive-help-item",
			attr: { role: "option", "data-id": entry.id, "aria-selected": String(i === this.selected) },
		});
		item.toggleClass("is-selected", i === this.selected);
		const head = item.createDiv({ cls: "mathlive-help-item-head" });
		head.createDiv({ cls: "mathlive-help-item-title", text: entry.title });
		if (entry.latex) {
			renderPreview(entry.latex, head.createDiv({ cls: "mathlive-help-preview" }));
		}

		const how = item.createDiv({ cls: "mathlive-help-how" });
		const keys = Platform.isMacOS && entry.macKeys ? entry.macKeys : entry.keys;
		if (entry.kind === "shortcut" && entry.typed) {
			how.appendText("Type ");
			entry.typed.forEach((typed, n) => {
				if (n > 0) {
					how.appendText(" or ");
				}
				how.createEl("kbd", { text: typed });
			});
		} else if (entry.kind === "key" && keys) {
			how.appendText("Press ");
			keys.forEach((key, n) => {
				if (n > 0) {
					how.appendText(" or ");
				}
				how.createEl("kbd", { text: key });
			});
		}
		const answer = entry.answer ?? entry.text;
		if (answer) {
			item.createDiv({ cls: "mathlive-help-answer", text: answer });
		} else if (entry.commands?.length) {
			item.createDiv({ cls: "mathlive-help-answer", text: `Commands like ${entry.commands.slice(0, 8).join(" ")}` });
		}
		if (!how.hasChildNodes()) {
			how.remove();
		}

		const foot = item.createDiv({ cls: "mathlive-help-item-foot" });
		if (entry.action) {
			const button = foot.createEl("button", { text: entry.actionText ?? "Try it", cls: "mod-cta" });
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				this.choose(entry);
			});
		}
		if (entry.url) {
			const place = entry.section ?? entry.title;
			const where = entry.kind === "topic" ? "" : entry.page && entry.page !== place ? `${entry.page} › ${place}` : place;
			const link = foot.createEl("a", {
				cls: "mathlive-help-docs-link",
				href: entry.url,
				attr: { "aria-label": where ? `Open “${where}” in the MathLive docs` : "Open the MathLive docs at this topic" },
			});
			setIcon(link.createSpan({ cls: "mathlive-help-link-icon" }), "external-link");
			link.createSpan({ text: where ? `Docs: ${where}` : "Read more in the MathLive docs" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.openUrl(entry.url ?? DOCS_URL);
			});
		}
		item.addEventListener("click", () => {
			this.selected = i;
			this.choose(entry);
		});
		item.addEventListener("mousemove", () => {
			if (this.selected !== i) {
				this.select(i);
			}
		});
	}

	private select(i: number) {
		this.selected = i;
		this.resultsEl.querySelectorAll(".mathlive-help-item").forEach((el, n) => {
			el.toggleClass("is-selected", n === i);
			el.setAttr("aria-selected", String(n === i));
			if (n === i) {
				el.scrollIntoView({ block: "nearest" });
			}
		});
	}

	private onKey(event: KeyboardEvent) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			this.select((this.selected + step + this.shown.length) % Math.max(1, this.shown.length));
		} else if (event.key === "Enter" && this.shown[this.selected]) {
			event.preventDefault();
			this.choose(this.shown[this.selected]);
		}
	}

	// Runs the topic's feature, or opens the docs at its section.
	private choose(entry: HelpEntry) {
		if (entry.action) {
			this.runAction(entry.action);
		} else if (entry.url) {
			this.openUrl(entry.url);
		}
	}

	private runAction(action: string) {
		this.close();
		this.actions.run(action);
	}

	private openUrl(url: string) {
		window.open(url, "_blank");
	}

	onClose() {
		this.contentEl.empty();
	}
}

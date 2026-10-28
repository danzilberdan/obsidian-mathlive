import { App, Notice, SuggestModal, finishRenderMath, loadMathJax, renderMath, requestUrl } from "obsidian";
import type { CloudAccount } from "./account";
import { errorCode, startScanProgress } from "./mathlive-shared";
import type { PluginSettings } from "./settings";

// Find a formula: searches MathLive's formula library by name, description, in any language, or
// by part of its LaTeX, and inserts the one picked. Searching is free and needs no account; only
// the query text is sent. When the library has nothing fitting, "Write it with AI" asks Claude to
// write the formula for one scan, charged only when it returns usable LaTeX.

interface FormulaHit {
	id: string;
	name: string;
	latex: string;
	description: string;
	topic: string;
}

type Suggestion = { kind: "formula"; formula: FormulaHit } | { kind: "write"; query: string };

// Wait this long after the last key press before searching.
const TYPING_PAUSE_MS = 180;
const NEEDS_ACCOUNT_NOTICE =
	"Writing formulas with AI needs a MathLive account. Open Settings → MathLive and click Connect.";
const SEARCH_TIMEOUT_MS = 8000;

function libraryUrl(settings: PluginSettings, path: string) {
	return settings.cloudScannerUrl.replace(/\/+$/, "") + path;
}

function sleep(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer = 0;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error("timed out")), ms);
			}),
		]);
	} finally {
		window.clearTimeout(timer);
	}
}

export async function searchFormulas(settings: PluginSettings, query: string): Promise<FormulaHit[]> {
	const url = libraryUrl(settings, `/formulas/search?limit=8&q=${encodeURIComponent(query)}`);
	const response = await withTimeout(requestUrl({ url, throw: false }), SEARCH_TIMEOUT_MS);
	if (response.status !== 200) {
		throw new Error(`Formula search answered ${response.status}.`);
	}
	const body = response.json as { results?: FormulaHit[] };
	return Array.isArray(body.results) ? body.results : [];
}

export class FormulaSearchModal extends SuggestModal<Suggestion> {
	private searches = 0;
	private last: Suggestion[] = [];

	constructor(
		app: App,
		private readonly settings: PluginSettings,
		private readonly account: CloudAccount,
		// Where the picked formula goes. False when it has nowhere to go anymore.
		private readonly insert: (latex: string) => boolean,
		initialQuery = ""
	) {
		super(app);
		this.modalEl.addClass("mathlive-formula-search");
		this.setPlaceholder("Find a formula: a name, what it does, any language, or LaTeX");
		this.emptyStateText = "Type the name of a formula, like “ideal gas law”.";
		this.setInstructions([
			{ command: "↑↓", purpose: "to pick" },
			{ command: "↵", purpose: "to insert" },
			{ command: "esc", purpose: "to close" },
		]);
		if (initialQuery) {
			this.inputEl.value = initialQuery;
		}
	}

	onOpen() {
		void super.onOpen();
		// Obsidian only loads MathJax once something needs it, and with every formula in the note
		// shown as a MathLive editor nothing may have yet, so previews would show raw LaTeX.
		void loadMathJax().then(() => {
			if (this.last.length > 0) {
				this.inputEl.dispatchEvent(new Event("input"));
			}
		});
		if (this.inputEl.value) {
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	async getSuggestions(query: string): Promise<Suggestion[]> {
		const search = ++this.searches;
		const text = query.trim();
		if (!text) {
			this.emptyStateText = "Type the name of a formula, like “ideal gas law”.";
			this.last = [];
			return [];
		}
		await sleep(TYPING_PAUSE_MS);
		if (search !== this.searches) {
			return this.last;
		}
		let suggestions: Suggestion[];
		try {
			const hits = await searchFormulas(this.settings, text);
			suggestions = hits.map((formula) => ({ kind: "formula", formula }));
			this.emptyStateText = "";
		} catch (error) {
			console.warn("MathLive: formula search failed.", error);
			suggestions = [];
		}
		// Writing with AI is always the last choice, so a formula the library lacks is one step away.
		suggestions.push({ kind: "write", query: text });
		if (search !== this.searches) {
			return this.last;
		}
		this.last = suggestions;
		return suggestions;
	}

	renderSuggestion(suggestion: Suggestion, el: HTMLElement) {
		el.addClass("mathlive-formula-suggestion");
		if (suggestion.kind === "write") {
			el.addClass("mathlive-formula-write");
			const title = el.createDiv({ cls: "mathlive-formula-name" });
			title.appendText("✨ Write “");
			title.createSpan({ text: suggestion.query });
			title.appendText("” with AI");
			el.createDiv({
				cls: "mathlive-formula-meta",
				text: this.last.length > 1 ? "Not what you need? Uses 1 scan, only if it works." : "Not in the library yet. Uses 1 scan, only if it works.",
			});
			return;
		}
		const { formula } = suggestion;
		const head = el.createDiv({ cls: "mathlive-formula-head" });
		head.createSpan({ cls: "mathlive-formula-name", text: formula.name });
		if (formula.topic) {
			head.createSpan({ cls: "mathlive-formula-topic", text: formula.topic });
		}
		const preview = el.createDiv({ cls: "mathlive-formula-preview" });
		try {
			preview.appendChild(renderMath(formula.latex, false));
			void finishRenderMath();
		} catch {
			preview.setText(formula.latex);
		}
		if (formula.description) {
			el.createDiv({ cls: "mathlive-formula-meta", text: formula.description });
		}
	}

	onChooseSuggestion(suggestion: Suggestion) {
		if (suggestion.kind === "formula") {
			if (this.insert(suggestion.formula.latex)) {
				new Notice(`Inserted ${suggestion.formula.name}`);
			}
			return;
		}
		void this.writeWithAi(suggestion.query);
	}

	private async writeWithAi(query: string) {
		const retry = () => void this.writeWithAi(query);
		if (!this.account.hasKey()) {
			if (!this.account.usesCloud()) {
				new Notice(NEEDS_ACCOUNT_NOTICE, 10000);
				return;
			}
			if (!(await this.account.ensureKey(retry))) {
				return;
			}
		}
		const done = startScanProgress("Writing the formula…");
		let response;
		try {
			response = await requestUrl({
				url: libraryUrl(this.settings, "/formulas/write"),
				method: "POST",
				contentType: "application/json",
				headers: { "Api-Key": this.settings.apiKey ?? "" },
				body: JSON.stringify({ query }),
				throw: false,
			});
		} catch (error) {
			console.warn("MathLive: writing a formula failed.", error);
			done();
			new Notice("Couldn't reach MathLive. Check your connection and try again. Nothing was charged.", 10000);
			return;
		}
		done();
		const code = errorCode(response);
		if (response.status === 200) {
			let body: { name?: string; latex?: string } = {};
			try {
				body = response.json as typeof body;
			} catch {
				new Notice("Couldn't write the formula right now. Try again.", 10000);
				return;
			}
			if (typeof body.latex === "string" && this.insert(body.latex)) {
				new Notice(`Inserted ${body.name || "the formula"}`);
				this.account.afterScan();
			}
			return;
		}
		if (code === "no_scans_left" || code === "missing_api_key" || code === "invalid_api_key" || code === "access_denied") {
			this.account.needsAccount(code === "no_scans_left" ? "no_scans_left" : "auth", retry);
			return;
		}
		let detail: unknown;
		try {
			detail = (response.json as { detail?: unknown } | null)?.detail;
		} catch {
			detail = null;
		}
		new Notice(
			typeof detail === "string" ? detail : "Couldn't write the formula right now. Try again. Nothing was charged.",
			10000
		);
	}
}

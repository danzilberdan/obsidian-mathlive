// Check my steps: sends the steps of a derivation in a note to the MathLive server, where an AI
// says whether each one follows, double-checks every "wrong" with the Compute Engine, and shows
// the result in a side panel. Nothing in the note changes unless the user inserts a fix.
import {
	type App,
	type Editor,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	requestUrl,
	setIcon,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { findSteps, stepHolds, type Step } from "./check-steps";
import {
	ensureCanScan,
	errorCode,
	findEnclosingMath,
	noticeWithButton,
	scannerAddress,
	type ScanAccount,
} from "./mathlive-shared";
import type { PluginSettings } from "./settings";

export const CHECK_VIEW_TYPE = "mathlive-check-steps";

const MAX_STEPS = 30;
const CHECK_TIMEOUT_MS = 90_000;

type Verdict = "ok" | "wrong" | "unsure";

interface StepResult {
	verdict: Verdict;
	reason: string;
	fix: string;
	// The AI called the step wrong, but the Compute Engine showed that it holds.
	overruled: boolean;
}

interface CheckedStep extends Step {
	// The step's text in the note when it was checked, to make sure a fix replaces the same thing.
	raw: string;
	result?: StepResult;
}

type PanelState =
	| { kind: "empty" }
	| { kind: "checking"; steps: CheckedStep[]; file: TFile }
	| { kind: "done"; steps: CheckedStep[]; file: TFile; stale: boolean }
	| { kind: "failed"; message: string; file: TFile; retry: () => void };

export interface CheckHost {
	app: App;
	settings: PluginSettings;
	account: ScanAccount;
}

class CheckError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

// The part of the note to check: the selection, or the `$$` block the cursor is in.
function pickText(editor: Editor): { text: string; base: number } | null {
	const doc = editor.getValue();
	if (editor.somethingSelected()) {
		const from = editor.posToOffset(editor.getCursor("from"));
		const to = editor.posToOffset(editor.getCursor("to"));
		return { text: doc.slice(from, to), base: from };
	}
	const math = findEnclosingMath(doc, editor.posToOffset(editor.getCursor()));
	if (!math || !doc.startsWith("$$", math.from)) {
		return null;
	}
	return { text: doc.slice(math.from, math.to), base: math.from };
}

async function requestCheck(settings: PluginSettings, context: string, steps: Step[]): Promise<StepResult[]> {
	let timer = 0;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new CheckError("timeout", "The check took too long.")), CHECK_TIMEOUT_MS);
	});
	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url: scannerAddress(settings) + "/check",
				method: "POST",
				contentType: "application/json",
				headers: { "Api-Key": settings.apiKey ?? "" },
				body: JSON.stringify({ context, steps: steps.map((step) => ({ latex: step.latex, text: step.text })) }),
				throw: false,
			}),
			timeout,
		]);
	} catch (error) {
		if (error instanceof CheckError) {
			throw error;
		}
		throw new CheckError("unavailable", error instanceof Error ? error.message : String(error));
	} finally {
		window.clearTimeout(timer);
	}
	if (res.status >= 400) {
		const code = errorCode(res) ?? (res.status === 404 || res.status === 405 ? "check_unavailable" : "unavailable");
		let detail = "";
		try {
			const value = (res.json as { detail?: unknown } | null)?.detail;
			detail = typeof value === "string" ? value : "";
		} catch {
			// Not JSON, like a self-hosted scanner's 404 page.
		}
		throw new CheckError(code, detail || `Check failed with status ${res.status}.`);
	}
	let answer: unknown;
	try {
		answer = res.json;
	} catch {
		answer = null;
	}
	const verdicts = (answer as { steps?: unknown } | null)?.steps;
	if (!Array.isArray(verdicts) || verdicts.length !== steps.length) {
		throw new CheckError("unavailable", "The check came back without a verdict for every step.");
	}
	return verdicts.map((value) => {
		const step = value as Partial<Record<"verdict" | "reason" | "fix", unknown>>;
		const verdict: Verdict = step.verdict === "ok" || step.verdict === "wrong" ? step.verdict : "unsure";
		return {
			verdict,
			reason: typeof step.reason === "string" ? step.reason : "",
			fix: typeof step.fix === "string" ? step.fix : "",
			overruled: false,
		};
	});
}

// A "wrong" from the AI stays red only when the Compute Engine can't show that the step holds.
function doubleCheck(steps: Step[], results: StepResult[]): StepResult[] {
	const latex = steps.map((step) => step.latex);
	return results.map((result, index) => {
		if (result.verdict !== "wrong") {
			return result;
		}
		let holds = false;
		try {
			holds = stepHolds(latex, index);
		} catch (error) {
			console.warn("MathLive: the Compute Engine couldn't check a step.", error);
		}
		return holds
			? { verdict: "unsure", reason: "The AI flagged this step, but the Compute Engine finds that it holds.", fix: "", overruled: true }
			: result;
	});
}

// Puts the fix where the step was, keeping the line's alignment mark in an aligned block.
function alignLike(raw: string, fix: string): string {
	if (!raw.includes("&") || fix.includes("&")) {
		return fix;
	}
	const at = fix.search(/=|\\le|\\ge|<|>/);
	return at < 0 ? fix : fix.slice(0, at) + "&" + fix.slice(at);
}

function openPanel(app: App): CheckStepsView | null {
	let leaf = app.workspace.getLeavesOfType(CHECK_VIEW_TYPE)[0];
	if (!leaf) {
		const right = app.workspace.getRightLeaf(false);
		if (!right) {
			return null;
		}
		leaf = right;
		void leaf.setViewState({ type: CHECK_VIEW_TYPE, active: true });
	}
	if (app.workspace.rightSplit.collapsed) {
		app.workspace.rightSplit.expand();
	}
	return leaf.view instanceof CheckStepsView ? leaf.view : null;
}

// Runs from the command palette, the editor's right-click menu and the formula ✨ menu.
export async function checkSteps(host: CheckHost, view: MarkdownView): Promise<void> {
	const file = view.file;
	if (!file) {
		return;
	}
	const picked = pickText(view.editor);
	if (!picked) {
		new Notice("To check your steps, select the lines of your working or click in a display formula.");
		return;
	}
	const { context, steps } = findSteps(picked.text);
	if (steps.length < 2) {
		new Notice("Check my steps needs at least two steps, like two lines of a derivation.");
		return;
	}
	if (steps.length > MAX_STEPS) {
		new Notice(`That's more than ${MAX_STEPS} steps. Select fewer lines and check them in parts.`);
		return;
	}
	const resume = () => void checkSteps(host, view);
	if (!(await ensureCanScan(host.settings, resume))) {
		return;
	}

	const checked: CheckedStep[] = steps.map((step) => ({
		...step,
		from: picked.base + step.from,
		to: picked.base + step.to,
		raw: picked.text.slice(step.from, step.to),
	}));
	const panel = openPanel(host.app) ?? (await waitForPanel(host.app));
	if (!panel) {
		new Notice("Couldn't open the step checker.");
		return;
	}
	panel.attach(view, () => void checkSteps(host, view));
	panel.show({ kind: "checking", steps: checked, file });
	try {
		const results = doubleCheck(steps, await requestCheck(host.settings, context, steps));
		checked.forEach((step, index) => (step.result = results[index]));
		panel.show({ kind: "done", steps: checked, file, stale: false });
		if (!host.settings.useLocalInference) {
			host.account.afterScan();
		}
	} catch (error) {
		const code = error instanceof CheckError ? error.code : "unavailable";
		console.error("MathLive: check failed:", error);
		const retry = () => void checkSteps(host, view);
		const accountProblem = code === "missing_api_key" || code === "invalid_api_key" || code === "no_scans_left";
		if (accountProblem && !host.settings.useLocalInference) {
			panel.show({ kind: "empty" });
			host.account.needsAccount(code === "no_scans_left" ? "no_scans_left" : "auth", resume);
			return;
		}
		const message = failureMessage(code, error);
		panel.show({ kind: "failed", message, file, retry });
		if (code === "unavailable" || code === "check_failed" || code === "timeout") {
			noticeWithButton(message, "Retry", retry, 15000);
		}
	}
}

function failureMessage(code: string, error: unknown): string {
	switch (code) {
		case "no_scans_left":
			return "No scans left on this scanner's key.";
		case "missing_api_key":
		case "invalid_api_key":
			return "This scanner didn't accept the API key.";
		case "check_unavailable":
			return "This scanner can't check steps. Turn off Self-hosted scanner in Settings → MathLive to use the MathLive scanner.";
		case "rate_limited":
			return "Too many checks in a short time. Wait a minute and try again. Nothing was charged.";
		case "too_few_steps":
		case "too_many_steps":
		case "step_too_long":
		case "context_too_long":
		case "bad_request":
			return error instanceof Error ? error.message : String(error);
		default:
			return "Couldn't check these steps right now. Try again. Nothing was charged.";
	}
}

// A panel opened a moment ago may take a tick to get its view.
async function waitForPanel(app: App): Promise<CheckStepsView | null> {
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => window.setTimeout(resolve, 50));
		const leaf = app.workspace.getLeavesOfType(CHECK_VIEW_TYPE)[0];
		if (leaf?.view instanceof CheckStepsView) {
			return leaf.view;
		}
	}
	return null;
}

export class CheckStepsView extends ItemView {
	private state: PanelState = { kind: "empty" };
	private note: MarkdownView | null = null;
	private rerun: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return CHECK_VIEW_TYPE;
	}

	getDisplayText() {
		return "Check my steps";
	}

	getIcon() {
		return "list-checks";
	}

	onOpen(): Promise<void> {
		this.render();
		// Editing the checked lines makes the result out of date.
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const state = this.state;
				if (state.kind === "done" && !state.stale && info.file?.path === state.file.path) {
					this.show({ ...state, stale: true });
				}
			})
		);
		return Promise.resolve();
	}

	attach(note: MarkdownView, rerun: () => void) {
		this.note = note;
		this.rerun = rerun;
	}

	show(state: PanelState) {
		this.state = state;
		this.render();
	}

	private render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("mathlive-check");
		const state = this.state;
		if (state.kind === "empty") {
			root.createEl("p", {
				cls: "mathlive-check-hint",
				text: "Select the lines of a derivation in a note and right-click them to check your steps. The first step that doesn't follow gets marked. Each check uses 1 scan.",
			});
			return;
		}
		const header = root.createDiv({ cls: "mathlive-check-header" });
		header.createDiv({ cls: "mathlive-check-file", text: state.file.basename });
		if (state.kind === "failed") {
			root.createEl("p", { cls: "mathlive-check-summary", text: state.message });
			const again = root.createEl("button", { cls: "mod-cta", text: "Try again" });
			again.addEventListener("click", () => state.retry());
			return;
		}
		const summary = root.createDiv({ cls: "mathlive-check-summary" });
		if (state.kind === "checking") {
			summary.addClass("mathlive-check-busy");
			summary.setText(`Checking ${state.steps.length} steps…`);
		} else {
			const firstWrong = state.steps.findIndex((step) => step.result?.verdict === "wrong");
			const unsure = state.steps.some((step) => step.result?.verdict === "unsure");
			summary.setText(
				firstWrong >= 0
					? `Step ${firstWrong + 1} doesn't follow.`
					: unsure
						? "No error found, but some steps couldn't be checked."
						: "Every step follows."
			);
			summary.addClass(firstWrong >= 0 ? "is-wrong" : unsure ? "is-unsure" : "is-ok");
			if (state.stale) {
				const stale = root.createDiv({ cls: "mathlive-check-stale", text: "The note changed since this check. " });
				const again = stale.createEl("a", { text: "Check again" });
				again.addEventListener("click", () => this.rerun?.());
			}
		}

		const list = root.createEl("ol", { cls: "mathlive-check-steps" });
		const firstWrong = state.steps.findIndex((step) => step.result?.verdict === "wrong");
		state.steps.forEach((step, index) => {
			const item = list.createEl("li", { cls: "mathlive-check-step" });
			const verdict = step.result?.verdict;
			if (verdict) item.addClass(`is-${verdict}`);
			// Steps after the first wrong one are judged from it, so they say less.
			if (firstWrong >= 0 && index > firstWrong) item.addClass("is-after-error");
			const mark = item.createSpan({ cls: "mathlive-check-mark" });
			setIcon(mark, verdict === "ok" ? "check" : verdict === "wrong" ? "x" : verdict === "unsure" ? "help-circle" : "loader");
			mark.setAttr("aria-label", verdict === "ok" ? "Follows" : verdict === "wrong" ? "Doesn't follow" : verdict === "unsure" ? "Not sure" : "Checking");
			const body = item.createDiv({ cls: "mathlive-check-body" });
			const math = body.createDiv({ cls: "mathlive-check-math" });
			void MarkdownRenderer.render(this.app, `$${step.latex}$`, math, state.file.path, this);
			math.addEventListener("click", () => this.reveal(step));
			const result = step.result;
			if (!result || result.verdict === "ok") return;
			const reason = body.createDiv({ cls: "mathlive-check-reason" });
			reason.setText(result.reason || (result.verdict === "unsure" ? "Couldn't check this step." : ""));
			if (result.verdict === "wrong") {
				reason.createSpan({
					cls: "mathlive-check-ai",
					text: "AI",
					attr: { "aria-label": "Found by AI. The Compute Engine couldn't check this step, so look it over." },
				});
			}
			if (result.verdict === "wrong" && result.fix && index === firstWrong && !step.raw.includes("$")) {
				const fix = body.createDiv({ cls: "mathlive-check-fix" });
				fix.createSpan({ cls: "mathlive-check-fix-label", text: "Suggested: " });
				void MarkdownRenderer.render(this.app, `$${result.fix.replace(/&/g, "")}$`, fix.createSpan(), state.file.path, this);
				const insert = body.createEl("button", { cls: "mathlive-check-insert", text: "Insert fix" });
				insert.disabled = state.kind !== "done" || state.stale;
				insert.addEventListener("click", () => this.insertFix(step, result.fix));
			}
		});
	}

	// Selects the step in the note.
	private reveal(step: CheckedStep) {
		const note = this.note;
		if (!note?.editor || !note.containerEl.isConnected) return;
		const editor = note.editor;
		editor.setSelection(editor.offsetToPos(step.from), editor.offsetToPos(step.to));
		editor.scrollIntoView({ from: editor.offsetToPos(step.from), to: editor.offsetToPos(step.to) }, true);
		this.app.workspace.setActiveLeaf(note.leaf, { focus: true });
	}

	private insertFix(step: CheckedStep, fix: string) {
		const note = this.note;
		const editor = note?.editor;
		if (!note || !editor || !note.containerEl.isConnected || note.file?.path !== (this.state as { file?: TFile }).file?.path) {
			new Notice("Open the note that was checked to insert the fix.");
			return;
		}
		const from = editor.offsetToPos(step.from);
		const to = editor.offsetToPos(step.to);
		if (editor.getRange(from, to) !== step.raw) {
			new Notice("The note changed since the check. Check again, then insert the fix.");
			return;
		}
		editor.replaceRange(alignLike(step.raw, fix), from, to);
		new Notice("Fix inserted. Check again to see if the rest follows.");
	}
}

// For the editor's right-click menu: whether there is something to check.
export function canCheck(editor: Editor): boolean {
	return pickText(editor) !== null;
}

import type { App } from "obsidian";
import type { MathfieldElement } from "mathlive";
import { syntaxTree } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

// Shorthands work like Quick Latex's: type a few letters in a formula, press Space, and they
// become a LaTeX snippet, such as `al` to `\alpha` or `sq` to `\sqrt{}`. They are kept in Quick
// Latex's own text format, `key:::snippet;` one per line, so a list can be pasted in from it.

export const QUICK_LATEX_ID = "quick-latex";
export const LATEX_SUITE_ID = "obsidian-latex-suite";

// Quick Latex's default shorthands, offered as a preset.
export const PRESET_SHORTHANDS = [
	"sq:::\\sqrt{};",
	"bb:::\\mathbb{};",
	"bf:::\\mathbf{};",
	"te:::\\text{};",
	"inf:::\\infty;",
	"cd:::\\cdot;",
	"qu:::\\quad;",
	"ti:::\\times;",
	"al:::\\alpha;",
	"be:::\\beta;",
	"ga:::\\gamma;",
	"Ga:::\\Gamma;",
	"de:::\\delta;",
	"De:::\\Delta;",
	"ep:::\\epsilon;",
	"ze:::\\zeta;",
	"et:::\\eta;",
	"th:::\\theta;",
	"Th:::\\Theta;",
	"io:::\\iota;",
	"ka:::\\kappa;",
	"la:::\\lambda;",
	"La:::\\Lambda;",
	"mu:::\\mu;",
	"nu:::\\nu;",
	"xi:::\\xi;",
	"Xi:::\\Xi;",
	"pi:::\\pi;",
	"Pi:::\\Pi;",
	"rh:::\\rho;",
	"si:::\\sigma;",
	"Si:::\\Sigma;",
	"ta:::\\tau;",
	"up:::\\upsilon;",
	"Up:::\\Upsilon;",
	"ph:::\\phi;",
	"Ph:::\\Phi;",
	"ch:::\\chi;",
	"ps:::\\psi;",
	"Ps:::\\Psi;",
	"om:::\\omega;",
	"Om:::\\Omega;",
].join("\n");

// Entries end with `;` and a line break. `;` alone isn't a separator, since snippets such as
// `\;` contain it. Keys are letters only, as in Quick Latex.
export function parseShorthands(text: string): Map<string, string> {
	const shorthands = new Map<string, string>();
	for (const entry of text.split(/;[ \t]*(?:\r?\n|$)/)) {
		const split = entry.indexOf(":::");
		if (split < 0) {
			continue;
		}
		const key = entry.slice(0, split).trim();
		const snippet = entry.slice(split + 3).trim();
		if (/^[A-Za-z]+$/.test(key) && snippet) {
			shorthands.set(key, snippet);
		}
	}
	return shorthands;
}

export function formatShorthands(shorthands: Map<string, string>): string {
	return Array.from(shorthands, ([key, snippet]) => `${key}:::${snippet};`).join("\n");
}

// The shorthands in effect: the preset when it is on, then the user's own, which win.
let active = new Map<string, string>();
let longestKey = 0;
let inSourceMode: () => boolean = () => false;

export function setActiveShorthands(options: { preset: boolean; custom: string; inSourceMode: () => boolean }) {
	active = new Map([...(options.preset ? parseShorthands(PRESET_SHORTHANDS) : []), ...parseShorthands(options.custom)]);
	longestKey = Math.max(0, ...Array.from(active.keys(), (key) => key.length));
	inSourceMode = options.inSourceMode;
}

// Quick Latex marks where the cursor goes with #cursor and further stops with #tab. MathLive's
// placeholders do both, and an empty argument becomes one too.
export function toMathfieldSnippet(snippet: string): string {
	return snippet.replace(/#cursor|#tab/g, "#?").replace(/\{\}/g, "{#?}");
}

// For typed LaTeX: the snippet without its markers, and where the cursor goes in it.
export function toSourceSnippet(snippet: string): { text: string; cursor: number } {
	const marker = snippet.search(/#cursor|#tab/);
	const cursorAt = marker >= 0 ? marker : snippet.indexOf("{}") >= 0 ? snippet.indexOf("{}") + 1 : -1;
	const before = snippet.slice(0, Math.max(cursorAt, 0)).replace(/#cursor|#tab/g, "");
	const text = snippet.replace(/#cursor|#tab/g, "");
	return { text, cursor: cursorAt >= 0 ? before.length : text.length };
}

// Space in a math-field: the letters typed just before the cursor become their shorthand's
// snippet. Letters that are part of a longer word are left alone, as in Quick Latex.
export function expandShorthandInMathfield(mfe: MathfieldElement): boolean {
	if (active.size === 0 || mfe.mode !== "math" || !mfe.selectionIsCollapsed) {
		return false;
	}
	const end = mfe.position;
	let word = "";
	for (let start = end - 1; start >= 0 && word.length <= longestKey; start -= 1) {
		const letter = mfe.getValue(start, start + 1, "latex");
		if (!/^[A-Za-z]$/.test(letter)) {
			break;
		}
		word = letter + word;
	}
	const snippet = active.get(word);
	if (!snippet) {
		return false;
	}
	mfe.selection = { ranges: [[end - word.length, end]] };
	mfe.insert(toMathfieldSnippet(snippet), { format: "latex", selectionMode: "placeholder" });
	return true;
}

export function attachShorthands(mfe: MathfieldElement) {
	mfe.addEventListener(
		"keydown",
		(event: KeyboardEvent) => {
			if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
				return;
			}
			if (expandShorthandInMathfield(mfe)) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
		{ capture: true }
	);
}

// Whether the position is inside $...$ or $$...$$ in the Markdown source.
function isInMath(view: EditorView, pos: number): boolean {
	const node = syntaxTree(view.state).resolveInner(pos, -1);
	if (/math/.test(node.name) && !/math-end/.test(node.name)) {
		return true;
	}
	// A formula still being typed may not be closed yet: an odd number of $ before the cursor.
	const line = view.state.doc.lineAt(pos);
	const before = line.text.slice(0, pos - line.from).replace(/\\\$/g, "");
	return (before.match(/\$/g) ?? []).length % 2 === 1;
}

function expandShorthandInSource(view: EditorView): boolean {
	if (active.size === 0 || !inSourceMode()) {
		return false;
	}
	const range = view.state.selection.main;
	if (!range.empty || view.state.selection.ranges.length > 1) {
		return false;
	}
	const line = view.state.doc.lineAt(range.head);
	const before = line.text.slice(0, range.head - line.from);
	const match = /(^|[^A-Za-z\\])([A-Za-z]+)$/.exec(before);
	const snippet = match ? active.get(match[2]) : undefined;
	if (!match || !snippet || !isInMath(view, range.head)) {
		return false;
	}
	const from = range.head - match[2].length;
	const { text, cursor } = toSourceSnippet(snippet);
	view.dispatch({
		changes: { from, to: range.head, insert: text },
		selection: { anchor: from + cursor },
		userEvent: "input.complete",
	});
	return true;
}

export function shorthandSourceExtension(): Extension {
	return Prec.high(keymap.of([{ key: "Space", run: expandShorthandInSource }]));
}

// Obsidian doesn't expose which community plugins are on, so this reads its internal list.
export function isPluginEnabled(app: App, id: string): boolean {
	const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
	return plugins?.enabledPlugins?.has(id) ?? false;
}

// Quick Latex's shorthands from its settings in this vault, if it was ever installed here. They
// are a string setting in its key:::snippet; format.
export async function readQuickLatexShorthands(app: App): Promise<Map<string, string>> {
	const path = `${app.vault.configDir}/plugins/${QUICK_LATEX_ID}/data.json`;
	try {
		if (!(await app.vault.adapter.exists(path))) {
			return new Map();
		}
		const data = JSON.parse(await app.vault.adapter.read(path)) as Record<string, unknown>;
		const saved = typeof data.customShorthand_parameter === "string"
			? [data.customShorthand_parameter]
			: Object.values(data).filter((value): value is string => typeof value === "string" && value.includes(":::"));
		return new Map(saved.flatMap((text) => [...parseShorthands(text)]));
	} catch {
		return new Map();
	}
}

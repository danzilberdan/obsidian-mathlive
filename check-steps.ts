// Check my steps: finds the steps of a derivation in a piece of a note, and double-checks a step
// the AI calls wrong with MathLive's Compute Engine. Nothing here touches Obsidian, so the server's
// test set can run the same code.
import { ComputeEngine } from "@cortex-js/compute-engine";

export interface Step {
	/** The step's LaTeX, without $ signs, alignment marks or line breaks. */
	latex: string;
	/** Words in the note between the previous step and this one. */
	text: string;
	/** Where the step's line sits in the text it was found in, without the $ signs. */
	from: number;
	to: number;
	inline: boolean;
}

export interface Derivation {
	/** Words before the first step. */
	context: string;
	steps: Step[];
}

const ALIGN_ENVS = /^\\begin\{(aligned|align\*?|gathered|gather\*?|split|eqnarray\*?|alignat\*?|flalign\*?)\}(\{[^}]*\})?([\s\S]*)\\end\{\1\}$/;
const RELATIONS = new Set([
	"=", "<", ">", "\\le", "\\leq", "\\ge", "\\geq", "\\ne", "\\neq", "\\approx", "\\equiv",
	"\\Rightarrow", "\\implies", "\\iff", "\\Leftrightarrow", "\\Longrightarrow", "\\Longleftrightarrow",
	"\\leqslant", "\\geqslant", "\\lt", "\\gt",
]);
const MAX_PROSE = 300;

interface Token {
	/** A command like `\le`, a single character, or the end of a `\begin`/`\end` pair. */
	value: string;
	start: number;
	end: number;
	/** Brace and environment depth the token sits at. */
	depth: number;
	/** Environment depth alone, which a missing brace can't throw off. */
	envDepth: number;
}

function tokenize(latex: string): Token[] {
	const tokens: Token[] = [];
	let depth = 0;
	let envDepth = 0;
	let i = 0;
	while (i < latex.length) {
		const start = i;
		const char = latex[i];
		if (char === "\\") {
			const match = /^\\([A-Za-z]+|.)/.exec(latex.slice(i));
			const value = match ? match[0] : "\\";
			i += value.length;
			if (value === "\\begin" || value === "\\end") {
				// Take the environment name along, so `\begin{pmatrix}` is one token.
				const name = /^\s*\{[^}]*\}/.exec(latex.slice(i));
				if (name) i += name[0].length;
				if (value === "\\end") {
					depth--;
					envDepth--;
				}
				tokens.push({ value, start, end: i, depth: Math.max(depth, 0), envDepth: Math.max(envDepth, 0) });
				if (value === "\\begin") {
					depth++;
					envDepth++;
				}
				continue;
			}
			tokens.push({ value, start, end: i, depth, envDepth });
			continue;
		}
		if (char === "}") depth--;
		tokens.push({ value: char, start, end: i + 1, depth: Math.max(depth, 0), envDepth });
		if (char === "{") depth++;
		i++;
	}
	return tokens;
}

export interface Line {
	latex: string;
	/** Where the line sits in the math it came from, without the surrounding spaces. */
	from: number;
	to: number;
}

/** Splits displayed math into its lines at top-level `\\`, without the alignment marks. */
/**
 * The tokens outside any braces or environment. A typo like a missing `}` would hide every line
 * break and relation after it, so with unbalanced braces only environments count.
 */
function topLevel(tokens: Token[]): Token[] {
	const opened = tokens.filter((token) => token.value === "{").length;
	const balanced = opened === tokens.filter((token) => token.value === "}").length;
	return tokens.filter((token) => (balanced ? token.depth : token.envDepth) === 0);
}

export function splitLines(math: string): Line[] {
	let offset = math.length - math.trimStart().length;
	let body = math.trim();
	const env = ALIGN_ENVS.exec(body);
	if (env) {
		offset += env[0].length - env[3].length - `\\end{${env[1]}}`.length;
		body = env[3];
	}
	const pieces: Array<[number, number]> = [];
	let start = 0;
	for (const token of topLevel(tokenize(body))) {
		if (token.value === "\\\\") {
			pieces.push([start, token.start]);
			start = token.end;
		}
	}
	pieces.push([start, body.length]);
	const lines: Line[] = [];
	for (const [a, b] of pieces) {
		const raw = body.slice(a, b);
		const latex = cleanLine(removeAlignment(raw));
		if (!latex) continue;
		const lead = raw.length - raw.trimStart().length;
		lines.push({ latex, from: offset + a + lead, to: offset + a + raw.trimEnd().length });
	}
	return lines;
}

/** Drops the top-level `&` marks of an aligned line. */
function removeAlignment(line: string): string {
	let out = "";
	let last = 0;
	for (const token of topLevel(tokenize(line))) {
		if (token.value === "&") {
			out += line.slice(last, token.start) + " ";
			last = token.end;
		}
	}
	return out + line.slice(last);
}

function cleanLine(line: string): string {
	return line
		.replace(/\\(tag|label)\*?\{[^}]*\}/g, "")
		.replace(/\\(nonumber|notag)\b/g, "")
		.replace(/\[\s*-?\d*\.?\d+\s*(pt|em|ex|mm)\s*\]\s*$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[,.;]\s*$/, "")
		.trim();
}

/** The top-level relation signs in a step, like `=` and `\le`, in order. */
function relations(latex: string): Token[] {
	return topLevel(tokenize(latex)).filter((token) => RELATIONS.has(token.value));
}

function hasRelation(latex: string): boolean {
	return relations(latex).length > 0;
}

interface MathSpan {
	from: number;
	to: number;
	/** Where the math itself starts and ends, inside the delimiters. */
	inner: [number, number];
	display: boolean;
}

/** Every `$$..$$`, `\[..\]` and `$..$` outside code, in order. */
function mathSpans(text: string): MathSpan[] {
	const spans: MathSpan[] = [];
	const code = /```[\s\S]*?(```|$)|`[^`\n]*`/g;
	const skip: Array<[number, number]> = [];
	for (let m = code.exec(text); m; m = code.exec(text)) skip.push([m.index, m.index + m[0].length]);
	const inCode = (at: number) => skip.some(([a, b]) => at >= a && at < b);
	let i = 0;
	while (i < text.length) {
		if (inCode(i)) {
			i++;
			continue;
		}
		if (text[i] === "\\" && text[i + 1] === "$") {
			i += 2;
			continue;
		}
		const open = text.startsWith("$$", i) ? "$$" : text.startsWith("\\[", i) ? "\\[" : text[i] === "$" ? "$" : null;
		if (!open) {
			i++;
			continue;
		}
		const close = open === "\\[" ? "\\]" : open;
		let j = i + open.length;
		let found = -1;
		while (j < text.length) {
			if (text[j] === "\\" && text[j + 1] === "$") {
				j += 2;
				continue;
			}
			if (text.startsWith(close, j)) {
				found = j;
				break;
			}
			// Inline math ends at the line.
			if (open === "$" && text[j] === "\n") break;
			j++;
		}
		if (found < 0 || found === i + open.length) {
			i += open.length;
			continue;
		}
		spans.push({ from: i, to: found + close.length, inner: [i + open.length, found], display: open !== "$" });
		i = found + close.length;
	}
	return spans;
}

function prose(text: string): string {
	const words = text.replace(/\s+/g, " ").trim();
	return words.length > MAX_PROSE ? "…" + words.slice(-MAX_PROSE) : words;
}

/**
 * Finds the steps in a selection: each line of displayed math, and each inline formula that states
 * something (has `=`, `<`, `\Rightarrow`...). Inline math without a relation stays part of the words,
 * and inline formulas joined only by "or" or "and" are one step, like `x = 2` or `x = 3`.
 */
export function findSteps(text: string): Derivation {
	const steps: Step[] = [];
	let context = "";
	let wordsStart = 0;
	for (const span of mathSpans(text)) {
		const inner = text.slice(span.inner[0], span.inner[1]);
		const lines: Line[] = span.display
			? splitLines(inner)
			: [{ latex: cleanLine(inner), from: 0, to: inner.length }];
		if (!span.display && !hasRelation(lines[0]?.latex ?? "")) continue;
		const between = text.slice(wordsStart, span.from);
		const previous = steps[steps.length - 1];
		if (!span.display && previous?.inline && /^\s*,?\s*(or|and)?\s*,?\s*$/i.test(between) && between.trim()) {
			const joiner = between.trim().replace(/^,\s*/, "").replace(/,$/, "") || ",";
			previous.latex += joiner === "," ? ", " + lines[0].latex : ` \\text{ ${joiner} } ` + lines[0].latex;
			previous.to = span.inner[1];
			wordsStart = span.to;
			continue;
		}
		const words = prose(between);
		lines.forEach((line, index) => {
			if (steps.length === 0) context = words;
			steps.push({
				latex: line.latex,
				text: index === 0 && steps.length > 0 ? words : "",
				from: span.inner[0] + line.from,
				to: span.inner[0] + line.to,
				inline: !span.display,
			});
		});
		wordsStart = span.to;
	}
	return { context, steps };
}

// ----------------------------------------------------------------------------- Compute Engine

type Expr = NonNullable<ReturnType<ComputeEngine["parse"]>>;

let engine: ComputeEngine | null = null;
function ce(): ComputeEngine {
	engine ??= new ComputeEngine();
	return engine;
}

const SAMPLES = 10;
const NEEDED = 5;
const CONSTANTS = new Set(["ExponentialE", "Pi", "ImaginaryUnit", "e", "Pi", "Nothing"]);

interface Sides {
	sides: string[];
	/** The relation between each pair of neighbouring sides. */
	ops: string[];
	/** The step starts with a relation, so it continues the previous line. */
	continues: boolean;
}

function sidesOf(latex: string): Sides {
	const rels = relations(latex);
	const sides: string[] = [];
	const ops: string[] = [];
	let last = 0;
	for (const rel of rels) {
		sides.push(latex.slice(last, rel.start).trim());
		ops.push(rel.value);
		last = rel.end;
	}
	sides.push(latex.slice(last).trim());
	const continues = sides.length > 1 && sides[0] === "";
	if (continues) sides.shift();
	return { sides, ops, continues };
}

/** Parses one side, or null when the Compute Engine can't make sense of it. */
function parse(latex: string): Expr | null {
	// The bundled Compute Engine is the small 0.30 one, which misreads derivatives, integrals and
	// limits, so those keep the AI's verdict.
	if (CALCULUS.test(latex)) return null;
	if (!latex || /\\text|\\mathrm\{[a-z]{2,}|\\quad|\\Big\[|\\big\[|\\left\[[^\]]*\\right\]_|\\Bigg|\]_\{?/.test(latex)) return null;
	try {
		const expr = ce().parse(latex);
		const json = JSON.stringify(expr.json);
		if (!expr.isValid || json.includes('"Error"') || json.includes('"Sequence"')) return null;
		// A derivative of a bare symbol, like dy/dx, means y depends on x, which the engine can't
		// know.
		if (/\["D","[A-Za-z]+"/.test(json)) return null;
		return expr;
	} catch {
		return null;
	}
}

function symbolsOf(expr: Expr): string[] {
	const found = new Set<string>();
	const walk = (node: unknown, bound: Set<string>) => {
		if (typeof node === "string") {
			if (/^[A-Za-z][A-Za-z0-9_]*$/.test(node) && !CONSTANTS.has(node) && !bound.has(node) && node.length <= 3) found.add(node);
			return;
		}
		if (!Array.isArray(node)) return;
		const [head, ...rest] = node as unknown[];
		if (typeof head !== "string") return;
		// Bound variables of integrals, sums and limits aren't free.
		let inner = bound;
		if (head === "Function") {
			inner = new Set([...bound, ...rest.slice(1).filter((x): x is string => typeof x === "string")]);
		}
		if (head === "Limits" || head === "Element") {
			const v = rest[0];
			if (typeof v === "string") inner = new Set([...bound, v]);
		}
		for (const child of rest) walk(child, inner);
	};
	walk(expr.json, new Set());
	return [...found];
}

function randomValue(seed: number): number {
	// Spread over both signs, away from 0, so square roots and logs of negatives are noticed.
	const magnitude = 0.3 + ((seed * 0.6180339887) % 1) * 2.4;
	return seed % 2 === 0 ? magnitude : -magnitude;
}

function numberOf(expr: Expr, values: Record<string, number>): number | null {
	try {
		const result = expr.subs(values).N();
		const value = result.re;
		const im = result.im;
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		if (typeof im === "number" && Math.abs(im) > 1e-9 * Math.max(1, Math.abs(value))) return null;
		return value;
	} catch {
		return null;
	}
}

function close(a: number, b: number): boolean {
	return Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The values of several expressions at random points where every one of them is a real number. */
function samples(exprs: Expr[]): number[][] {
	const names = [...new Set(exprs.flatMap(symbolsOf))];
	const points: number[][] = [];
	for (let trial = 0; trial < SAMPLES * 3 && points.length < SAMPLES; trial++) {
		const values: Record<string, number> = {};
		names.forEach((name, i) => (values[name] = randomValue(trial * 7 + i * 3 + 1)));
		const row = exprs.map((expr) => numberOf(expr, values));
		if (row.every((v): v is number => v !== null)) points.push(row);
		// Expressions without variables only need one look.
		if (names.length === 0) break;
	}
	return points;
}

/** Whether `a = b` holds for every value of the variables (up to a constant, for antiderivatives). */
function identity(a: Expr, b: Expr, upToConstant: boolean): boolean {
	const points = samples([a, b]);
	const needed = symbolsOf(a).concat(symbolsOf(b)).length === 0 ? 1 : NEEDED;
	if (points.length < needed) return false;
	const offset = points[0][0] - points[0][1];
	return points.every(([x, y]) => (upToConstant ? close(x - y, offset) : close(x, y)));
}

const CALCULUS = /\\(int|iint|oint|lim|sum|prod|partial|nabla|det|begin|infty|to)\b|\\frac\s*\{\s*d|\\mathrm\{d\}|\b(d[a-z]\s*\/|dx\b|dt\b)|'|\^\{?\\prime/;
const INDEFINITE = /\\int(?!_)|\+\s*C\b/;

/**
 * Whether the Compute Engine can show that step `index` holds: every `=` in it is an identity
 * (with a continued line, starting from the previous line's last expression), or it is an
 * equation equivalent to the previous line's, or a solution that satisfies it. False means only
 * "couldn't show it", never that the step is wrong.
 */
export function stepHolds(steps: string[], index: number): boolean {
	const step = sidesOf(steps[index]);
	if (step.ops.some((op) => op !== "=")) return false;
	let sides = step.sides;
	const previous = index > 0 ? sidesOf(steps[index - 1]) : null;
	if (step.continues) {
		if (!previous || previous.ops.some((op) => op !== "=")) return false;
		sides = [previous.sides[previous.sides.length - 1], ...sides];
	}
	if (sides.length < 2) return false;
	const upToConstant = sides.some((side) => INDEFINITE.test(side));
	// The constant of integration is any number, so leave it out of both sides.
	if (upToConstant) sides = sides.map((side) => side.replace(/\+\s*C\s*$/, "").trim());
	const parsed = sides.map(parse);
	if (parsed.some((expr) => expr === null)) return false;
	const exprs = parsed as Expr[];

	let allIdentities = true;
	for (let i = 0; i + 1 < exprs.length; i++) {
		if (!identity(exprs[i], exprs[i + 1], upToConstant)) {
			allIdentities = false;
			break;
		}
	}
	if (allIdentities) return true;

	// An equation step: the same solutions as the equation on the line before.
	if (step.continues || exprs.length !== 2 || !previous || previous.continues || previous.sides.length !== 2) return false;
	const before = previous.sides.map(parse);
	if (before.some((expr) => expr === null)) return false;
	const [l0, r0] = before as Expr[];
	const [l1, r1] = exprs;
	// Every value satisfies an identity, so it says nothing about the next line.
	if (identity(l0, r0, false)) return false;
	const points = samples([l0, r0, l1, r1]);
	if (points.length >= NEEDED) {
		// Multiplying or dividing both sides by a non-zero number, or adding to both sides.
		const ratios = points.map(([a, b, c, d]) => (Math.abs(a - b) > 1e-9 ? (c - d) / (a - b) : NaN));
		if (ratios.every((r) => Number.isFinite(r) && Math.abs(r) > 1e-9 && close(r, ratios[0]))) return true;
	}
	// Solved for a variable: putting the answer back into the previous equation satisfies it.
	const variable = sides[0].trim();
	if (/^[A-Za-z]$/.test(variable) && !symbolsOf(r1).includes(variable)) {
		try {
			const solved = ce().parse(sides[1]);
			const left = l0.subs({ [variable]: solved });
			const right = r0.subs({ [variable]: solved });
			return identity(left, right, false);
		} catch {
			return false;
		}
	}
	return false;
}

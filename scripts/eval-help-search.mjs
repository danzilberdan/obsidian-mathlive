// Checks that "How do I…" questions find the right help: each question lists the topic ids or
// docs anchors that count as a right answer, and one of them must be in the top 3.
//
//   node --experimental-strip-types scripts/eval-help-search.mjs   (npm run eval:help)

import { readFileSync } from "node:fs";
import { HelpIndex } from "../help-search.ts";

const load = (file) => JSON.parse(readFileSync(new URL(`../help/${file}`, import.meta.url), "utf8")).entries;
const topics = load("topics.json").map((entry) => ({ kind: "topic", ...entry }));
const index = new HelpIndex([...topics, ...load("mathlive-docs.json")]);

const QUESTIONS = [
	["how do I write a fraction", ["fraction"]],
	["fraction", ["fraction"]],
	["divide", ["fraction"]],
	["x squared", ["power"]],
	["exponent", ["power"]],
	["how to raise to a power", ["power"]],
	["subscript", ["subscript"]],
	["index of a variable", ["subscript"]],
	["square root", ["sqrt", "#math-symbols"]],
	["cube root", ["sqrt"]],
	["sqaure root", ["sqrt", "#math-symbols"]],
	["greek letters", ["greek", "#greek"]],
	["alpha", ["greek", "#greek-letters", "#greek"]],
	["how to type theta", ["greek", "#greek-letters"]],
	["matrix", ["matrix", "#creating-a-matrix"]],
	["make a 2x2 matrix", ["matrix", "#creating-a-matrix"]],
	["make a matrix", ["matrix"]],
	["add a row to a matrix", ["matrix-shape", "#changing-the-shape-of-a-matrix"]],
	["integral", ["integral", "#large-operators"]],
	["sum from i=1 to n", ["integral", "#large-operators"]],
	["limit", ["integral"]],
	["derivative", ["derivative"]],
	["partial derivative", ["derivative", "#letter-like-symbols"]],
	["not equal", ["#relational-operators", "symbols"]],
	["greater than or equal", ["#relational-operators", "symbols"]],
	["->", ["#arrows"]],
	["arrow", ["#arrows"]],
	["implies", ["#arrows"]],
	["infinity", ["#letter-like-symbols", "symbols"]],
	["plus minus", ["#other-operators", "symbols"]],
	["multiply sign", ["#other-operators", "symbols"]],
	["real numbers", ["sets", "#letter-like-symbols"]],
	["element of a set", ["sets", "#other-operators"]],
	["union of sets", ["#other-operators", "#set-operators"]],
	["text in a formula", ["text"]],
	["write words inside an equation", ["text"]],
	["new line", ["multiline"]],
	["align equations", ["multiline"]],
	["piecewise function", ["cases"]],
	["vector arrow", ["vector", "#accents"]],
	["hat over x", ["vector", "#accents"]],
	["absolute value", ["brackets", "#delimiters"]],
	["parentheses", ["brackets", "#delimiters"]],
	["color", ["color", "#colors"]],
	["bold letters", ["bold", "#bold"]],
	["chemistry", ["chemistry", "#chemistry-mhchem-package"]],
	["undo", ["undo"]],
	["select part of the formula", ["select"]],
	["get out of the formula", ["leave", "move"]],
	["move to the next box", ["move"]],
	["virtual keyboard", ["math-keyboard"]],
	["on screen keyboard", ["math-keyboard"]],
	["keyboard shortcuts", ["all-shortcuts", "#keybindings", "#keyboard-shortcuts"]],
	["latex commands list", ["all-commands"]],
	["type latex", ["latex-mode"]],
	["see the latex code", ["raw-latex"]],
	["scan a formula from a pdf", ["scan", "pdf"]],
	["screenshot to latex", ["scan"]],
	["handwriting", ["draw"]],
	["find the quadratic formula", ["find-formula"]],
	["pythagorean theorem", ["find-formula"]],
	["convert pdf to notes", ["pdf"]],
	["quick latex", ["shorthands"]],
	["my own shortcuts", ["shorthands"]],
	["hotkey to add a formula", ["hotkey"]],
	["bigger editor", ["editor-window"]],
	["inline math", ["start-formula"]],
	["how do i start", ["start-formula"]],
	["dots", ["#dots", "#miscellaneous"]],
	["floor", ["#delimiters"]],
	["sin", ["#functions", "#trigonometry"]],
];

let hits = 0;
let firsts = 0;
const misses = [];
for (const [question, expected] of QUESTIONS) {
	const results = index.search(question, 3);
	const right = (entry) => expected.some((want) => (want.startsWith("#") ? entry.url?.endsWith(want) : entry.id === want));
	const ok = results.some(right);
	if (results[0] && right(results[0])) {
		firsts++;
	}
	if (ok) {
		hits++;
	} else {
		misses.push(`  ${question}  →  ${results.map((e) => `${e.title} (${e.id})`).join(" | ") || "nothing"}`);
	}
}
const percent = ((100 * hits) / QUESTIONS.length).toFixed(1);
console.log(`Right answer in the top 3: ${hits}/${QUESTIONS.length} (${percent}%), first: ${firsts}/${QUESTIONS.length}`);
if (misses.length) {
	console.log(`Misses:\n${misses.join("\n")}`);
}
const nothing = ["asdfgh", "qwertyuiop"].filter((q) => index.search(q).length > 0);
if (nothing.length) {
	console.log(`Gibberish that still found something: ${nothing.join(", ")}`);
}
process.exit(hits / QUESTIONS.length >= 0.9 ? 0 : 1);

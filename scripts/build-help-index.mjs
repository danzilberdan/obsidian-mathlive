// Builds help/mathlive-docs.json, the "How do I…" index of the MathLive editor's public docs
// (mathlive.io/mathfield), from a checkout of the docs site's source:
//
//   git clone --depth 1 https://github.com/cortex-js/cortexjs.io /tmp/cortexjs.io
//   node scripts/build-help-index.mjs /tmp/cortexjs.io
//
// It runs once, when the docs change, and the result is committed and bundled into the plugin, so
// searching needs no network and no server. Only the pages about using the editor are indexed, not
// the ones about building it into a web page. Every entry links to its exact section of the docs.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://mathlive.io";
const root = process.argv[2];
if (!root) {
	console.error("Usage: node scripts/build-help-index.mjs <path to a cortexjs.io checkout>");
	process.exit(1);
}
const docs = join(root, "docs", "mathfield");
const read = (file) => readFileSync(join(docs, file), "utf8");

// What a key glyph reads as on Windows, Linux, Android and ChromeOS, as the docs show it.
const KEY_NAMES = {
	"⌘": "Ctrl", "⌃": "Ctrl", "⇧": "Shift", "⌥": "Alt", "⤒": "Home", "⤓": "End", "⇞": "Page Up", "⇟": "Page Down",
	"⌫": "Backspace", "⌦": "Delete", "⏎": "Enter", "⌤": "Enter", "⇥": "Tab", "⇠": "←", "⇢": "→", "⇡": "↑", "⇣": "↓",
	SPACE: "Space", ESC: "Esc",
};
const MAC_KEYS = { "⇠": "←", "⇢": "→", "⇡": "↑", "⇣": "↓", SPACE: "Space", ESC: "Esc" };

// Plain names for symbols, so "not equal" or "multiply" finds them as well as their LaTeX.
const NAMES = {
	"\\frac": "fraction; divide over", "\\sqrt": "square root; radical", "\\sqrt[n]": "nth root; cube root radical",
	"\\pi": "pi", "\\emptyset": "empty set", "\\varnothing": "empty set", "\\differentialD": "differential d; derivative",
	"\\partial": "partial derivative", "\\prod": "product", "\\infty": "infinity", "\\|": "norm; double bar",
	"\\backslash": "backslash; set minus", "\\~": "tilde", "\\imaginaryI": "imaginary unit i", "\\imaginaryJ": "imaginary unit j",
	"\\exponentialE": "Euler's number e; exponential", "\\N": "natural numbers", "\\Z": "integers", "\\Q": "rational numbers",
	"\\R": "real numbers", "\\C": "complex numbers", "\\P": "prime numbers", "\\forall": "for all", "\\exists": "there exists",
	"\\nexists": "there does not exist", "\\nabla": "nabla; gradient del", "\\aleph": "aleph", "\\bot": "bottom; perpendicular",
	"\\top": "top", "\\ne": "not equal", "\\ge": "greater than or equal", "\\le": "less than or equal", "\\ll": "much less than",
	"\\gg": "much greater than", "\\approx": "approximately equal", "\\equiv": "equivalent; congruent identical",
	"\\cong": "congruent; isomorphic", "\\coloneq": "defined as; assign", "\\propto": "proportional to",
	"\\leq": "less than or equal", "\\geq": "greater than or equal", "\\cdot": "multiplication dot; times product",
	"\\times": "times; multiply cross product", "\\pm": "plus or minus", "\\div": "division sign; divide", "\\circ": "composition; compose degree",
	"\\otimes": "tensor product", "\\oplus": "direct sum; xor", "\\in": "element of; in set", "\\notin": "not an element of",
	"\\cap": "intersection", "\\cup": "union", "\\bigcap": "big intersection", "\\bigcup": "big union", "\\subset": "subset",
	"\\supset": "superset", "\\subseteq": "subset or equal", "\\supseteq": "superset or equal", "\\land": "logical and",
	"\\lor": "logical or", "\\neg": "logical not; negation", "\\wedge": "wedge; and", "\\vee": "vee; or",
	"\\lfloor": "floor", "\\rfloor": "floor", "\\lceil": "ceiling", "\\rceil": "ceiling", "\\Vert": "norm; double bar",
	"\\langle": "angle bracket; inner product", "\\rangle": "angle bracket; inner product", "\\to": "arrow; to tends to limit",
	"\\mapsto": "maps to", "\\Rightarrow": "implies; double arrow", "\\Longrightarrow": "long implies; arrow",
	"\\Leftrightarrow": "if and only if; iff equivalent arrow", "\\leftrightarrow": "left right arrow", "\\rightarrow": "right arrow",
	"\\leftarrow": "left arrow", "\\uparrow": "up arrow", "\\downarrow": "down arrow", "\\sum": "sum; sigma summation",
	"\\int": "integral", "\\ldots": "dots; ellipsis", "\\therefore": "therefore", "\\vdash": "turnstile; proves",
	"\\models": "models; entails", "\\sin": "sine; trig", "\\cos": "cosine; trig", "\\tan": "tangent; trig", "\\log": "logarithm; log",
	"\\ln": "natural logarithm; log", "\\exp": "exponential", "\\lim": "limit", "\\det": "determinant", "\\mod": "modulo",
	"\\max": "maximum", "\\min": "minimum", "\\mathbb": "blackboard bold; double struck", "\\star": "star", "\\ast": "asterisk",
	"\\Colon": "double colon", "\\questeq": "questioned equal", "<": "less than", ">": "greater than", "-:": "division sign; divide",
	"\\doubleprime": "double prime; second derivative", "\\ominus": "circled minus", "\\odot": "circled dot",
	"\\operatorname": "", "iff": "if and only if; iff", "x \\in": "x element of; in", "\\%": "percent",
	"\\overline": "overline; conjugate mean bar", "\\binom": "binomial coefficient; choose", "\\cancel": "cancel; strike out",
	"\\boxed": "box; boxed frame", "\\degree": "degree", "\\vec": "vector arrow", "\\hat": "hat; unit vector",
};

// "name; more search words" in NAMES: the name, and everything for searching.
const displayName = (latex) => nameOf(latex).split(";")[0].trim();
const searchName = (latex) => nameOf(latex).replace(";", "");

function nameOf(latex) {
	const text = latex.trim().replace(/^\^\{(.*)\}$/, "$1");
	const operator = text.match(/^\\operatorname\*?\{([^}]+)\}/);
	if (operator) {
		return operator[1].replace("~", " ");
	}
	if (text in NAMES) {
		return NAMES[text];
	}
	const command = text.match(/^\\[a-zA-Z]+(\[n\])?|^\\./)?.[0];
	if (!command) {
		return "";
	}
	return NAMES[command] ?? NAMES[command.replace("[n]", "")] ?? command.slice(1);
}

// The anchor Docusaurus gives a heading (github-slugger), unless the heading sets its own {#id}.
function slugger() {
	const seen = new Map();
	return (heading) => {
		const own = heading.match(/\{#([\w-]+)\}\s*$/);
		if (own) {
			return own[1];
		}
		const base = clean(heading)
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
			.replace(/ /g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count ? `${base}-${count}` : base;
	};
}

// Markdown and JSX down to plain sentences.
function clean(text) {
	return text
		.replace(/\{#[\w-]+\}/g, "")
		.replace(/<kbd>(.*?)<\/kbd>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|__/g, "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^#+ /gm, "").replace(/ #{2,} /g, " ")
		.replace(/\\\\\(|\\\\\)/g, "")
		.replace(/\\([<>_|~*`\\])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

// The first sentences of a section's own prose, without code, components or tables.
function summary(body, max = 240) {
	const prose = [];
	let inCode = false;
	for (const line of body.split("\n")) {
		if (line.trim().startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode || /^\s*(<|:::|!\[|\||---|import |export |\{)/.test(line) || line.trim() === "") {
			if (prose.length && line.trim() === "") {
				prose.push("\n");
			}
			continue;
		}
		prose.push(line);
	}
	let text = "";
	for (const paragraph of prose.join(" ").split("\n").map(clean).filter(Boolean)) {
		text = text ? `${text} ${paragraph}` : paragraph;
		if (text.length > max * 0.6) {
			break;
		}
	}
	if (text.length > max) {
		const cut = text.slice(0, max);
		const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(": "));
		text = end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
	}
	return text;
}

// A page split at its ## and ### headings, with each section's anchor.
function sections(file) {
	const source = read(file);
	const slug = source.match(/^slug:\s*(\S+)/m)[1].replace(/\/?$/, "/");
	const page = source.match(/^title:\s*(.+)$/m)[1].trim();
	const anchor = slugger();
	const out = [];
	let current = null;
	let inCode = false;
	for (const line of source.split("\n")) {
		if (line.trim().startsWith("```")) {
			inCode = !inCode;
		}
		const heading = !inCode && line.match(/^(#{2,3}) (.+)$/);
		if (heading) {
			const parent = heading[1] === "###" ? out.filter((s) => s.level === 2).at(-1)?.title : undefined;
			current = { level: heading[1].length, title: clean(heading[2]), parent, anchor: anchor(heading[2]), body: "" };
			out.push(current);
		} else if (current) {
			current.body += `${line}\n`;
		}
	}
	return { slug, page, url: `${SITE}${slug}`, sections: out };
}

const entries = [];
const add = (entry) => entries.push({ source: "docs", ...entry });

function keys(value) {
	return value
		.trim()
		.split(/ +/)
		.map((combo) => combo.split("+").map((key) => KEY_NAMES[key] ?? key).join("+"));
}

function macKeys(value) {
	return value
		.trim()
		.split(/ +/)
		.map((combo) => combo.split("+").map((key) => MAC_KEYS[key] ?? key).join(""));
}

// Keyboard shortcuts and inline shortcuts: one entry each, with the keys to press.
{
	const page = sections("06-keybindings.md");
	for (const section of page.sections) {
		const url = `${page.url}#${section.anchor}`;
		for (const match of section.body.matchAll(/<Keybinding value="([^"]+)"(?: appleValue="([^"]+)")?>([\s\S]*?)<\/Keybinding>/g)) {
			const [, value, appleValue, label] = match;
			const latex = label.match(/\$\$(.+)\$\$/)?.[1];
			const what = latex ? `Insert ${displayName(latex) || latex}` : clean(label);
			add({
				id: `key-${entries.length}`,
				kind: "key",
				title: what.charAt(0).toUpperCase() + what.slice(1),
				keys: keys(value),
				macKeys: appleValue ? [...macKeys(value), ...macKeys(appleValue)] : macKeys(value),
				latex,
				keywords: [section.title, latex ?? "", latex ? searchName(latex) : ""].join(" "),
				page: page.page,
				section: section.title,
				url,
			});
		}
		for (const match of section.body.matchAll(/<Shortcut value=(["'])(.+?)\1>([\s\S]*?)<\/Shortcut>/g)) {
			const latex = match[2].trim();
			const typed = [...match[3].matchAll(/<div>(.*?)<\/div>/g)].map((m) => m[1]);
			// What to type, exactly as written: markdown escapes off, nothing else cleaned.
			const ways = (typed.length ? typed : [match[3]])
				.map((t) => t.replace(/&ast;/g, "*").replace(/&amp;/g, "&").replace(/\\([<>_|~*\\{}%#])/g, "$1").trim())
				.filter(Boolean);
			const name = displayName(latex);
			add({
				id: `shortcut-${entries.length}`,
				kind: "shortcut",
				title: !name ? latex : /^[a-z]{1,4}$/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1),
				typed: ways,
				latex,
				keywords: [section.title, latex, searchName(latex)].join(" "),
				page: page.page,
				section: section.title,
				url,
			});
		}
		if (section.level === 2 || !/inlineshortcut-table|keybindings-table/.test(section.body)) {
			add({
				id: `section-${page.slug}${section.anchor}`,
				kind: "section",
				title: section.title,
				text: summary(section.body),
				keywords: page.page,
				page: page.page,
				section: section.title,
				url,
			});
		}
	}
}

// The demo page's table of the most used shortcuts.
{
	const page = sections("02-playground.md");
	const section = page.sections.find((s) => s.title === "Keyboard Shortcuts");
	for (const cell of section.body.split(/<div className="cell">/).slice(1)) {
		const label = cell.match(/className="label">([^<]+)</)?.[1]?.replace("Blakckboard", "Blackboard");
		const latex = cell.match(/className="result">\{`\$\$\s*(.+?)\$\$`\}/)?.[1]?.replace(/\\\\/g, "\\");
		const pressed = [...cell.matchAll(/className="shortcut(?: if-not-glyphs)?">([\s\S]*?)<\/div>/g)]
			.filter((m) => !m[0].includes("if-glyphs"))
			.map((m) => clean(m[1]).replace(/ ?\+ ?/g, "+").replace(/\bALT\b/g, "Alt").replace(/\bSHIFT\b/g, "Shift"));
		if (!label || !pressed.length) {
			continue;
		}
		add({
			id: `basic-${label.toLowerCase().replace(/\W+/g, "-")}`,
			kind: "key",
			title: label,
			keys: pressed,
			macKeys: pressed.map((k) => k.replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧")),
			latex: latex?.replace(/\\blacksquare|\\square/g, "\\placeholder{}"),
			keywords: `${latex ?? ""} ${latex ? searchName(latex) : ""} keyboard shortcut`,
			page: "Mathfield demo",
			section: "Keyboard shortcuts",
			url: `${page.url}#${section.anchor}`,
		});
	}
}

// Section pages: the math keyboard, matrices and the LaTeX commands MathLive knows.
for (const file of ["03-virtual-keyboard.md", "04-matrix.md", "05-latex-commands.md"]) {
	const page = sections(file);
	const intro = read(file).match(/<Intro>([\s\S]*?)<\/Intro>/)?.[1];
	add({
		id: `page-${page.slug}`,
		kind: "section",
		title: page.page,
		text: intro ? summary(intro) : "",
		keywords: "",
		page: page.page,
		url: page.url,
	});
	for (const section of page.sections) {
		// The LaTeX commands a section lists, so searching a command finds where it is explained.
		const commands = [
			...new Set(
				[...section.body.matchAll(/<Latex value=(['"])(.*?)\1(?: source=(['"])(.*?)\3)?/g)]
					.map((m) => (m[4] || m[2]).match(/\\[a-zA-Z]+/)?.[0])
					.filter(Boolean)
			),
		];
		add({
			id: `section-${page.slug}${section.anchor}`,
			kind: "section",
			title: section.parent && !section.title.includes(section.parent) ? `${section.parent}: ${section.title}` : section.title,
			text: summary(section.body),
			commands: commands.slice(0, 60),
			keywords: [page.page, commands.map(searchName).join(" ")].join(" "),
			page: page.page,
			url: `${page.url}#${section.anchor}`,
		});
	}
}

// One entry per symbol: "Floor" from |__ and from __| is one result with both ways to type it.
const seen = new Map();
const unique = entries.filter((entry) => {
	const key = entry.kind === "shortcut" ? `${entry.title}|${entry.url}` : `${entry.kind}|${entry.title}|${entry.url}|${(entry.keys ?? []).join()}`;
	const first = seen.get(key);
	if (first) {
		if (entry.typed) {
			first.typed = [...new Set([...first.typed, ...entry.typed])];
		}
		return false;
	}
	seen.set(key, entry);
	return true;
});
unique.forEach((entry) => {
	entry.keywords = entry.keywords.replace(/\s+/g, " ").trim();
	if (!entry.keywords) {
		delete entry.keywords;
	}
});

const out = new URL("../help/mathlive-docs.json", import.meta.url);
writeFileSync(out, `${JSON.stringify({ site: SITE, entries: unique }, null, "\t")}\n`);
console.log(`Wrote ${unique.length} entries to help/mathlive-docs.json`);

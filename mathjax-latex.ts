// Obsidian draws formulas with MathJax, which doesn't know some commands MathLive writes or
// accepts: \differentialD from typing "dx" (#24), KaTeX's \rarr (#13), and others. Formulas are
// saved with what MathJax draws the same way instead. Each entry was checked against Obsidian's
// MathJax (tests/e2e/mathjax.spec.mjs).
const REPLACEMENTS: Record<string, string> = {
	// MathLive's own names for the upright d, e and i.
	differentialD: "\\mathrm{d}",
	capitalDifferentialD: "\\mathrm{D}",
	exponentialE: "\\mathrm{e}",
	imaginaryI: "\\mathrm{i}",
	imaginaryJ: "\\mathrm{j}",

	// KaTeX's short arrows.
	rarr: "\\rightarrow",
	larr: "\\leftarrow",
	lArr: "\\Leftarrow",
	lrArr: "\\Leftrightarrow",
	biconditional: "\\leftrightarrow",

	// Number sets.
	N: "\\mathbb{N}",
	Z: "\\mathbb{Z}",
	Q: "\\mathbb{Q}",
	R: "\\mathbb{R}",
	C: "\\mathbb{C}",

	// Function names MathJax has no command for.
	arcsec: "\\operatorname{arcsec}",
	arccsc: "\\operatorname{arccsc}",
	arcsech: "\\operatorname{arcsech}",
	arccsch: "\\operatorname{arccsch}",
	arsinh: "\\operatorname{arsinh}",
	arcosh: "\\operatorname{arcosh}",
	artanh: "\\operatorname{artanh}",
	cosec: "\\operatorname{cosec}",
	cotg: "\\operatorname{cotg}",
	ctg: "\\operatorname{ctg}",
	tg: "\\operatorname{tg}",
	cth: "\\operatorname{cth}",
	sh: "\\operatorname{sh}",
	ch: "\\operatorname{ch}",
	lb: "\\operatorname{lb}",

	// Other symbols and spellings.
	dag: "\\dagger",
	ddag: "\\ddagger",
	divides: "\\mid",
	mvert: "\\mid",
	mVert: "\\parallel",
	nsubset: "\\not\\subset",
	nsupset: "\\not\\supset",
	colonequals: "\\mathrel{:=}",
	vcentcolon: "\\mathrel{:}",
	doubleprime: "\\prime\\prime",
	mathellipsis: "\\ldots",
	llbracket: "[\\![",
	rrbracket: "]\\!]",
	Kappa: "\\mathrm{K}",
	i: "\\imath",
	j: "\\jmath",
	euro: "\\text{€}",
	pounds: "\\text{£}",
	AE: "\\text{Æ}",
	ae: "\\text{æ}",
	OE: "\\text{Œ}",
	oe: "\\text{œ}",
	O: "\\text{Ø}",
	ss: "\\text{ß}",
	slash: "/",
	widecheck: "\\check",
	bm: "\\boldsymbol",
	emph: "\\textit",
	mleft: "\\left",
	mright: "\\right",
	enskip: "\\enspace",
	displaylimits: "\\limits",
};

// A command with its name, or any other escaped character, so `\\rarr` (a line break, then
// "rarr") is never read as \rarr. A command may be followed by an [option].
const TOKEN = /\\([a-zA-Z]+)(\[[^\]]*\])?|\\[^a-zA-Z]/g;
const SINGLE_COMMAND = /^\\[a-zA-Z]+$/;

export function toMathJaxLatex(latex: string): string {
	return latex.replace(TOKEN, (match: string, name: string | undefined, option: string | undefined, offset: number) => {
		if (name === undefined) {
			return match;
		}
		// An empty box MathLive keeps for a part still to fill in: keep only its contents.
		if (name === "placeholder") {
			return "";
		}
		if (!Object.prototype.hasOwnProperty.call(REPLACEMENTS, name)) {
			return match;
		}

		let replacement = REPLACEMENTS[name];
		// x^\N becomes x^{\mathbb{N}}: a sub- or superscript takes one token.
		if (!SINGLE_COMMAND.test(replacement) && /[_^]\s*$/.test(latex.slice(0, offset))) {
			replacement = `{${replacement}}`;
		}
		return replacement + (option ?? "");
	});
}

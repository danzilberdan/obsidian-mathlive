// "How do I…" search over MathLive's help: hand-written topics plus an index of the MathLive docs
// made once by scripts/build-help-index.mjs. It runs on the device with no network and no AI: a
// BM25 keyword ranking with stemming, a few synonyms, and typo and prefix matching, so the answer
// is instant, free and works offline.

export interface HelpEntry {
	id: string;
	// topic: written for this plugin; key: a key combination; shortcut: letters MathLive turns into a
	// symbol; section: a section of the docs.
	kind: "topic" | "key" | "shortcut" | "section";
	title: string;
	answer?: string;
	text?: string;
	keys?: string[];
	macKeys?: string[];
	typed?: string[];
	latex?: string;
	keywords?: string;
	commands?: string[];
	page?: string;
	// For keys and shortcuts: the docs section they are listed in.
	section?: string;
	url?: string;
	action?: string;
	actionText?: string;
	basic?: boolean;
}

const STOP_WORDS = new Set(
	"a an the to of in on at by with and or is are be it its this that i me my you your we our can could do does did how what which where when why way ways get got put make use using want need should would will there here into from some any type typing write writing insert add create enter".split(
		" "
	)
);

// Words people use for the same thing as the docs.
const SYNONYMS: Record<string, string[]> = {
	power: ["superscript", "exponent"],
	exponent: ["superscript", "power"],
	squar: ["power", "superscript", "sqrt"],
	cube: ["power", "root"],
	index: ["subscript"],
	lower: ["subscript"],
	divid: ["fraction"],
	division: ["fraction"],
	over: ["fraction"],
	ratio: ["fraction"],
	root: ["sqrt", "radical"],
	radical: ["sqrt", "root"],
	integrat: ["integral"],
	summation: ["sum"],
	sigma: ["sum"],
	colour: ["color"],
	equation: ["formula"],
	formula: ["equation"],
	multiply: ["times", "cdot"],
	multiplication: ["times", "cdot"],
	matric: ["matrix"],
	table: ["matrix", "array"],
	vector: ["vec", "arrow"],
	abs: ["absolute", "delimiter"],
	absolute: ["delimiter", "brackets"],
	parenthes: ["brackets", "delimiter"],
	bracket: ["delimiter", "parenthes"],
	keyboard: ["virtual", "keys"],
	shortcut: ["keybinding", "shortcuts"],
	hotkey: ["keybinding", "shortcut"],
	space: ["spacing", "text"],
	word: ["text"],
	newline: ["line", "multiple"],
	align: ["line", "aligned"],
	photo: ["scan", "image"],
	screenshot: ["scan", "image"],
	picture: ["scan", "image"],
	handwrit: ["draw"],
	handwriting: ["draw"],
	latex: ["code", "raw"],
	symbol: ["shortcut"],
	infinite: ["infinity"],
	unequal: ["not", "equal"],
	neq: ["not", "equal"],
	derivat: ["derivative", "differential", "partial"],
	differentiat: ["derivative", "differential"],
	arrow: ["to", "rightarrow"],
	piecewis: ["cases"],
	chemical: ["chemistry", "ce"],
};

function stem(word: string): string {
	if (word.length > 5 && word.endsWith("ing")) {
		return word.slice(0, -3);
	}
	if (word.length > 4 && word.endsWith("ies")) {
		return `${word.slice(0, -3)}y`;
	}
	// "matches", "boxes" lose "es"; "notes", "shapes" only "s".
	if (word.length > 4 && (/(s|x|z|ch|sh)es$/.test(word) || word.endsWith("ed"))) {
		return word.slice(0, -2);
	}
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
		return word.slice(0, -1);
	}
	return word;
}

// Words, with a LaTeX command also counted as its plain name: "\alpha" is "alpha".
function words(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
}

// Runs of symbols such as "->", ">=" or "+-", which are what some shortcuts are typed as.
function symbolRuns(text: string): string[] {
	return text.match(/[^\p{L}\p{N}\s]{2,}/gu) ?? [];
}

function editDistanceAtMost(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) {
		return false;
	}
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
			best = Math.min(best, current[j]);
		}
		if (best > max) {
			return false;
		}
		previous = current;
	}
	return previous[b.length] <= max;
}

interface Doc {
	entry: HelpEntry;
	terms: Map<string, number>;
	length: number;
	typed: Set<string>;
	title: string;
}

const KIND_BOOST: Record<HelpEntry["kind"], number> = { topic: 1.5, key: 1.1, shortcut: 1, section: 1 };
const K1 = 1.2;
const B = 0.75;

export class HelpIndex {
	private readonly docs: Doc[];
	private readonly df = new Map<string, number>();
	private readonly averageLength: number;
	private readonly vocabulary: string[];

	constructor(entries: HelpEntry[]) {
		this.docs = entries.map((entry) => {
			const terms = new Map<string, number>();
			const add = (text: string | undefined, weight: number) => {
				for (const word of words(text ?? "")) {
					terms.set(word, (terms.get(word) ?? 0) + weight);
				}
			};
			add(entry.title, 3);
			add(entry.keywords, 2);
			add((entry.typed ?? []).join(" "), 2);
			add(entry.answer ?? entry.text, 1);
			add((entry.commands ?? []).join(" "), 1);
			add(entry.page, 0.5);
			let length = 0;
			terms.forEach((weight) => (length += weight));
			const typed = new Set((entry.typed ?? []).concat(entry.keys ?? []).map((t) => t.toLowerCase()));
			return { entry, terms, length, typed, title: entry.title.toLowerCase() };
		});
		let total = 0;
		for (const doc of this.docs) {
			total += doc.length;
			doc.terms.forEach((_, term) => this.df.set(term, (this.df.get(term) ?? 0) + 1));
		}
		this.averageLength = total / Math.max(1, this.docs.length);
		this.vocabulary = [...this.df.keys()];
	}

	// The getting-started topics, in their written order.
	basics(): HelpEntry[] {
		return this.docs.filter((doc) => doc.entry.basic).map((doc) => doc.entry);
	}

	search(query: string, limit = 8): HelpEntry[] {
		const raw = query.trim().toLowerCase();
		if (!raw) {
			return [];
		}
		const queryWords = words(raw);
		// Single letters ("e to the x") are names of variables, not what is asked about.
		const content = queryWords.filter((word) => !STOP_WORDS.has(word) && (word.length > 1 || queryWords.length === 1));
		const terms = new Map<string, number>();
		const want = (term: string, weight: number) => terms.set(term, Math.max(terms.get(term) ?? 0, weight));
		for (const [i, word] of (content.length ? content : queryWords).entries()) {
			const last = i === content.length - 1 && !/\s$/.test(query);
			if (this.df.has(word)) {
				want(word, 1);
			} else {
				// A typo, or a word still being typed.
				for (const term of this.vocabulary) {
					if (last && word.length >= 2 && term.startsWith(word)) {
						want(term, 0.8);
					} else if (word.length >= 4 && editDistanceAtMost(word, term, word.length >= 8 ? 2 : 1)) {
						want(term, 0.7);
					}
				}
			}
			for (const [prefix, synonyms] of Object.entries(SYNONYMS)) {
				if (word.startsWith(prefix)) {
					synonyms.forEach((synonym) => want(stem(synonym), 0.5));
				}
			}
		}
		const symbols = symbolRuns(raw);

		const scored: { entry: HelpEntry; score: number }[] = [];
		for (const doc of this.docs) {
			let score = 0;
			let matched = 0;
			terms.forEach((weight, term) => {
				const tf = doc.terms.get(term);
				if (!tf) {
					return;
				}
				matched++;
				const idf = Math.log(1 + (this.docs.length - (this.df.get(term) ?? 0) + 0.5) / ((this.df.get(term) ?? 0) + 0.5));
				score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / this.averageLength)));
			});
			// Typed exactly what a shortcut is typed as: "->", "oo", "alpha".
			for (const symbol of symbols) {
				if (doc.typed.has(symbol)) {
					score += 6;
				}
			}
			if (doc.typed.has(raw)) {
				score += 4;
			}
			if (!score) {
				continue;
			}
			// Results that match more of what was asked come first.
			if (terms.size > 1) {
				score *= 0.6 + (0.4 * matched) / terms.size;
			}
			// The question is the topic's own title: "make a matrix", "undo a change".
			const phrase = raw.replace(/^(how (do|can) (i|you)|how to)\s+/, "").replace(/[?.!]+$/, "");
			if (phrase.includes(" ") && doc.title.includes(phrase)) {
				score *= 1.5;
			} else if (content.length > 1 && doc.title.includes(content.join(" "))) {
				score *= 1.3;
			}
			scored.push({ entry: doc.entry, score: score * KIND_BOOST[doc.entry.kind] });
		}
		scored.sort((a, b) => b.score - a.score);
		const top = scored[0]?.score ?? 0;
		const seen = new Set<string>();
		const results: HelpEntry[] = [];
		for (const { entry, score } of scored) {
			// Leave out the long tail far below the best answer.
			if (score < top * 0.25 || results.length >= limit) {
				break;
			}
			// "Pi", "pi" and "Insert pi" from different pages are one answer.
			const key = entry.title.toLowerCase().replace(/^insert /, "");
			if (!seen.has(key)) {
				seen.add(key);
				results.push(entry);
			}
		}
		return results;
	}
}

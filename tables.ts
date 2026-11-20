// The LaTeX for the tables that "Insert array…" and "Insert table" add to a formula. These
// functions have no Obsidian imports, so tests can run them in Node.

export type TableKind = "array" | "synthetic-division" | "tabular-integration";

export interface TableOptions {
	kind: TableKind;
	// Array: the size, the column format such as "c|rrr", and a line under the first row.
	rows: number;
	columns: number;
	columnFormat: string;
	headerLine: boolean;
	// Synthetic division: the degree of the dividend. A header row shows the powers of x.
	degree: number;
	powersHeader: boolean;
	// Tabular integration: the number of rows, and a column for the terms of the answer.
	steps: number;
	termColumn: boolean;
}

export const DEFAULT_TABLE_OPTIONS: TableOptions = {
	kind: "array",
	rows: 3,
	columns: 3,
	columnFormat: "ccc",
	headerLine: true,
	degree: 2,
	powersHeader: true,
	steps: 4,
	termColumn: true,
};

const PLACEHOLDER = "#?";

function placeholders(count: number): string[] {
	return Array.from({ length: count }, () => PLACEHOLDER);
}

function row(cells: string[]): string {
	return cells.join(" & ");
}

// linesBelow holds the indexes of the rows that get a line under them.
function table(columnFormat: string, rows: string[], linesBelow: Set<number>): string {
	const body = rows.map((line, i) => (i > 0 && linesBelow.has(i - 1) ? `\\hline ${line}` : line));
	return `\\begin{array}{${columnFormat}}${body.join("\\\\ ")}\\end{array}`;
}

// The LaTeX for a table. #? marks a placeholder that MathLive selects with Tab.
export function tableLatex(options: TableOptions): string {
	switch (options.kind) {
		case "array": {
			const rows = Array.from({ length: options.rows }, () => row(placeholders(options.columns)));
			return table(options.columnFormat, rows, new Set(options.headerLine ? [0] : []));
		}
		case "synthetic-division": {
			// The divisor's root, then one column for each coefficient. The line is above the result.
			const n = options.degree + 1;
			const rows: string[] = [];
			if (options.powersHeader) {
				const powers = Array.from({ length: n }, (_, i) => `x^{${options.degree - i}}`);
				rows.push(row(["", ...powers]));
			}
			rows.push(row([PLACEHOLDER, ...placeholders(n)]));
			rows.push(row(["", "\\downarrow", ...placeholders(n - 1)]));
			rows.push(row(["", ...placeholders(n)]));
			return table(`c|${"r".repeat(n)}`, rows, new Set([rows.length - 2]));
		}
		case "tabular-integration": {
			// The DI method: a sign, u and its derivatives (D), dv and its integrals (I), and the term.
			const header = ["", "D", "I", ...(options.termColumn ? ["\\text{term}"] : [])];
			const rows = [row(header)];
			for (let i = 0; i < options.steps; i++) {
				rows.push(row([i % 2 === 0 ? "+" : "-", PLACEHOLDER, PLACEHOLDER, ...(options.termColumn ? [PLACEHOLDER] : [])]));
			}
			return table(options.termColumn ? "c|c|c|c" : "c|c|c", rows, new Set([0]));
		}
	}
}

// The column format of a new array: every column centered.
export function defaultColumnFormat(columns: number): string {
	return "c".repeat(columns);
}

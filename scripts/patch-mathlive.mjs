// Adds \hline to the arrays and to \displaylines in the bundled MathLive library.
//
// MathLive 0.111 has no \hline (https://github.com/arnog/mathlive/issues/1151). It shows the
// command as an unknown red command in the next cell. This script patches
// node_modules/mathlive/mathlive.mjs, the file that webpack bundles in development mode.
//
// An ArrayAtom keeps `hlines`: hlines[b] is the number of lines on row boundary b.
// Boundary 0 is above the first row. Boundary rowCount is under the last row.
//
// The patch also does these things:
// - It adds the toggleHlineAbove and toggleHlineBelow commands.
// - It turns \hline typed or pasted into a table cell into a line above the cell's row.
//
// Every patch must match exactly once. When a MathLive update changes the code, the script stops
// with an error. It does not build a plugin without \hline.
//
// The script runs from "postinstall" and is safe to run again.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../node_modules/mathlive/mathlive.mjs", import.meta.url));
const MARKER = "/* obsidian-mathlive: hline patch */";

const patches = [
	{
		name: "ArrayAtom keeps hlines",
		find: `    this.rowGaps = rowGaps;
    if (options.arraycolsep !== void 0)`,
		replace: `    this.rowGaps = rowGaps;
    this.hlines = options.hlines ? [...options.hlines] : [];
    if (options.arraycolsep !== void 0)`,
	},
	{
		name: "toJson writes hlines",
		find: `    if (this.arraystretch !== void 0)
      result.arraystretch = this.arraystretch;
    if (this.arraycolsep !== void 0) result.arraycolsep = this.arraycolsep;`,
		replace: `    if (this.arraystretch !== void 0)
      result.arraystretch = this.arraystretch;
    if (this.hlines.some(Boolean)) result.hlines = [...this.hlines];
    if (this.arraycolsep !== void 0) result.arraycolsep = this.arraycolsep;`,
	},
	{
		name: "render draws hlines",
		find: `    const inner = new Box(cols, {
      classes: ["ML__mtable", ...this.classes].join(" ")
    });`,
		replace: `    if (this.hlines.some(Boolean)) {
      for (let b = 0; b <= nr; b++) {
        const count = this.hlines[b] ?? 0;
        if (count === 0) continue;
        const y = b === 0 ? body[0].pos - body[0].height - offset : body[b - 1].pos + body[b - 1].depth - offset;
        for (let k = 0; k < count; k++) {
          // The table's top edge is "offset" above the baseline. The line is absolute in the table,
          // so it does not use vertical-align: the \\displaylines table is a flex box, and a flex box
          // ignores vertical-align. Left and right 0 make the line span the whole table.
          const rule = new Box(null, { classes: "ML__hline" });
          rule.setStyle("position", "absolute");
          rule.setStyle("left", "0");
          rule.setStyle("right", "0");
          rule.setStyle("top", y + offset + k * (doubleRuleSep + arrayRuleWidth), "em");
          rule.setStyle("border-top", \`\${arrayRuleWidth}em solid currentColor\`);
          cols.push(rule);
        }
      }
    }
    const inner = new Box(cols, {
      classes: ["ML__mtable", ...this.classes].join(" ")
    });
    if (this.hlines.some(Boolean)) inner.setStyle("position", "relative");`,
	},
	{
		name: "serialize writes hlines",
		find: `    if (this.environmentName === "lines" && this._rows.length > 1)
      result.push(\`\\\\displaylines{\`);`,
		replace: `    // One line with a rule under it still needs \\displaylines{…}.
    const wrapLines = this.environmentName === "lines" && (this._rows.length > 1 || this.hlines.some(Boolean));
    if (wrapLines)
      result.push(\`\\\\displaylines{\`);`,
	},
	{
		name: "serialize closes \\displaylines with hlines",
		find: `    if (this.environmentName === "lines" && this._rows.length > 1)
      result.push(\`}\`);`,
		replace: `    if (wrapLines)
      result.push(\`}\`);`,
	},
	{
		name: "serialize writes hlines in the rows",
		find: `    for (let row = 0; row < this._rows.length; row++) {
      for (let col = 0; col < this._rows[row].length; col++) {
        if (col > 0) result.push(" & ");
        result.push(Atom.serialize(this._rows[row][col], options));
      }
      if (row < this._rows.length - 1) {
        const gap = this.rowGaps[row];
        if (gap == null ? void 0 : gap.dimension)
          result.push(\`\\\\\\\\[\${gap.dimension} \${(_a3 = gap.unit) != null ? _a3 : "pt"}] \`);
        else result.push("\\\\\\\\ ");
      }
    }`,
		replace: `    const pushHlines = (b) => {
      for (let k = 0; k < (this.hlines[b] ?? 0); k++) result.push("\\\\hline");
    };
    pushHlines(0);
    for (let row = 0; row < this._rows.length; row++) {
      for (let col = 0; col < this._rows[row].length; col++) {
        if (col > 0) result.push(" & ");
        result.push(Atom.serialize(this._rows[row][col], options));
      }
      if (row < this._rows.length - 1) {
        const gap = this.rowGaps[row];
        if (gap == null ? void 0 : gap.dimension)
          result.push(\`\\\\\\\\[\${gap.dimension} \${(_a3 = gap.unit) != null ? _a3 : "pt"}] \`);
        else result.push("\\\\\\\\ ");
        pushHlines(row + 1);
      } else if (this.hlines[row + 1]) {
        result.push("\\\\\\\\ ");
        pushHlines(row + 1);
      }
    }`,
	},
	{
		name: "addRowBefore keeps lines next to their row",
		find: `  addRowBefore(row) {
    console.assert(this.type === "array" && Array.isArray(this._rows));
    this._rows.splice(`,
		replace: `  /** Gives hlines one entry for each row boundary. */
  normalizeHlines() {
    this.hlines = Array.from({ length: this.rowCount + 1 }, (_, b) => this.hlines[b] ?? 0);
  }
  toggleHline(boundary) {
    this.normalizeHlines();
    this.hlines[boundary] = this.hlines[boundary] ? 0 : 1;
    this.isDirty = true;
  }
  addRowBefore(row) {
    console.assert(this.type === "array" && Array.isArray(this._rows));
    this.normalizeHlines();
    this.hlines.splice(row, 0, 0);
    this._rows.splice(`,
	},
	{
		name: "addRowAfter keeps lines next to their row",
		find: `  addRowAfter(row) {
    console.assert(this.type === "array" && Array.isArray(this._rows));
    this._rows.splice(`,
		replace: `  addRowAfter(row) {
    console.assert(this.type === "array" && Array.isArray(this._rows));
    this.normalizeHlines();
    this.hlines.splice(row + 2, 0, 0);
    this._rows.splice(`,
	},
	{
		name: "removeRow merges the lines around the row",
		find: `    const deleted = this._rows.splice(row, 1);`,
		replace: `    this.normalizeHlines();
    this.hlines.splice(row, 2, Math.max(this.hlines[row], this.hlines[row + 1]));
    const deleted = this._rows.splice(row, 1);`,
	},
	{
		name: "parser reads hlines at the start of the body",
		find: `    const array = [];
    const rowGaps = [];
    let row = [];
    let done = false;
    do {`,
		replace: `    const array = [];
    const rowGaps = [];
    const hlines = [];
    const scanHlines = () => {
      this.skipWhitespace();
      while (this.match("\\\\hline")) {
        hlines[array.length] = (hlines[array.length] ?? 0) + 1;
        this.skipWhitespace();
      }
    };
    let row = [];
    let done = false;
    scanHlines();
    do {`,
	},
	{
		name: "parser reads hlines after a row separator",
		find: `          rowGaps.push(gap != null ? gap : { dimension: 0 });
          array.push(row);
          row = [];`,
		replace: `          rowGaps.push(gap != null ? gap : { dimension: 0 });
          array.push(row);
          row = [];
          scanHlines();`,
	},
	{
		name: "parser attaches hlines to the array",
		find: `    row.push(this.mathlist);
    if (row.length > 0) array.push(row);
    this.endContext();
    if (def.rootOnly) this.index = this.tokens.length;
    return def.createAtom(
      envName,
      array,
      rowGaps,
      args,
      this.context.maxMatrixCols
    );`,
		replace: `    row.push(this.mathlist);
    if (row.length > 0) array.push(row);
    // In "\\\\\\\\ \\\\hline \\\\end{array}", LaTeX draws the line under the last row. It adds no empty row.
    const lastRow = array.length - 1;
    if (lastRow > 0 && hlines[lastRow] && array[lastRow].length === 1 && array[lastRow][0].length === 0)
      array.pop();
    this.endContext();
    if (def.rootOnly) this.index = this.tokens.length;
    const arrayAtom = def.createAtom(
      envName,
      array,
      rowGaps,
      args,
      this.context.maxMatrixCols
    );
    if (hlines.length > 0 && arrayAtom instanceof ArrayAtom) {
      arrayAtom.hlines = Array.from({ length: arrayAtom.rowCount + 1 }, (_, b) => hlines[b] ?? 0);
    }
    return arrayAtom;`,
	},
	{
		name: "\\displaylines parser reads hlines",
		find: `    if (parser.mathlist.length > 0) lines.push([parser.mathlist]);
    parser.beginContext({ tabular: true, root: true });
    do {
      if (parser.end() || parser.match("<}>")) break;
      if (parser.matchColumnSeparator() || parser.matchRowSeparator()) {
        lines.push([line]);
        line = [];
      } else {`,
		replace: `    if (parser.mathlist.length > 0) lines.push([parser.mathlist]);
    parser.beginContext({ tabular: true, root: true });
    const hlines = [];
    const scanHlines = () => {
      parser.skipWhitespace();
      while (parser.match("\\\\hline")) {
        hlines[lines.length] = (hlines[lines.length] ?? 0) + 1;
        parser.skipWhitespace();
      }
    };
    scanHlines();
    do {
      if (parser.end() || parser.match("<}>")) break;
      if (parser.matchColumnSeparator() || parser.matchRowSeparator()) {
        lines.push([line]);
        line = [];
        scanHlines();
      } else {`,
	},
	{
		name: "\\displaylines parser attaches hlines",
		find: `    parser.endContext();
    lines.push([line]);
    const rhs = parser.scan();
    if (rhs.length > 0) lines.push([rhs]);
    return lines;`,
		replace: `    parser.endContext();
    lines.push([line]);
    // In "\\\\\\\\ \\\\hline}", LaTeX draws the line under the last line. It adds no empty line.
    const lastLine = lines.length - 1;
    if (lastLine > 0 && hlines[lastLine] && lines[lastLine][0].length === 0) lines.pop();
    const rhs = parser.scan();
    if (rhs.length > 0) lines.push([rhs]);
    // createAtom gets this array as options.args.
    lines.hlines = Array.from({ length: lines.length + 1 }, (_, b) => hlines[b] ?? 0);
    return lines;`,
	},
	{
		name: "\\displaylines atom keeps hlines",
		find: `  createAtom: (options) => new ArrayAtom("lines", options.args, [], {
    // arraystretch: 1.2,`,
		replace: `  createAtom: (options) => new ArrayAtom("lines", options.args, [], {
    hlines: options.args.hlines,
    // arraystretch: 1.2,`,
	},
	{
		name: "toggleHlineAbove and toggleHlineBelow commands",
		find: `function placeholderCell() {`,
		replace: `// The innermost table cell around the caret, as [table, row]. A \\displaylines line is a row too.
function tableRowAtCaret(model) {
  let atom = model.at(model.position);
  while (atom && !(atom.parent instanceof ArrayAtom && isCellBranch(atom.parentBranch)))
    atom = atom.parent;
  return atom ? [atom.parent, atom.parentBranch[0]] : null;
}
// Typed or pasted \\hline in a table cell: a line above the cell's row. Outside a table it does nothing.
function insertHlineAtCaret(model) {
  const found = tableRowAtCaret(model);
  if (!found) return false;
  const [array, row] = found;
  array.normalizeHlines();
  if (array.hlines[row]) return true;
  if (!model.contentWillChange({ data: "\\\\hline", inputType: "insertText" })) return true;
  array.toggleHline(row);
  model.contentDidChange({ data: "\\\\hline", inputType: "insertText" });
  return true;
}
function toggleHline(model, side) {
  const found = tableRowAtCaret(model);
  if (!found) {
    model.announce("plonk");
    return false;
  }
  if (!model.contentWillChange({ inputType: "insertText" })) return false;
  const [array, row] = found;
  array.toggleHline(side === "above" ? row : row + 1);
  // Only commands that start with "add" or "delete" get an undo snapshot from MathLive.
  model.mathfield.snapshot();
  model.contentDidChange({ inputType: "insertText" });
  return true;
}
register2(
  {
    toggleHlineAbove: (model) => toggleHline(model, "above"),
    toggleHlineBelow: (model) => toggleHline(model, "below")
  },
  {
    target: "model",
    canUndo: true,
    changeContent: true,
    changeSelection: true
  }
);
function placeholderCell() {`,
	},
	{
		name: "typed or pasted \\hline adds a line",
		find: `  insert(model, input, options) {
    var _a3, _b3, _c2, _d2;
    const data = typeof input === "string" ? input :`,
		replace: `  insert(model, input, options) {
    var _a3, _b3, _c2, _d2;
    if (typeof input === "string" && input.trim() === "\\\\hline" && insertHlineAtCaret(model)) return true;
    const data = typeof input === "string" ? input :`,
	},
];

let source = readFileSync(target, "utf8");
if (source.includes(MARKER)) {
	console.log("patch-mathlive: already patched");
	process.exit(0);
}

for (const { name, find, replace } of patches) {
	const count = source.split(find).length - 1;
	if (count !== 1) {
		console.error(`patch-mathlive: "${name}" matched ${count} times, not 1. MathLive changed. Update scripts/patch-mathlive.mjs.`);
		process.exit(1);
	}
	source = source.replace(find, () => replace);
}

writeFileSync(target, `${MARKER}\n${source}`);
console.log(`patch-mathlive: applied ${patches.length} patches`);

// Checks mathjax-latex.ts against the MathJax that Obsidian draws formulas with: every command it
// replaces is one MathJax doesn't know, and every replacement draws.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.mjs";

const SOURCE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../mathjax-latex.ts"), "utf8");
const REPLACEMENTS = [...SOURCE.matchAll(/^\t(\w+): ("(?:[^"\\]|\\.)*"),$/gm)].map(([, name, value]) => [name, JSON.parse(value)]);

// What to draw each command in. Most are followed by an argument, which a symbol ignores.
const sample = (command, name) => {
	if (name === "mleft" || name === "mright") {
		return command === `\\${name}` ? "\\mleft( x \\mright)" : "\\left( x \\right)";
	}
	if (name === "displaylimits") {
		return `\\sum${command}_{a}^{b}`;
	}
	return `${command}{x}`;
};

test("Obsidian's MathJax can't draw the commands that are replaced, and draws their replacements", async ({ page }) => {
	expect(REPLACEMENTS.length).toBeGreaterThan(50);
	// Obsidian loads MathJax when a note shows a formula.
	await page.evaluate(() => {
		window.app.plugins.plugins.mathlive.settings.editOnlyAtCursor = true;
		window.app.workspace.activeEditor.editor.setCursor({ line: 0, ch: 0 });
		return true;
	});
	await expect.poll(() => page.evaluate(() => typeof window.MathJax?.tex2chtml)).toBe("function");

	const results = await page.evaluate((samples) => {
		// MathJax draws an unknown command in red, and other mistakes as an error.
		const draws = (latex) => {
			const node = window.MathJax.tex2chtml(latex);
			const unknown = [...node.querySelectorAll("mjx-mtext")].some((element) => (element.getAttribute("style") ?? "").includes("red"));
			return !unknown && !node.querySelector("mjx-merror");
		};
		return samples.map(({ name, original, replaced }) => ({ name, original: draws(original), replaced: draws(replaced) }));
	}, REPLACEMENTS.map(([name, value]) => ({ name, original: sample(`\\${name}`, name), replaced: sample(value, name) })));

	expect(results.filter((result) => result.original).map((result) => result.name), "MathJax already draws these").toEqual([]);
	expect(results.filter((result) => !result.replaced).map((result) => result.name), "MathJax can't draw these replacements").toEqual([]);
});

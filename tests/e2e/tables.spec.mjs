// The table items in a formula's menu: "Insert array…", "Insert table", and the items that add or
// remove a line at the caret's row.
import { blockField, drawnLines, expect, focusField, noteText, setBlockFormula, test } from "./fixtures.mjs";

// MathLive's own menu, which opens on a right-click in a formula.
async function openFormulaMenu(page, field) {
	await field.click({ button: "right" });
	await expect(page.locator(".ui-menu-container").first()).toBeVisible();
}

const formulaMenuItem = (page, label) => page.locator(".ui-menu-container [part='menu-item']", { hasText: label });

const tableModal = (page) => page.locator(".mathlive-table-modal");

test.describe("table items in the formula menu", () => {
	test("Insert array… puts an array with a header line in the formula", async ({ page }) => {
		await setBlockFormula(page, "x");
		const field = blockField(page);
		await focusField(field);
		await page.keyboard.press("End");
		await openFormulaMenu(page, field);
		await formulaMenuItem(page, "Insert array…").click();

		const modal = tableModal(page);
		await expect(modal).toBeVisible();
		// The preview draws the array with MathJax.
		await expect(modal.locator(".mathlive-table-preview mjx-container")).toBeVisible();
		await modal.locator(".setting-item", { hasText: "Column format" }).locator("input").fill("c|cc");
		await modal.getByRole("button", { name: "Insert" }).click();
		await expect(modal).toBeHidden();

		await expect.poll(() => drawnLines(field)).toBe(1);
		await expect.poll(() => noteText(page)).toMatch(/x\\begin\{array\}\{c\|cc\}.*\\\\ \\hline/);
	});

	test("Insert table has synthetic division and tabular integration by parts", async ({ page }) => {
		await setBlockFormula(page, "x");
		const field = blockField(page);
		await focusField(field);
		await page.keyboard.press("End");
		await openFormulaMenu(page, field);
		await formulaMenuItem(page, "Insert table").hover();
		await formulaMenuItem(page, "Synthetic division…").click();

		const modal = tableModal(page);
		await expect(modal).toBeVisible();
		await modal.getByRole("button", { name: "Insert" }).click();
		await expect.poll(() => noteText(page)).toContain("\\begin{array}{c|rrr} & x^2 & x^1 & x^0");
		expect(await noteText(page)).toContain("\\downarrow");
		await expect.poll(() => drawnLines(field)).toBe(1);

		await focusField(field);
		await openFormulaMenu(page, field);
		await formulaMenuItem(page, "Insert table").hover();
		await formulaMenuItem(page, "Tabular integration by parts…").click();
		await expect(modal).toBeVisible();
		await modal.getByRole("button", { name: "Insert" }).click();
		await expect.poll(() => noteText(page)).toContain("\\begin{array}{c|c|c|c} & D & I & \\text{term}");
	});

	test("Line below this row adds a line, and undo removes it", async ({ page }) => {
		await setBlockFormula(page, String.raw`\begin{array}{cc}a & b\\ c & d\end{array}`);
		const field = blockField(page);
		await focusField(field);
		await field.evaluate((element) => {
			element.position = 1;
			return true;
		});
		await openFormulaMenu(page, field);
		await formulaMenuItem(page, "Line below this row").click();
		await expect.poll(() => drawnLines(field)).toBe(1);
		await expect.poll(() => noteText(page)).toContain("a & b\\\\ \\hline c & d");

		await focusField(field);
		await page.keyboard.press("Control+z");
		await expect.poll(() => drawnLines(field)).toBe(0);
		await expect.poll(() => noteText(page)).not.toContain("\\hline");
	});

	test("the line items show only inside a table", async ({ page }) => {
		await setBlockFormula(page, "x+y");
		const field = blockField(page);
		await focusField(field);
		await openFormulaMenu(page, field);
		await expect(formulaMenuItem(page, "Insert array…")).toBeVisible();
		await expect(formulaMenuItem(page, "Line below this row")).toHaveCount(0);
		await expect(formulaMenuItem(page, "Line above this row")).toHaveCount(0);
	});
});

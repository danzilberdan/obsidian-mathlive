// \hline in tables. MathLive has no \hline, so scripts/patch-mathlive.mjs adds it to the library.
import { blockField, drawnLines, expect, focusField, linePositions, noteText, setBlockFormula, test, unknownCommands } from "./fixtures.mjs";

const SYNTHETIC_DIVISION = String.raw`\begin{array}{c|rrr} & x^1 & x^0\\ {\textcolor{red}{-6}} & 15 & 4\\  & \downarrow & -10\\ \hline & 15 & {\textcolor{blue}{-90}}\end{array}`;
const TWO_BY_TWO = String.raw`\begin{array}{cc}a & b\\ c & d\end{array}`;

// Puts the caret at the start of the cell that holds the letter, then runs a command there.
// Both happen in one step, so a redrawn formula can't move the caret in between.
const atCellOf = (field, letter, command) =>
	field.evaluate(
		(element, { letter, command }) => {
			for (let offset = 0; offset <= element.lastOffset; offset += 1) {
				if (element.getValue(offset, offset + 1) === letter) {
					element.position = offset;
					if (command) {
						element.executeCommand(command);
					}
					return true;
				}
			}
			return false;
		},
		{ letter, command }
	);

test.describe("\\hline in tables", () => {
	test("a formula with \\hline draws the line and keeps it in the note", async ({ page }) => {
		await setBlockFormula(page, SYNTHETIC_DIVISION);
		const field = blockField(page);
		await expect.poll(() => drawnLines(field)).toBe(1);
		// The line is between row 3 and row 4 of 4.
		const [position] = await linePositions(field);
		expect(position).toBeGreaterThan(0.6);
		expect(position).toBeLessThan(0.9);
		expect(await unknownCommands(field)).toBe(0);

		// An edit somewhere else in the formula writes the line back.
		await focusField(field);
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect.poll(() => noteText(page)).toContain("+1");
		expect(await noteText(page)).toContain("\\\\ \\hline & 15");
	});

	test("lines above the first row and under the last row stay in place", async ({ page }) => {
		const latex = String.raw`\begin{array}{cc}\hline a & b\\ c & d\\ \hline\hline\end{array}`;
		await setBlockFormula(page, latex);
		const field = blockField(page);
		await expect.poll(() => drawnLines(field)).toBe(3);
		const [top, bottom, bottomSecond] = await linePositions(field);
		expect(top).toBeLessThan(0.05);
		expect(bottom).toBeGreaterThan(0.9);
		expect(bottomSecond).toBeGreaterThan(bottom);
		await expect(field).toHaveJSProperty("value", `\n${latex}\n`);
	});

	test("typing \\hline in a row adds a line above the row", async ({ page }) => {
		await setBlockFormula(page, TWO_BY_TWO);
		const field = blockField(page);
		await focusField(field);
		expect(await atCellOf(field, "c")).toBe(true);
		await page.keyboard.type("\\hline", { delay: 40 });
		await page.keyboard.press("Enter");
		await expect.poll(() => drawnLines(field)).toBe(1);
		expect(await unknownCommands(field)).toBe(0);
		await expect.poll(async () => (await linePositions(field))[0]).toBeGreaterThan(0.3);
		expect((await linePositions(field))[0]).toBeLessThan(0.7);
		// Enter ends the command. It doesn't also add a row.
		await expect.poll(() => noteText(page)).toContain("a & b\\\\ \\hline c & d\\end{array}");
	});

	test("toggleHlineBelow adds and removes a line, with undo", async ({ page }) => {
		await setBlockFormula(page, TWO_BY_TWO);
		const field = blockField(page);
		await focusField(field);
		expect(await atCellOf(field, "a", "toggleHlineBelow")).toBe(true);
		await expect.poll(() => drawnLines(field)).toBe(1);
		await expect.poll(() => noteText(page)).toContain("a & b\\\\ \\hline c & d");

		await page.keyboard.press("Control+z");
		await expect.poll(() => drawnLines(field)).toBe(0);
		await expect.poll(() => noteText(page)).not.toContain("\\hline");
	});

	test("\\hline in \\displaylines draws a line under the lines", async ({ page }) => {
		// The form that notes use to put a line under a worked problem.
		const latex = String.raw`\displaylines{R=1\\ \\ \hline}`;
		await setBlockFormula(page, latex);
		const field = blockField(page);
		await expect.poll(() => drawnLines(field)).toBe(1);
		// The line is under the last line, not at the top.
		expect((await linePositions(field))[0]).toBeGreaterThan(0.9);
		expect(await unknownCommands(field)).toBe(0);
		expect(await field.evaluate((element) => element.value.trim())).toBe(latex);

		await focusField(field);
		expect(await atCellOf(field, "R")).toBe(true);
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect.poll(() => noteText(page)).toContain("+1");
		expect(await noteText(page)).toContain("\\\\ \\hline}$$");
	});

	test("typing \\hline in a \\displaylines line adds a line above it", async ({ page }) => {
		await setBlockFormula(page, String.raw`\displaylines{a\\ b}`);
		const field = blockField(page);
		await focusField(field);
		expect(await atCellOf(field, "b")).toBe(true);
		await page.keyboard.type("\\hline", { delay: 40 });
		await page.keyboard.press("Enter");
		await expect.poll(() => drawnLines(field)).toBe(1);
		expect(await unknownCommands(field)).toBe(0);
		await expect.poll(async () => (await linePositions(field))[0]).toBeGreaterThan(0.3);
		expect((await linePositions(field))[0]).toBeLessThan(0.7);
		await expect.poll(() => noteText(page)).toContain("\\displaylines{a\\\\ \\hline b}");
	});

	test("a new row keeps the line next to the row the caret is in", async ({ page }) => {
		await setBlockFormula(page, String.raw`\begin{array}{cc}a & b\\ \hline c & d\end{array}`);
		const field = blockField(page);
		await focusField(field);
		expect(await atCellOf(field, "a", "addRowAfter")).toBe(true);
		// The new row goes under the line, and the line stays under the first row.
		await expect.poll(() => noteText(page)).toContain("a & b\\\\ \\hline{} & {}\\\\ c & d");
	});
});

import { expect, modalField, noteLine, noteText, runCommand, test, waitForModalField } from "./fixtures.mjs";

const selectInLine = (page, prefix, from, to) =>
	page.evaluate(
		({ prefix, from, to }) => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith(prefix));
			const text = editor.getLine(line);
			const start = from === undefined ? text.indexOf("$") : from;
			const end = to === undefined ? text.lastIndexOf("$") + 1 : to;
			editor.setSelection({ line, ch: start }, { line, ch: end });
			return true;
		},
		{ prefix, from, to }
	);

test.describe("formula editor window", () => {
	test("edits a selected inline formula", async ({ page }) => {
		await selectInLine(page, "Last line");
		await runCommand(page, "mathlive:open-modal-inline");

		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit inline math");
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha + \\beta");
		await waitForModalField(page);

		await page.keyboard.press("End");
		await page.keyboard.type("+y", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha+\\beta+y");
		await page.keyboard.press("Control+Enter");

		await expect(modalField(page)).toHaveCount(0);
		const line = "Last line $\\alpha+\\beta+y$ done.";
		expect(await noteLine(page, "Last line")).toBe(line);
	});

	test("opens on the formula around the cursor when nothing is selected", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("\\int"));
			editor.setCursor({ line, ch: 3 });
			return true;
		});
		await runCommand(page, "mathlive:open-modal");
		await expect(modalField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
	});

	test("Escape closes the window and keeps the formula", async ({ page }) => {
		const before = await noteText(page);
		await selectInLine(page, "Inline math");
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.keyboard.press("Escape");
		await expect(modalField(page)).toHaveCount(0);
		expect(await noteText(page)).toBe(before);
	});

	test("inserts a new block formula with the Insert button", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setCursor({ line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
			editor.replaceSelection("\n\n");
			return true;
		});
		await runCommand(page, "mathlive:open-modal");
		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit math block");
		await expect(modalField(page)).toHaveJSProperty("defaultMode", "math");
		await waitForModalField(page);
		await page.keyboard.type("a/b", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\frac{a}{b}");
		await page.locator(".mathlive-modal-root button.submit").click();

		await expect(modalField(page)).toHaveCount(0);
		const lines = (await noteText(page)).split("\n");
		expect(lines.at(-1)).toBe("$$\\frac{a}{b}$$");
	});

	test("inserts inline math wrapped in single dollar signs", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Plain paragraph"));
			editor.setCursor({ line, ch: editor.getLine(line).length });
			editor.replaceSelection(" ");
			return true;
		});
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.keyboard.type("e^x", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "e^{x}");
		await page.keyboard.press("Control+Enter");
		await expect(modalField(page)).toHaveCount(0);
		expect(await noteLine(page, "Plain paragraph")).toBe("Plain paragraph between formulas. $e^{x}$");
	});

	test("the window's More options menu opens and closes", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		const header = page.locator(".mathlive-modal-header");
		const dropdown = header.locator(".mathlive-modal-menu-dropdown");
		await header.locator(".mathlive-modal-menu-trigger").click();
		await expect(dropdown).not.toHaveClass(/--hidden/);
		await expect(dropdown.getByRole("link", { name: "Made by Dan Zilberman" })).toBeVisible();
		await page.locator(".mathlive-modal-title").click();
		await expect(dropdown).toHaveClass(/--hidden/);
	});
});

import { blockField, expect, focusField, menuItem, modalField, noteLine, noteText, runCommand, test, waitForModalField } from "./fixtures.mjs";

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

	test("the window's ⋮ menu sits by the close button and opens Obsidian's menu", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const trigger = page.locator(".mathlive-modal-root .mathlive-modal-menu-trigger");
		const close = page.locator(".mathlive-modal-root .modal-close-button, .mathlive-modal-root .modal > .modal-header-button");
		const triggerBox = await trigger.boundingBox();
		const closeBox = await close.first().boundingBox();
		// Same row as the close button, just to its left, without overlapping it.
		expect(Math.abs(triggerBox.y - closeBox.y)).toBeLessThanOrEqual(2);
		expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(closeBox.x);

		await trigger.click();
		await expect(menuItem(page, "Made by Dan Zilberman")).toBeVisible();
		await expect(menuItem(page, "Connect to scan images")).toBeVisible();
		// A click elsewhere in the window closes the menu and leaves the window open.
		await page.locator(".mathlive-modal-title").click();
		await expect(page.locator(".menu")).toHaveCount(0);
		await expect(modalField(page)).toBeVisible();
	});

	test("the window's buttons sit on one row under the formula", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const scan = await page.locator(".mathlive-modal-root .scan-button").boundingBox();
		const insert = await page.locator(".mathlive-modal-root button.submit").boundingBox();
		const field = await modalField(page).boundingBox();
		expect(Math.abs(scan.y - insert.y)).toBeLessThanOrEqual(2);
		expect(scan.y).toBeGreaterThan(field.y + field.height);
		await expect(page.locator(".mathlive-modal-root button.submit")).toContainText("Insert into note");
	});

	test("the virtual keyboard opens inside the window", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		await modalField(page).locator("[part=virtual-keyboard-toggle]").click();
		// The plugin hosts the keyboard inside the window so it stays above Obsidian's overlay.
		await expect(page.locator(".mathlive-modal-root .virt-keyboard .ML__keyboard")).toBeVisible();
		await page.keyboard.type("7");
		await expect(modalField(page)).toHaveJSProperty("value", "7");
	});

	test("MathLive's own menu opens from a block formula in the note", async ({ page }) => {
		const field = blockField(page);
		// The plugin moves focus into a clicked formula a moment later, which would take it from the menu.
		await focusField(field);
		await field.locator("[part=menu-toggle]").click();
		await expect(page.getByText("Insert Matrix")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByText("Insert Matrix")).toBeHidden();
	});
});

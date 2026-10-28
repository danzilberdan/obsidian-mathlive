import { blockField, expect, focusField, menuItem, modalField, noteLine, noteText, openedUrls, recordOpenedUrls, runCommand, setSettings, test, waitForModalField } from "./fixtures.mjs";

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

	test("the window shows the scans left with a way to get more, and opens the guide", async ({ page, scanner: _scanner }) => {
		await recordOpenedUrls(page);
		await setSettings(page, { cloudScannerUrl: "http://127.0.0.1:8502", websiteUrl: "http://127.0.0.1:8502/site" });
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const footer = page.locator(".mathlive-modal-root .mathlive-modal-footer");
		await expect(footer.locator(".mathlive-modal-plan")).toHaveText("First scans free, no account neededGet 10 free scans");

		await setSettings(page, { apiKey: "low-key", apiKeySource: "device" });
		await page.keyboard.press("Escape");
		await page.evaluate(() => window.app.plugins.plugins.mathlive.account.refreshStatus());
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		await expect(footer.locator(".mathlive-modal-plan")).toHaveText("2 free scans leftUpgrade");
		await footer.getByText("Upgrade").click();
		await expect.poll(() => openedUrls(page)).toEqual(["http://127.0.0.1:8502/site/pricing"]);

		await footer.getByText("Learn what MathLive can do").click();
		await expect(page.locator(".mathlive-guide-modal")).toBeVisible();
		await expect(page.locator(".mathlive-guide-modal")).toContainText("2 free scans left.");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});

	test("the window's buttons sit on one row under the formula", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const scan = await page.locator(".mathlive-modal-root .scan-button").boundingBox();
		const insert = await page.locator(".mathlive-modal-root button.submit").boundingBox();
		const field = await modalField(page).boundingBox();
		expect(Math.abs(scan.y - insert.y)).toBeLessThanOrEqual(2);
		expect(scan.y).toBeGreaterThan(field.y + field.height);
		await expect(page.locator(".mathlive-modal-root button.submit")).toHaveText(/^Insert(Ctrl\+Enter|⌘ Enter)$/);
	});

	test("the scan buttons are small icons named by their tooltips", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const actions = page.locator(".mathlive-modal-root .mathlive-scan-actions");
		await expect(actions).toHaveText("");
		for (const name of ["Scan clipboard image", "Scan from screen"]) {
			const button = actions.getByRole("button", { name });
			const box = await button.boundingBox();
			expect(box.width).toBeLessThanOrEqual(34);
			expect(box.height).toBeLessThanOrEqual(34);
			await button.hover();
			await expect(page.locator(".tooltip")).toHaveText(name);
			await page.mouse.move(5, 5);
		}
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

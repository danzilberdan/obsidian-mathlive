import { modalAiAction, blockField, expect, focusField, inlineField, menuItem, modalField, noteLine, noteText, openedUrls, recordOpenedUrls, runCommand, setSettings, test, waitForModalField } from "./fixtures.mjs";

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
		await expect.poll(() => openedUrls(page)).toEqual(["http://127.0.0.1:8502/site/pricing?src=plugin_editor"]);

		await footer.getByText("Learn what MathLive can do").click();
		await expect(page.locator(".mathlive-guide-modal")).toBeVisible();
		await expect(page.locator(".mathlive-guide-modal")).toContainText("2 free scans left.");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});

	test("the window's buttons sit on one row under the formula", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const ai = await page.locator(".mathlive-modal-root .mathlive-ai-fill-button").boundingBox();
		const insert = await page.locator(".mathlive-modal-root button.submit").boundingBox();
		const field = await modalField(page).boundingBox();
		expect(Math.abs(ai.y - insert.y)).toBeLessThanOrEqual(2);
		expect(ai.y).toBeGreaterThan(field.y + field.height);
		await expect(page.locator(".mathlive-modal-root button.submit")).toHaveText(/^Insert(Ctrl\+Enter|⌘ Enter)$/);
	});

	test("one ✨ AI fill button holds the AI actions, each with an icon and a name", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const actions = page.locator(".mathlive-modal-root .mathlive-scan-actions");
		await expect(actions.getByRole("button")).toHaveCount(1);
		const button = actions.getByRole("button", { name: "AI fill" });
		await button.click();
		await expect(button).toHaveAttribute("aria-expanded", "true");
		const menu = page.locator(".menu");
		await expect(menu.locator(".menu-item-title")).toHaveText([
			"Magic edit",
			"Find a formula",
			"Scan clipboard image",
			"Scan from screen",
			"Draw formula",
		]);
		await expect(menu.locator(".menu-item-icon svg")).toHaveCount(5);
		// Escape closes the menu, and leaves the window open.
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(modalField(page)).toBeVisible();

		await modalAiAction(page, "Find a formula");
		await expect(page.locator(".mathlive-formula-search")).toBeVisible();
		await page.keyboard.press("Escape");
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

	test("MathLive's own menu takes clicks, though the formula's buttons show only on hover", async ({ page }) => {
		const field = blockField(page);
		await focusField(field);
		await field.hover();
		await field.locator("[part=menu-toggle]").click();
		// A submenu opens on hover, and an item does what it says.
		await page.getByText("Font Style").hover();
		await expect(page.getByText("Roman Upright")).toBeVisible();
		await page.getByText("Select All").click();
		await expect(page.getByText("Insert Matrix")).toBeHidden();
		await expect.poll(() => field.evaluate((f) => JSON.stringify(f.selection.ranges[0]) === JSON.stringify([0, f.lastOffset]))).toBe(true);
	});

	test("MathLive's own menu closes on a click outside it, on ☰ again, and on Escape", async ({ page }) => {
		const field = blockField(page);
		const menu = page.getByText("Insert Matrix");
		const open = async () => {
			await focusField(field);
			await field.hover();
			await field.locator("[part=menu-toggle]").click();
			await expect(menu).toBeVisible();
		};

		// A click in the note, away from the formula.
		await open();
		await page.getByText("Plain paragraph between formulas.").click();
		await expect(menu).toBeHidden();

		// ☰ again.
		await open();
		await field.locator("[part=menu-toggle]").click();
		await expect(menu).toBeHidden();

		// Escape, after the mouse has left the formula, keeps the formula as it is.
		await open();
		await page.mouse.move(5, 5);
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(field).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");

		// The right-click menu too.
		await inlineField(page, 0).click({ button: "right" });
		await expect(menu).toBeVisible();
		// Away from the menu, which may cover the paragraph.
		await page.mouse.click(850, 650);
		await expect(menu).toBeHidden();
	});

	test("the editor window has MathLive's ☰ menu", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		const field = modalField(page);
		const menu = page.getByText("Insert Matrix");
		await field.locator("[part=menu-toggle]").click();
		await expect(menu).toBeVisible();
		await page.getByText("Select All").click();
		await expect(menu).toBeHidden();

		// Escape closes only the menu, and a second one the window.
		await field.locator("[part=menu-toggle]").click();
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(field).toBeVisible();

		// A click elsewhere in the window closes it too.
		await field.locator("[part=menu-toggle]").click();
		await expect(menu).toBeVisible();
		// MathLive's clear layer over the window takes the click, so click by position.
		const title = await page.locator(".mathlive-modal-title").boundingBox();
		await page.mouse.click(title.x + 10, title.y + title.height / 2);
		await expect(menu).toBeHidden();
		await expect(field).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(field).toHaveCount(0);
	});

	test("the editor window grows on a big screen, with bigger formulas", async ({ page }) => {
		const measure = async () => {
			await runCommand(page, "mathlive:open-modal");
			await waitForModalField(page);
			const size = await modalField(page).evaluate((field) => ({
				width: field.getBoundingClientRect().width,
				height: field.getBoundingClientRect().height,
				font: Number.parseFloat(getComputedStyle(field).fontSize),
			}));
			await page.keyboard.press("Escape");
			await expect(modalField(page)).toHaveCount(0);
			return size;
		};
		const resize = (width, height) =>
			page.evaluate(({ width, height }) => {
				window.require("electron").remote.getCurrentWindow().setContentSize(width, height);
				return true;
			}, { width, height });

		const small = await measure();
		await resize(1400, 900);
		try {
			await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1300);
			const big = await measure();
			expect(big.width).toBeGreaterThan(small.width + 250);
			expect(big.height).toBeGreaterThan(small.height * 2);
			expect(big.font).toBeGreaterThan(small.font);
		} finally {
			await resize(1024, 800);
		}
	});
});

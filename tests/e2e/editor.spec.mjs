import {
	blockField,
	blockWidget,
	expect,
	focusField,
	inlineField,
	inlineWidget,
	menuItem,
	modalField,
	noteLine,
	noteText,
	openWidgetMenu,
	openedUrls,
	recordOpenedUrls,
	setSettings,
	test,
	waitForModalField,
} from "./fixtures.mjs";

const lineHeight = (page, startsWith) =>
	page.evaluate((prefix) => {
		const line = [...document.querySelectorAll(".cm-content > .cm-line")].find((element) =>
			element.textContent.startsWith(prefix)
		);
		return line.getBoundingClientRect().height;
	}, startsWith);

test.describe("formulas in the note", () => {
	test("plugin loads with its commands and turns formulas into editors", async ({ page }) => {
		const state = await page.evaluate(() => ({
			commands: Object.keys(window.app.commands.commands).filter((id) => id.startsWith("mathlive:")),
			bodyClasses: [...document.body.classList].filter((name) => name.startsWith("mathlive-")),
			fonts: [...document.fonts].filter((font) => font.family.startsWith("KaTeX")).length,
		}));
		expect(state.commands.sort()).toEqual(["mathlive:open-modal", "mathlive:open-modal-inline", "mathlive:scan-anywhere-on-screen", "mathlive:scan-screen-area"]);
		expect(state.bodyClasses).toEqual(
			expect.arrayContaining(["mathlive-inline-widgets-active", "mathlive-block-widgets-active"])
		);
		expect(state.fonts).toBeGreaterThan(0);

		await expect(inlineField(page, 0)).toHaveJSProperty("value", "x^2 + y^2 = z^2");
		await expect(inlineField(page, 1)).toHaveJSProperty("value", "\\alpha + \\beta");
		await expect(blockField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
		// Each formula has a single small menu button and nothing else around it.
		await expect(page.locator(".cm-content .obsidian-mathlive-widget-menu-button")).toHaveCount(3);
		await expect(page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper a")).toHaveCount(0);
	});

	test("typing in an inline formula updates the note", async ({ page }) => {
		await focusField(inlineField(page, 0));
		await expect(page.locator("body")).toHaveClass(/mathlive-editing-inline/);
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect.poll(() => noteLine(page, "Inline math")).toBe("Inline math $x^2+y^2=z^2+1$ in a sentence.");

		// Clicking back into the text leaves the formula.
		await page.locator(".cm-content .cm-line", { hasText: "Plain paragraph" }).click();
		await expect(page.locator("body")).not.toHaveClass(/mathlive-editing-inline/);
	});

	test("typing in a block formula updates the note", async ({ page }) => {
		await focusField(blockField(page));
		await expect(page.locator("body")).toHaveClass(/mathlive-editing-block/);
		await page.keyboard.press("End");
		await page.keyboard.type("+C", { delay: 40 });
		await expect.poll(() => noteText(page)).toContain("+C");
		expect(await noteText(page)).toMatch(/\$\$[\s\S]*\\int_0\^1[\s\S]*\+C[\s\S]*\$\$/);
	});

	test("Escape leaves the formula without touching the rest of the note", async ({ page }) => {
		await focusField(inlineField(page, 1));
		await page.keyboard.press("Escape");
		await expect(inlineField(page, 1)).not.toBeFocused();
		expect(await noteLine(page, "Last line")).toBe("Last line $\\alpha + \\beta$ done.");
	});

	test("arrow keys move from the text into a formula", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Inline math"));
			editor.setCursor({ line, ch: "Inline math ".length });
			editor.focus();
			return true;
		});
		await page.keyboard.press("ArrowRight");
		await expect(inlineField(page, 0)).toBeFocused();
	});

	test("arrow key navigation can be turned off", async ({ page }) => {
		await setSettings(page, { arrowKeyNavigation: false });
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Inline math"));
			editor.setCursor({ line, ch: "Inline math ".length });
			editor.focus();
			return true;
		});
		await page.keyboard.press("ArrowRight");
		await expect(inlineField(page, 0)).not.toBeFocused();
	});

	test("an inline formula keeps the line close to its normal height", async ({ page }) => {
		const plain = await lineHeight(page, "Plain paragraph");
		const withFormula = await lineHeight(page, "Last line");
		// The formula fits in the line of text, superscripts included.
		expect(withFormula).toBeLessThanOrEqual(plain + 2);
		expect(await lineHeight(page, "Inline math")).toBeLessThanOrEqual(plain + 2);

		const widget = inlineWidget(page, 1);
		const box = await widget.boundingBox();
		expect(box.height).toBeLessThanOrEqual(plain + 2);
		// The formula's own keyboard and menu buttons are hidden; the ⋮ menu has them.
		await expect(inlineField(page, 1).locator("[part=virtual-keyboard-toggle]")).toBeHidden();
	});

	test("the ⋮ menu lists the formula's actions and closes", async ({ page }) => {
		const widget = inlineWidget(page, 0);
		const trigger = widget.getByRole("button", { name: "More options" });
		const menu = await openWidgetMenu(page, widget);
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(menu.locator(".menu-item-title")).toHaveText([
			"Scan clipboard image",
			"Scan from screen",
			"Open in editor window",
			"Show math keyboard",
			"Connect to scan images",
			"Made by Dan Zilberman",
		]);

		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(await noteText(page)).toContain("$x^2 + y^2 = z^2$");
	});

	test("the ⋮ menu opens the formula in the editor window", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 1));
		await menuItem(page, "Open in editor window").click();

		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit inline math");
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha + \\beta");
		await waitForModalField(page);
		await page.keyboard.press("End");
		await page.keyboard.type("+y", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha+\\beta+y");
		await page.keyboard.press("Control+Enter");
		await expect.poll(() => noteLine(page, "Last line")).toBe("Last line $\\alpha+\\beta+y$ done.");
	});

	test("the ⋮ menu opens a block formula in the editor window", async ({ page }) => {
		await openWidgetMenu(page, blockWidget(page));
		await menuItem(page, "Open in editor window").click();
		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit math block");
		await expect(modalField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
	});

	test("the ⋮ menu shows the math keyboard for that formula", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Show math keyboard").click();
		await expect(page.locator(".ML__keyboard")).toBeVisible();
		await expect(inlineField(page, 0)).toBeFocused();
	});

	test("the ⋮ menu's links connect the account and open the author's site", async ({ page }) => {
		await recordOpenedUrls(page);
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Connect to scan images").click();
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Made by Dan Zilberman").click();
		await expect.poll(() => openedUrls(page)).toHaveLength(2);
		const [connect, author] = await openedUrls(page);
		expect(connect).toMatch(/^https:\/\/mathlive\.danz\.blog\/connect\?state=[0-9a-f]{64}&device=vault%20on%20/);
		expect(author).toBe("https://danz.blog");
	});

	test("Connect shows only when the cloud scanner isn't connected", async ({ page }) => {
		await setSettings(page, { useLocalInference: true });
		await openWidgetMenu(page, inlineWidget(page, 0));
		await expect(menuItem(page, "Made by Dan Zilberman")).toBeVisible();
		await expect(menuItem(page, "Connect to scan images")).toHaveCount(0);
	});

	test("block formulas keep their own keyboard and menu buttons beside the ⋮ menu", async ({ page }) => {
		const widget = blockWidget(page);
		await expect(blockField(page).locator("[part=virtual-keyboard-toggle]")).toBeVisible();
		const field = await blockField(page).boundingBox();
		const button = await widget.getByRole("button", { name: "More options" }).boundingBox();
		// The button sits to the right of the formula, not on a row of its own.
		expect(button.x).toBeGreaterThan(field.x + field.width - 1);
		expect(button.y).toBeLessThan(field.y + field.height);
	});
});

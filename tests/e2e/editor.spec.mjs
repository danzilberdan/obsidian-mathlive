import {
	blockField,
	blockWidget,
	clickWidgetButton,
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
		expect(state.commands.sort()).toEqual(["mathlive:convert-pdf-to-notes", "mathlive:draw-formula", "mathlive:open-guide", "mathlive:open-modal", "mathlive:open-modal-inline", "mathlive:scan-screen-area", "mathlive:toggle-raw-latex"]);
		expect(state.bodyClasses).toEqual(
			expect.arrayContaining(["mathlive-inline-widgets-active", "mathlive-block-widgets-active"])
		);
		expect(state.fonts).toBeGreaterThan(0);

		await expect(inlineField(page, 0)).toHaveJSProperty("value", "x^2 + y^2 = z^2");
		await expect(inlineField(page, 1)).toHaveJSProperty("value", "\\alpha + \\beta");
		await expect(blockField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
		// Each formula has an AI fill and an Expand button, and nothing else around it.
		await expect(page.locator(".cm-content .obsidian-mathlive-widget-ai-button")).toHaveCount(3);
		await expect(page.locator(".cm-content .obsidian-mathlive-widget-expand-button")).toHaveCount(3);
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

	test("the LaTeX never shows next to a formula, wherever the cursor is", async ({ page }) => {
		const visibleText = () => page.locator(".cm-content").innerText();
		for (const [line, ch] of [[2, 12], [2, 29], [3, 0], [4, 0], [6, 2], [7, 0], [10, 10]]) {
			await page.evaluate(({ line, ch }) => {
				const editor = window.app.workspace.activeEditor.editor;
				editor.focus();
				editor.setCursor({ line, ch });
				return true;
			}, { line, ch });
			await page.waitForTimeout(100);
			const text = await visibleText();
			expect(text, `cursor at ${line}:${ch}`).not.toContain("$");
			expect(text, `cursor at ${line}:${ch}`).not.toContain("\\int");
		}
		await expect(page.locator(".cm-content math-field")).toHaveCount(3);
	});

	test("Left, Backspace, Down and Up next to a formula go into it", async ({ page }) => {
		const placeCursor = (find, offset) =>
			page.evaluate(({ find, offset }) => {
				const editor = window.app.workspace.activeEditor.editor;
				editor.focus();
				editor.setCursor(editor.offsetToPos(editor.getValue().indexOf(find) + offset));
				return true;
			}, { find, offset });
		const leave = async () => {
			await page.keyboard.press("Escape");
			await expect(page.locator(".cm-content math-field:focus")).toHaveCount(0);
		};

		await placeCursor("z^2$", 4);
		await page.keyboard.press("ArrowLeft");
		await expect(inlineField(page, 0)).toBeFocused();
		await leave();

		await placeCursor("z^2$", 4);
		await page.keyboard.press("Backspace");
		await expect(inlineField(page, 0)).toBeFocused();
		expect(await noteText(page)).toContain("$x^2 + y^2 = z^2$ in a sentence.");
		await leave();

		await placeCursor("in a sentence.", 14);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await expect(blockField(page)).toBeFocused();
		await leave();

		await placeCursor("Plain paragraph", 3);
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await expect(blockField(page)).toBeFocused();
	});

	test("the note's ⋮ menu shows the raw LaTeX for a while, and switches back", async ({ page }) => {
		const openNoteMenu = async () => {
			await page.locator(".workspace-leaf.mod-active .view-header .view-action[aria-label='More options']").click();
			return page.locator(".menu");
		};
		await openNoteMenu();
		await page.locator(".menu .menu-item", { hasText: "Show raw LaTeX" }).click();
		await expect(page.locator(".cm-content math-field")).toHaveCount(0);
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.focus();
			editor.setCursor({ line: 2, ch: 14 });
			return true;
		});
		await expect(page.locator(".cm-content")).toContainText("$x^2 + y^2 = z^2$");

		await openNoteMenu();
		await page.locator(".menu .menu-item", { hasText: "Show formulas as editors" }).click();
		await expect(page.locator(".cm-content math-field")).toHaveCount(3);
		await expect(page.locator(".cm-content")).not.toContainText("$");
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
		// The formula's own keyboard and menu buttons are hidden; the ✨ menu has them.
		await expect(inlineField(page, 1).locator("[part=virtual-keyboard-toggle]")).toBeHidden();
	});

	test("the ✨ menu lists the formula's actions and closes", async ({ page }) => {
		const widget = inlineWidget(page, 0);
		const trigger = widget.getByRole("button", { name: "AI fill" });
		const menu = await openWidgetMenu(page, widget);
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(menu.locator(".menu-item-title")).toHaveText([
			"Scan clipboard image",
			"Scan from screen",
			"Draw formula",
			"What MathLive can do",
			"Connect",
		]);
		// Two sections: what ✨ does for this formula, then help and the account.
		await expect(menu.locator(".menu-separator")).toHaveCount(1);

		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(await noteText(page)).toContain("$x^2 + y^2 = z^2$");
	});

	test("Expand opens the formula in the editor window", async ({ page }) => {
		await clickWidgetButton(inlineWidget(page, 1), "Expand");

		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit inline math");
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha + \\beta");
		await waitForModalField(page);
		await page.keyboard.press("End");
		await page.keyboard.type("+y", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha+\\beta+y");
		await page.keyboard.press("Control+Enter");
		await expect.poll(() => noteLine(page, "Last line")).toBe("Last line $\\alpha+\\beta+y$ done.");
	});

	test("Expand opens a block formula in the editor window", async ({ page }) => {
		await clickWidgetButton(blockWidget(page), "Expand");
		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit math block");
		await expect(modalField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
	});

	test("the ✨ menu connects the account", async ({ page }) => {
		await recordOpenedUrls(page);
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Connect").click();
		await expect.poll(() => openedUrls(page)).toHaveLength(1);
		const [connect] = await openedUrls(page);
		expect(connect).toMatch(/^https:\/\/mathlive\.danz\.blog\/connect\?state=[0-9a-f]{64}&device=vault%20on%20/);
	});

	test("Connect shows only when the cloud scanner isn't connected", async ({ page }) => {
		await setSettings(page, { useLocalInference: true });
		await openWidgetMenu(page, inlineWidget(page, 0));
		await expect(menuItem(page, "Scan clipboard image")).toBeVisible();
		await expect(menuItem(page, "Connect")).toHaveCount(0);
		await page.keyboard.press("Escape");

		// Connected, nothing about the account: no Connect and no Upgrade.
		await setSettings(page, { useLocalInference: false, apiKey: "low-key", apiKeySource: "device" });
		await openWidgetMenu(page, inlineWidget(page, 0));
		await expect(menuItem(page, "What MathLive can do")).toBeVisible();
		await expect(menuItem(page, "Connect")).toHaveCount(0);
		await expect(page.locator(".menu .menu-item")).toHaveCount(4);
	});

	test("block formulas show AI fill, Magic edit and Expand inside the input, after its keyboard and menu buttons", async ({ page }) => {
		const widget = blockWidget(page);
		await blockField(page).hover({ position: { x: 10, y: 10 } });
		const keyboard = await blockField(page).locator("[part=virtual-keyboard-toggle]").boundingBox();
		const menu = await blockField(page).locator("[part=menu-toggle]").boundingBox();
		const field = await blockField(page).boundingBox();
		const ai = await widget.getByRole("button", { name: "AI fill" }).boundingBox();
		const magic = await widget.getByRole("button", { name: "Magic edit" }).boundingBox();
		const expand = await widget.getByRole("button", { name: "Expand" }).boundingBox();
		// One row, same size, in order, all inside the input's border.
		for (const button of [menu, ai, magic, expand]) {
			expect(Math.abs(button.y + button.height / 2 - (keyboard.y + keyboard.height / 2))).toBeLessThanOrEqual(2);
			expect(Math.abs(button.width - keyboard.width)).toBeLessThanOrEqual(1);
		}
		expect(keyboard.x).toBeLessThan(menu.x);
		expect(menu.x + menu.width).toBeLessThanOrEqual(ai.x);
		expect(ai.x + ai.width).toBeLessThanOrEqual(magic.x);
		expect(magic.x + magic.width).toBeLessThanOrEqual(expand.x);
		expect(expand.x + expand.width).toBeLessThanOrEqual(field.x + field.width);
		expect(ai.y).toBeGreaterThanOrEqual(field.y);
		expect(ai.y + ai.height).toBeLessThanOrEqual(field.y + field.height);
	});

	test("a formula's buttons show only while the mouse is over the formula or them", async ({ page }) => {
		const opacity = (widget) =>
			widget.locator(".obsidian-mathlive-widget-buttons").evaluate((element) => Number(getComputedStyle(element).opacity));
		for (const widget of [inlineWidget(page, 0), blockWidget(page)]) {
			await page.mouse.move(5, 5);
			await expect.poll(() => opacity(widget)).toBe(0);
			await widget.locator("math-field").hover({ position: { x: 10, y: 10 } });
			await expect.poll(() => opacity(widget)).toBe(1);
			// Moving straight onto the buttons keeps them, and they work.
			const expand = widget.getByRole("button", { name: "Expand" });
			const from = await widget.locator("math-field").boundingBox();
			const to = await expand.boundingBox();
			await page.mouse.move(from.x + from.width - 2, to.y + to.height / 2);
			await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
			await expect.poll(() => opacity(widget)).toBe(1);
			await page.mouse.down();
			await page.mouse.up();
			await expect(page.locator(".mathlive-modal-title")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.locator(".mathlive-modal-title")).toHaveCount(0);
		}
		// Inline, the hidden buttons leave no gap in the line.
		await page.mouse.move(5, 5);
		const field = await inlineField(page, 0).boundingBox();
		const wrapper = await inlineWidget(page, 0).boundingBox();
		expect(wrapper.width - field.width).toBeLessThanOrEqual(2);
	});

	test("a block formula's keyboard and ☰ buttons also show only on hover", async ({ page }) => {
		const opacity = (part) =>
			blockField(page).locator(`[part=${part}]`).evaluate((element) => Number(getComputedStyle(element).opacity));
		await page.mouse.move(5, 5);
		await expect.poll(() => opacity("virtual-keyboard-toggle")).toBe(0);
		await expect.poll(() => opacity("menu-toggle")).toBe(0);
		await blockField(page).hover({ position: { x: 10, y: 10 } });
		await expect.poll(() => opacity("virtual-keyboard-toggle")).toBe(1);
		await expect.poll(() => opacity("menu-toggle")).toBe(1);
		await blockField(page).locator("[part=virtual-keyboard-toggle]").click();
		await expect(page.locator(".ML__keyboard")).toBeVisible();
	});

	test("the ✨ menu keeps its button showing while it is open", async ({ page }) => {
		const widget = inlineWidget(page, 0);
		await widget.locator("math-field").hover();
		await openWidgetMenu(page, widget);
		await page.mouse.move(5, 5);
		await page.waitForTimeout(400);
		const opacity = await widget.locator(".obsidian-mathlive-widget-buttons").evaluate((element) => Number(getComputedStyle(element).opacity));
		expect(opacity).toBe(1);
		await page.keyboard.press("Escape");
	});

	test("the ✨ menu opens the guide, which tries features from there", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "What MathLive can do").click();
		const guide = page.locator(".mathlive-guide-modal");
		await expect(guide.locator(".modal-title")).toHaveText("What MathLive can do");
		await expect(guide.locator(".mathlive-guide-section h3")).toHaveText([
			"Edit formulas as you see them",
			"Add a formula",
			"AI fill: scan a formula instead of typing it",
			"Draw a formula",
			"Magic edit: say what to change",
			"Expand for a bigger editor",
			"Math keyboard",
			"Turn a PDF into notes",
			"Your scans",
		]);
		await expect(guide).toContainText("Free accounts get 10 scans");
		await expect(guide.getByRole("button", { name: "Get 10 free scans" })).toBeVisible();
		await guide.getByRole("button", { name: "Add a formula now" }).click();
		await expect(guide).toHaveCount(0);
		await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit math block");
		await page.keyboard.press("Escape");
	});
});

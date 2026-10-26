import { blockField, expect, focusField, inlineField, noteLine, noteText, reopenNote, setSettings, test } from "./fixtures.mjs";

test.describe("formulas in the note", () => {
	test("plugin loads with its commands and turns formulas into editors", async ({ page }) => {
		const state = await page.evaluate(() => ({
			commands: Object.keys(window.app.commands.commands).filter((id) => id.startsWith("mathlive:")),
			bodyClasses: [...document.body.classList].filter((name) => name.startsWith("mathlive-")),
			fonts: [...document.fonts].filter((font) => font.family.startsWith("KaTeX")).length,
		}));
		expect(state.commands.sort()).toEqual(["mathlive:open-modal", "mathlive:open-modal-inline"]);
		expect(state.bodyClasses).toEqual(
			expect.arrayContaining(["mathlive-inline-widgets-active", "mathlive-block-widgets-active"])
		);
		expect(state.fonts).toBeGreaterThan(0);

		await expect(inlineField(page, 0)).toHaveJSProperty("value", "x^2 + y^2 = z^2");
		await expect(inlineField(page, 1)).toHaveJSProperty("value", "\\alpha + \\beta");
		await expect(blockField(page)).toHaveJSProperty("value", "\n\\int_0^1 f(x)\\,dx\n");
		// Obsidian's own rendering is hidden behind the editors.
		await expect(page.locator(".cm-content .obsidian-mathlive-widget-menu")).toHaveCount(3);
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

	test("the More options menu opens and closes", async ({ page }) => {
		const widget = page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper").first();
		const trigger = widget.getByRole("button", { name: "More options" });
		const dropdown = widget.locator(".mathlive-modal-menu-dropdown");

		await expect(dropdown).toHaveClass(/--hidden/);
		await trigger.click();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(dropdown).not.toHaveClass(/--hidden/);
		await expect(dropdown.getByRole("link", { name: "Made by Dan Zilberman" })).toHaveAttribute("href", "https://danz.blog");

		// A click anywhere else closes it.
		await page.locator(".cm-content .cm-line", { hasText: "Plain paragraph" }).click();
		await expect(dropdown).toHaveClass(/--hidden/);
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
	});

	test("Sign in shows only when the cloud scanner has no API key", async ({ page }) => {
		const signIn = page.locator(".cm-content .obsidian-mathlive-widget-account-link");
		await expect(signIn.first()).toHaveText("Sign in");
		await expect(signIn.first()).toHaveAttribute("href", /mathlive\.danz\.blog/);

		await setSettings(page, { useLocalInference: true });
		await reopenNote(page);
		await expect(signIn).toHaveCount(0);
	});
});

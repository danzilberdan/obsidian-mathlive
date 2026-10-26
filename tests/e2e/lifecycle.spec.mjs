import { expect, focusField, inlineField, test, waitForStableWidgets } from "./fixtures.mjs";

test.describe("plugin lifecycle", () => {
	test("formulas still render after the plugin is turned off and on again", async ({ page }) => {
		for (let round = 0; round < 3; round += 1) {
			await page.evaluate(() => window.app.plugins.disablePlugin("mathlive").then(() => true));
			await expect(page.locator(".cm-content math-field")).toHaveCount(0);
			const leftover = await page.evaluate(() => [...document.body.classList].filter((name) => name.startsWith("mathlive-")));
			expect(leftover).toEqual([]);

			await page.evaluate(() => window.app.plugins.enablePlugin("mathlive").then(() => true));
			await expect(page.locator(".cm-content math-field")).toHaveCount(3);
		}

		// The re-enabled plugin still edits the note.
		await waitForStableWidgets(page);
		await focusField(inlineField(page, 0));
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect
			.poll(() => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue()))
			.toContain("$x^2+y^2=z^2+1$");
	});

	test("formulas render in the dark theme", async ({ page }) => {
		await page.evaluate(() => {
			window.app.changeTheme("obsidian");
			return true;
		});
		await expect(page.locator("body")).toHaveClass(/theme-dark/);
		await expect(page.locator(".cm-content math-field")).toHaveCount(3);
		// Formula text follows the theme's text colour instead of staying black.
		const colors = await page.evaluate(() => ({
			text: getComputedStyle(document.body).getPropertyValue("--text-normal").trim(),
			field: getComputedStyle(document.querySelector(".cm-content math-field")).color,
		}));
		expect(colors.field).not.toBe("rgb(0, 0, 0)");
	});
});

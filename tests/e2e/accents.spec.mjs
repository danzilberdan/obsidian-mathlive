import { blockField, expect, focusField, inlineField, noteText, test } from "./fixtures.mjs";

for (const inline of [true, false]) {
	for (const [name, command] of [["Hat", "hat"], ["Tilde", "tilde"]]) {
		test(`${inline ? "inline" : "display"} accent menu applies ${command} to the selected expression`, async ({ page }) => {
			await page.evaluate((inline) => {
				const editor = window.app.workspace.activeEditor.editor;
				editor.setValue(inline ? "$x+y$" : "$$\nx+y\n$$");
				editor.setCursor({ line: 0, ch: 0 });
			}, inline);
			const field = inline ? inlineField(page) : blockField(page);
			await focusField(field);
			await field.evaluate((mfe) => mfe.executeCommand("selectAll"));
			if (inline) {
				await field.click({ button: "right" });
			} else {
				await field.locator("[part=menu-toggle]").click();
			}
			await page.getByText("Accent", { exact: true }).hover();
			await page.getByRole("menuitem", { name, exact: true }).click();
			await expect(field).toHaveJSProperty("value", `\\${command}{x+y}`);
			await expect.poll(() => noteText(page)).toContain(`\\${command}{x+y}`);
		});
	}
}

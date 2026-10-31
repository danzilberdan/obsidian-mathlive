import { blockField, expect, focusField, inlineField, noteText, test } from "./fixtures.mjs";

for (const inline of [true, false]) {
	for (const [name, command] of [["Hat", "hat"], ["Tilde", "tilde"]]) {
		for (const [expression, wide] of [["x", false], ["\\alpha", false], ["\\boldsymbol{\\alpha}", false], ["xy", true], ["x+y", true]]) {
			const expectedCommand = wide ? `wide${command}` : command;
			test(`${inline ? "inline" : "display"} accent menu uses ${expectedCommand} for ${expression}`, async ({ page }) => {
				await page.evaluate(({ inline, expression }) => {
					const editor = window.app.workspace.activeEditor.editor;
					editor.setValue(inline ? `$${expression}$` : `$$\n${expression}\n$$`);
					editor.setCursor({ line: 0, ch: 0 });
				}, { inline, expression });
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
				await expect.poll(() => field.evaluate((mfe) => mfe.value)).toMatch(new RegExp(`^\\\\${expectedCommand}\\{`));
				await expect.poll(() => noteText(page)).toContain(`\\${expectedCommand}{`);
			});
		}
	}
}

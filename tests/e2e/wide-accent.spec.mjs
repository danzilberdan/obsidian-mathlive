import { blockField, expect, focusField, inlineField, modalField, runCommand, test, waitForModalField } from "./fixtures.mjs";

async function openField(page, mode, latex) {
	await page.evaluate(({ mode, latex }) => {
		const editor = window.app.workspace.activeEditor.editor;
		editor.setValue(mode === "display" ? `$$\n${latex}\n$$` : `$${latex}$`);
		editor.setCursor({ line: 0, ch: 1 });
	}, { mode, latex });
	if (mode === "expanded") {
		await page.bringToFront();
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
	}
	const field = mode === "expanded" ? modalField(page) : mode === "display" ? blockField(page) : inlineField(page);
	await focusField(field);
	await field.evaluate(async mfe => { await mfe.ownerDocument.fonts.ready; });
	return field;
}

async function expectFullWidthAccents(field, count = 1) {
	await expect.poll(() => field.evaluate((mfe, count) => {
		const accents = [...mfe.shadowRoot.querySelectorAll('.ML__stretchy > svg[preserveAspectRatio="none"]')];
		return accents.length === count && accents.every(svg => {
			const accent = svg.getBoundingClientRect();
			const body = svg.closest('.ML__vlist').firstElementChild.lastElementChild.getBoundingClientRect();
			const centerError = Math.abs((accent.left + accent.right - body.left - body.right) / 2);
			return accent.width > 0 && Math.abs(accent.width - body.width) < 1 && centerError < 1;
		});
	}, count)).toBe(true);
}

for (const mode of ["inline", "display", "expanded"]) {
	for (const command of ["widehat", "widetilde"]) {
		for (const body of ["xy", "abcdefghij", "\\alpha_{ij}+\\beta^{2}"]) {
			test(`${mode} ${command} covers and centers over ${body}`, async ({ page }) => {
				const field = await openField(page, mode, `\\${command}{${body}}`);
				await expectFullWidthAccents(field);
			});
		}
	}
}

test("nested wide accents remain centered as the underlying expression grows", async ({ page }, testInfo) => {
	const field = await openField(page, "expanded", "\\widehat{\\widetilde{xy}}");
	await expectFullWidthAccents(field, 2);
	await field.evaluate(mfe => { mfe.value = "\\widehat{\\widetilde{abcdefghij}}"; });
	await expectFullWidthAccents(field, 2);
	await field.evaluate(mfe => mfe.executeCommand("moveToMathfieldEnd"));
	await field.screenshot({ path: testInfo.outputPath("wide-accents.png") });
});

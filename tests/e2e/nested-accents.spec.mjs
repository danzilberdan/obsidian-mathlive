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

async function expectCenteredLayers(field) {
	await expect.poll(() => field.evaluate(mfe => {
		const layers = [...mfe.shadowRoot.querySelectorAll('.ML__vlist > .ML__center > .ML__accent-body')].filter(accent => {
			const base = accent.closest('.ML__vlist').firstElementChild;
			return base.querySelector('.ML__accent-body, .ML__stretchy');
		});
		return layers.length > 0 && layers.every(accent => {
			const a = accent.getBoundingClientRect();
			const base = accent.closest('.ML__vlist').firstElementChild.lastElementChild.getBoundingClientRect();
			return a.width > 0 && Math.abs((a.left + a.right - base.left - base.right) / 2) < 1;
		});
	})).toBe(true);
}

for (const mode of ["inline", "display", "expanded"]) {
	for (const latex of ["\\dot{\\bar{x}}", "\\hat{\\bar{x}}", "\\bar{\\hat{x}}", "\\dot{\\hat{x}}", "\\dot{\\widehat{xy}}", "\\dot{\\hat{\\bar{x}}}"]) {
		test(`${mode} centers every outer accent in ${latex}`, async ({ page }) => {
			const field = await openField(page, mode, latex);
			await expectCenteredLayers(field);
		});
	}
}

test("nested accents stay centered after editing", async ({ page }, testInfo) => {
	const field = await openField(page, "expanded", "\\dot{\\bar{x}}");
	await expectCenteredLayers(field);
	await field.evaluate(mfe => { mfe.value = "\\dot{\\bar{xy}}"; });
	await expectCenteredLayers(field);
	await field.evaluate(mfe => { mfe.value = "\\dot{\\bar{x}}+\\hat{\\bar{x}}+\\bar{\\hat{x}}+\\dot{\\widehat{xy}}"; mfe.position = mfe.lastOffset; });
	await expectCenteredLayers(field);
	await field.screenshot({path:testInfo.outputPath("nested-accents.png")});
});

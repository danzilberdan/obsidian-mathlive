import { blockField, expect, focusField, inlineField, modalField, noteText, runCommand, test, waitForModalField } from "./fixtures.mjs";

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
	await field.evaluate((mfe) => { mfe.position = mfe.lastOffset; });
	return field;
}

for (const mode of ["inline", "display", "expanded"]) {
	test(`${mode} Backspace removes nested accents from outside inward, then the symbol`, async ({ page }) => {
		const field = await openField(page, mode, "\\hat{\\tilde{\\vec{x}}}");
		for (const expected of ["\\tilde{\\vec{x}}", "\\vec{x}", "x", ""]) {
			await page.keyboard.press("Backspace");
			if (mode === "inline" && expected === "") {
				await expect.poll(() => noteText(page)).toBe("$$");
			} else {
				await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe(expected);
			}
		}
	});

	test(`${mode} Backspace unwraps wide accents and preserves neighbors`, async ({ page }) => {
		const field = await openField(page, mode, "a+\\widehat{\\widetilde{xy}}+b");
		await field.evaluate((mfe) => {
			mfe.position = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) })).find((entry) => entry.latex?.startsWith("\\widehat")).offset;
		});
		for (const expected of ["a+\\widetilde{xy}+b", "a+xy+b", "a+x+b"]) {
			await page.keyboard.press("Backspace");
			await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe(expected);
		}
	});
}

test("Backspace at the end inside an accent also removes the outermost layer", async ({ page }) => {
	const field = await openField(page, "expanded", "\\hat{\\tilde{x}}");
	await field.evaluate((mfe) => {
		mfe.position = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) })).find((entry) => entry.latex === "x").offset;
	});
	await page.keyboard.press("Backspace");
	await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe("\\tilde{x}");
});

test("Backspace inside wide accented text keeps ordinary character deletion", async ({ page }) => {
	const field = await openField(page, "expanded", "\\widehat{xy}");
	await field.evaluate((mfe) => { mfe.position = 2; });
	await page.keyboard.press("Backspace");
	await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe("\\widehat{y}");
});

test("selected accented expressions still delete normally", async ({ page }) => {
	const field = await openField(page, "expanded", "\\hat{x}+y");
	await field.evaluate((mfe) => mfe.executeCommand("selectAll"));
	await page.keyboard.press("Backspace");
	await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe("");
});

test("accent removal is individually undoable and redoable", async ({ page }) => {
	const field = await openField(page, "expanded", "\\hat{\\tilde{x}}");
	for (const expected of ["\\tilde{x}", "x"]) {
		await page.keyboard.press("Backspace");
		await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe(expected);
	}
	for (const expected of ["\\tilde{x}", "\\hat{\\tilde{x}}"] ) {
		await field.evaluate((mfe) => mfe.executeCommand("undo"));
		await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe(expected);
	}
	await field.evaluate((mfe) => mfe.executeCommand("redo"));
	await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe("\\tilde{x}");
});

for (const [latex, expected] of [
	["\\overline{\\dot{x}}", "\\dot{x}"],
	["\\hat{\\frac{x}{y}}", "\\frac{x}{y}"],
	["\\hat{\\{x\\}}", "\\{x\\}"],
	["\\hat{x}_i", "x_{i}"],
]) {
	test(`Backspace unwraps ${latex} while preserving its contents and scripts`, async ({ page }) => {
		const field = await openField(page, "expanded", latex);
		if (latex.endsWith("_i")) {
			await field.evaluate((mfe) => {
				mfe.position = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) })).find((entry) => entry.latex === "\\hat{x}").offset;
			});
		}
		await page.keyboard.press("Backspace");
		await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe(expected);
	});
}

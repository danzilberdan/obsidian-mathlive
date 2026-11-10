import { blockField, expect, inlineField, modalField, noteText, runCommand, test, waitForModalField } from "./fixtures.mjs";

async function openField(page, latex, mode) {
	await page.evaluate(({ latex, mode }) => {
		const editor = window.app.workspace.activeEditor.editor;
		editor.setValue(mode === "display" ? `Before.\n\n$$\n${latex}\n$$\n\nAfter.` : `Before $${latex}$ after.`);
		editor.setCursor({ line: 0, ch: mode === "expanded" ? 8 : 0 });
	}, { latex, mode });
	await page.bringToFront();
	if (mode === "expanded") {
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
	}
	const field = mode === "expanded" ? modalField(page) : mode === "inline" ? inlineField(page) : blockField(page);
	await expect(field).toBeVisible();
	await field.evaluate(async (mfe) => { await mfe.ownerDocument.fonts.ready; mfe.position = 0; });
	await expect.poll(() => field.evaluate(mfe => {
		const entries = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => mfe.getElementInfo(offset));
		const visible = entries.filter(entry => entry?.latex && !/^[_^]/.test(entry.latex));
		return visible.length > 0 && visible.every(entry => entry.bounds?.width > 0);
	})).toBe(true);
	return field;
}

async function clickFormula(page, field, target) {
	await page.mouse.click(target.x, target.y);
	await expect(async () => {
		expect(await field.evaluate(mfe => mfe.ownerDocument.activeElement === mfe)).toBe(true);
		await page.waitForTimeout(300);
		expect(await field.evaluate(mfe => mfe.ownerDocument.activeElement === mfe)).toBe(true);
	}).toPass({ timeout: 10_000 });
}

for (const mode of ["inline", "display", "expanded"]) {

	for (const bracket of ["bmatrix", "pmatrix"]) {
		for (const side of ["left", "right"]) {
			test(`${mode}: clicking the ${side} ${bracket} bracket places the cursor outside the matrix`, async ({ page }) => {
				const field = await openField(page, `a+\\begin{${bracket}}1&2\\\\3&4\\end{${bracket}}+b`, mode);
				const target = await field.evaluate((mfe, side) => {
					const entries = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) }));
					const matrix = entries.find((entry) => entry.latex?.startsWith("\\begin{"));
					let before = matrix.offset - 1;
					while (entries[before].depth > matrix.depth) before -= 1;
					const inset = Number.parseFloat(getComputedStyle(mfe).fontSize) * 0.3;
					return { x: side === "left" ? matrix.bounds.left + inset : matrix.bounds.right - inset, y: (matrix.bounds.top + matrix.bounds.bottom) / 2, position: side === "left" ? before : matrix.offset };
				}, side);
				await clickFormula(page, field, target);
				await expect.poll(() => field.evaluate((mfe) => mfe.position), { timeout: 1000 }).toBe(target.position);
				await page.keyboard.type("z");
				const value = await field.evaluate((mfe) => mfe.value);
				expect(value).toContain(side === "left" ? `a+z\\begin{${bracket}}` : `\\end{${bracket}}z+b`);
				if (mode !== "expanded") {
					await expect.poll(() => noteText(page)).toContain(value);
					const note = await noteText(page);
					expect(note).toContain("Before");
					expect(note).toContain(mode === "inline" ? "after." : "After.");
				}
			});
		}
	}

	for (const latex of ["x_i+y", "\\alpha_{ij}+y", "x_i^2+y"]) {
		test(`${mode}: clicking after the complete scripted symbol in ${latex} leaves the script`, async ({ page }) => {
			const field = await openField(page, latex, mode);
			const target = await field.evaluate((mfe) => {
				const entries = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) }));
				const script = entries.find((entry) => /^[_^]/.test(entry.latex ?? "") && entry.depth === 0);
				const base = entries.find((entry) => entry.depth === 0 && entry.latex && entry.bounds);
				const right = Math.max(...entries.slice(base.offset + 1, script.offset).filter((entry) => entry.bounds).map((entry) => entry.bounds.right));
				return { x: right + 3, y: (base.bounds.top + base.bounds.bottom) / 2, position: script.offset };
			});
			await clickFormula(page, field, target);
			await expect.poll(() => field.evaluate((mfe) => mfe.position), { timeout: 1000 }).toBe(target.position);
			await page.keyboard.type("z");
			await expect.poll(() => field.evaluate((mfe) => mfe.value)).toMatch(/z\+y$/);
		});
	}

	test(`${mode}: clicks inside a matrix cell still edit the cell`, async ({ page }) => {
		const field = await openField(page, "a+\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}+b", mode);
		const target = await field.evaluate((mfe) => {
			const entries = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) }));
			const cell = entries.find((entry) => entry.latex === "4" && entry.depth > 0);
			return { x: cell.bounds.right - 2, y: (cell.bounds.top + cell.bounds.bottom) / 2, position: cell.offset };
		});
		await clickFormula(page, field, target);
		await expect(field).toHaveJSProperty("position", target.position);
		await page.keyboard.type("z");
		await expect.poll(() => field.evaluate((mfe) => mfe.value)).toContain("4z\\end{bmatrix}");
	});

	test(`${mode}: clicks inside a subscript still edit the subscript`, async ({ page }) => {
		const field = await openField(page, "x_i+y", mode);
		const target = await field.evaluate((mfe) => {
			const entries = Array.from({ length: mfe.lastOffset + 1 }, (_, offset) => ({ offset, ...mfe.getElementInfo(offset) }));
			const subscript = entries.find((entry) => entry.latex === "i" && entry.depth > 0);
			return { x: subscript.bounds.right - 1, y: (subscript.bounds.top + subscript.bounds.bottom) / 2, position: subscript.offset };
		});
		await clickFormula(page, field, target);
		await expect(field).toHaveJSProperty("position", target.position);
		await page.keyboard.type("z");
		await expect.poll(() => field.evaluate((mfe) => mfe.value)).toBe("x_{iz}+y");
	});

	test(`${mode}: clicking the base before a subscript keeps the position before the script`, async ({ page }) => {
		const field = await openField(page, "x_i+y", mode);
		const target = await field.evaluate((mfe) => {
			const base = mfe.getElementInfo(1).bounds;
			return { x: base.right - 1, y: (base.top + base.bottom) / 2 };
		});
		await clickFormula(page, field, target);
		await expect(field).toHaveJSProperty("position", 1);
	});
}

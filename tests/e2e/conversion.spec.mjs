import {
	blockField,
	blockWidget,
	clickWidgetButton,
	expect,
	focusField,
	inlineField,
	inlineWidget,
	NOTE_TEXT,
	noteText,
	setSettings,
	test,
} from "./fixtures.mjs";

const setNote = (page, text) => page.evaluate((value) => {
	const editor = window.app.workspace.activeEditor.editor;
	editor.setValue(value);
	editor.setCursor({ line: 0, ch: 0 });
}, text);

test.describe("inline and display conversion", () => {
	test("inline formulas convert to display and back without changing surrounding content", async ({ page }) => {
		await clickWidgetButton(inlineWidget(page), "Convert to display math");
		const display = "Inline math \n\n$$\nx^2 + y^2 = z^2\n$$\n\n in a sentence.";
		await expect.poll(() => noteText(page)).toBe(NOTE_TEXT.replace("Inline math $x^2 + y^2 = z^2$ in a sentence.", () => display));
		await expect(blockWidget(page).getByRole("button", { name: "Convert to inline math" })).toHaveCount(1);
		await clickWidgetButton(blockWidget(page), "Convert to inline math");
		await expect.poll(() => noteText(page)).toBe(NOTE_TEXT.replace("Inline math $x^2 + y^2 = z^2$ in a sentence.", "Inline math \n\n$x^2 + y^2 = z^2$\n\n in a sentence."));
	});

	test("converts a display formula to inline and supports undo", async ({ page }) => {
		await clickWidgetButton(blockWidget(page), "Convert to inline math");
		await expect.poll(() => noteText(page)).toBe(NOTE_TEXT.replace("$$\n\\int_0^1 f(x)\\,dx\n$$", "$\\int_0^1 f(x)\\,dx$"));
		await page.evaluate(() => window.app.workspace.activeEditor.editor.undo());
		await expect.poll(() => noteText(page)).toBe(NOTE_TEXT);
		await expect(blockField(page)).toHaveCount(1);
	});

	test("keeps pending edits when immediate updates are disabled", async ({ page }) => {
		await setSettings(page, { immediateInlineUpdate: false });
		await focusField(inlineField(page));
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await clickWidgetButton(inlineWidget(page), "Convert to display math");
		await expect.poll(() => noteText(page)).toContain("$$\nx^2+y^2=z^2+1\n$$");
		await expect(blockField(page)).toHaveJSProperty("value", "\nx^2+y^2=z^2+1\n");
	});

	test("joins multiline display source while preserving escaped percent and TeX row breaks", async ({ page }) => {
		await setNote(page, "$$\na + % comment\nb + 10\\% + \\begin{matrix}1 & 2 \\\\\n3 & 4\\end{matrix}\n$$");
		await clickWidgetButton(blockWidget(page), "Convert to inline math");
		const converted = await noteText(page);
		expect(converted).not.toContain("\n");
		expect(converted).not.toContain("% comment");
		expect(converted).toContain("10\\%");
		expect(converted).toContain("\\\\");
		expect(converted).toMatch(/^\$a \+\s+b/);
		await expect(inlineField(page)).toHaveCount(1);
	});

	test("empty display formulas remain valid inline math", async ({ page }) => {
		await setNote(page, "$$\n\n$$");
		await clickWidgetButton(blockWidget(page), "Convert to inline math");
		await expect.poll(() => noteText(page)).toBe("${}$");
		await expect(inlineField(page)).toHaveCount(1);
	});

	test("uses updated source positions and leaves adjacent formulas intact", async ({ page }) => {
		await setNote(page, "$a$ $b$");
		await focusField(inlineField(page));
		await page.keyboard.press("End");
		await page.keyboard.type("+123", { delay: 40 });
		await clickWidgetButton(inlineWidget(page, 1), "Convert to display math");
		await expect.poll(() => noteText(page)).toBe("$a+123$ \n\n$$\nb\n$$");
		await expect(inlineField(page)).toHaveJSProperty("value", "a+123");
	});

	test("converts formulas at document edges with editing only at the cursor", async ({ page }) => {
		await setSettings(page, { editOnlyAtCursor: true });
		await setNote(page, "$x$");
		await clickWidgetButton(inlineWidget(page), "Convert to display math");
		await expect.poll(() => noteText(page)).toBe("$$\nx\n$$");
		await clickWidgetButton(blockWidget(page), "Convert to inline math");
		await expect.poll(() => noteText(page)).toBe("$x$");
	});
});

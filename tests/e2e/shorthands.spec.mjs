import { expect, modalField, noteLine, notices, runCommand, setSettings, test, waitForModalField } from "./fixtures.mjs";

const QUICK_LATEX_DATA = ".obsidian/plugins/quick-latex/data.json";

const openEmptyEditor = async (page) => {
	await page.evaluate(() => {
		const editor = window.app.workspace.activeEditor.editor;
		editor.setCursor({ line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
		return true;
	});
	await runCommand(page, "mathlive:open-modal-inline");
	await waitForModalField(page);
};

// The cursor goes inside the first formula on the line, just before its closing $.
const cursorBeforeClosingDollar = (page, prefix) =>
	page.evaluate((prefix) => {
		const editor = window.app.workspace.activeEditor.editor;
		const line = editor.getValue().split("\n").findIndex((text) => text.startsWith(prefix));
		const text = editor.getLine(line);
		editor.setCursor({ line, ch: text.indexOf("$", text.indexOf("$") + 1) });
		editor.focus();
		return true;
	}, prefix);

const writeQuickLatexData = (page, data) =>
	page.evaluate(
		async ({ path, data }) => {
			const adapter = window.app.vault.adapter;
			if (!(await adapter.exists(".obsidian/plugins/quick-latex"))) {
				await adapter.mkdir(".obsidian/plugins/quick-latex");
			}
			await adapter.write(path, JSON.stringify(data));
			return true;
		},
		{ path: QUICK_LATEX_DATA, data }
	);

const removeQuickLatex = (page) =>
	page.evaluate(async () => {
		const adapter = window.app.vault.adapter;
		if (await adapter.exists(".obsidian/plugins/quick-latex")) {
			await adapter.rmdir(".obsidian/plugins/quick-latex", true);
		}
		return true;
	});

test.describe("Quick Latex shorthands", () => {
	test.afterEach(async ({ page }) => {
		await removeQuickLatex(page);
	});

	test("are off until turned on", async ({ page }) => {
		await openEmptyEditor(page);
		await page.keyboard.type("al ", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "al");
	});

	test("the preset turns letters into LaTeX on Space in the editor", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true });
		await openEmptyEditor(page);
		await page.keyboard.type("al +sq ", { delay: 40 });
		await page.keyboard.type("2", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha+\\sqrt2");
	});

	test("letters that are part of a longer word stay as they are", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true });
		await openEmptyEditor(page);
		await page.keyboard.type("xal ", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "xal");
	});

	test("your own shorthands work and win over the preset", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true, shorthands: "rr:::\\mathbb{R};\nal:::\\aleph;" });
		await openEmptyEditor(page);
		await page.keyboard.type("rr +al ", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\mathbb{R}+\\aleph");
	});

	test("expand in typed LaTeX between $ signs", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true, enableInlineEditorMode: false });
		await cursorBeforeClosingDollar(page, "Inline math");
		await page.keyboard.type("+be ", { delay: 40 });
		await page.keyboard.type("+sq ", { delay: 40 });
		await page.keyboard.type("2", { delay: 40 });
		expect(await noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2+\\beta+\\sqrt{2}$ in a sentence.");
	});

	test("leave plain text outside formulas alone", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true, enableInlineEditorMode: false });
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Plain paragraph"));
			editor.setCursor({ line, ch: editor.getLine(line).length });
			editor.focus();
			return true;
		});
		await page.keyboard.type(" al be", { delay: 40 });
		expect(await noteLine(page, "Plain paragraph")).toBe("Plain paragraph between formulas. al be");
	});

	test("stay out of typed LaTeX when set to off", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true, enableInlineEditorMode: false, shorthandsInSource: "off" });
		await cursorBeforeClosingDollar(page, "Inline math");
		await page.keyboard.type("+be ", { delay: 40 });
		expect(await noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2+be $ in a sentence.");
	});

	test("leave typed LaTeX to Latex Suite when it is on", async ({ page }) => {
		await setSettings(page, { shorthandPreset: true, enableInlineEditorMode: false });
		await page.evaluate(() => window.app.plugins.enabledPlugins.add("obsidian-latex-suite"));
		try {
			await cursorBeforeClosingDollar(page, "Inline math");
			await page.keyboard.type("+be ", { delay: 40 });
			expect(await noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2+be $ in a sentence.");
		} finally {
			await page.evaluate(() => window.app.plugins.enabledPlugins.delete("obsidian-latex-suite"));
		}
	});

	test("are imported from Quick Latex's settings in the vault", async ({ page }) => {
		await writeQuickLatexData(page, {
			customShorthand_parameter: "sq:::\\sqrt{};\nrr:::\\mathbb{R};\nfr:::\\frac{#cursor}{#tab};",
		});
		const added = await page.evaluate(() => window.app.plugins.plugins.mathlive.importQuickLatexShorthands());
		expect(added).toBe(2);
		const settings = await page.evaluate(() => window.app.plugins.plugins.mathlive.settings);
		expect(settings.shorthandPreset).toBe(true);
		expect(settings.shorthands).toBe("rr:::\\mathbb{R};\nfr:::\\frac{#cursor}{#tab};");

		await openEmptyEditor(page);
		await page.keyboard.type("fr ", { delay: 40 });
		await page.keyboard.type("1", { delay: 40 });
		await page.keyboard.press("Tab");
		await page.keyboard.type("2", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\frac12");
	});

	test("a vault with Quick Latex gets a one-time offer to import", async ({ page }) => {
		await writeQuickLatexData(page, { customShorthand_parameter: "rr:::\\mathbb{R};" });
		await page.evaluate(() => window.app.plugins.plugins.mathlive.offerQuickLatexImport());
		const offer = notices(page).filter({ hasText: "Coming from Quick Latex? Import your 1 shorthand into" });
		await expect(offer).toHaveCount(1);
		await offer.getByRole("button", { name: "Import" }).click();
		await expect(notices(page).filter({ hasText: "Imported 1 shorthand," })).toHaveCount(1);

		await page.evaluate(() => document.querySelectorAll(".notice").forEach((notice) => notice.remove()));
		await page.evaluate(() => window.app.plugins.plugins.mathlive.offerQuickLatexImport());
		await expect(notices(page).filter({ hasText: "Coming from Quick Latex" })).toHaveCount(0);
	});
});

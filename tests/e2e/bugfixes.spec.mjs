// Regression tests for the bugs reported in issues #12, #13, #18, #19, #21, #22, #23, #24 and #25,
// and the option asked for in #27.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCANNED_LATEX, startStubScanner } from "./stub-scanner.mjs";
import {
	blockField,
	expect,
	focusField,
	inlineField,
	modalField,
	noteLine,
	noteText,
	putImageOnClipboard,
	runCommand,
	setSettings,
	test,
	waitForModalField,
} from "./fixtures.mjs";

const CODE_NOTE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "Code.md"), "utf8");
const cursor = (page) => page.evaluate(() => window.app.workspace.activeEditor.editor.getCursor());

test.describe("reported bugs", () => {
	test("#25: dollar signs inside code are not turned into formulas", async ({ page }) => {
		await page.evaluate((text) => {
			window.app.workspace.activeEditor.editor.setValue(text);
			return true;
		}, CODE_NOTE);
		const fields = page.locator(".cm-content math-field");
		await expect(fields).toHaveCount(2);
		await expect(fields.nth(0)).toHaveJSProperty("value", "a+b");
		await expect(fields.nth(1)).toHaveJSProperty("value", "\nc^2\n");
		// The code itself is untouched.
		await expect(page.locator(".cm-content")).toContainText('price = "$5"');
	});

	test("#22: the cursor ends up after an edited formula", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Last line"));
			const text = editor.getLine(line);
			editor.setSelection({ line, ch: text.indexOf("$") }, { line, ch: text.lastIndexOf("$") + 1 });
			return true;
		});
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.keyboard.press("End");
		await page.keyboard.type("+y", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\alpha+\\beta+y");
		await page.keyboard.press("Control+Enter");
		await expect(modalField(page)).toHaveCount(0);

		const line = await noteLine(page, "Last line");
		expect(line).toBe("Last line $\\alpha+\\beta+y$ done.");
		expect((await cursor(page)).ch).toBe(line.indexOf(" done."));
	});

	test("#22: the cursor ends up after a newly inserted block", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setCursor({ line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
			editor.replaceSelection("\n\n");
			return true;
		});
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		await page.keyboard.type("a/b", { delay: 40 });
		await expect(modalField(page)).toHaveJSProperty("value", "\\frac{a}{b}");
		await page.keyboard.press("Control+Enter");
		await expect(modalField(page)).toHaveCount(0);

		const lines = (await noteText(page)).split("\n");
		expect(await cursor(page)).toEqual({ line: lines.length - 1, ch: "$$\\frac{a}{b}$$".length });
	});

	test("#21: the inline editor window uses math mode so long formulas scroll", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal-inline");
		await expect(modalField(page)).toHaveJSProperty("defaultMode", "math");
	});

	test("#12: selected math stays readable in the light theme", async ({ page }) => {
		const light = await page.evaluate(() => {
			const field = document.querySelector(".cm-content math-field");
			const style = getComputedStyle(field);
			const body = getComputedStyle(document.body);
			return {
				background: style.getPropertyValue("--selection-background-color").trim(),
				color: style.getPropertyValue("--selection-color").trim(),
				expectedBackground: body.getPropertyValue("--text-selection").trim(),
				expectedColor: body.getPropertyValue("--text-normal").trim(),
			};
		});
		expect(light.background).toBe(light.expectedBackground);
		expect(light.color).toBe(light.expectedColor);

		await page.evaluate(() => {
			window.app.changeTheme("obsidian");
			return true;
		});
		const dark = await page.evaluate(() =>
			getComputedStyle(document.querySelector(".cm-content math-field")).getPropertyValue("--selection-color").trim()
		);
		expect(dark).toBe("rgb(73, 201, 206)");
	});

	test("#18: scans go to the self-hosted scanner address from settings", async ({ page }) => {
		const otherScanner = await startStubScanner(8503);
		try {
			await setSettings(page, { useLocalInference: true, apiKey: "", localInferenceUrl: "http://127.0.0.1:8503/" });
			expect(await putImageOnClipboard(page)).toBe(true);
			await runCommand(page, "mathlive:open-modal");
			await page.locator(".mathlive-modal-root .scan-button").click();
			await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
			// The trailing slash is trimmed, so the path is not doubled.
			expect(otherScanner.requests.map((request) => request.url)).toEqual(["/predict/"]);
		} finally {
			await otherScanner.close();
		}
	});
});

const keyboard = (page) => page.locator("body > .ML__keyboard");
const hideKeyboard = (page) =>
	page.evaluate(() => {
		window.mathVirtualKeyboard.hide();
		document.body.style.paddingBottom = "";
		return true;
	});

test.describe("reported bugs in 2.0", () => {
	test("#24: typing dx saves a d that Obsidian's MathJax draws", async ({ page }) => {
		await focusField(inlineField(page, 1));
		await page.keyboard.press("End");
		await page.keyboard.type("+dx", { delay: 60 });
		await expect(inlineField(page, 1)).toHaveJSProperty("value", "\\alpha+\\beta+\\differentialD x");
		await expect.poll(() => noteLine(page, "Last line")).toBe("Last line $\\alpha+\\beta+\\mathrm{d} x$ done.");
	});

	test("#13: the editor window saves arrows that Obsidian's MathJax draws", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Last line"));
			const text = editor.getLine(line);
			editor.setSelection({ line, ch: text.indexOf("$") }, { line, ch: text.lastIndexOf("$") + 1 });
			return true;
		});
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.keyboard.press("End");
		await page.keyboard.type("\\rarr x", { delay: 60 });
		await page.keyboard.press("Control+Enter");
		await expect(modalField(page)).toHaveCount(0);
		expect(await noteLine(page, "Last line")).toBe("Last line $\\alpha+\\beta\\rightarrow x$ done.");
	});

	test("#19: the suggestions list shows above the editor window", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.keyboard.type("\\fr", { delay: 60 });
		const popover = page.locator("#mathlive-suggestion-popover.is-visible");
		await expect(popover).toBeVisible();
		// Nothing covers its first suggestion.
		const topmost = await page.evaluate(() => {
			const first = document.querySelector("#mathlive-suggestion-popover li").getBoundingClientRect();
			return document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2)?.closest("#mathlive-suggestion-popover") !== null;
		});
		expect(topmost).toBe(true);
		await page.keyboard.press("Escape");
	});

	test("#23: the keyboard button works after a popout window with the keyboard open closes", async ({ page, obsidian }) => {
		await page.evaluate(async () => {
			const leaf = window.app.workspace.openPopoutLeaf();
			await leaf.openFile(window.app.vault.getAbstractFileByPath("Test.md"), { state: { mode: "source", source: false } });
			return true;
		});
		await expect.poll(() => obsidian.context.pages().filter((p) => p.url() === "about:blank").length).toBeGreaterThan(0);
		const popout = obsidian.context.pages().find((p) => p.url() === "about:blank" && p !== page);
		const field = popout.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline) math-field").first();
		await expect(field).toBeVisible();

		// Formulas in a popout window get MathLive's styles, so its buttons don't cover each other.
		const toggles = await field.evaluate((element) => {
			const box = (part) => element.shadowRoot.querySelector(`[part=${part}]`).getBoundingClientRect();
			return { keyboard: box("virtual-keyboard-toggle").right, menu: box("menu-toggle").left };
		});
		expect(toggles.keyboard).toBeLessThanOrEqual(toggles.menu);

		await focusField(field);
		await field.locator("[part=virtual-keyboard-toggle]").click();
		await expect(popout.locator("body > .ML__keyboard")).toBeVisible();

		await popout.evaluate(() => {
			window.close();
			return true;
		}).catch(() => {});
		await expect.poll(() => popout.isClosed()).toBe(true);

		await page.bringToFront();
		await focusField(blockField(page));
		await blockField(page).locator("[part=virtual-keyboard-toggle]").click();
		await expect(keyboard(page)).toBeVisible();
		await hideKeyboard(page);
	});

	test("#27: with editing at the cursor, only the formula with the cursor is editable", async ({ page }) => {
		await setSettings(page, { editOnlyAtCursor: true });
		const setCursor = (prefix, ch) =>
			page.evaluate(({ prefix, ch }) => {
				const editor = window.app.workspace.activeEditor.editor;
				const line = editor.getValue().split("\n").findIndex((text) => text.startsWith(prefix));
				editor.setCursor({ line, ch });
				return true;
			}, { prefix, ch });

		await setCursor("Plain paragraph", 0);
		await expect(page.locator(".cm-content math-field")).toHaveCount(0);
		// Obsidian draws the formulas, and clicks reach them.
		await expect(page.locator("body")).not.toHaveClass(/mathlive-hide-mathjax-inline/);
		await expect(page.locator(".cm-content span.math .MathJax").first()).toBeVisible();

		await setCursor("Last line", "Last line $\\al".length);
		await expect(page.locator(".cm-content math-field")).toHaveCount(1);
		await expect(inlineField(page, 0)).toHaveJSProperty("value", "\\alpha + \\beta");

		// Editing it works as usual, and other formulas stay drawn meanwhile.
		await focusField(inlineField(page, 0));
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect.poll(() => noteLine(page, "Last line")).toBe("Last line $\\alpha+\\beta+1$ done.");
		await expect(page.locator(".cm-content span.math .MathJax").first()).toBeVisible();

		await setCursor("Plain paragraph", 0);
		await expect(page.locator(".cm-content math-field")).toHaveCount(0);
	});
});

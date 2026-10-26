// Regression tests for the bugs reported in issues #12, #18, #21, #22 and #25.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCANNED_LATEX, startStubScanner } from "./stub-scanner.mjs";
import {
	expect,
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

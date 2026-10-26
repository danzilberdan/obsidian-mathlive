import { SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	clearClipboard,
	expect,
	FORMULA_IMAGE,
	inlineWidget,
	menuItem,
	modalField,
	noteText,
	notices,
	openWidgetMenu,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const overlay = (page) => page.locator(".mathlive-capture-overlay");

// Drags a box on the frozen picture and returns its size in screen pixels.
async function dragBox(page, from, to) {
	await expect(overlay(page)).toBeVisible();
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
	await page.mouse.move(to.x, to.y, { steps: 3 });
	await expect(page.locator(".mathlive-capture-box")).toBeVisible();
	await page.mouse.up();
	return page.evaluate(
		({ width, height }) => ({ width: Math.round(width * window.devicePixelRatio), height: Math.round(height * window.devicePixelRatio) }),
		{ width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
	);
}

const setCursor = (page, line, ch) =>
	page.evaluate(
		({ line, ch }) => {
			window.app.workspace.activeEditor.editor.setCursor({ line, ch });
			return true;
		},
		{ line, ch }
	);

const noteValue = (page) =>
	page.evaluate(() => window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue());

// Scans go to a stub of the self-hosted scanner on localhost:8502.
test.describe("scanning a formula from the screen", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: true, apiKey: "" });
	});

	test.afterEach(async ({ page }) => {
		// Close the image a test opened next to the note.
		await page.evaluate(() => {
			for (const leaf of window.app.workspace.getLeavesOfType("image")) {
				leaf.detach();
			}
			return true;
		});
	});

	test("the command scans the dragged box into the note as a math block", async ({ page, scanner }) => {
		// The line after "Plain paragraph between formulas." is empty.
		await setCursor(page, 9, 0);
		await runCommand(page, "mathlive:scan-screen-area");
		const size = await dragBox(page, { x: 400, y: 200 }, { x: 600, y: 280 });

		await expect(notices(page).filter({ hasText: "Scanned formula added to the note" })).toBeVisible();
		await expect(overlay(page)).toHaveCount(0);
		expect(await noteText(page)).toContain(`Plain paragraph between formulas.\n$$\n${SCANNED_LATEX}\n$$\n`);
		expect(scanner.requests).toHaveLength(1);
		expect(scanner.requests[0]).toMatchObject({ method: "POST", url: "/predict/", hasPng: true });
		expect(scanner.requests[0].pngSize).toEqual(size);
	});

	test("in a line of text the scan goes in as inline math", async ({ page }) => {
		// After "Plain paragraph".
		await setCursor(page, 8, 15);
		await runCommand(page, "mathlive:scan-screen-area");
		await dragBox(page, { x: 600, y: 300 }, { x: 420, y: 220 });
		await expect.poll(() => noteText(page)).toContain(`Plain paragraph$${SCANNED_LATEX}$ between formulas.`);
	});

	test("inside a formula the scan goes in without extra dollar signs", async ({ page }) => {
		// Inside $x^2 + y^2 = z^2$, after "x^2".
		await setCursor(page, 2, 16);
		await runCommand(page, "mathlive:scan-screen-area");
		await dragBox(page, { x: 400, y: 200 }, { x: 600, y: 280 });
		await expect.poll(() => noteText(page)).toContain(`Inline math $x^2${SCANNED_LATEX} + y^2 = z^2$ in a sentence.`);
	});

	test("pressed over an image next to the note, the scan goes into the note", async ({ page, scanner }) => {
		// The empty line under the title.
		await setCursor(page, 1, 0);
		await page.evaluate(async (bytes) => {
			const app = window.app;
			const file =
				app.vault.getAbstractFileByPath("formula.png") ??
				(await app.vault.createBinary("formula.png", new Uint8Array(bytes).buffer));
			const leaf = app.workspace.getLeaf("split");
			await leaf.openFile(file);
			app.workspace.setActiveLeaf(leaf, { focus: true });
			return true;
		}, [...(await import("node:fs")).readFileSync(FORMULA_IMAGE)]);
		await expect(page.locator(".workspace-leaf.mod-active .image-container img")).toBeVisible();

		const image = await page.locator(".workspace-leaf.mod-active .image-container img").boundingBox();
		await runCommand(page, "mathlive:scan-screen-area");
		await dragBox(page, { x: image.x - 4, y: image.y - 4 }, { x: image.x + image.width + 4, y: image.y + image.height + 4 });

		await expect(notices(page).filter({ hasText: "Scanned formula added to the note" })).toBeVisible();
		await expect.poll(() => noteValue(page)).toContain(`# Test note\n$$\n${SCANNED_LATEX}\n$$\n`);
		expect(scanner.requests).toHaveLength(1);
	});

	test("Escape cancels without scanning", async ({ page, scanner }) => {
		const before = await noteText(page);
		await runCommand(page, "mathlive:scan-screen-area");
		await expect(overlay(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(overlay(page)).toHaveCount(0);
		expect(await noteText(page)).toBe(before);
		expect(scanner.requests).toHaveLength(0);
	});

	test("a click without dragging cancels", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:scan-screen-area");
		await expect(overlay(page)).toBeVisible();
		await page.mouse.click(500, 300);
		await expect(overlay(page)).toHaveCount(0);
		expect(scanner.requests).toHaveLength(0);
	});

	test("the editor window steps aside while the box is drawn, then gets the scan", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-screen-button").click();
		await expect(overlay(page)).toBeVisible();
		await expect(page.locator(".modal-container")).toBeHidden();

		await dragBox(page, { x: 400, y: 200 }, { x: 600, y: 280 });
		await expect(page.locator(".modal-container")).toBeVisible();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		await expect(notices(page).filter({ hasText: "Scan added to the formula" })).toBeVisible();
		expect(scanner.requests).toHaveLength(1);
	});

	test("Escape cancels the box but leaves the editor window open", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-screen-button").click();
		await expect(overlay(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(overlay(page)).toHaveCount(0);
		await expect(page.locator(".modal-container")).toBeVisible();
		expect(scanner.requests).toHaveLength(0);
	});

	test("Scan from screen in a formula's ⋮ menu adds the scan to that formula", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Scan from screen").click();
		await dragBox(page, { x: 400, y: 200 }, { x: 600, y: 280 });
		await expect(notices(page).filter({ hasText: "Scan added to the formula" })).toBeVisible();
		await expect.poll(() => noteText(page)).toContain(`Inline math $x^2 + y^2 = z^2${SCANNED_LATEX}$ in a sentence.`);
	});

	test("an empty clipboard offers to select the formula on screen", async ({ page, scanner }) => {
		await clearClipboard(page);
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		const notice = notices(page).filter({ hasText: "No image found in clipboard." });
		await notice.getByRole("button", { name: "Select on screen" }).click();

		await dragBox(page, { x: 400, y: 200 }, { x: 600, y: 280 });
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(scanner.requests).toHaveLength(1);
	});

	test("the cloud scanner without an API key asks for one before showing the box", async ({ page, scanner }) => {
		await setSettings(page, { useLocalInference: false, apiKey: "" });
		await runCommand(page, "mathlive:scan-screen-area");
		await expect(notices(page).filter({ hasText: /configure your API key/ })).toBeVisible();
		await expect(overlay(page)).toHaveCount(0);
		expect(scanner.requests).toHaveLength(0);
	});
});

import fs from "node:fs";
import { SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	expect,
	FORMULA_IMAGE,
	blockWidget,
	menuItem,
	noteText,
	notices,
	openWidgetMenu,
	inlineWidget,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const CLOUD = "http://127.0.0.1:8502";
const VERSION = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")).version;

const scans = (scanner) => scanner.requests.filter((request) => request.url === "/predict/");

// Puts formula.png in the vault and embeds it in the note under the first paragraph.
async function embedImage(page) {
	const bytes = [...fs.readFileSync(FORMULA_IMAGE)];
	await page.evaluate(async (bytes) => {
		const app = window.app;
		if (!app.vault.getAbstractFileByPath("formula.png")) {
			await app.vault.createBinary("formula.png", new Uint8Array(bytes).buffer);
		}
		const editor = app.workspace.activeEditor.editor;
		editor.replaceRange("![[formula.png]]\n\n", { line: 2, ch: 0 });
		editor.setCursor({ line: 0, ch: 0 });
		return true;
	}, bytes);
}

test.describe("scanning photos and images in notes", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: false, apiKey: "device-key", cloudScannerUrl: CLOUD });
	});

	test("Scan formula from an image in this note puts the formula under the image", async ({ page, scanner }) => {
		await embedImage(page);
		await runCommand(page, "mathlive:scan-note-image");

		await expect(notices(page).filter({ hasText: "Scanned formula added under the image" })).toBeVisible();
		expect(await noteText(page)).toContain(`![[formula.png]]\n\n$$\n${SCANNED_LATEX}\n$$\n`);
		expect(scans(scanner)).toHaveLength(1);
		expect(scans(scanner)[0]).toMatchObject({
			apiKey: "device-key",
			hasPng: true,
			client: { platform: "linux", version: VERSION, source: "note-image" },
		});
	});

	test("a note without images says so and sends nothing", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:scan-note-image");
		await expect(notices(page).filter({ hasText: "This note has no images" })).toBeVisible();
		expect(scans(scanner)).toHaveLength(0);
	});

	test("right-clicking an image's line offers Scan this image", async ({ page, scanner }) => {
		await embedImage(page);
		// In source mode the embed is text, so the right-click opens the note's own menu.
		await page.evaluate(async () => {
			const leaf = window.app.workspace.activeLeaf;
			await leaf.setViewState({ type: "markdown", state: { file: "Test.md", mode: "source", source: true } });
			return true;
		});
		await page.locator(".cm-line", { hasText: "Plain paragraph" }).click({ button: "right" });
		await expect(menuItem(page, "Find a formula")).toBeVisible();
		await expect(menuItem(page, "Scan this image with MathLive")).toHaveCount(0);
		await page.keyboard.press("Escape");

		// Like a long-press on a phone, which puts the cursor in the line before the menu opens.
		const imageLine = page.locator(".cm-line", { hasText: "![[formula.png]]" });
		await imageLine.click({ position: { x: 40, y: 8 } });
		await imageLine.click({ button: "right", position: { x: 40, y: 8 } });
		await menuItem(page, "Scan this image with MathLive").click();
		await expect(notices(page).filter({ hasText: "Scanned formula added under the image" })).toBeVisible();
		expect(await noteText(page)).toContain(`![[formula.png]]\n\n$$\n${SCANNED_LATEX}\n$$\n`);
		expect(scans(scanner)).toHaveLength(1);
	});

	test("Scan formula from an image file opens the picker and inserts at the cursor", async ({ page, scanner }) => {
		await page.evaluate(() => {
			window.app.workspace.activeEditor.editor.setCursor({ line: 1, ch: 0 });
			return true;
		});
		const chooser = page.waitForEvent("filechooser");
		await runCommand(page, "mathlive:scan-photo");
		await (await chooser).setFiles(FORMULA_IMAGE);

		await expect(notices(page).filter({ hasText: "Scanned formula added to the note" })).toBeVisible();
		expect((await noteText(page)).split("\n").slice(1, 4)).toEqual(["$$", SCANNED_LATEX, "$$"]);
		expect(scans(scanner)[0].client).toEqual({ platform: "linux", version: VERSION, source: "photo" });
	});

	test("cancelling the picker sends nothing", async ({ page, scanner }) => {
		const chooser = page.waitForEvent("filechooser");
		await runCommand(page, "mathlive:scan-photo");
		await chooser;
		await page.evaluate(() => {
			document.querySelector(".mathlive-image-picker")?.dispatchEvent(new Event("cancel"));
			return true;
		});
		await expect(page.locator(".mathlive-image-picker")).toHaveCount(0);
		expect(scans(scanner)).toHaveLength(0);
	});

	test("on desktop a formula's ✨ menu scans from the screen, not a photo", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await expect(menuItem(page, "Scan from screen")).toBeVisible();
		await expect(menuItem(page, "Scan a photo")).toHaveCount(0);
		await page.keyboard.press("Escape");
	});

	test("the self-hosted scanner gets no device headers", async ({ page, scanner }) => {
		await setSettings(page, { useLocalInference: true, apiKey: "" });
		const chooser = page.waitForEvent("filechooser");
		await runCommand(page, "mathlive:scan-photo");
		await (await chooser).setFiles(FORMULA_IMAGE);
		await expect(notices(page).filter({ hasText: "Scanned formula added to the note" })).toBeVisible();
		expect(scans(scanner)[0].client).toEqual({ platform: null, version: null, source: null });
	});
});

test("on a touch screen a full-line formula's buttons line up with MathLive's", async ({ page }) => {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	try {
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		const boxes = await blockWidget(page).evaluate((widget) => {
			const box = (el) => {
				const { top, left, width, height } = el.getBoundingClientRect();
				return { top: Math.round(top), left: Math.round(left), width: Math.round(width), height: Math.round(height) };
			};
			const shadow = widget.querySelector("math-field").shadowRoot;
			return [
				shadow.querySelector(".ML__virtual-keyboard-toggle"),
				shadow.querySelector(".ML__menu-toggle"),
				...widget.querySelectorAll(".obsidian-mathlive-widget-button"),
			].map(box);
		});
		expect(boxes).toHaveLength(4);
		for (const b of boxes) expect(b).toMatchObject({ top: boxes[0].top, width: 60, height: 60 });
		const gaps = boxes.slice(1).map((b, i) => b.left - (boxes[i].left + boxes[i].width));
		expect(gaps).toEqual([4, 4, 4]);
	} finally {
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await cdp.detach();
	}
});

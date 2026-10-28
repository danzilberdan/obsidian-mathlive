// Playwright fixtures: one Obsidian instance per worker, and a clean note, settings and
// clipboard before every test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { launchObsidian } from "./obsidian.mjs";
import { startStubScanner } from "./stub-scanner.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const NOTE_TEXT = fs.readFileSync(path.join(FIXTURES, "Test.md"), "utf8");
export const FORMULA_IMAGE = path.join(FIXTURES, "formula.png");

export const test = base.extend({
	obsidian: [
		async ({}, use) => {
			const obsidian = await launchObsidian();
			const defaults = await obsidian.page.evaluate(() => ({ ...window.app.plugins.plugins.mathlive.settings }));
			await use({ ...obsidian, defaults });
			await obsidian.close();
		},
		{ scope: "worker", timeout: 180_000 },
	],

	scanner: [
		async ({}, use) => {
			const scanner = await startStubScanner();
			await use(scanner);
			await scanner.close();
		},
		{ scope: "worker" },
	],

	page: async ({ obsidian }, use) => {
		const { page, defaults } = obsidian;
		const errors = [];
		const onConsole = (message) => {
			if (message.type() === "error" && message.text().includes("Plugin failure: mathlive")) {
				errors.push(message.text());
			}
		};
		const onPageError = (error) => {
			if (String(error.stack).includes("plugin:mathlive")) {
				errors.push(error.stack);
			}
		};
		page.on("console", onConsole);
		page.on("pageerror", onPageError);

		await resetApp(page, defaults);
		await use(page);

		page.off("console", onConsole);
		page.off("pageerror", onPageError);
		// A plugin crash fails the test that caused it.
		expect(errors, "MathLive crashed").toEqual([]);
	},
});

export { expect };

async function resetApp(page, defaults) {
	// Close anything a previous test left open. Closing the editor window writes its formula
	// into the note, so the note is reset afterwards.
	await page.evaluate(() => {
		window.app.setting?.close();
		document.querySelectorAll(".notice").forEach((notice) => notice.remove());
		if (window.__e2eOriginalOpen) {
			window.open = window.__e2eOriginalOpen;
			window.__e2eOriginalOpen = undefined;
		}
		return true;
	});
	await expect(async () => {
		if ((await page.locator(".modal-container, .menu").count()) > 0) {
			await page.keyboard.press("Escape");
		}
		await expect(page.locator(".modal-container, .menu")).toHaveCount(0, { timeout: 1000 });
	}).toPass({ timeout: 10_000 });

	await page.evaluate(
		async ({ text, defaults }) => {
			const app = window.app;
			app.changeTheme("moonstone");

			const plugin = app.plugins.plugins.mathlive;
			plugin.account.cancelConnect();
			if (plugin.showRawLatex) {
				plugin.toggleRawLatex();
			}
			plugin.settings = { ...defaults };
			await plugin.saveSettings();

			const file = app.vault.getAbstractFileByPath("Test.md");
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: "source", source: false } });
			app.workspace.setActiveLeaf(leaf, { focus: true });
			const editor = leaf.view.editor;
			editor.setValue(text);
			editor.setCursor({ line: 0, ch: 0 });
			await leaf.view.save();
			return true;
		},
		{ text: NOTE_TEXT, defaults }
	);
	await expect(page.locator(".cm-content math-field")).toHaveCount(3);
}

// Small helpers shared by the specs.

export const noteText = (page) => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue());

export const noteLine = (page, startsWith) =>
	page.evaluate((prefix) => window.app.workspace.activeEditor.editor.getValue().split("\n").find((line) => line.startsWith(prefix)), startsWith);

export const notices = (page) => page.locator(".notice");

// The plugin reads its settings from memory, so tests wait for the save only briefly: right after
// a PDF conversion writes its note, Obsidian has been seen to drop the save's promise unresolved.
export const setSettings = (page, values) =>
	page.evaluate(async (values) => {
		const plugin = window.app.plugins.plugins.mathlive;
		Object.assign(plugin.settings, values);
		await Promise.race([plugin.saveSettings(), new Promise((resolve) => setTimeout(resolve, 2000))]);
		return true;
	}, values);

export const runCommand = (page, id) =>
	page.evaluate((id) => window.app.commands.executeCommandById(id), id);

export const putImageOnClipboard = (page) =>
	page.evaluate((file) => {
		const { clipboard, nativeImage } = window.require("electron");
		clipboard.writeImage(nativeImage.createFromPath(file));
		return clipboard.availableFormats().includes("image/png");
	}, FORMULA_IMAGE);

export const clearClipboard = (page) =>
	page.evaluate(() => {
		window.require("electron").clipboard.clear();
		return true;
	});

export const inlineField = (page, index = 0) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper.inline math-field").nth(index);
export const blockField = (page) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline) math-field").first();
export const modalField = (page) => page.locator("#mathlive-modal-field");
export const inlineWidget = (page, index = 0) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper.inline").nth(index);
export const blockWidget = (page) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline)").first();
export const menuItem = (page, title) => page.locator(".menu .menu-item", { hasText: title });

// A formula's buttons show while the mouse is over it, so point at the formula first.
export async function clickWidgetButton(widget, name) {
	await widget.locator("math-field").hover({ position: { x: 5, y: 5 } });
	await widget.getByRole("button", { name }).click();
}

// Opens a formula's ✨ menu and returns Obsidian's menu.
export async function openWidgetMenu(page, widget) {
	await clickWidgetButton(widget, "AI fill");
	const menu = page.locator(".menu");
	await expect(menu).toBeVisible();
	return menu;
}

// Records the links the plugin opens instead of opening a browser.
export const recordOpenedUrls = (page) =>
	page.evaluate(() => {
		window.__e2eOriginalOpen ??= window.open;
		window.__e2eOpenedUrls = [];
		window.open = (url) => {
			window.__e2eOpenedUrls.push(String(url));
			return null;
		};
		return true;
	});

export const openedUrls = (page) => page.evaluate(() => window.__e2eOpenedUrls ?? []);

// Clicks a formula and waits until it keeps keyboard focus, so typing reaches it. A click
// first lands in the note, and the plugin moves focus into the formula a moment later.
export async function focusField(field) {
	const hasFocus = () => field.evaluate((element) => element.ownerDocument.activeElement === element);
	await field.click();
	await expect(async () => {
		expect(await hasFocus()).toBe(true);
		await field.page().waitForTimeout(300);
		expect(await hasFocus()).toBe(true);
	}).toPass({ timeout: 10_000 });
}

// Waits until the editor window's formula is ready for typing.
export async function waitForModalField(page) {
	const field = modalField(page);
	// hasFocus() can report true before the browser has moved focus, so check the document.
	await expect.poll(() => field.evaluate((element) => element.ownerDocument.activeElement === element)).toBe(true);
	return field;
}

// Waits until the formula editors stop being redrawn, so a click lands on the one that stays.
export async function waitForStableWidgets(page) {
	await expect(page.locator(".cm-content math-field")).toHaveCount(3);
	await page.evaluate(() => {
		document.querySelectorAll(".cm-content math-field").forEach((field) => (field.dataset.e2eMark = "1"));
		return true;
	});
	await expect(async () => {
		await page.waitForTimeout(500);
		const marked = await page.locator(".cm-content math-field[data-e2e-mark]").count();
		if (marked !== 3) {
			await page.evaluate(() => {
				document.querySelectorAll(".cm-content math-field").forEach((field) => (field.dataset.e2eMark = "1"));
				return true;
			});
		}
		expect(marked).toBe(3);
	}).toPass({ timeout: 10_000 });
}

// Widgets draw their toolbar once, so settings that change it need the note opened again.
export const reopenNote = async (page) => {
	await page.evaluate(async () => {
		const leaf = window.app.workspace.getLeaf(false);
		await leaf.rebuildView();
		return true;
	});
	await waitForStableWidgets(page);
};

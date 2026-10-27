// Helpers the Obsidian scenes share.
import path from "node:path";
import { ASSETS } from "../tools/lib.mjs";

export const blockWidgets = (page) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline)");
export const menuItem = (page, title) => page.locator(".menu .menu-item", { hasText: title });
export const notice = (page, text) => page.locator(".notice", { hasText: text });

export const putImageOnClipboard = (page, file = path.join(ASSETS, "clipboard-formula.png")) =>
	page.evaluate((file) => {
		const { clipboard, nativeImage } = window.require("electron");
		clipboard.writeImage(nativeImage.createFromPath(file));
		return true;
	}, file);

export const setSettings = (page, values) =>
	page.evaluate(async (values) => {
		const plugin = window.app.plugins.plugins.mathlive;
		Object.assign(plugin.settings, values);
		await Promise.race([plugin.saveSettings(), new Promise((resolve) => setTimeout(resolve, 2000))]);
		return true;
	}, values);

// Copies the demo lecture into the vault.
export async function addLecture(page, demo) {
	const fs = await import("node:fs");
	const bytes = [...fs.readFileSync(path.join(ASSETS, "lecture.pdf"))];
	await page.evaluate(
		async ({ name, bytes }) => {
			const { vault } = window.app;
			const old = vault.getAbstractFileByPath(name);
			if (old) {
				await vault.delete(old);
			}
			await vault.createBinary(name, new Uint8Array(bytes).buffer);
			return true;
		},
		{ name: demo.lecture.file, bytes }
	);
}

// Puts the cursor at the start of the line after the first line that starts with `text`.
export const cursorAfterLine = (page, text) =>
	page.evaluate((text) => {
		const editor = window.app.workspace.getLeavesOfType("markdown")[0].view.editor;
		const lines = editor.getValue().split("\n");
		const line = lines.findIndex((l) => l.startsWith(text));
		editor.setCursor({ line: line + 1, ch: 0 });
		return true;
	}, text);

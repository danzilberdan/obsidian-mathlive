// Scan from screen: boxing a formula in a lecture PDF that's open beside the note.
import { addLecture, cursorAfterLine, setSettings } from "./shared.mjs";
import { ASSETS, readJson } from "../tools/lib.mjs";
import path from "node:path";

export async function setup({ page, scanner, demo, sleep }) {
	await addLecture(page, demo);
	await page.evaluate(async (name) => {
		const { workspace, vault } = window.app;
		const noteLeaf = workspace.getLeavesOfType("markdown")[0];
		const leaf = workspace.createLeafBySplit(noteLeaf, "vertical");
		await leaf.openFile(vault.getAbstractFileByPath(name));
		workspace.setActiveLeaf(noteLeaf, { focus: true });
		return true;
	}, demo.lecture.file);
	await cursorAfterLine(page, "The first burn:");
	await setSettings(page, { scanOtherApps: false });
	const target = demo.lecture.pages[0].blocks.find((block) => block.target);
	scanner.nextScan(target.latex);
	await page.locator('.pdfViewer .page[data-page-number="1"]').waitFor();
	await sleep(1500);
	await page.evaluate(() => {
		// Fit the slide to the pane's width.
		const viewer = window.app.workspace.getLeavesOfType("pdf")[0].view.viewer.child.pdfViewer;
		const pdfjs = viewer.pdfViewer ?? viewer;
		pdfjs.currentScaleValue = "page-width";
		const editor = window.app.workspace.getLeavesOfType("markdown")[0].view.editor;
		const cursor = editor.getCursor();
		editor.scrollIntoView({ from: cursor, to: cursor }, true);
		return true;
	});
	await sleep(1500);
}

export async function run({ page, say, click, sleep, lineDone, pointAt }) {
	const where = readJson(path.join(ASSETS, "lecture-target.json"));
	await say("scan-screen-1");
	await sleep(400);
	await click(page.locator('.side-dock-ribbon-action[aria-label="Scan formula from screen"]'));
	await page.locator(".mathlive-capture-overlay").waitFor();
	await lineDone();

	await say("scan-screen-2");
	const pdfPage = await page.locator(`.pdfViewer .page[data-page-number="${where.page}"]`).boundingBox();
	const pad = 10;
	const from = { x: pdfPage.x + where.x * pdfPage.width - pad, y: pdfPage.y + where.y * pdfPage.height - pad };
	const to = { x: from.x + where.width * pdfPage.width + 2 * pad, y: from.y + where.height * pdfPage.height + 2 * pad };
	await page.mouse.move(from.x, from.y, { steps: 30 });
	await sleep(300);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 40 });
	await sleep(300);
	await page.mouse.up();
	await lineDone();

	await say("scan-screen-3");
	await sleep(500);
	await pointAt(page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline)").last(), { steps: 30 });
}

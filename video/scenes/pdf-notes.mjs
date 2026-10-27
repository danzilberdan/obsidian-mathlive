// PDF to notes: the whole lecture becomes a Markdown note with LaTeX.
import { addLecture, menuItem } from "./shared.mjs";

export async function setup({ page, scanner, demo, sleep }) {
	await addLecture(page, demo);
	scanner.resetPages();
	scanner.state.pageDelayMs = 1500;
	await page.evaluate(async () => {
		const { workspace } = window.app;
		const leaf = workspace.getLeftLeaf(false);
		await leaf.setViewState({ type: "file-explorer" });
		workspace.leftSplit.expand();
		workspace.revealLeaf(leaf);
		return true;
	});
	await sleep(1000);
}

export async function run({ page, demo, say, click, sleep, lineDone }) {
	const modal = page.locator(".mathlive-pdf-modal");
	await say("pdf-notes-1");
	const file = page.locator(`.nav-file-title[data-path="${demo.lecture.file}"]`);
	await click(file);
	await sleep(300);
	const box = await file.boundingBox();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
	await sleep(700);
	await click(menuItem(page, "Convert to notes with MathLive"));
	await modal.waitFor();
	await lineDone();

	await say("pdf-notes-2");
	await click(modal.getByRole("button", { name: "Convert", exact: true }));
	await page.locator(".mathlive-pdf-status", { hasText: "Read 3 of 3 pages" }).waitFor({ timeout: 30_000 });
	await lineDone();

	await say("pdf-notes-3");
	await click(modal.getByRole("button", { name: "Open note", exact: true }));
	await sleep(1500);
	await page.mouse.wheel(0, 300);
}

export async function teardown({ page, scanner }) {
	scanner.state.pageDelayMs = 1200;
	await page.evaluate(() => {
		window.app.workspace.leftSplit.collapse();
		return true;
	});
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_MARKDOWN } from "./stub-scanner.mjs";
import { expect, runCommand, setSettings, test } from "./fixtures.mjs";

const PDF = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "Lecture.pdf"));

const modal = (page) => page.locator(".mathlive-pdf-modal");
const status = (page) => modal(page).locator(".mathlive-pdf-status");
const button = (page, name) => modal(page).getByRole("button", { name, exact: true });
const readNote = (page, notePath) =>
	page.evaluate(async (notePath) => {
		const file = window.app.vault.getAbstractFileByPath(notePath);
		return file ? await window.app.vault.read(file) : null;
	}, notePath);

const pageSection = (n) => `[[Lecture.pdf#page=${n}|Page ${n}]]\n\n${PAGE_MARKDOWN}\n`;
const failureNote = (n) => `> [!warning] MathLive couldn't read page ${n}`;

// Pages go to a stub of the self-hosted scanner on localhost:8502, which reads every page with
// text as PAGE_MARKDOWN and the fixture's blank page 2 as blank.
test.describe("converting a PDF to notes", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: true, apiKey: "" });
		await page.evaluate(async (bytes) => {
			const { vault } = window.app;
			for (const file of vault.getFiles().filter((f) => f.path.startsWith("Lecture"))) {
				await vault.delete(file);
			}
			await vault.createBinary("Lecture.pdf", new Uint8Array(bytes).buffer);
			return true;
		}, [...PDF]);
	});

	// Other specs expect the one tab with Test.md that they start with.
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => {
			const { workspace } = window.app;
			const leaves = ["markdown", "pdf", "file-explorer"].flatMap((type) => workspace.getLeavesOfType(type));
			for (const leaf of leaves) {
				const file = leaf.getViewState().state?.file;
				if (leaf.view.getViewType() === "file-explorer" || file?.startsWith("Lecture")) {
					leaf.detach();
				}
			}
			return true;
		});
		await expect(page.locator(".workspace-tab-header", { hasText: "Lecture" })).toHaveCount(0);
	});

	test("an open PDF has a button in its header that converts it", async ({ page }) => {
		await page.evaluate(async () => {
			await window.app.workspace.getLeaf("tab").openFile(window.app.vault.getAbstractFileByPath("Lecture.pdf"));
			return true;
		});
		const action = page.locator(".workspace-leaf.mod-active .mathlive-pdf-convert-action");
		await expect(action).toHaveAttribute("aria-label", "Convert to notes with MathLive");
		await action.click();
		await expect(modal(page)).toContainText("Lecture.pdf");
		await expect(button(page, "Convert")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(modal(page)).toHaveCount(0);
	});

	test("the ribbon's ✨ menu converts a PDF to notes", async ({ page }) => {
		await page.locator('.side-dock-ribbon-action[aria-label="MathLive"]').click();
		await expect(page.locator(".menu .menu-item-title")).toHaveText(["Scan formula from screen", "Draw formula", "Convert a PDF to notes"]);
		await page.locator(".menu .menu-item", { hasText: "Convert a PDF to notes" }).click();
		// No PDF is open, so it asks for one first.
		await expect(page.locator(".prompt")).toBeVisible();
		await page.keyboard.press("Escape");
	});

	test("the PDF's file menu turns it into a note in page order, without blank pages", async ({ page, scanner }) => {
		await page.evaluate(async () => {
			const leaf = window.app.workspace.getLeftLeaf(false);
			await leaf.setViewState({ type: "file-explorer" });
			window.app.workspace.revealLeaf(leaf);
			return true;
		});
		await page.locator('.nav-file-title[data-path="Lecture.pdf"]').click({ button: "right" });
		await page.locator(".menu .menu-item", { hasText: "Convert to notes with MathLive" }).click();

		await expect(modal(page)).toContainText("Lecture.pdf has 3 pages.");
		await expect(modal(page)).toContainText("Reads 3 pages with your self-hosted scanner.");
		await button(page, "Convert").click();

		await expect(status(page)).toHaveText("Read 2 of 3 pages. 1 blank, not charged.", { timeout: 30_000 });
		expect(await readNote(page, "Lecture.md")).toBe(
			`---\nsource: "[[Lecture.pdf]]"\n---\n\n${pageSection(1)}\n${pageSection(3)}`
		);
		const pages = scanner.requests.filter((request) => request.url === "/pages/");
		expect(pages).toHaveLength(3);
		for (const request of pages) {
			expect(request.hasPng).toBe(true);
			// A4 rendered at 2048 px on its long side.
			expect(Math.max(request.pngSize.width, request.pngSize.height)).toBe(2048);
		}

		await button(page, "Open note").click();
		await expect(modal(page)).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.app.workspace.getActiveFile()?.path)).toBe("Lecture.md");
	});

	test("the command converts the open PDF, only the pages asked for, into a new note", async ({ page, scanner }) => {
		await page.evaluate(async () => {
			await window.app.vault.create("Lecture.md", "My own notes");
			const file = window.app.vault.getAbstractFileByPath("Lecture.pdf");
			await window.app.workspace.getLeaf("tab").openFile(file);
			return true;
		});
		await runCommand(page, "mathlive:convert-pdf-to-notes");

		await modal(page).getByLabel("First page").fill("3");
		await expect(modal(page)).toContainText("Reads 1 page with your self-hosted scanner.");
		await button(page, "Convert").click();

		await expect(status(page)).toHaveText("Read 1 of 1 page.", { timeout: 30_000 });
		expect(await readNote(page, "Lecture.md")).toBe("My own notes");
		expect(await readNote(page, "Lecture 1.md")).toBe(`---\nsource: "[[Lecture.pdf]]"\n---\n\n${pageSection(3)}`);
		expect(scanner.requests.filter((request) => request.url === "/pages/")).toHaveLength(1);
	});

	test("a scanner from before pages says so and writes nothing", async ({ page }) => {
		await setSettings(page, { apiKey: "old-scanner" });
		await runCommand(page, "mathlive:convert-pdf-to-notes");
		// No PDF is open, so the command asks for one first.
		await page.keyboard.type("Lecture");
		await page.keyboard.press("Enter");
		await button(page, "Convert").click();

		await expect(status(page)).toContainText("Your self-hosted scanner can't read whole pages.");
		expect(await readNote(page, "Lecture.md")).toBeNull();
	});

	test("pages that fail are marked in the note and a retry fills them in", async ({ page }) => {
		test.setTimeout(90_000);
		await setSettings(page, { apiKey: "pages-down" });
		await runCommand(page, "mathlive:convert-pdf-to-notes");
		await page.keyboard.type("Lecture");
		await page.keyboard.press("Enter");
		await button(page, "Convert").click();

		await expect(status(page)).toHaveText("Read 0 of 3 pages. 3 couldn't be read and are marked in the note.", {
			timeout: 60_000,
		});
		const failed = await readNote(page, "Lecture.md");
		for (const n of [1, 2, 3]) {
			expect(failed).toContain(failureNote(n));
		}

		await setSettings(page, { apiKey: "" });
		await button(page, "Retry failed pages").click();
		await expect(status(page)).toHaveText("Read 2 of 3 pages. 1 blank, not charged.", { timeout: 30_000 });
		const note = await readNote(page, "Lecture.md");
		expect(note).toContain(pageSection(1));
		expect(note).toContain(pageSection(3));
		expect(note).not.toContain("[!warning]");
		expect(note.indexOf("page=1")).toBeLessThan(note.indexOf("page=3"));
	});

	test("running out of scans stops the conversion and offers to continue", async ({ page }) => {
		await setSettings(page, { apiKey: "no-scans-left" });
		await runCommand(page, "mathlive:convert-pdf-to-notes");
		await page.keyboard.type("Lecture");
		await page.keyboard.press("Enter");
		await button(page, "Convert").click();

		await expect(status(page)).toContainText("You've used all your free scans.");
		await expect(status(page)).toContainText("3 pages are still to do.");
		await expect(button(page, "Continue")).toBeVisible();
		expect(await readNote(page, "Lecture.md")).toBeNull();

		await setSettings(page, { apiKey: "" });
		await button(page, "Continue").click();
		await expect(status(page)).toHaveText("Read 2 of 3 pages. 1 blank, not charged.", { timeout: 30_000 });
	});

	test("a PDF longer than the pages left converts only what's left and offers more", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "two-pages-left" });
		await runCommand(page, "mathlive:convert-pdf-to-notes");
		await page.keyboard.type("Lecture");
		await page.keyboard.press("Enter");

		await expect(modal(page).locator(".mathlive-pdf-cost")).toHaveText(
			"These are 3 pages. You have 2 pages left this month. Your pages start again on November 1."
		);
		await expect(button(page, "Get more pages")).toBeVisible();
		// Picking pages that fit gives the ordinary quote back.
		await modal(page).getByLabel("Last page").fill("1");
		await expect(modal(page).locator(".mathlive-pdf-cost")).toHaveText(
			"Reads 1 page. Blank pages are free. You have 2 pages left this month."
		);
		await expect(button(page, "Get more pages")).toBeHidden();
		await modal(page).getByLabel("Last page").fill("3");

		await button(page, "Convert the first 2").click();
		await expect(status(page)).toHaveText("Read 1 of 2 pages. 1 blank, not charged.", { timeout: 30_000 });
		expect(scanner.requests.filter((request) => request.url === "/pages/")).toHaveLength(2);
		expect(await readNote(page, "Lecture.md")).toBe(`---\nsource: "[[Lecture.pdf]]"\n---\n\n${pageSection(1)}`);
	});

	test("running out of pages stops the conversion and offers more", async ({ page }) => {
		await setSettings(page, { apiKey: "page-limit" });
		await runCommand(page, "mathlive:convert-pdf-to-notes");
		await page.keyboard.type("Lecture");
		await page.keyboard.press("Enter");
		await button(page, "Convert").click();

		await expect(status(page)).toHaveText(
			"You've used this month's pages. 3 pages are still to do. Get more pages, or continue when your pages start again."
		);
		await expect(button(page, "Continue")).toBeVisible();
		await expect(button(page, "Get more pages")).toBeVisible();
		expect(await readNote(page, "Lecture.md")).toBeNull();
	});
});

import { DRAWN_LATEX, SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	expect,
	focusField,
	inlineField,
	inlineWidget,
	menuItem,
	noteText,
	notices,
	openWidgetMenu,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const CLOUD = "http://127.0.0.1:8502";
const drawWindow = (page) => page.locator(".mathlive-draw-modal");
const pad = (page) => drawWindow(page).locator("canvas.mathlive-draw-pad");
const preview = (page) => drawWindow(page).locator("math-field.mathlive-draw-field");

// A few strokes on the pad, like a hand-drawn ½.
async function drawOnPad(page) {
	const box = await pad(page).boundingBox();
	const stroke = async (points) => {
		await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
		await page.mouse.down();
		for (const [x, y] of points.slice(1)) {
			await page.mouse.move(box.x + x, box.y + y, { steps: 5 });
		}
		await page.mouse.up();
	};
	await stroke([[200, 40], [210, 30], [210, 90]]);
	await stroke([[170, 120], [260, 120]]);
	await stroke([[190, 150], [230, 150], [190, 210], [235, 210]]);
}

// Puts the cursor on an empty line at the end of the note, where a drawn formula becomes a block.
async function cursorOnEmptyLine(page) {
	await page.evaluate(() => {
		const editor = window.app.workspace.activeEditor.editor;
		editor.setValue(editor.getValue().replace(/\n*$/, "\n\n"));
		editor.setCursor({ line: editor.lineCount() - 1, ch: 0 });
		return true;
	});
}

test.describe("Draw formula", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		scanner.draw.reset();
		// Forget a code an earlier test left waiting: the stub no longer knows it.
		await page.evaluate(() => {
			window.app.plugins.plugins.mathlive.phoneLink.stop();
			return true;
		});
		await setSettings(page, { useLocalInference: false, apiKey: "device-key", apiKeySource: "device", cloudScannerUrl: CLOUD });
	});

	test("drawing on the pad previews the formula, and Insert puts it in the note for one scan", async ({ page, scanner }) => {
		await cursorOnEmptyLine(page);
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page)).toBeVisible();
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toBeVisible();

		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		const session = scanner.draw.latest();
		expect(session.recognized.length).toBeGreaterThanOrEqual(1);
		// The picture fits what the handwriting models read best.
		const { width, height } = session.recognized.at(-1).pngSize;
		expect(Math.max(width, height)).toBeLessThanOrEqual(1024);
		expect(Math.min(width, height)).toBeGreaterThanOrEqual(300);
		expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(2.01);
		expect(scanner.draw.charged).toBe(0);

		await drawWindow(page).getByRole("button", { name: "Insert" }).click();
		await expect(drawWindow(page)).toHaveCount(0);
		await expect.poll(() => noteText(page)).toContain(`$$\n${DRAWN_LATEX}\n$$`);
		expect(scanner.draw.charged).toBe(1);
		expect(session.closed).toBe(true);
	});

	test("a phone pairs once from the QR code, then its formulas go wherever you are, even after a restart", async ({ page, scanner }) => {
		await cursorOnEmptyLine(page);
		await runCommand(page, "mathlive:draw-formula");
		const qr = drawWindow(page).locator(".mathlive-draw-qr");
		await expect(qr).toBeVisible();
		const pairing = scanner.draw.latestPairing();
		await expect(qr).toHaveAttribute("data-url", pairing.phoneUrl);

		const phone = await scanner.draw.phone(pairing);
		expect(phone.claimed.status).toBe(200);
		expect(phone.claimed.body.paired).toBe(true);
		await expect(drawWindow(page).locator(".mathlive-draw-phone-note")).toHaveText(/Paired with your iPhone/);
		await expect.poll(() => page.evaluate(() => window.app.plugins.plugins.mathlive.settings.drawPairing?.id)).toBe(pairing.id);
		// A second phone can't use the same code.
		expect((await scanner.draw.phone(pairing)).claimed.status).toBe(409);

		// With the window open, the phone's preview shows there and Insert fills the window's formula.
		expect((await phone.draw()).status).toBe(200);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		expect(scanner.draw.charged).toBe(0);
		const started = Date.now();
		expect((await phone.insert()).status).toBe(200);
		await expect.poll(() => noteText(page), { timeout: 3000 }).toContain(`$$\n${DRAWN_LATEX}\n$$`);
		expect(Date.now() - started).toBeLessThan(3000);
		await expect(drawWindow(page)).toHaveCount(0);
		expect(scanner.draw.charged).toBe(1);

		// No window: the next formula goes in at the note's cursor, with no new code.
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setCursor({ line: editor.lineCount() - 1, ch: editor.getLine(editor.lineCount() - 1).length });
			editor.replaceSelection(" and ");
			return true;
		});
		expect((await phone.draw()).status).toBe(200);
		expect((await phone.insert()).status).toBe(200);
		await expect.poll(() => noteText(page)).toContain(` and $${DRAWN_LATEX}$`);
		await expect(notices(page).filter({ hasText: "Formula from your phone added" }).first()).toBeVisible();

		// Into the formula being edited, at its cursor.
		await focusField(inlineField(page, 0));
		await inlineField(page, 0).evaluate((field) => {
			field.position = field.lastOffset;
		});
		const formulaBefore = await inlineField(page, 0).evaluate((field) => field.value);
		expect((await phone.draw()).status).toBe(200);
		expect((await phone.insert()).status).toBe(200);
		// MathLive writes the drawn \frac{1}{2} its own way, as \frac12.
		await expect.poll(() => inlineField(page, 0).evaluate((field) => field.value)).toMatch(/^x\^2\+y\^2=z\^2\\frac/);
		const formulaAfter = await inlineField(page, 0).evaluate((field) => field.value);
		expect(formulaAfter.length).toBeGreaterThan(formulaBefore.replace(/\s/g, "").length);
		await expect.poll(() => noteText(page)).toContain(`$${formulaAfter}$`);
		expect(scanner.draw.charged).toBe(3);

		// Obsidian restarts (the plugin turned off and on): still paired, no code to scan.
		await page.evaluate(() => window.app.plugins.disablePlugin("mathlive").then(() => true));
		await page.evaluate(() => window.app.plugins.enablePlugin("mathlive").then(() => true));
		await expect.poll(() => page.evaluate(() => window.app.plugins.plugins.mathlive?.settings.drawPairing?.id)).toBe(pairing.id);
		await cursorOnEmptyLine(page);
		const before = await noteText(page);
		await expect
			.poll(
				async () => {
					// The plugin needs a moment to start listening again.
					if ((await noteText(page)) === before) {
						await phone.draw();
						await phone.insert();
					}
					return (await noteText(page)).length > before.length;
				},
				{ timeout: 15_000 }
			)
			.toBe(true);
		expect(await noteText(page)).toContain(`$$\n${DRAWN_LATEX}\n$$`);

		// The window shows the paired phone instead of a code.
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page).locator(".mathlive-draw-phone-note")).toHaveText(/Paired with your iPhone/);
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toHaveCount(0);

		// Unpair: the phone's page stops working, and the window offers a new code.
		await drawWindow(page).getByRole("button", { name: "Unpair" }).click();
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toBeVisible();
		await expect.poll(async () => (await phone.draw()).status).toBe(410);
		expect(await page.evaluate(() => window.app.plugins.plugins.mathlive.settings.drawPairing)).toBeNull();
	});

	test("unpairing on the phone tells Obsidian, and a new phone replaces the old one", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toBeVisible();
		const first = await scanner.draw.phone(scanner.draw.latestPairing());
		await expect(drawWindow(page).locator(".mathlive-draw-phone-note")).toHaveText(/Paired/);
		await page.keyboard.press("Escape");

		// Pairing another phone, from the settings' Pair a phone window, ends the first.
		await page.evaluate(() => window.app.plugins.plugins.mathlive.phoneLink.newCode().then(() => true));
		const second = await scanner.draw.phone(scanner.draw.latestPairing());
		expect(second.claimed.status).toBe(200);
		await expect.poll(async () => (await first.draw()).status).toBe(410);
		await expect.poll(() => page.evaluate(() => window.app.plugins.plugins.mathlive.settings.drawPairing?.id)).toBe(
			scanner.draw.latestPairing().id
		);
		await expect(notices(page).filter({ hasText: "Your phone was unpaired" })).toHaveCount(0);

		// The phone unpairs itself: Obsidian forgets it, and says so.
		expect((await second.done()).status).toBe(204);
		await expect.poll(() => page.evaluate(() => window.app.plugins.plugins.mathlive.settings.drawPairing)).toBeNull();
		await expect(notices(page).filter({ hasText: "Your phone was unpaired" })).toBeVisible();
	});

	test("closing the window ends the pad's session, and its code still pairs a phone", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toBeVisible();
		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		const session = scanner.draw.latest();
		const pairing = scanner.draw.latestPairing();
		await page.keyboard.press("Escape");
		await expect(drawWindow(page)).toHaveCount(0);
		await expect.poll(() => session.closed).toBe(true);
		const phone = await scanner.draw.phone(pairing);
		expect(phone.claimed.status).toBe(200);
		await expect(notices(page).filter({ hasText: "Phone paired" })).toBeVisible();
		expect(scanner.draw.charged).toBe(0);
	});

	test("the settings pair a phone and unpair it", async ({ obsidian, page, scanner }) => {
		await page.evaluate(() => {
			window.app.setting.open();
			window.app.setting.openTabById("mathlive");
			return true;
		});
		// Settings open in a window of their own, or inside the main window.
		const rowIn = (candidate) => candidate.locator(".setting-item", { hasText: "Draw on your phone" });
		let settingsWindow;
		await expect
			.poll(async () => {
				for (const candidate of obsidian.context.pages()) {
					if ((await rowIn(candidate).count()) > 0) {
						settingsWindow = candidate;
						return true;
					}
				}
				return false;
			})
			.toBe(true);
		const row = rowIn(settingsWindow);
		await row.getByRole("button", { name: "Pair a phone" }).click();
		let modal;
		await expect
			.poll(async () => {
				for (const candidate of obsidian.context.pages()) {
					if ((await candidate.locator(".mathlive-pair-modal .mathlive-draw-qr").count()) > 0) {
						modal = candidate.locator(".mathlive-pair-modal");
						return true;
					}
				}
				return false;
			})
			.toBe(true);
		await scanner.draw.phone(scanner.draw.latestPairing());
		await expect(modal.locator(".mathlive-draw-phone-note").first()).toHaveText(/Paired with your iPhone/);
		await modal.page().keyboard.press("Escape");
		await expect(modal).toHaveCount(0);
		await expect(row).toContainText("Paired with your iPhone");
		await row.getByRole("button", { name: "Unpair" }).click();
		await expect(row.getByRole("button", { name: "Pair a phone" })).toBeVisible();
		await page.evaluate(() => {
			window.app.setting.close();
			return true;
		});
	});

	test("out of scans keeps the drawing and offers more scans", async ({ page, scanner }) => {
		scanner.draw.scansLeft = 0;
		await runCommand(page, "mathlive:draw-formula");
		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		await drawWindow(page).getByRole("button", { name: "Insert" }).click();
		const upgrade = page.locator(".mathlive-upgrade-modal");
		await expect(upgrade.locator(".modal-title")).toHaveText("You're out of free scans");
		await upgrade.getByRole("button", { name: /^Wait until / }).click();
		await expect(upgrade).toHaveCount(0);
		await expect(drawWindow(page)).toBeVisible();
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		expect(scanner.draw.charged).toBe(0);
	});

	test("the ribbon's ✨ menu opens Draw formula", async ({ page }) => {
		await page.locator('.side-dock-ribbon-action[aria-label="MathLive"]').click();
		await page.locator(".menu .menu-item", { hasText: "Draw formula" }).click();
		await expect(drawWindow(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(drawWindow(page)).toHaveCount(0);
	});

	test("the formula's ✨ menu draws into that formula", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Draw formula").click();
		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		await drawWindow(page).getByRole("button", { name: "Insert" }).click();
		await expect(inlineField(page, 0)).toHaveJSProperty("value", `x^2 + y^2 = z^2${DRAWN_LATEX}`);
	});

	test("with a self-hosted scanner there's no QR code, and the pad is read there for free", async ({ page, scanner }) => {
		await setSettings(page, { useLocalInference: true, apiKey: "" });
		await cursorOnEmptyLine(page);
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page)).toBeVisible();
		await expect(drawWindow(page).locator(".mathlive-draw-phone")).toHaveCount(0);
		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", SCANNED_LATEX);
		await drawWindow(page).getByRole("button", { name: "Insert" }).click();
		await expect.poll(() => noteText(page)).toContain(`$$\n${SCANNED_LATEX}\n$$`);
		expect(scanner.requests.filter((request) => request.url.startsWith("/draw"))).toHaveLength(0);
		expect(scanner.requests.filter((request) => request.url === "/predict/").length).toBeGreaterThanOrEqual(1);
	});
});

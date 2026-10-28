import { DRAWN_LATEX, SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	expect,
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

	test("a phone that scanned the QR code draws, previews on the computer, and inserts", async ({ page, scanner }) => {
		await cursorOnEmptyLine(page);
		await runCommand(page, "mathlive:draw-formula");
		const qr = drawWindow(page).locator(".mathlive-draw-qr");
		await expect(qr).toBeVisible();
		const session = scanner.draw.latest();
		await expect(qr).toHaveAttribute("data-url", session.phoneUrl);

		const phone = await scanner.draw.phone(session);
		expect(phone.claimed.status).toBe(200);
		await expect(drawWindow(page).locator(".mathlive-draw-phone-note")).toHaveText(/Phone connected/);
		// A second phone can't use the same link.
		expect((await scanner.draw.phone(session)).claimed.status).toBe(409);

		expect((await phone.draw()).status).toBe(200);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		expect(scanner.draw.charged).toBe(0);

		// From Insert on the phone to the formula in the note in under 3 seconds.
		const started = Date.now();
		expect((await phone.insert()).status).toBe(200);
		await expect.poll(() => noteText(page), { timeout: 3000 }).toContain(`$$\n${DRAWN_LATEX}\n$$`);
		expect(Date.now() - started).toBeLessThan(3000);
		await expect(drawWindow(page)).toHaveCount(0);
		await expect(notices(page).filter({ hasText: "Formula from your phone added." })).toBeVisible();
		expect(scanner.draw.charged).toBe(1);

		// The phone can draw another, which goes to the note too.
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setCursor({ line: editor.lineCount() - 1, ch: editor.getLine(editor.lineCount() - 1).length });
			editor.replaceSelection(" and ");
			return true;
		});
		expect((await phone.draw()).status).toBe(200);
		expect((await phone.insert()).status).toBe(200);
		await expect.poll(() => noteText(page)).toContain(` and $${DRAWN_LATEX}$`);
		expect(scanner.draw.charged).toBe(2);

		expect((await phone.done()).status).toBe(204);
	});

	test("closing the window ends the phone's session", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:draw-formula");
		await expect(drawWindow(page).locator(".mathlive-draw-qr")).toBeVisible();
		const phone = await scanner.draw.phone(scanner.draw.latest());
		await page.keyboard.press("Escape");
		await expect(drawWindow(page)).toHaveCount(0);
		await expect.poll(async () => (await phone.draw()).status).toBe(410);
		expect(scanner.draw.charged).toBe(0);
	});

	test("out of scans keeps the drawing and offers more scans", async ({ page, scanner }) => {
		scanner.draw.scansLeft = 0;
		await runCommand(page, "mathlive:draw-formula");
		await drawOnPad(page);
		await expect(preview(page)).toHaveJSProperty("value", DRAWN_LATEX);
		await drawWindow(page).getByRole("button", { name: "Insert" }).click();
		await expect(notices(page).filter({ hasText: "You've used your free scans." })).toBeVisible();
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

import { clickWidgetButton, expect, inlineWidget, modalField, noteLine, runCommand, setSettings, test, waitForModalField } from "./fixtures.mjs";

// Magic edit goes to a stub of the MathLive scanner on localhost:8502 (stub-scanner.mjs): "square"
// squares the formula, "unclear" can't be done, and any recording is heard as "square it".
const CLOUD = "http://127.0.0.1:8502";
const popover = (page) => page.locator(".mathlive-magic-edit-popover");
const status = (page) => page.locator(".mathlive-magic-edit-status");

// The microphone, played by Web Audio: a loud tone stands in for speech, or silence.
const fakeMicrophone = (page, loud) =>
	page.evaluate((loud) => {
		navigator.mediaDevices.getUserMedia = async () => {
			const context = new AudioContext();
			const destination = context.createMediaStreamDestination();
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			gain.gain.value = loud ? 0.5 : 0;
			oscillator.connect(gain).connect(destination);
			oscillator.start();
			return destination.stream;
		};
		return true;
	}, loud);

const editRequests = (scanner) => scanner.requests.filter((request) => request.url === "/edit");

async function openMagicEdit(page) {
	await clickWidgetButton(inlineWidget(page), "Magic edit");
	await expect(popover(page)).toBeVisible();
	await expect(popover(page).locator("input")).toBeFocused();
}

test.describe("Magic edit", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: false, apiKey: "device-key", cloudScannerUrl: CLOUD });
	});

	test("edits a formula from a typed instruction, and Undo puts it back", async ({ page, scanner }) => {
		await openMagicEdit(page);
		await popover(page).locator("input").fill("square it");
		await popover(page).locator("input").press("Enter");

		await expect(status(page)).toContainText("Done.");
		const edited = "Inline math $\\left(x^2 + y^2 = z^2\\right)^2$ in a sentence.";
		await expect.poll(() => noteLine(page, "Inline math")).toBe(edited);
		expect(editRequests(scanner)[0]).toMatchObject({
			apiKey: "device-key",
			edit: { latex: "x^2 + y^2 = z^2", instruction: "square it", audio: 0 },
		});
		// Ready for the next change.
		await expect(popover(page).locator("input")).toHaveValue("");

		await popover(page).getByRole("button", { name: "Undo" }).click();
		await expect.poll(() => noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2$ in a sentence.");

		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);
	});

	test("says so when the AI can't tell what to change, and keeps the formula", async ({ page }) => {
		await openMagicEdit(page);
		await popover(page).locator("input").fill("something unclear");
		await popover(page).getByRole("button", { name: "Apply" }).click();
		await expect(status(page)).toContainText("I couldn't tell which term to change.");
		expect(await noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2$ in a sentence.");
	});

	test("edits from a spoken instruction and shows what it heard", async ({ page, scanner }) => {
		await fakeMicrophone(page, true);
		await openMagicEdit(page);
		await popover(page).getByRole("button", { name: "Speak the change" }).click();
		await expect(status(page)).toContainText("Listening");
		await page.waitForTimeout(800);
		await popover(page).getByRole("button", { name: "Stop and apply" }).click();

		await expect(status(page)).toContainText("“square it” Done.");
		await expect.poll(() => noteLine(page, "Inline math")).toBe("Inline math $\\left(x^2 + y^2 = z^2\\right)^2$ in a sentence.");
		const [request] = editRequests(scanner);
		expect(request.edit.audio).toBeGreaterThan(100);
		expect(request.edit.audio_type).toMatch(/^audio\/webm/);
	});

	test("never sends a recording without speech", async ({ page, scanner }) => {
		await fakeMicrophone(page, false);
		await openMagicEdit(page);
		await popover(page).getByRole("button", { name: "Speak the change" }).click();
		await expect(status(page)).toContainText("Listening");
		await page.waitForTimeout(800);
		await popover(page).locator("input").press("Enter");
		await expect(status(page)).toContainText("I didn't hear anything");
		expect(editRequests(scanner)).toHaveLength(0);
	});

	test("says when the scanner can't do Magic edit", async ({ page }) => {
		await setSettings(page, { apiKey: "old-scanner" });
		await openMagicEdit(page);
		await popover(page).locator("input").fill("square it");
		await popover(page).locator("input").press("Enter");
		await expect(status(page)).toContainText("This scanner can't do Magic edit.");
	});

	test("passes the server's message on when the edit fails", async ({ page }) => {
		await setSettings(page, { apiKey: "edit-down" });
		await openMagicEdit(page);
		await popover(page).locator("input").fill("square it");
		await popover(page).locator("input").press("Enter");
		await expect(status(page)).toContainText("Nothing was charged.");
		expect(await noteLine(page, "Inline math")).toBe("Inline math $x^2 + y^2 = z^2$ in a sentence.");
	});

	test("works in the editor window", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			const line = editor.getValue().split("\n").findIndex((text) => text.startsWith("Last line"));
			editor.setCursor({ line, ch: 12 });
			return true;
		});
		await runCommand(page, "mathlive:open-modal-inline");
		await waitForModalField(page);
		await page.locator(".modal").getByRole("button", { name: "Magic edit" }).click();
		const box = page.locator(".modal .mathlive-magic-edit");
		await expect(box.locator("input")).toBeFocused();
		await box.locator("input").fill("square it");
		await box.locator("input").press("Enter");
		await expect(box.locator(".mathlive-magic-edit-status")).toContainText("Done.");
		await expect(modalField(page)).toHaveJSProperty("value", "\\left(\\alpha + \\beta\\right)^2");

		await page.keyboard.press("Control+Enter");
		await expect(modalField(page)).toHaveCount(0);
		await expect.poll(() => noteLine(page, "Last line")).toBe("Last line $\\left(\\alpha + \\beta\\right)^2$ done.");
	});
});

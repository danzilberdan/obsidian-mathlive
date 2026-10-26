import { SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	clearClipboard,
	expect,
	inlineField,
	modalField,
	noteLine,
	notices,
	putImageOnClipboard,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const AUTH_NOTICE = /configure your API key/;
const FAILED_NOTICE = "Couldn't scan the image. Check your connection and try again.";

// Scans go to a stub of the self-hosted scanner on localhost:8502.
test.describe("scanning a formula image", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: true, apiKey: "" });
		expect(await putImageOnClipboard(page)).toBe(true);
	});

	test("the scan button on a formula adds the scanned LaTeX", async ({ page, scanner }) => {
		const widget = page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper").first();
		await widget.getByRole("button", { name: "Paste LaTeX from clipboard image" }).click();

		await expect(notices(page).filter({ hasText: "Scan added to the formula" })).toBeVisible();
		await expect.poll(() => noteLine(page, "Inline math")).toBe(`Inline math $x^2 + y^2 = z^2${SCANNED_LATEX}$ in a sentence.`);
		await expect(inlineField(page, 0)).toHaveJSProperty("value", `x^2 + y^2 = z^2${SCANNED_LATEX}`);

		expect(scanner.requests).toHaveLength(1);
		expect(scanner.requests[0]).toMatchObject({ method: "POST", url: "/predict/", hasPng: true });
		expect(scanner.requests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
	});

	test("the scan button in the editor window adds the scanned LaTeX", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		await expect(notices(page).filter({ hasText: "Scan added to the formula" })).toBeVisible();
	});

	test("an empty clipboard says so and sends nothing", async ({ page, scanner }) => {
		await clearClipboard(page);
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: "No image found in clipboard." })).toBeVisible();
		expect(scanner.requests).toHaveLength(0);
	});

	test("a scanner error shows a retry message and leaves the formula alone", async ({ page }) => {
		await setSettings(page, { apiKey: "server-error" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: FAILED_NOTICE })).toBeVisible();
		await expect(modalField(page)).toHaveJSProperty("value", "");
	});

	test("the cloud scanner without an API key asks for one and sends nothing", async ({ page, scanner }) => {
		await setSettings(page, { useLocalInference: false, apiKey: "" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: AUTH_NOTICE })).toBeVisible();
		expect(scanner.requests).toHaveLength(0);
	});
});

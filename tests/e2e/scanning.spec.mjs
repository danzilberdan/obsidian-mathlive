import { SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	clearClipboard,
	expect,
	FORMULA_IMAGE,
	inlineField,
	inlineWidget,
	menuItem,
	modalField,
	noteLine,
	notices,
	openWidgetMenu,
	putImageOnClipboard,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const FAILED_NOTICE = "Couldn't scan the image. Check your connection and try again.";

// Scans go to a stub of the self-hosted scanner on localhost:8502.
test.describe("scanning a formula image", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: true, apiKey: "" });
		expect(await putImageOnClipboard(page)).toBe(true);
	});

	test("Scan clipboard image in a formula's ✨ menu adds the scanned LaTeX", async ({ page, scanner }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Scan clipboard image").click();

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

	test("a slow scan shows a moving progress notice until the LaTeX arrives", async ({ page }) => {
		await setSettings(page, { apiKey: "slow" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();

		const progress = page.locator(".notice.mathlive-scan-progress");
		await expect(progress).toBeVisible();
		await expect(progress.locator(".mathlive-scan-progress-text")).toHaveText("Reading the formula…");
		await expect(progress.locator(".mathlive-scan-progress-bar")).toBeVisible();
		await expect(modalField(page)).toHaveClass(/mathlive-is-scanning/);
		// It counts the seconds once the scan takes a while, and stays up the whole time.
		await expect(progress.locator(".mathlive-scan-progress-time")).toHaveText("2 s", { timeout: 2900 });
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX, { timeout: 5000 });
		await expect(progress).toHaveCount(0);
		await expect(modalField(page)).not.toHaveClass(/mathlive-is-scanning/);
	});

	test("an empty clipboard says so and sends nothing", async ({ page, scanner }) => {
		await clearClipboard(page);
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: "No image found in clipboard." })).toBeVisible();
		expect(scanner.requests).toHaveLength(0);
	});

	test("a scanner error shows a retry message and leaves the formula alone", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "server-error" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: FAILED_NOTICE })).toBeVisible();
		await expect(modalField(page)).toHaveJSProperty("value", "");
		// A quick failure is retried once on its own before the user sees it.
		expect(scanner.requests).toHaveLength(2);
	});

	test("Retry in the error message scans the same image again", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "server-error" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		const failed = notices(page).filter({ hasText: FAILED_NOTICE });
		await expect(failed).toBeVisible();

		// The retry must not need the clipboard any more.
		expect(await clearClipboard(page)).toBe(true);
		await setSettings(page, { apiKey: "" });
		await failed.getByRole("button", { name: "Retry" }).click();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		await expect(notices(page).filter({ hasText: "Scan added to the formula" })).toBeVisible();
		expect(scanner.requests).toHaveLength(3);
		expect(scanner.requests[2].hasPng).toBe(true);
	});

	test("a scanner that fails once is retried without bothering the user", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "flaky" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(scanner.requests).toHaveLength(2);
		await expect(notices(page).filter({ hasText: FAILED_NOTICE })).toHaveCount(0);
	});

	test("an account with no scans left is told how to get more, with no retry", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "no-scans-left" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		const notice = notices(page).filter({ hasText: /used all your free scans/ });
		await expect(notice).toBeVisible();
		await expect(notice.getByRole("button", { name: "Retry" })).toHaveCount(0);
		expect(scanner.requests).toHaveLength(1);
	});

	test("a key over the daily limit sees the server's reason, not a sign-in prompt", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "daily-limit" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: /daily limit of 150 scans/ })).toBeVisible();
		await expect(page.locator(".modal").filter({ hasText: /Connect/ })).toHaveCount(0);
		expect(scanner.requests).toHaveLength(1);
	});

	test("an image with no math says so", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "no-math" });
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(notices(page).filter({ hasText: /No math found in this image/ })).toBeVisible();
		await expect(modalField(page)).toHaveJSProperty("value", "");
		expect(scanner.requests).toHaveLength(1);
	});

	test("a big screenshot is scaled down before upload", async ({ page, scanner }) => {
		const onClipboard = await page.evaluate((file) => {
			const { clipboard, nativeImage } = window.require("electron");
			const image = nativeImage.createFromPath(file).resize({ width: 4000 });
			clipboard.writeImage(image);
			return image.getSize();
		}, FORMULA_IMAGE);
		expect(onClipboard.width).toBe(4000);

		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(scanner.requests[0].pngSize).toEqual({
			width: 1600,
			height: Math.round((onClipboard.height * 1600) / 4000),
		});
	});

	test("a small screenshot is uploaded as it is", async ({ page, scanner }) => {
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .scan-button").click();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(scanner.requests[0].pngSize).toEqual({ width: 115, height: 58 });
	});


});

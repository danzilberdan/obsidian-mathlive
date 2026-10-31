import fs from "node:fs";
import path from "node:path";
import { SCANNED_LATEX } from "./stub-scanner.mjs";
import {
	modalAiAction,
	expect,
	modalField,
	notices,
	openedUrls,
	putImageOnClipboard,
	recordOpenedUrls,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

// The cloud scanner's account endpoints are stubbed on localhost:8502 too (stub-scanner.mjs).
const CLOUD = "http://127.0.0.1:8502";
const SITE = "http://127.0.0.1:8502/site";

const pluginSettings = (page) => page.evaluate(() => ({ ...window.app.plugins.plugins.mathlive.settings }));

async function scanInEditorWindow(page) {
	await runCommand(page, "mathlive:open-modal");
	await modalAiAction(page, "Scan clipboard image");
}

// The challenge in the /connect link the plugin opened.
async function connectChallenge(page) {
	await expect.poll(async () => (await openedUrls(page)).find((url) => url.startsWith(`${SITE}/connect?`))).toBeTruthy();
	const url = new URL((await openedUrls(page)).find((url) => url.startsWith(`${SITE}/connect?`)));
	expect(url.searchParams.get("device")).toBe("vault on Linux");
	return url.searchParams.get("state");
}

test.describe("account", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		scanner.account.reset();
		await setSettings(page, {
			useLocalInference: false,
			apiKey: null,
			apiKeySource: null,
			cloudScannerUrl: CLOUD,
			websiteUrl: SITE,
		});
		await recordOpenedUrls(page);
		expect(await putImageOnClipboard(page)).toBe(true);
	});

	test("the first scan starts a free trial without an account", async ({ page, scanner }) => {
		await scanInEditorWindow(page);
		await expect(notices(page).filter({ hasText: "free trial: 3 scans, no account needed" })).toBeVisible();
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(await pluginSettings(page)).toMatchObject({ apiKey: "trial-key", apiKeySource: "trial" });
		expect(scanner.requests.filter((request) => request.url === "/predict/").map((request) => request.apiKey)).toEqual(["trial-key"]);
	});

	test("when the trial is used up, connecting finishes the scan that was waiting", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "trial-used", apiKeySource: "trial" });
		await scanInEditorWindow(page);
		const dialog = page.locator(".mathlive-connect-modal");
		await expect(dialog.locator(".modal-title")).toHaveText("Your trial scans are used up");
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toContainText("Finish in your browser");

		// The user approves on the website; the plugin notices on its own within a few seconds.
		scanner.account.approve(await connectChallenge(page));
		await expect(dialog).toHaveCount(0, { timeout: 15_000 });
		await expect(notices(page).filter({ hasText: "MathLive is connected to ada@example.com." })).toBeVisible();
		expect(await pluginSettings(page)).toMatchObject({ apiKey: "device-key", apiKeySource: "device" });
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		// The trial key isn't needed anymore.
		await expect.poll(() => scanner.account.forgotten).toEqual(["trial-used"]);
	});

	test("coming back from the browser connects right away", async ({ page, scanner }) => {
		await page.evaluate(() => {
			void window.app.plugins.plugins.mathlive.account.connect();
			return true;
		});
		const challenge = await connectChallenge(page);
		scanner.account.approve(challenge);
		const started = Date.now();
		// What obsidian://mathlive-auth?state=… does.
		await page.evaluate((state) => window.app.plugins.plugins.mathlive.account.handleReturn({ action: "mathlive-auth", state }), challenge);
		expect(await pluginSettings(page)).toMatchObject({ apiKey: "device-key", apiKeySource: "device" });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("a network with no trials left asks to connect and sends no scan", async ({ page, scanner }) => {
		scanner.account.trialAvailable = false;
		await scanInEditorWindow(page);
		const dialog = page.locator(".mathlive-connect-modal");
		await expect(dialog.locator(".modal-title")).toHaveText("Connect MathLive to scan");
		await dialog.getByRole("button", { name: "Not now" }).click();
		await expect(dialog).toHaveCount(0);
		expect(scanner.requests.filter((request) => request.url === "/predict/")).toHaveLength(0);
		expect(await pluginSettings(page)).toMatchObject({ apiKey: null });
	});

	test("a device disconnected on the website asks to connect again", async ({ page }) => {
		await setSettings(page, { apiKey: "unauthorized", apiKeySource: "device" });
		await scanInEditorWindow(page);
		await expect(page.locator(".mathlive-connect-modal .modal-title")).toHaveText("Connect MathLive again");
		expect(await pluginSettings(page)).toMatchObject({ apiKey: null, apiKeySource: null });
	});

	test("an account running low hears about it after a scan", async ({ page }) => {
		await page.evaluate(() => {
			window.app.plugins.plugins.mathlive.account.lowScansWarnedAt = 0;
			return true;
		});
		// The stub answers this key's status as an account with 2 scans left.
		await setSettings(page, { apiKey: "low-key", apiKeySource: "device" });
		await scanInEditorWindow(page);
		const notice = notices(page).filter({ hasText: "2 free scans left this month. Unlimited is $39 a year." });
		await expect(notice).toBeVisible();
		await notice.getByRole("button", { name: "Go unlimited" }).click();
		expect(await openedUrls(page)).toContain(`${SITE}/pricing?src=plugin_low`);
	});

	test("out of scans offers the plans, and buying one finishes the refused scan", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "out-key", apiKeySource: "device" });
		await scanInEditorWindow(page);
		const dialog = page.locator(".mathlive-upgrade-modal");
		await expect(dialog.locator(".modal-title")).toHaveText("You're out of free scans");
		await expect(dialog).toContainText("Your next 5 arrive on");
		// Unlimited shows yearly first, with a switch to monthly, and Lifetime beside it.
		const unlimited = dialog.locator(".mathlive-upgrade-plan.is-featured");
		await expect(unlimited).toContainText("Unlimited");
		await expect(unlimited.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
		await expect(unlimited.locator(".mathlive-upgrade-plan-price")).toHaveText("$39/yr");
		await expect(unlimited).toContainText("$3.25 a month, billed yearly");
		await unlimited.getByRole("button", { name: "Monthly" }).click();
		await expect(unlimited.locator(".mathlive-upgrade-plan-price")).toHaveText("$6/mo");
		await unlimited.getByRole("button", { name: "Yearly" }).click();
		await expect(dialog.locator(".mathlive-upgrade-plan", { hasText: "Lifetime" })).toContainText("$69");

		await unlimited.getByRole("button", { name: "Go unlimited" }).click();
		await expect.poll(() => openedUrls(page)).toContain("https://checkout.example/go?plan=annual&src=plugin_out");
		const linkRequest = scanner.requests.find((request) => request.url === "/checkout-link");
		expect(linkRequest.apiKey).toBe("out-key");
		await expect(dialog).toContainText("Finish paying in your browser");
		expect(scanner.requests.filter((request) => request.url === "/predict/")).toHaveLength(1);

		// Paid in the browser: the window notices on its own, closes and runs the scan.
		scanner.account.paid = true;
		await expect(dialog).toHaveCount(0, { timeout: 15_000 });
		await expect(modalField(page)).toHaveJSProperty("value", SCANNED_LATEX);
		expect(scanner.requests.filter((request) => request.url === "/predict/")).toHaveLength(2);
	});

	test("out of scans can wait for next month", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "out-key", apiKeySource: "device" });
		await scanInEditorWindow(page);
		const dialog = page.locator(".mathlive-upgrade-modal");
		await dialog.getByRole("button", { name: /^Wait until / }).click();
		await expect(dialog).toHaveCount(0);
		expect(scanner.requests.filter((request) => request.url === "/checkout-link")).toHaveLength(0);
		expect(await openedUrls(page)).toHaveLength(0);
	});

	test("settings connect, show the account and disconnect", async ({ obsidian, page, scanner }) => {
		await page.evaluate(() => {
			window.app.setting.open();
			window.app.setting.openTabById("mathlive");
			return true;
		});
		// Settings open in a window of their own, or inside the main window.
		let settingsWindow;
		await expect
			.poll(async () => {
				for (const candidate of obsidian.context.pages()) {
					if ((await candidate.locator(".mathlive-account-setting").count()) > 0) {
						settingsWindow = candidate;
						return true;
					}
				}
				return false;
			})
			.toBe(true);
		const row = settingsWindow.locator(".mathlive-account-setting");
		await expect(row).toContainText("Your first scans need no account.");
		// Record what the settings window opens too.
		await settingsWindow.evaluate(() => {
			window.__e2eOriginalOpen ??= window.open;
			window.__e2eOpenedUrls = [];
			window.open = (url) => window.__e2eOpenedUrls.push(String(url));
			return true;
		});
		await row.getByRole("button", { name: "Connect" }).click();
		await expect(row).toContainText("Finish in your browser");
		await expect.poll(() => settingsWindow.evaluate(() => window.__e2eOpenedUrls.length)).toBe(1);
		const opened = new URL(await settingsWindow.evaluate(() => window.__e2eOpenedUrls[0]));
		scanner.account.approve(opened.searchParams.get("state"));

		await expect(row).toContainText("Connected as ada@example.com · 9 scans left.", { timeout: 15_000 });
		await row.getByRole("button", { name: "Disconnect" }).click();
		await expect(row.getByRole("button", { name: "Connect" })).toBeVisible();
		// The key is forgotten on the server in the background, after the row already shows Connect.
		await expect.poll(() => scanner.account.forgotten).toEqual(["device-key"]);
		expect(await pluginSettings(page)).toMatchObject({ apiKey: null, apiKeySource: null });
		const saved = JSON.parse(fs.readFileSync(path.join(obsidian.vault, ".obsidian", "plugins", "mathlive", "data.json"), "utf8"));
		expect(saved.apiKey).toBeNull();
	});
});

test("a fresh install says welcome once and opens the editor from there", async ({ page }) => {
	await setSettings(page, { welcomeShown: false });
	await page.evaluate(async () => {
		await window.app.plugins.disablePlugin("mathlive");
		await window.app.plugins.enablePlugin("mathlive");
		return true;
	});
	const welcome = page.locator(".mathlive-welcome-modal");
	await expect(welcome.locator(".modal-title")).toHaveText("Welcome to MathLive");
	await expect(welcome).toContainText("Your first scans need no account.");
	await expect(welcome.getByRole("button", { name: "See everything" })).toBeVisible();
	await welcome.getByRole("button", { name: "Try the editor" }).click();
	await expect(page.locator(".mathlive-modal-title")).toHaveText("Edit math block");
	expect(await pluginSettings(page)).toMatchObject({ welcomeShown: true });
	await page.keyboard.press("Escape");
});

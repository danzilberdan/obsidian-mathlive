// One-click connect: three trial scans without an account, then connecting through the website.
import { notice, putImageOnClipboard, setSettings } from "./shared.mjs";

const SITE = "https://mathlive-staging.danz.blog";

export async function setup({ page, scanner, demo }) {
	scanner.state.trialScansLeft = 3;
	scanner.nextScan(demo.clipboard.latex);
	scanner.nextScan(demo.clipboard.latex);
	await putImageOnClipboard(page);
	await setSettings(page, { useLocalInference: false, apiKey: null, apiKeySource: null, cloudScannerUrl: "http://127.0.0.1:8502", websiteUrl: SITE });
	// Keep the links the plugin opens, instead of handing them to a browser outside the recording.
	await page.evaluate(() => {
		window.__demoOpened = [];
		window.open = (url) => {
			window.__demoOpened.push(String(url));
			return null;
		};
		window.app.commands.executeCommandById("mathlive:open-modal");
		return true;
	});
	await page.locator(".mathlive-modal-root .scan-button").waitFor();
}

export async function run({ page, scanner, say, click, sleep, lineDone, openBrowser, closeBrowser, pointAt }) {
	const scanButton = page.locator(".mathlive-modal-root .scan-button");
	await click(scanButton);
	await notice(page, "free trial").waitFor();
	await say("connect-1");
	await lineDone();

	scanner.trialUsedUp();
	await say("connect-2");
	// Start the second scan on an empty formula, so its result reads clearly.
	await page.locator("#mathlive-modal-field").evaluate((field) => (field.value = ""));
	await sleep(300);
	await click(scanButton);
	const dialog = page.locator(".mathlive-connect-modal");
	await dialog.waitFor();
	await sleep(1500);
	await click(dialog.getByRole("button", { name: "Connect" }));
	await dialog.getByText("Finish in your browser").waitFor();
	await lineDone();

	const url = await page.evaluate(() => window.__demoOpened.find((u) => u.includes("/connect")));
	const tab = await openBrowser(url);
	await tab.mouse.move(1100, 700);
	await say("connect-3");
	await sleep(800);
	await pointAt(tab.getByRole("button", { name: /sign in to connect/i }).or(tab.getByRole("link", { name: /sign in to connect/i })).first(), { steps: 30 });
	await lineDone();

	// What signing in does: the website approves the device and Obsidian picks it up by itself.
	scanner.approve();
	await closeBrowser();
	await say("connect-4");
	await notice(page, "MathLive is connected").waitFor({ timeout: 15_000 });
}

export async function teardown({ page }) {
	await page.evaluate(() => {
		window.app.plugins.plugins.mathlive.account.cancelConnect();
		return true;
	});
}

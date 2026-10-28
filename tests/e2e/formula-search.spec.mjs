import { IDEAL_GAS, WRITTEN } from "./stub-scanner.mjs";
import {
	expect,
	inlineField,
	inlineWidget,
	menuItem,
	modalField,
	noteText,
	notices,
	openWidgetMenu,
	runCommand,
	setSettings,
	test,
} from "./fixtures.mjs";

const CLOUD = "http://127.0.0.1:8502";

const search = (page) => page.locator(".mathlive-formula-search");
const searchInput = (page) => search(page).locator("input.prompt-input");
const suggestion = (page, text) => search(page).locator(".suggestion-item", { hasText: text });

const putCursor = (page, line, ch = 0) =>
	page.evaluate(({ line, ch }) => {
		const editor = window.app.workspace.activeEditor.editor;
		editor.focus();
		editor.setCursor({ line, ch });
		return true;
	}, { line, ch });

// The formula library is on the cloud scanner (the stub on localhost:8502), whatever scanner
// the user picked for images.
test.describe("find a formula", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, {
			useLocalInference: false,
			apiKey: "device-key",
			apiKeySource: "device",
			cloudScannerUrl: CLOUD,
		});
	});

	test("the command finds a formula by name and puts it on the empty line as a math block", async ({ page, scanner }) => {
		await putCursor(page, 1);
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("gas law");
		await expect(suggestion(page, IDEAL_GAS.name)).toBeVisible();
		await expect(suggestion(page, IDEAL_GAS.name).locator(".mathlive-formula-preview mjx-container")).toBeVisible();
		await expect(suggestion(page, "with AI")).toBeVisible();
		await page.keyboard.press("Enter");

		await expect(search(page)).toHaveCount(0);
		await expect.poll(() => noteText(page)).toContain(`# Test note\n$$\n${IDEAL_GAS.latex}\n$$\n`);
		await expect(notices(page).filter({ hasText: `Inserted ${IDEAL_GAS.name}` })).toBeVisible();

		// Searching is free: no key goes with it, only the query.
		const searches = scanner.requests.filter((request) => request.url.startsWith("/formulas/search"));
		expect(searches.length).toBeGreaterThan(0);
		expect(searches.every((request) => request.apiKey === null && request.method === "GET")).toBe(true);
		expect(searches.at(-1).url).toBe("/formulas/search?limit=8&q=gas%20law");
	});

	test("in a sentence the formula goes in as inline math", async ({ page }) => {
		await putCursor(page, 8, "Plain paragraph".length);
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("ideal gas");
		await suggestion(page, IDEAL_GAS.name).click();
		await expect.poll(() => noteText(page)).toContain(`Plain paragraph$${IDEAL_GAS.latex}$ between formulas.`);
	});

	test("Find a formula in a formula's ✨ menu inserts into that formula", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page, 0));
		await menuItem(page, "Find a formula").click();
		await searchInput(page).fill("gas");
		await suggestion(page, IDEAL_GAS.name).click();
		// It goes after what the formula already has.
		await expect.poll(() => inlineField(page, 0).evaluate((field) => field.value)).toBe("x^2+y^2=z^2PV=nRT");
		await expect.poll(() => noteText(page)).toContain("Inline math $x^2+y^2=z^2PV=nRT$ in a sentence.");
	});

	test("the editor window's Find a formula button fills its formula", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await page.locator(".mathlive-modal-root .find-formula-button").click();
		await searchInput(page).fill("gas");
		await suggestion(page, IDEAL_GAS.name).click();
		await expect(modalField(page)).toHaveJSProperty("value", IDEAL_GAS.latex);
	});

	test("Write it with AI fills in a formula the library doesn't have, with the account's key", async ({ page, scanner }) => {
		await putCursor(page, 1);
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("black scholes");
		await expect(search(page).locator(".suggestion-item")).toHaveCount(1);
		await expect(suggestion(page, "Not in the library yet")).toBeVisible();
		await suggestion(page, "with AI").click();

		await expect.poll(() => noteText(page)).toContain(`$$\n${WRITTEN.latex}\n$$`);
		await expect(notices(page).filter({ hasText: `Inserted ${WRITTEN.name}` })).toBeVisible();
		const writes = scanner.requests.filter((request) => request.url === "/formulas/write");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ method: "POST", apiKey: "device-key" });
	});

	test("Write it with AI says so when the text isn't a formula, and inserts nothing", async ({ page }) => {
		const before = await noteText(page);
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("banana bread");
		await suggestion(page, "with AI").click();
		await expect(notices(page).filter({ hasText: "doesn't look like a formula" })).toBeVisible();
		expect(await noteText(page)).toBe(before);
	});

	test("with no scans left, Write it with AI asks to upgrade", async ({ page }) => {
		await setSettings(page, { apiKey: "no-scans-left", apiKeySource: "device" });
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("black scholes");
		await suggestion(page, "with AI").click();
		await expect(notices(page).filter({ hasText: "You've used your free scans" })).toBeVisible();
	});

	test("when the library is down, writing with AI is still offered", async ({ page }) => {
		await runCommand(page, "mathlive:find-formula");
		await searchInput(page).fill("down");
		await expect(search(page).locator(".suggestion-item")).toHaveCount(1);
		await expect(suggestion(page, "with AI")).toBeVisible();
		await page.keyboard.press("Escape");
	});

	test("right-clicking in a note offers Find a formula, starting from the selected words", async ({ page }) => {
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setSelection({ line: 8, ch: 0 }, { line: 8, ch: 5 });
			return true;
		});
		await page.locator(".cm-content .cm-line", { hasText: "Plain paragraph" }).click({ button: "right", position: { x: 10, y: 5 } });
		await menuItem(page, "Find a formula").click();
		await expect(searchInput(page)).toBeVisible();
	});
});

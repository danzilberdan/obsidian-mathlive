import {
	clickWidgetButton,
	expect,
	focusField,
	inlineField,
	notices,
	setSettings,
	inlineWidget,
	menuItem,
	openWidgetMenu,
	openedUrls,
	recordOpenedUrls,
	runCommand,
	test,
	waitForModalField,
} from "./fixtures.mjs";

const help = (page) => page.locator(".mathlive-help-modal");
const helpInput = (page) => help(page).locator(".mathlive-help-search input");
const helpItem = (page, title) => help(page).locator(".mathlive-help-item", { has: page.locator(".mathlive-help-item-title", { hasText: title }) });

test.describe("help", () => {
	test.afterEach(async ({ page }) => {
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});

	test("opens with the getting started list, and finds how to write a fraction", async ({ page }) => {
		await runCommand(page, "mathlive:open-help");
		await expect(help(page)).toBeVisible();
		await expect(helpInput(page)).toBeFocused();
		await expect(help(page).locator(".mathlive-help-heading")).toHaveText("Getting started");
		await expect(helpItem(page, "Write a fraction")).toBeVisible();
		await expect(helpItem(page, "Type Greek letters")).toBeVisible();

		await helpInput(page).fill("how do I divide");
		const first = help(page).locator(".mathlive-help-item").first();
		await expect(first.locator(".mathlive-help-item-title")).toHaveText("Write a fraction");
		await expect(first.locator(".mathlive-help-answer")).toContainText("Type / and the part before it becomes the numerator.");
		await expect(first.locator(".mathlive-help-preview mjx-container")).toBeVisible();
	});

	test("a result opens the MathLive docs at its section", async ({ page }) => {
		await recordOpenedUrls(page);
		await runCommand(page, "mathlive:open-help");
		await helpInput(page).fill("make a matrix");
		await expect(help(page).locator(".mathlive-help-item").first()).toContainText("Make a matrix");
		await page.keyboard.press("Enter");
		await expect.poll(() => openedUrls(page)).toEqual(["https://mathlive.io/mathfield/matrix/#creating-a-matrix"]);

		await helpInput(page).fill("->");
		const arrow = help(page).locator(".mathlive-help-item").first();
		await expect(arrow.locator(".mathlive-help-how")).toContainText("Type ->");
		await arrow.locator(".mathlive-help-docs-link").click();
		await expect.poll(async () => (await openedUrls(page)).at(-1)).toBe("https://mathlive.io/mathfield/reference/keybindings/#arrows");
	});

	test("arrow keys pick a result, and a plugin topic runs its feature", async ({ page }) => {
		await runCommand(page, "mathlive:open-help");
		await helpInput(page).fill("everything mathlive can do");
		await expect(help(page).locator(".mathlive-help-item.is-selected")).toContainText("Everything MathLive can do in Obsidian");
		await page.keyboard.press("Enter");
		await expect(help(page)).toHaveCount(0);
		await expect(page.locator(".mathlive-guide-modal")).toBeVisible();
	});

	test("says so when nothing matches", async ({ page }) => {
		await runCommand(page, "mathlive:open-help");
		await helpInput(page).fill("qwertyuiop");
		await expect(help(page).locator(".mathlive-help-empty")).toContainText("Nothing found");
	});

	test("opens from a formula's ✨ menu and from the editor window's ?", async ({ page }) => {
		await openWidgetMenu(page, inlineWidget(page));
		await menuItem(page, "Help: how to…").click();
		await expect(help(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(help(page)).toHaveCount(0);

		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		await page.locator(".mathlive-modal-root .mathlive-modal-help").click();
		await expect(help(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(help(page)).toHaveCount(0);
		await expect(page.locator(".mathlive-modal-root")).toBeVisible();
	});

	test("every formula has a ? button that opens the help", async ({ page }) => {
		await clickWidgetButton(inlineWidget(page), "Help: how to…");
		await expect(help(page)).toBeVisible();
		await expect(help(page).locator(".mathlive-help-heading")).toHaveText("Getting started");
	});

	test("the first formula someone edits shows a tip about help, once", async ({ page }) => {
		await setSettings(page, { helpTipShown: false });
		await focusField(inlineField(page, 0));
		const tip = notices(page).filter({ hasText: "New to math typing?" });
		await expect(tip).toBeVisible();
		await expect(tip).toContainText("Type / for a fraction");
		await tip.getByText("Open help").click();
		await expect(help(page)).toBeVisible();
		expect(await page.evaluate(() => window.app.plugins.plugins.mathlive.settings.helpTipShown)).toBe(true);
		await page.keyboard.press("Escape");

		await focusField(inlineField(page, 1));
		await page.waitForTimeout(500);
		await expect(notices(page).filter({ hasText: "New to math typing?" })).toHaveCount(0);
	});
});

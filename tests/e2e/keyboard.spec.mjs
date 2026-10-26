import {
	blockField,
	expect,
	focusField,
	inlineField,
	inlineWidget,
	menuItem,
	modalField,
	openWidgetMenu,
	runCommand,
	test,
	waitForModalField,
} from "./fixtures.mjs";

const keyboard = (page) => page.locator("body > .ML__keyboard");

// The space MathLive reserves at the bottom of the window for its keyboard.
const reservedSpace = (page) => page.evaluate(() => document.body.style.paddingBottom);

const showFromMenu = async (page, index) => {
	await openWidgetMenu(page, inlineWidget(page, index));
	await menuItem(page, "Show math keyboard").click();
	await expect(keyboard(page)).toBeVisible();
};

const leaveFormula = async (page) => {
	await page.locator(".cm-content .cm-line", { hasText: "Plain paragraph" }).click();
	await expect(keyboard(page)).toHaveCount(0);
};

test.describe("math keyboard in the note", () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => {
			window.mathVirtualKeyboard.hide();
			document.body.style.paddingBottom = "";
			return true;
		});
	});

	test("a block formula's keyboard button opens the keyboard after the editor window was used", async ({ page }) => {
		await runCommand(page, "mathlive:open-modal");
		await waitForModalField(page);
		await page.keyboard.press("Escape");
		await expect(modalField(page)).toHaveCount(0);

		await focusField(blockField(page));
		await blockField(page).locator("[part=virtual-keyboard-toggle]").click();
		await expect(keyboard(page)).toBeVisible();
	});

	test("closing the keyboard leaves no empty space behind", async ({ page }) => {
		await showFromMenu(page, 0);
		expect(await reservedSpace(page)).not.toBe("");
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});

	test("opening the keyboard again doesn't stack empty space under it", async ({ page }) => {
		await showFromMenu(page, 0);
		const once = await reservedSpace(page);
		await showFromMenu(page, 1);
		expect(await reservedSpace(page)).toBe(once);
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});

	test("opening the editor window while the keyboard is open leaves no empty space in the note", async ({ page }) => {
		await showFromMenu(page, 0);
		await openWidgetMenu(page, inlineWidget(page, 1));
		await menuItem(page, "Open in editor window").click();
		await waitForModalField(page);
		await page.keyboard.press("Escape");
		await expect(modalField(page)).toHaveCount(0);
		expect(await reservedSpace(page)).toBe("");

		await showFromMenu(page, 0);
		await expect(inlineField(page, 0)).toBeFocused();
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});
});

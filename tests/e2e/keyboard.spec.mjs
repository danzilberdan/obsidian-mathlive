import {
	blockField,
	clickWidgetButton,
	expect,
	focusField,
	inlineField,
	inlineWidget,
	modalField,
	runCommand,
	test,
	waitForModalField,
} from "./fixtures.mjs";

const keyboard = (page) => page.locator("body > .ML__keyboard");

// The space MathLive reserves at the bottom of the window for its keyboard.
const reservedSpace = (page) => page.evaluate(() => document.body.style.paddingBottom);

const showKeyboard = async (page, index) => {
	await focusField(inlineField(page, index));
	await inlineField(page, index).evaluate((field) => field.executeCommand("showVirtualKeyboard"));
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
		await blockField(page).hover({ position: { x: 10, y: 10 } });
		await blockField(page).locator("[part=virtual-keyboard-toggle]").click();
		await expect(keyboard(page)).toBeVisible();
	});

	test("closing the keyboard leaves no empty space behind", async ({ page }) => {
		await showKeyboard(page, 0);
		expect(await reservedSpace(page)).not.toBe("");
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});

	test("opening the keyboard again doesn't stack empty space under it", async ({ page }) => {
		await showKeyboard(page, 0);
		const once = await reservedSpace(page);
		await showKeyboard(page, 1);
		expect(await reservedSpace(page)).toBe(once);
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});

	test("a blank strip left by a missed close goes away, and the next keyboard doesn't stack on it", async ({ page }) => {
		await showKeyboard(page, 0);
		const once = await reservedSpace(page);
		await leaveFormula(page);
		// What a close that MathLive missed leaves behind: the room the keyboard took, still reserved.
		await page.evaluate((space) => {
			document.body.style.paddingBottom = space;
			window.mathVirtualKeyboard.originalContainerBottomPadding = space;
			return true;
		}, once);

		await showKeyboard(page, 0);
		expect(await reservedSpace(page)).toBe(once);
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");

		for (let i = 0; i < 3; i++) {
			await showKeyboard(page, i % 2);
			expect(await reservedSpace(page)).toBe(once);
			await leaveFormula(page);
			expect(await reservedSpace(page)).toBe("");
		}
	});

	test("opening the editor window while the keyboard is open leaves no empty space in the note", async ({ page }) => {
		await showKeyboard(page, 0);
		await clickWidgetButton(inlineWidget(page, 1), "Expand");
		await waitForModalField(page);
		await page.keyboard.press("Escape");
		await expect(modalField(page)).toHaveCount(0);
		expect(await reservedSpace(page)).toBe("");

		await showKeyboard(page, 0);
		await expect(inlineField(page, 0)).toBeFocused();
		await leaveFormula(page);
		expect(await reservedSpace(page)).toBe("");
	});
});

// On a phone, a tap on the keyboard's tabs could take the focus from the formula (Dan, 2.4.0). The
// test plays such a tap: MathLive switches the tab on pointerdown, then the phone moves the focus.
test.describe("math keyboard taps", () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => {
			window.mathVirtualKeyboard.hide();
			document.body.style.paddingBottom = "";
			return true;
		});
	});

	// Taps another tab, and answers which layer was showing before and after.
	const tapTabThenLoseFocus = (page) =>
		page.evaluate(() => {
			const visible = () => document.querySelector(".ML__keyboard .MLK__layer.is-visible")?.id;
			const before = visible();
			const switcher = document.querySelector(".ML__keyboard .MLK__layer.is-visible [data-layer]");
			switcher.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "touch" }));
			document.activeElement?.blur();
			return { before, after: visible() };
		});

	for (const [name, field, open] of [
		["an inline formula", (page) => inlineField(page, 0), (page) => showKeyboard(page, 0)],
		[
			"the editor window",
			(page) => modalField(page),
			async (page) => {
				await runCommand(page, "mathlive:open-modal");
				await waitForModalField(page);
				await modalField(page).evaluate((mfe) => mfe.executeCommand("showVirtualKeyboard"));
				await expect(page.locator(".ML__keyboard")).toBeVisible();
			},
		],
	]) {
		test(`switching keyboard tabs keeps the cursor in ${name}`, async ({ page }) => {
			await open(page);
			await field(page).evaluate((mfe) => {
				mfe.value = "a+b";
				mfe.position = 1;
				return true;
			});
			await expect(page.locator(".ML__keyboard .MLK__layer.is-visible [data-layer]").first()).toBeAttached();
			const layers = await tapTabThenLoseFocus(page);
			expect(layers.after).not.toBe(layers.before);
			await expect(field(page)).toBeFocused();
			expect(await field(page).evaluate((mfe) => mfe.position)).toBe(1);
			await field(page).evaluate((mfe) => {
				mfe.insert("x");
				return true;
			});
			expect(await field(page).evaluate((mfe) => mfe.value)).toBe("ax+b");

			// Leaving the formula some other way still works.
			await page.waitForTimeout(900);
			await field(page).evaluate((mfe) => {
				mfe.blur();
				return true;
			});
			await expect(field(page)).not.toBeFocused();
		});
	}
});

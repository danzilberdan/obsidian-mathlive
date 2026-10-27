// Typing a formula: the fraction and root appear as they're typed.
const blockWidgets = (page) => page.locator(".cm-content .obsidian-mathlive-codemirror-wrapper:not(.inline)");

export async function run({ page, demo, say, click, focusFormula, sleep, lineDone }) {
	await say("editing-1");
	const field = blockWidgets(page).nth(1).locator("math-field");
	await focusFormula(field, { offset: { x: 30, y: 20 } });
	for (const key of demo.typing.keys) {
		await page.keyboard.press(key);
		await sleep(key.length > 1 ? 220 : 170);
	}
	await lineDone();
	await say("editing-2");
	// Leave the formula so it shows as finished math.
	await click(page.locator(".cm-content .cm-line", { hasText: "The energy of the orbit" }).first(), { offset: { x: 160, y: 14 } });
}

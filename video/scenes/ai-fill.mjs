// ✨ AI fill: scanning a screenshot from the clipboard into an empty formula.
import { blockWidgets, menuItem, putImageOnClipboard } from "./shared.mjs";

export async function setup({ page, scanner, demo }) {
	await putImageOnClipboard(page);
	scanner.nextScan(demo.clipboard.latex);
	scanner.state.scanDelayMs = 2800;
}

export async function run({ page, say, click, pointAt, sleep }) {
	await say("ai-fill-1");
	await sleep(700);
	await click(blockWidgets(page).nth(2).getByRole("button", { name: "AI fill" }));
	await sleep(700);
	await pointAt(menuItem(page, "Scan from screen"), { steps: 16 });
	await sleep(500);
	await pointAt(menuItem(page, "Scan clipboard image"), { steps: 12 });
	await say("ai-fill-2");
	await click(menuItem(page, "Scan clipboard image"), { steps: 2 });
}

export async function teardown({ scanner }) {
	scanner.state.scanDelayMs = 1800;
}

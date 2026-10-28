import { blockWidget, expect, menuItem, notices, openWidgetMenu, runCommand, setSettings, test } from "./fixtures.mjs";

// The stub scanner's /check calls a step wrong when it has "+ 8", and also calls "= 2x + 2"
// wrong, which is right: the plugin's Compute Engine double check has to overrule that one.
const WRONG = String.raw`# Working

$$
\begin{aligned}
(x+3)^2 - x^2 + 1 &= x^2 + 6x + 9 - x^2 + 1 \\
&= 6x + 8
\end{aligned}
$$
`;
const HOLDS = String.raw`$$
\begin{aligned}
(x+1)^2 - (x^2 - 1) &= x^2 + 2x + 1 - x^2 + 1 \\
&= 2x + 2
\end{aligned}
$$
`;
const INLINE = String.raw`Solve $x^2 - 3x + 2 = 0$, so $x = 1$ or $x = 2$.`;

const panel = (page) => page.locator(".mathlive-check");
const summary = (page) => panel(page).locator(".mathlive-check-summary");
// The panel takes focus, so read the note from its markdown leaf, not the active editor.
const noteText = (page) => page.evaluate(() => window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue());
const checkRequests = (scanner) => scanner.requests.filter((r) => r.url === "/check");

async function writeNote(page, text, cursorOffset) {
	await page.evaluate(
		({ text, cursorOffset }) => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setValue(text);
			editor.setCursor(editor.offsetToPos(cursorOffset));
			return true;
		},
		{ text, cursorOffset }
	);
}

test.describe("check my steps", () => {
	test.beforeEach(async ({ page, scanner }) => {
		scanner.requests.length = 0;
		await setSettings(page, { useLocalInference: true, apiKey: "check-key" });
	});

	test.afterEach(async ({ page }) => {
		await page.evaluate(() => {
			window.app.workspace.getLeavesOfType("mathlive-check-steps").forEach((leaf) => leaf.detach());
			// The panel opens the right sidebar, which narrows the note for the tests after these.
			window.app.workspace.rightSplit.collapse();
			return true;
		});
	});

	test("marks the first step that doesn't follow, and inserts the fix", async ({ page, scanner }) => {
		await writeNote(page, WRONG, WRONG.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");

		await expect(summary(page)).toHaveText("Step 2 doesn't follow.");
		const steps = panel(page).locator(".mathlive-check-step");
		await expect(steps).toHaveCount(2);
		await expect(steps.nth(0)).toHaveClass(/is-ok/);
		await expect(steps.nth(1)).toHaveClass(/is-wrong/);
		await expect(steps.nth(1).locator(".mathlive-check-reason")).toContainText("The constant should be 9 + 1 = 10.");
		await expect(steps.nth(1).locator(".mathlive-check-ai")).toHaveText("AI");

		const [request] = checkRequests(scanner);
		expect(request.apiKey).toBe("check-key");
		expect(request.json.steps.map((s) => s.latex)).toEqual([
			"(x+3)^2 - x^2 + 1 = x^2 + 6x + 9 - x^2 + 1",
			"= 6x + 8",
		]);

		await panel(page).getByRole("button", { name: "Insert fix" }).click();
		expect(await noteText(page)).toContain("&= 6x + 10\n\\end{aligned}");
		await expect(panel(page).locator(".mathlive-check-stale")).toContainText("The note changed");
	});

	test("the Compute Engine overrules a wrong verdict on a step that holds", async ({ page }) => {
		await writeNote(page, HOLDS, HOLDS.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");

		await expect(summary(page)).toHaveText("No error found, but some steps couldn't be checked.");
		const step = panel(page).locator(".mathlive-check-step").nth(1);
		await expect(step).toHaveClass(/is-unsure/);
		await expect(step).toContainText("the Compute Engine finds that it holds");
	});

	test("checks selected inline steps from the right-click menu", async ({ page, scanner }) => {
		await writeNote(page, INLINE, 0);
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor.editor;
			editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: editor.getLine(0).length });
			return true;
		});
		await page.locator(".cm-content .cm-line").first().click({ button: "right", position: { x: 5, y: 5 } });
		await menuItem(page, "Check my steps").click();

		await expect(summary(page)).toHaveText("Every step follows.");
		const [request] = checkRequests(scanner);
		expect(request.json.context).toBe("Solve");
		expect(request.json.steps).toEqual([
			{ latex: "x^2 - 3x + 2 = 0", text: "" },
			{ latex: String.raw`x = 1 \text{ or } x = 2`, text: ", so" },
		]);
	});

	test("the ✨ menu of a multi-line block formula checks it", async ({ page, scanner }) => {
		await writeNote(page, `Intro line.\n\n${WRONG}`, 0);
		const widget = blockWidget(page);
		await expect(widget).toBeVisible();
		await openWidgetMenu(page, widget);
		await menuItem(page, "Check my steps").click();
		await expect(summary(page)).toHaveText("Step 2 doesn't follow.");
		expect(checkRequests(scanner)).toHaveLength(1);
	});

	test("one step isn't enough to check", async ({ page, scanner }) => {
		await writeNote(page, "$$\nx = 1\n$$\n", 3);
		await runCommand(page, "mathlive:check-steps");
		await expect(notices(page).filter({ hasText: "needs at least two steps" })).toBeVisible();
		expect(checkRequests(scanner)).toHaveLength(0);
	});

	test("a failed check offers to try again, and nothing is shown as checked", async ({ page, scanner }) => {
		await setSettings(page, { apiKey: "check-down" });
		await writeNote(page, WRONG, WRONG.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");
		await expect(summary(page)).toHaveText(/Couldn't check these steps right now/);
		const notice = notices(page).filter({ hasText: "Couldn't check these steps" });
		await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();

		await setSettings(page, { apiKey: "check-key" });
		await notice.getByRole("button", { name: "Retry" }).click();
		await expect(summary(page)).toHaveText("Step 2 doesn't follow.");
		expect(checkRequests(scanner)).toHaveLength(2);
	});

	test("out of scans points to the plans", async ({ page }) => {
		await setSettings(page, { useLocalInference: false, cloudScannerUrl: "http://127.0.0.1:8502", apiKey: "no-scans-left" });
		await writeNote(page, WRONG, WRONG.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");
		const notice = notices(page).filter({ hasText: "used your free scans" });
		await expect(notice.getByRole("button", { name: "See plans" })).toBeVisible();
	});

	test("the panel closes when the plugin is turned off, and checks again after it is back", async ({ page }) => {
		await writeNote(page, WRONG, WRONG.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");
		await expect(summary(page)).toHaveText("Step 2 doesn't follow.");

		await page.evaluate(() => window.app.plugins.disablePlugin("mathlive").then(() => true));
		await expect(panel(page)).toHaveCount(0);
		await page.evaluate(() => window.app.plugins.enablePlugin("mathlive").then(() => true));

		await page.evaluate(() => {
			window.app.workspace.setActiveLeaf(window.app.workspace.getLeavesOfType("markdown")[0], { focus: true });
			return true;
		});
		await writeNote(page, WRONG, WRONG.indexOf("aligned"));
		await runCommand(page, "mathlive:check-steps");
		await expect(summary(page)).toHaveText("Step 2 doesn't follow.");
	});
});

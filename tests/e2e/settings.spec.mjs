import fs from "node:fs";
import path from "node:path";
import { blockField, expect, focusField, inlineField, reopenNote, setSettings, test } from "./fixtures.mjs";

// Obsidian opens settings in a window of its own.
async function openSettings(obsidian) {
	const { context, page } = obsidian;
	await page.evaluate(() => {
		window.app.setting.open();
		window.app.setting.openTabById("mathlive");
		return true;
	});
	// The window is reused after the first time it opens.
	let settingsWindow;
	await expect
		.poll(async () => {
			for (const candidate of context.pages()) {
				if (candidate !== page && (await candidate.title().catch(() => "")).startsWith("Settings")) {
					settingsWindow = candidate;
					return true;
				}
			}
			return false;
		})
		.toBe(true);
	await settingsWindow.locator(".mathlive-settings-intro").waitFor();
	return settingsWindow;
}

// Obsidian may be halfway through writing the file, so a read can see it empty.
function readSavedSettings(vault) {
	try {
		return JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "plugins", "mathlive", "data.json"), "utf8"));
	} catch {
		return {};
	}
}

const settingRow = (settingsWindow, name) =>
	settingsWindow.locator(".vertical-tab-content .setting-item").filter({
		has: settingsWindow.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }),
	});

test.describe("settings", () => {
	test("the settings tab lists every option under its heading", async ({ obsidian }) => {
		const settingsWindow = await openSettings(obsidian);
		const rows = await settingsWindow.locator(".vertical-tab-content .setting-item").evaluateAll((items) =>
			items.map((item) => ({
				name: item.querySelector(".setting-item-name")?.textContent,
				heading: item.classList.contains("setting-item-heading"),
			}))
		);
		expect(rows.filter((row) => row.heading).map((row) => row.name)).toEqual(["Image scanner", "Inline editor"]);
		expect(rows.map((row) => row.name)).toEqual(
			expect.arrayContaining([
				"API key",
				"Self-hosted scanner",
				"Self-hosted scanner address",
				"Enable inline editor mode",
				"Enable inline math widgets",
				"Enable block math widgets",
				"Hide rendered inline math",
				"Hide rendered block math",
				"Update inline widgets immediately",
				"Arrow key navigation between editor and widgets",
			])
		);
		await expect(settingsWindow.locator(".mathlive-settings-intro")).toContainText("visual formula editor");
		await expect(settingRow(settingsWindow, "API key").getByRole("link")).toHaveAttribute("href", /mathlive\.danz\.blog/);
	});

	test("the options show up in Obsidian's settings search", async ({ obsidian }) => {
		const settingsWindow = await openSettings(obsidian);
		await settingsWindow.locator(".vertical-tab-header input[type='search']").fill("scanner address");
		await expect(settingsWindow.locator(".vertical-tab-header")).toContainText("Self-hosted scanner address");
	});

	test("the API key and self-hosted switch are saved", async ({ obsidian }) => {
		const settingsWindow = await openSettings(obsidian);
		await settingRow(settingsWindow, "API key").locator("input").fill("test-key-123");
		await settingRow(settingsWindow, "Self-hosted scanner").locator(".checkbox-container").click();

		await expect
			.poll(() => readSavedSettings(obsidian.vault))
			.toMatchObject({ apiKey: "test-key-123", useLocalInference: true });
	});

	test("the self-hosted scanner address is saved", async ({ obsidian }) => {
		const settingsWindow = await openSettings(obsidian);
		const input = settingRow(settingsWindow, "Self-hosted scanner address").locator("input");
		await expect(input).toHaveValue("http://localhost:8502");
		await input.fill("http://192.168.1.20:8502");

		await expect
			.poll(() => readSavedSettings(obsidian.vault))
			.toMatchObject({ localInferenceUrl: "http://192.168.1.20:8502" });
	});

	test("turning off inline widgets keeps block widgets", async ({ obsidian, page }) => {
		const settingsWindow = await openSettings(obsidian);
		await settingRow(settingsWindow, "Enable inline math widgets").locator(".checkbox-container").click();
		await expect(inlineField(page, 0)).toHaveCount(0);
		await expect(blockField(page)).toBeVisible();
		await expect(page.locator("body")).not.toHaveClass(/mathlive-inline-widgets-active/);
	});

	test("turning off block widgets keeps inline widgets", async ({ obsidian, page }) => {
		const settingsWindow = await openSettings(obsidian);
		await settingRow(settingsWindow, "Enable block math widgets").locator(".checkbox-container").click();
		await expect(blockField(page)).toHaveCount(0);
		await expect(inlineField(page, 0)).toBeVisible();
		await expect(page.locator("body")).not.toHaveClass(/mathlive-block-widgets-active/);
	});

	test("turning off inline editor mode removes every widget and shows Obsidian's math", async ({ obsidian, page }) => {
		const settingsWindow = await openSettings(obsidian);
		await settingRow(settingsWindow, "Enable inline editor mode").locator(".checkbox-container").click();
		await expect(page.locator(".cm-content math-field")).toHaveCount(0);
		const classes = await page.evaluate(() => [...document.body.classList].filter((name) => name.startsWith("mathlive-")));
		expect(classes).toEqual([]);
	});

	test("updates can wait until the formula loses focus", async ({ page }) => {
		await setSettings(page, { immediateInlineUpdate: false });
		await reopenNote(page);
		const field = inlineField(page, 0);
		await focusField(field);
		await page.keyboard.press("End");
		await page.keyboard.type("+1", { delay: 40 });
		await expect.poll(() => field.evaluate((element) => element.value)).toContain("+1");
		const lineBefore = await page.evaluate(() => window.app.workspace.activeEditor.editor.getValue().split("\n")[2]);
		expect(lineBefore).toBe("Inline math $x^2 + y^2 = z^2$ in a sentence.");

		await page.locator(".cm-content .cm-line", { hasText: "Plain paragraph" }).click();
		await expect
			.poll(() => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue().split("\n")[2]))
			.toBe("Inline math $x^2+y^2=z^2+1$ in a sentence.");
	});
});

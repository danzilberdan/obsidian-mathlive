import { defineConfig } from "@playwright/test";

// The UI tests drive a real Obsidian app, so they run one at a time against a single instance.
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "*.spec.mjs",
	workers: 1,
	fullyParallel: false,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	retries: 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		screenshot: "only-on-failure",
	},
});

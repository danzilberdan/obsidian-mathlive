// Downloads Obsidian, builds a throwaway vault with this plugin installed, launches the app
// under Xvfb when there is no display, and connects Playwright to it over the DevTools protocol.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const OBSIDIAN_VERSION = process.env.OBSIDIAN_VERSION ?? "1.14.5";
const CACHE_DIR = process.env.OBSIDIAN_CACHE_DIR ?? path.join(ROOT, ".obsidian-cache");
const FIXTURE_NOTE = path.join(ROOT, "tests/e2e/fixtures/Test.md");

export function ensureObsidian() {
	const dir = path.join(CACHE_DIR, OBSIDIAN_VERSION);
	const exe = path.join(dir, "squashfs-root", "obsidian");
	if (fs.existsSync(exe)) {
		return exe;
	}

	fs.mkdirSync(dir, { recursive: true });
	const appImage = path.join(dir, "Obsidian.AppImage");
	const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}.AppImage`;
	execFileSync("curl", ["-sSfL", "-o", appImage, url], { stdio: "inherit" });
	fs.chmodSync(appImage, 0o755);
	// Extracting avoids needing FUSE to run the AppImage.
	execFileSync(appImage, ["--appimage-extract"], { cwd: dir, stdio: "ignore" });
	return exe;
}

function createVault() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "mathlive-e2e-"));
	const vault = path.join(base, "vault");
	const pluginDir = path.join(vault, ".obsidian", "plugins", "mathlive");
	fs.mkdirSync(pluginDir, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		const source = path.join(ROOT, file);
		if (!fs.existsSync(source)) {
			throw new Error(`${file} is missing. Run "npm run build" first.`);
		}
		fs.copyFileSync(source, path.join(pluginDir, file));
	}
	fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), '["mathlive"]');
	fs.copyFileSync(FIXTURE_NOTE, path.join(vault, "Test.md"));

	const config = path.join(base, "config");
	fs.mkdirSync(path.join(config, "obsidian"), { recursive: true });
	fs.writeFileSync(
		path.join(config, "obsidian", "obsidian.json"),
		JSON.stringify({
			vaults: { mathlivee2e0001: { path: vault, ts: Date.now(), open: true } },
			updateDisabled: true,
		})
	);
	return { base, vault, config };
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitFor(check, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = await check();
			if (value) {
				return value;
			}
		} catch {
			// Not ready yet.
		}
		if (Date.now() > deadline) {
			throw new Error(message);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

export async function launchObsidian() {
	const exe = ensureObsidian();
	const { base, vault, config } = createVault();
	const port = await freePort();
	// OBSIDIAN_ARGS adds Chromium switches, such as a fake microphone that plays a file:
	// --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=speech.wav
	const extra = (process.env.OBSIDIAN_ARGS ?? "").split(" ").filter(Boolean);
	const args = ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, ...extra];
	const [command, commandArgs] = process.env.DISPLAY
		? [exe, args]
		: ["xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", exe, ...args]];
	const proc = spawn(command, commandArgs, {
		env: { ...process.env, XDG_CONFIG_HOME: config },
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	let browser;
	proc.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});

	const close = async () => {
		await browser?.close().catch(() => {});
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		fs.rmSync(base, { recursive: true, force: true });
	};

	try {
		await waitFor(
			async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
			60_000,
			`Obsidian did not start. Output:\n${stderr}`
		);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const context = browser.contexts()[0];
		const page = await waitFor(
			() => context.pages().find((p) => p.url().includes("index.html")),
			30_000,
			"Obsidian's main window did not open."
		);

		// A fresh vault with community plugins asks whether to trust it.
		await page.getByRole("button", { name: "Trust author and enable plugins" }).click({ timeout: 30_000 });
		await waitFor(
			() => page.evaluate(() => Boolean(window.app?.plugins?.plugins?.mathlive)),
			30_000,
			"The MathLive plugin did not load."
		);
		await page.evaluate(() => {
			window.app.setting?.close();
			document.querySelectorAll(".modal-close-button").forEach((button) => button.click());
			return true;
		});
		return { browser, context, page, vault, close };
	} catch (error) {
		await close();
		throw error;
	}
}

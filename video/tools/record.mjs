// Records every scene (or the ones named with --only) as a screen recording in out/recordings/.
//
//   node tools/record.mjs                 record all scenes
//   node tools/record.mjs --only connect  record one scene again
//
// Everything runs on a virtual screen (Xvfb): a real Obsidian with this plugin's build, a browser
// for the website, and ffmpeg filming the screen. Title cards are stills. A scene script calls
// say("line id") where a narration line starts. say() waits until the line before it has finished
// playing (the clips in voice/ give the lengths), and the start times are saved next to the
// recording, so the build lays each clip exactly where its line was said.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchObsidian } from "../../tests/e2e/obsidian.mjs";
import { CURSOR_SCRIPT } from "./cursor.mjs";
import { startDemoScanner } from "./demo-scanner.mjs";
import { ASSETS, ffmpeg, launchChromium, onlyFilter, readJson, readManifest, RECORDINGS, ROOT, VIDEO, VOICE_INDEX, writeJson } from "./lib.mjs";

const manifest = readManifest();
const only = onlyFilter();
const voices = readJson(VOICE_INDEX, {});
const demo = readJson(path.join(ASSETS, "demo.json"));
const { width, height } = manifest.size;
const DISPLAY = process.env.VIDEO_DISPLAY ?? ":99";
const LEAD_IN = 0.6;
const TAIL = 0.9;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(RECORDINGS, { recursive: true });
if (!fs.existsSync(path.join(ROOT, "main.js"))) {
	throw new Error('Build the plugin first: "npm run build" in the repository root.');
}

// The virtual screen everything is drawn on.
const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
process.env.DISPLAY = DISPLAY;
await sleep(800);

const scanner = await startDemoScanner({ pages: demo.lecture.pages.map((page) => page.markdown) });
const obsidian = await launchObsidian();
const { page } = obsidian;
await page.evaluate(
	({ width, height, zoom }) => {
		const electron = window.require("electron");
		const main = electron.remote.getCurrentWindow();
		// Obsidian keeps its settings in a second window; without a window manager it would sit on top.
		for (const other of electron.remote.BrowserWindow.getAllWindows()) {
			if (other.id !== main.id) {
				other.hide();
			}
		}
		main.setBounds({ x: 0, y: 0, width, height });
		main.focus();
		// Bigger than life, so the formulas read well in a video.
		electron.webFrame.setZoomFactor(zoom);
		return true;
	},
	{ width, height, zoom: manifest.obsidian_zoom ?? 1.3 }
);
const installCursor = (target) => target.evaluate(CURSOR_SCRIPT).catch(() => {});
await installCursor(page);
const defaults = await page.evaluate(() => ({ ...window.app.plugins.plugins.mathlive.settings }));

let browser = null;
async function openBrowser(url) {
	browser ??= await launchChromium({
		headless: false,
		args: [`--window-size=${width},${height}`, "--window-position=0,0", "--kiosk", "--hide-scrollbars", "--force-device-scale-factor=1.25"],
	});
	const context = await browser.newContext({ viewport: null, colorScheme: "dark" });
	await context.addInitScript({ content: `document.addEventListener("DOMContentLoaded", () => { ${CURSOR_SCRIPT} });` });
	const tab = await context.newPage();
	await tab.goto(url, { waitUntil: "networkidle" });
	await installCursor(tab);
	return tab;
}
async function closeBrowser() {
	await browser?.close();
	browser = null;
}

// Films the screen until stop() is called. Resolves once ffmpeg is actually capturing.
function startFilming(file) {
	const ffmpeg = spawn(
		"ffmpeg",
		["-hide_banner", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(manifest.output.fps), "-video_size", `${width}x${height}`, "-i", DISPLAY, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", file],
		{ stdio: ["pipe", "ignore", "pipe"] }
	);
	return new Promise((resolve, reject) => {
		let log = "";
		ffmpeg.stderr.on("data", (chunk) => {
			log += chunk;
			if (log.includes("Press [q]")) {
				log = "";
				resolve({
					startedAt: Date.now(),
					stop: () =>
						new Promise((done) => {
							ffmpeg.on("exit", done);
							ffmpeg.stdin.write("q");
						}),
				});
			}
		});
		ffmpeg.on("exit", (code) => code && reject(new Error(`ffmpeg stopped: ${log.slice(-500)}`)));
	});
}

// Puts Obsidian back to the state every scene starts from: the demo note open, nothing else.
async function resetObsidian() {
	await page.evaluate(
		async ({ note, defaults }) => {
			const app = window.app;
			app.setting?.close();
			document.querySelectorAll(".modal-close-button").forEach((button) => button.click());
			document.querySelectorAll(".notice, .modal-container, .menu").forEach((element) => element.remove());
			// A dialog removed without closing leaves its keyboard scope behind, which steals focus.
			const stack = app.keymap.getWindowStack(window);
			while (stack.scope?.tabFocusContainerEl && stack.prevScopes.length > 0) {
				app.keymap.popScope(stack.scope);
			}
			app.changeTheme("obsidian");
			// Obsidian opens dialogs in the window it thinks has focus; make that the main one.
			window.require("electron").remote.getCurrentWindow().focus();
			window.dispatchEvent(new Event("focus"));
			const plugin = app.plugins.plugins.mathlive;
			plugin.account.cancelConnect();
			plugin.settings = { ...defaults, useLocalInference: true, localInferenceUrl: "http://127.0.0.1:8502", apiKey: "demo", scanOtherApps: false };
			await plugin.saveSettings();
			for (const leaf of app.workspace.getLeavesOfType("markdown").concat(app.workspace.getLeavesOfType("pdf"), app.workspace.getLeavesOfType("image"))) {
				leaf.detach();
			}
			let file = app.vault.getAbstractFileByPath(note.path);
			if (file) {
				await app.vault.modify(file, note.text);
			} else {
				file = await app.vault.create(note.path, note.text);
			}
			for (const extra of app.vault.getFiles().filter((f) => f.path !== note.path && f.extension === "md")) {
				await app.vault.delete(extra);
			}
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: "source", source: false } });
			app.workspace.setActiveLeaf(leaf, { focus: true });
			if (app.workspace.leftSplit && !app.workspace.leftSplit.collapsed) {
				app.workspace.leftSplit.collapse();
			}
			if (app.workspace.rightSplit && !app.workspace.rightSplit.collapsed) {
				app.workspace.rightSplit.collapse();
			}
			return true;
		},
		{ note: demo.note, defaults }
	);
	await page.mouse.move(width * 0.62, height * 0.5);
	await sleep(1200);
}

// A title card, drawn by the browser so the text and fade match the website.
function cardHtml(card) {
	return `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; height: 100%; background: radial-gradient(ellipse at 30% 20%, #2b2350 0%, #15131f 55%, #0e0d14 100%); color: #f3f1ff; font-family: Inter, "DejaVu Sans", sans-serif; }
main { height: 100%; display: flex; flex-direction: column; justify-content: center; padding: 0 140px; animation: in 0.9s ease-out both; }
h1 { font-size: 92px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 22px; }
h1 span { color: #a78bfa; }
p { font-size: 34px; color: #c9c3e6; margin: 0; max-width: 1340px; line-height: 1.35; }
@keyframes in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
</style><main><h1>${card.heading.replace(/2\.0/, "<span>2.0</span>")}</h1><p>${card.subheading}</p></main>`;
}

// A title card is a still picture held for as long as its lines take; nothing needs filming.
async function recordCard(scene) {
	const file = path.join(RECORDINGS, `${scene.id}.mp4`);
	const still = path.join(RECORDINGS, `${scene.id}.png`);
	const headless = await launchChromium();
	const tab = await headless.newPage({ viewport: { width, height }, deviceScaleFactor: manifest.output.width / width });
	await tab.setContent(cardHtml(scene.card).replace("animation: in 0.9s ease-out both;", ""));
	await tab.evaluate(() => document.fonts.ready);
	await tab.screenshot({ path: still });
	await headless.close();

	const cues = {};
	let at = LEAD_IN;
	for (const line of scene.lines) {
		const clip = voices[line.id];
		if (!clip) {
			throw new Error(`No voice clip for ${line.id}. Run tools/voice.mjs first.`);
		}
		cues[line.id] = { at: Number(at.toFixed(3)), duration: clip.duration };
		at += clip.duration + (line.pause ?? manifest.voice.gap);
	}
	const length = at + TAIL;
	ffmpeg(["-loop", "1", "-i", still, "-t", length.toFixed(3), "-r", String(manifest.output.fps), "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", file]);
	fs.rmSync(still);
	writeJson(path.join(RECORDINGS, `${scene.id}.json`), { length: Number(length.toFixed(3)), cues });
	console.log(`${scene.id}: ${length.toFixed(1)} s (card)`);
}

async function recordScene(scene) {
	const file = path.join(RECORDINGS, `${scene.id}.mp4`);
	const script = path.join(VIDEO, "scenes", `${scene.id}.mjs`);
	const module = fs.existsSync(script) ? await import(pathToFileURL(script).href) : {};
	const lines = new Map(scene.lines.map((line) => [line.id, line]));
	const cues = {};
	let film;
	let lineEnd = LEAD_IN;
	const now = () => (Date.now() - film.startedAt) / 1000;

	const ctx = {
		page,
		scanner,
		demo,
		manifest,
		width,
		height,
		openBrowser,
		closeBrowser,
		installCursor,
		sleep,
		// Starts a narration line once the one before it has finished.
		async say(id) {
			const line = lines.get(id);
			if (!line) {
				throw new Error(`${scene.id} has no line "${id}".`);
			}
			const clip = voices[id];
			if (!clip) {
				throw new Error(`No voice clip for ${id}. Run tools/voice.mjs first.`);
			}
			const wait = lineEnd - now();
			if (wait > 0) {
				await sleep(wait * 1000);
			}
			cues[id] = { at: Number(now().toFixed(3)), duration: clip.duration };
			lineEnd = cues[id].at + clip.duration + (line.pause ?? manifest.voice.gap);
		},
		// Waits until the line being said is over.
		async lineDone() {
			const wait = lineEnd - now();
			if (wait > 0) {
				await sleep(wait * 1000);
			}
		},
		// Moves the pointer to an element in steps, so the movement is visible.
		async pointAt(locator, { steps = 28, offset } = {}) {
			const box = await locator.boundingBox();
			const target = locator.page();
			const x = box.x + (offset?.x ?? box.width / 2);
			const y = box.y + (offset?.y ?? box.height / 2);
			await target.mouse.move(x, y, { steps });
			await sleep(250);
			return { x, y };
		},
		// Clicks a formula and waits until it has the keyboard: the click first lands in the note,
		// and the plugin moves focus into the formula a moment later.
		async focusFormula(field, options) {
			await ctx.click(field, options);
			for (let stable = 0, tries = 0; stable < 3 && tries < 40; tries++) {
				const focused = await field.evaluate((element) => element.ownerDocument.activeElement === element);
				stable = focused ? stable + 1 : 0;
				await sleep(100);
			}
		},
		async click(locator, options) {
			await ctx.pointAt(locator, options);
			await locator.page().mouse.down();
			await sleep(90);
			await locator.page().mouse.up();
			await sleep(200);
		},
	};

	if (scene.kind === "obsidian") {
		await closeBrowser();
		await resetObsidian();
	}
	await module.setup?.(ctx);

	film = await startFilming(file);
	try {
		await module.run(ctx);
	} catch (error) {
		// Keep a picture of what went wrong, and don't leave ffmpeg running.
		await page.screenshot({ path: path.join(RECORDINGS, `${scene.id}-error.png`) }).catch(() => {});
		await film.stop();
		throw error;
	}
	await ctx.lineDone();
	await sleep(TAIL * 1000);
	const length = now();
	await film.stop();
	await module.teardown?.(ctx);
	writeJson(path.join(RECORDINGS, `${scene.id}.json`), { length: Number(length.toFixed(3)), cues });
	console.log(`${scene.id}: ${length.toFixed(1)} s`);
}

try {
	for (const scene of manifest.scenes) {
		if (only(scene.id) && scene.kind === "card" && !fs.existsSync(path.join(VIDEO, "scenes", `${scene.id}.mjs`))) {
			await recordCard(scene);
		} else if (only(scene.id)) {
			await recordScene(scene);
		}
	}
} finally {
	await closeBrowser();
	await scanner.close();
	await obsidian.close();
	xvfb.kill();
}

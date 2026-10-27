// Shared helpers: where things live, reading and writing the scene manifest, and running ffmpeg.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = path.resolve(VIDEO, "..");
export const MANIFEST = path.join(VIDEO, "scenes.yaml");
export const VOICE_DIR = path.join(VIDEO, "voice");
export const VOICE_INDEX = path.join(VOICE_DIR, "index.json");
export const ASSETS = path.join(VIDEO, "assets");
// Recordings and renders are big and can be made again, so they stay out of git.
export const OUT = path.join(VIDEO, "out");
export const RECORDINGS = path.join(OUT, "recordings");
export const CACHE = process.env.MATHLIVE_VIDEO_CACHE ?? path.join(process.env.HOME ?? "/tmp", ".cache", "mathlive-video");

export function readManifest() {
	return YAML.parse(fs.readFileSync(MANIFEST, "utf8"));
}

// The manifest as a YAML document, so edits keep its comments and layout.
export function readManifestDocument() {
	return YAML.parseDocument(fs.readFileSync(MANIFEST, "utf8"));
}

export function writeManifestDocument(doc) {
	fs.writeFileSync(MANIFEST, doc.toString({ lineWidth: 0 }));
}

export function allLines(manifest) {
	return manifest.scenes.flatMap((scene) => scene.lines.map((line) => ({ ...line, scene: scene.id })));
}

export function readJson(file, fallback) {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

export function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t") + "\n");
}

export const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export function ffmpeg(args) {
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

export function duration(file) {
	const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
	return Number(out.toString().trim());
}

// Picks scene or line ids from the command line: `--only intro,editing-1`.
export function onlyFilter(argv = process.argv) {
	const at = argv.indexOf("--only");
	if (at < 0) {
		return () => true;
	}
	const ids = new Set(argv[at + 1].split(","));
	return (...candidates) => candidates.some((id) => ids.has(id));
}

// Playwright's own Chromium, or a preinstalled one when the pinned version isn't downloaded
// (set CHROMIUM_PATH to choose).
export async function launchChromium(options = {}) {
	const { chromium } = await import("@playwright/test");
	const preinstalled = ["/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].find(
		(file) => fs.existsSync(file) && fs.statSync(file).isFile()
	);
	const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync(chromium.executablePath()) ? undefined : preinstalled);
	return chromium.launch({ executablePath, ...options });
}

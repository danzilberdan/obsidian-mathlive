// Makes one voice clip per narration line, in voice/<line id>.m4a.
//
//   node tools/voice.mjs                      make the clips whose text or voice settings changed
//   node tools/voice.mjs --only connect-2     remake only these lines (or whole scenes)
//   node tools/voice.mjs --force              remake every clip
//
// With voice.engine "takes", the clips come from your own recordings in takes/ (tools/prompter.mjs).
//
// voice/index.json remembers what each clip was made from, so an unchanged line is never sent again.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { speak, totalSpend } from "./openrouter.mjs";
import { allLines, CACHE, duration, ffmpeg, hash, onlyFilter, readJson, readManifest, VOICE_DIR, VOICE_INDEX, writeJson } from "./lib.mjs";

const manifest = readManifest();
const only = onlyFilter();
const force = process.argv.includes("--force");
const engine = manifest.voice.engine;
const settings = manifest.voice[engine];
const index = readJson(VOICE_INDEX, {});
fs.mkdirSync(CACHE, { recursive: true });
const work = fs.mkdtempSync(path.join(CACHE, "voice-"));

// Piper voices come from the Piper project's releases on GitHub.
function piperModel(name) {
	const file = path.join(CACHE, `${name}.onnx`);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(CACHE, { recursive: true });
		const url = `https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-${name}.tar.gz`;
		execFileSync("sh", ["-c", `curl -sSfL "${url}" | tar xz -C "${CACHE}"`], { stdio: "inherit" });
	}
	return file;
}

// Takes recorded with tools/prompter.mjs, cleaned up a little.
const TAKES = path.join(VOICE_DIR, "..", "takes");
const takeFile = (id) => path.join(TAKES, `${id}.webm`);

async function synthesize(text, wav, id) {
	if (engine === "takes") {
		ffmpeg(["-i", takeFile(id), "-af", settings.cleanup, "-ac", "1", wav]);
	} else if (engine === "openrouter") {
		const mp3 = `${wav}.mp3`;
		fs.writeFileSync(mp3, await speak({ ...settings, text, purpose: "voice" }));
		ffmpeg(["-i", mp3, wav]);
	} else if (engine === "piper") {
		execFileSync("python3", ["-m", "piper", "-m", piperModel(settings.model), "--length-scale", String(settings.length_scale ?? 1), "-f", wav], {
			input: text,
			stdio: ["pipe", "ignore", "inherit"],
		});
	} else {
		throw new Error(`Unknown voice engine "${engine}".`);
	}
}

fs.mkdirSync(VOICE_DIR, { recursive: true });
let made = 0;
for (const line of allLines(manifest)) {
	if (!line.text) {
		console.log(`${line.id}: no text yet, skipped`);
		continue;
	}
	if (engine === "takes") {
		if (!fs.existsSync(takeFile(line.id))) {
			console.log(`${line.id}: no take yet, record it with tools/prompter.mjs`);
			continue;
		}
		const take = readJson(takeFile(line.id).replace(/\.webm$/, ".json"), {});
		if (take.text !== line.text) {
			console.warn(`! ${line.id}: the take was read from older text. Record it again if the words changed.`);
		}
	}
	const source = engine === "takes" ? crypto.createHash("sha256").update(fs.readFileSync(takeFile(line.id))).digest("hex") : null;
	const key = hash({ engine, settings, text: line.text, source });
	const clip = path.join(VOICE_DIR, `${line.id}.m4a`);
	const fresh = index[line.id]?.hash === key && fs.existsSync(clip);
	if ((fresh && !force) || !only(line.scene, line.id)) {
		continue;
	}
	const wav = path.join(work, `${line.id}.wav`);
	await synthesize(line.text, wav, line.id);
	// Cut the silence the voice leaves at both ends, so the gaps between lines are ours to set.
	const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05";
	ffmpeg(["-i", wav, "-af", `${trim},areverse,${trim},areverse`, "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", clip]);
	index[line.id] = { hash: key, engine, duration: Number(duration(clip).toFixed(3)), text: line.text };
	console.log(`${line.id}: ${index[line.id].duration.toFixed(2)} s`);
	made++;
}
// Forget clips of lines that were removed from the manifest.
const ids = new Set(allLines(manifest).map((line) => line.id));
for (const id of Object.keys(index)) {
	if (!ids.has(id)) {
		delete index[id];
		fs.rmSync(path.join(VOICE_DIR, `${id}.m4a`), { force: true });
	}
}
writeJson(VOICE_INDEX, index);
fs.rmSync(work, { recursive: true, force: true });
console.log(`${made} clip(s) made with ${engine}.${engine === "openrouter" ? ` OpenRouter spend so far: $${totalSpend().toFixed(4)}` : ""}`);

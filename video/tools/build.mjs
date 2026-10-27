// Puts the video together: each scene's recording with its voice clips laid at the times they were
// said, then all scenes in order. Writes out/mathlive-2.0-showcase.mp4 and matching subtitles (.srt).
//
//   node tools/build.mjs
//
// Nothing here calls a paid service; run it as often as you like.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, OUT, readJson, readManifest, RECORDINGS, VOICE_DIR, VOICE_INDEX } from "./lib.mjs";

const manifest = readManifest();
const voices = readJson(VOICE_INDEX, {});
const { width, height, fps } = manifest.output;
const FADE = 0.3;
const segments = path.join(OUT, "segments");
fs.mkdirSync(segments, { recursive: true });

const srt = [];
const stamp = (seconds) => {
	const ms = Math.round(seconds * 1000);
	const pad = (n, size = 2) => String(n).padStart(size, "0");
	return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

let offset = 0;
const parts = [];
for (const scene of manifest.scenes) {
	const recording = path.join(RECORDINGS, `${scene.id}.mp4`);
	const timing = readJson(path.join(RECORDINGS, `${scene.id}.json`), null);
	if (!timing || !fs.existsSync(recording)) {
		throw new Error(`${scene.id} isn't recorded yet. Run: node tools/record.mjs --only ${scene.id}`);
	}
	const inputs = ["-i", recording];
	const delays = [];
	for (const line of scene.lines) {
		const cue = timing.cues[line.id];
		const voice = voices[line.id];
		if (!cue || !voice) {
			throw new Error(`${line.id} has no ${cue ? "voice clip" : "recorded cue"}. Run tools/voice.mjs, then tools/record.mjs --only ${scene.id}.`);
		}
		if (Math.abs(voice.duration - cue.duration) > 0.05) {
			console.warn(`! ${line.id} was recorded for a ${cue.duration.toFixed(2)} s clip but the clip is now ${voice.duration.toFixed(2)} s. Record ${scene.id} again to fit it.`);
		}
		inputs.push("-i", path.join(VOICE_DIR, `${line.id}.m4a`));
		delays.push(cue.at);
		srt.push(`${srt.length + 1}\n${stamp(offset + cue.at)} --> ${stamp(offset + cue.at + voice.duration)}\n${line.text}\n`);
	}

	const length = timing.length;
	const video = `[0:v]fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,fade=in:st=0:d=${FADE},fade=out:st=${(length - FADE).toFixed(3)}:d=${FADE}[v]`;
	const voiceChains = delays.map((at, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(at * 1000)}:all=1[a${i}]`);
	const mix = `${delays.map((_, i) => `[a${i}]`).join("")}amix=inputs=${delays.length}:normalize=0,apad,atrim=0:${length.toFixed(3)}[a]`;
	const segment = path.join(segments, `${scene.id}.mp4`);
	ffmpeg([
		...inputs,
		"-filter_complex",
		[video, ...voiceChains, mix].join(";"),
		"-map", "[v]", "-map", "[a]",
		"-t", length.toFixed(3),
		"-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "192k", "-ar", "48000",
		segment,
	]);
	parts.push(segment);
	offset += length;
	console.log(`${scene.id}: ${length.toFixed(1)} s`);
}

const list = path.join(segments, "list.txt");
fs.writeFileSync(list, parts.map((part) => `file '${part}'`).join("\n") + "\n");
const output = path.join(OUT, "mathlive-2.0-showcase.mp4");
// One loudness pass over the whole voice track, so every line sits at the same level.
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output]);
fs.writeFileSync(output.replace(/\.mp4$/, ".srt"), srt.join("\n"));
console.log(`\n${output} (${offset.toFixed(1)} s)`);

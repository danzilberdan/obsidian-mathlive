// Writes the narration with a model on OpenRouter and saves it into scenes.yaml.
//
//   node tools/write-script.mjs                         write every line
//   node tools/write-script.mjs --only connect,intro-1  rewrite only these scenes or lines
//   node tools/write-script.mjs --note "shorter, less salesy"   steer the rewrite
//
// Lines that aren't rewritten are sent as context, so the new lines fit around them.
import fs from "node:fs";
import path from "node:path";
import { complete, totalSpend } from "./openrouter.mjs";
import { onlyFilter, readManifest, readManifestDocument, VIDEO, writeManifestDocument } from "./lib.mjs";

const manifest = readManifest();
const only = onlyFilter();
const noteAt = process.argv.indexOf("--note");
const note = noteAt >= 0 ? process.argv[noteAt + 1] : "";
const brief = fs.readFileSync(path.join(VIDEO, "brief.md"), "utf8");

const wanted = [];
const outline = manifest.scenes.map((scene) => ({
	scene: scene.id,
	lines: scene.lines.map((line) => {
		const rewrite = only(scene.id, line.id);
		if (rewrite) {
			wanted.push(line.id);
		}
		return { id: line.id, on_screen: line.on_screen, words: line.words, ...(rewrite ? { write: true } : { text: line.text }) };
	}),
}));
if (wanted.length === 0) {
	throw new Error("No lines match --only.");
}

const system = `You write voice-over narration for short product demo videos.
Answer with one JSON object only, no code fence: {"<line id>": "<narration>", ...}, with exactly the line ids marked "write": true.`;
const user = `${brief}

## The video, scene by scene

${JSON.stringify(outline, null, 2)}
${note ? `\n## Notes for this rewrite\n\n${note}\n` : ""}`;

const answer = await complete({ model: manifest.script.model, system, user, purpose: `script ${wanted.join(",")}` });
const texts = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));

const doc = readManifestDocument();
for (const scene of doc.get("scenes").items) {
	for (const line of scene.get("lines").items) {
		const id = line.get("id");
		if (wanted.includes(id)) {
			if (typeof texts[id] !== "string") {
				throw new Error(`The model left out ${id}.`);
			}
			line.set("text", texts[id].trim());
			console.log(`${id}: ${texts[id].trim()}`);
		}
	}
}
writeManifestDocument(doc);
console.log(`\nOpenRouter spend so far: $${totalSpend().toFixed(4)}`);

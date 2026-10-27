// A small OpenRouter client that writes what every call cost to spend.jsonl.
import fs from "node:fs";
import path from "node:path";
import { VIDEO } from "./lib.mjs";

const API = "https://openrouter.ai/api/v1/chat/completions";
export const SPEND_LOG = path.join(VIDEO, "spend.jsonl");

function apiKey() {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) {
		throw new Error("Set OPENROUTER_API_KEY first.");
	}
	return key;
}

function logSpend(purpose, model, usage) {
	const entry = { at: new Date().toISOString(), purpose, model, cost: usage?.cost ?? null, tokens: usage?.total_tokens ?? null };
	fs.appendFileSync(SPEND_LOG, JSON.stringify(entry) + "\n");
	return entry;
}

async function post(body) {
	const response = await fetch(API, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "X-Title": "MathLive video" },
		body: JSON.stringify({ ...body, usage: { include: true } }),
	});
	if (!response.ok) {
		throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 800)}`);
	}
	return response;
}

// A plain text completion.
export async function complete({ model, system, user, purpose }) {
	const response = await post({
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	});
	const data = await response.json();
	if (data.error) {
		throw new Error(`OpenRouter: ${JSON.stringify(data.error).slice(0, 800)}`);
	}
	logSpend(purpose, model, data.usage);
	return data.choices[0].message.content;
}

// Speech from a text-to-speech model (ElevenLabs and others) as MP3 bytes. The speech endpoint
// answers with bare audio, so the cost is worked out from the model's price per character.
const pricePerCharacter = new Map();
async function speechPrice(model) {
	if (!pricePerCharacter.has(model)) {
		const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=speech");
		const found = (await response.json()).data.find((entry) => entry.id === model);
		pricePerCharacter.set(model, Number(found?.pricing?.prompt ?? 0));
	}
	return pricePerCharacter.get(model);
}

export async function speak({ model, voice, speed, text, purpose }) {
	const response = await fetch(API.replace("chat/completions", "audio/speech"), {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "X-Title": "MathLive video" },
		body: JSON.stringify({ model, input: text, voice, speed, response_format: "mp3" }),
	});
	if (!response.ok) {
		throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 800)}`);
	}
	const mp3 = Buffer.from(await response.arrayBuffer());
	logSpend(purpose, model, { cost: Number(((await speechPrice(model)) * text.length).toFixed(6)) });
	return mp3;
}

export function totalSpend() {
	if (!fs.existsSync(SPEND_LOG)) {
		return 0;
	}
	return fs
		.readFileSync(SPEND_LOG, "utf8")
		.split("\n")
		.filter(Boolean)
		.reduce((sum, line) => sum + (JSON.parse(line).cost ?? 0), 0);
}

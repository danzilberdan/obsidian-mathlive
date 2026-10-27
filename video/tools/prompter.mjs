// A teleprompter for recording the narration yourself, one line at a time.
//
//   node tools/prompter.mjs        then open http://localhost:4700
//
// Each take is saved as takes/<line id>.webm the moment you keep it, with the text it was read
// from, so a retake replaces just that line. With voice.engine set to "takes" in scenes.yaml,
// tools/voice.mjs turns the takes into the voice clips the video is built from.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { allLines, readManifest, VIDEO, writeJson } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 4700);
const TAKES = path.join(VIDEO, "takes");
const PAGE = path.join(VIDEO, "tools", "prompter.html");
// A comfortable reading pace for the time bar, in words per second.
const PACE = 2.5;

function lines() {
	const manifest = readManifest();
	return allLines(manifest).map((line) => {
		const scene = manifest.scenes.find((s) => s.id === line.scene);
		const meta = path.join(TAKES, `${line.id}.json`);
		const take = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")) : null;
		return {
			id: line.id,
			scene: scene.id,
			text: line.text,
			onScreen: line.on_screen,
			target: Number((line.text.split(/\s+/).length / PACE + 0.4).toFixed(1)),
			take: take && { duration: take.duration, stale: take.text !== line.text },
		};
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		return res.end(fs.readFileSync(PAGE, "utf8").replace("/*LINES*/[]", JSON.stringify(lines())));
	}
	if (req.method === "GET" && url.pathname === "/lines") {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify(lines()));
	}
	const take = url.pathname.match(/^\/takes\/([a-z0-9-]+)$/);
	if (take && req.method === "GET") {
		const file = path.join(TAKES, `${take[1]}.webm`);
		if (!fs.existsSync(file)) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { "Content-Type": "audio/webm" });
		return fs.createReadStream(file).pipe(res);
	}
	if (take && req.method === "POST") {
		const line = lines().find((l) => l.id === take[1]);
		if (!line) {
			res.writeHead(404);
			return res.end();
		}
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			fs.mkdirSync(TAKES, { recursive: true });
			fs.writeFileSync(path.join(TAKES, `${line.id}.webm`), Buffer.concat(chunks));
			writeJson(path.join(TAKES, `${line.id}.json`), {
				text: line.text,
				duration: Number(url.searchParams.get("duration")),
				recordedAt: new Date().toISOString(),
			});
			console.log(`kept ${line.id} (${url.searchParams.get("duration")} s)`);
			res.writeHead(204);
			res.end();
		});
		return;
	}
	res.writeHead(404);
	res.end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`Teleprompter: http://localhost:${PORT}  (takes go to ${TAKES})`));

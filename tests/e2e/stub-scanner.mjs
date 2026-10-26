// A stand-in for the self-hosted scanner's /predict/ endpoint. It records each request and
// answers by API key: "unauthorized" gets 401, "server-error" gets 500, anything else gets LaTeX.
import http from "node:http";

export const SCANNED_LATEX = "\\sqrt[3]{x}";

export function startStubScanner(port = 8502) {
	const requests = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const apiKey = req.headers["api-key"] ?? null;
			requests.push({
				method: req.method,
				url: req.url,
				apiKey,
				contentType: req.headers["content-type"] ?? "",
				hasPng: body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
			});

			const reply = (status, payload) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.method !== "POST" || req.url !== "/predict/") {
				reply(404, { detail: "Not found" });
			} else if (apiKey === "unauthorized") {
				reply(401, { detail: "Invalid API key" });
			} else if (apiKey === "server-error") {
				reply(500, { detail: "Model crashed" });
			} else {
				reply(200, SCANNED_LATEX);
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve({ requests, close: () => new Promise((done) => server.close(() => done())) });
		});
	});
}

// A stand-in for the scanner's /predict/ endpoint. It records each request and answers by API key:
// "unauthorized" gets 401, "server-error" gets 500, "flaky" gets 503 on its first request only,
// "no-scans-left" and "no-math" get the cloud scanner's coded errors, anything else gets LaTeX.
// It also stands in for the cloud scanner's account endpoints: trials, connecting a device
// (approve a challenge with `approve`), disconnecting and the account status.
import crypto from "node:crypto";
import http from "node:http";

export const SCANNED_LATEX = "\\sqrt[3]{x}";

// The width and height of the first PNG in a request body.
function pngSize(body) {
	const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	if (start < 0 || body.length < start + 24) {
		return null;
	}
	return { width: body.readUInt32BE(start + 16), height: body.readUInt32BE(start + 20) };
}

export function startStubScanner(port = 8502) {
	const requests = [];
	let flakyFailed = false;
	const account = {
		trialAvailable: true,
		approved: new Set(),
		forgotten: [],
		approve(challenge) {
			this.approved.add(challenge);
		},
		reset() {
			this.trialAvailable = true;
			this.approved.clear();
			this.forgotten.length = 0;
		},
	};
	const STATUS = {
		"trial-key": { hasUnlimitedAccess: false, scansLeft: 2, trial: true, email: "", device: "Trial" },
		"low-key": { hasUnlimitedAccess: false, scansLeft: 2, trial: false, email: "ada@example.com", device: null },
		"device-key": { hasUnlimitedAccess: false, scansLeft: 9, trial: false, email: "ada@example.com", device: "vault on Linux" },
	};
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
				pngSize: pngSize(body),
			});

			const reply = (status, payload) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/trial" && req.method === "POST") {
				if (account.trialAvailable) {
					reply(200, { apikey: "trial-key", scans: 3 });
				} else {
					reply(429, { detail: "No more trials from this network today.", code: "trial_unavailable" });
				}
			} else if (req.url === "/connect/claim" && req.method === "POST") {
				const { verifier } = JSON.parse(body.toString() || "{}");
				const challenge = crypto.createHash("sha256").update(String(verifier)).digest("hex");
				if (account.approved.delete(challenge)) {
					reply(200, { apikey: "device-key", email: "ada@example.com", device: "vault on Linux" });
				} else {
					reply(202, { status: "pending" });
				}
			} else if (req.url === "/connect/forget" && req.method === "POST") {
				account.forgotten.push(apiKey);
				res.writeHead(204);
				res.end();
			} else if (req.url === "/access-status") {
				if (STATUS[apiKey]) {
					reply(200, STATUS[apiKey]);
				} else if (apiKey === "unauthorized") {
					reply(401, { detail: "Invalid API key.", code: "access_denied" });
				} else {
					reply(200, { hasUnlimitedAccess: false });
				}
			} else if (req.method !== "POST" || req.url !== "/predict/") {
				reply(404, { detail: "Not found" });
			} else if (apiKey === "unauthorized") {
				reply(401, { detail: "Invalid API key" });
			} else if (apiKey === "server-error") {
				reply(500, { detail: "Model crashed" });
			} else if (apiKey === "flaky" && !flakyFailed) {
				flakyFailed = true;
				reply(503, { detail: "Restarting" });
			} else if (apiKey === "no-scans-left" || apiKey === "trial-used") {
				reply(400, { detail: "No scans left.", code: "no_scans_left" });
			} else if (apiKey === "no-math") {
				reply(502, { detail: "No math found in this image.", code: "no_math" });
			} else {
				reply(200, SCANNED_LATEX);
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve({ requests, account, close: () => new Promise((done) => server.close(() => done())) });
		});
	});
}

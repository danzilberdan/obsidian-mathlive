// A stand-in for the scanner's /predict/ endpoint. It records each request and answers by API key:
// "unauthorized" gets 401, "server-error" gets 500, "flaky" gets 503 on its first request only,
// "no-scans-left" and "no-math" get the cloud scanner's coded errors, anything else gets LaTeX.
// It also stands in for the cloud scanner's account endpoints: trials, connecting a device
// (approve a challenge with `approve`), disconnecting and the account status.
// /pages/ answers a page as Markdown, and a blank page (a tiny PNG) as blank. "old-scanner" gets
// 404 there, like a scanner from before pages, and "pages-down" always gets 503. "two-pages-left"
// has a monthly plan with 2 pages left in /access-status, and "page-limit" is told 402 page_limit.
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";

export const SCANNED_LATEX = "\\sqrt[3]{x}";
export const PAGE_MARKDOWN = "## Circles\n\nThe area is $A = \\pi r^2$.";

// The width and height of the first PNG in a request body.
function pngSize(body) {
	const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	if (start < 0 || body.length < start + 24) {
		return null;
	}
	return { width: body.readUInt32BE(start + 16), height: body.readUInt32BE(start + 20) };
}

// Whether the first PNG in a request body is a plain white picture, like a blank page.
function isBlankPng(body) {
	const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	if (start < 0) {
		return false;
	}
	const data = [];
	for (let at = start + 8; at + 8 <= body.length; ) {
		const length = body.readUInt32BE(at);
		const type = body.toString("latin1", at + 4, at + 8);
		if (type === "IDAT") {
			data.push(body.subarray(at + 8, at + 8 + length));
		}
		if (type === "IEND") {
			break;
		}
		at += 12 + length;
	}
	// White rows come out as 255s, or as 0s after PNG's row filters; any ink adds other values.
	const pixels = zlib.inflateSync(Buffer.concat(data));
	let ink = 0;
	for (const value of pixels) {
		if (value !== 0 && value !== 255 && value > 4) {
			ink++;
		}
	}
	return ink === 0;
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
				bytes: body.length,
			});

			const reply = (status, payload) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.method === "GET" && req.url === "/access-status" && apiKey === "two-pages-left") {
				reply(200, {
					hasUnlimitedAccess: true,
					pages: {
						plan: "monthly",
						included: 500,
						used: 498,
						credits: 0,
						left: 2,
						resetsAt: "2026-11-01T00:00:00Z",
						costCeilingReached: false,
					},
				});
			} else if (req.method === "POST" && req.url === "/pages/") {
				if (apiKey === "old-scanner") {
					reply(404, { detail: "Not found" });
				} else if (apiKey === "pages-down") {
					reply(503, { detail: "Couldn't read this page.", code: "scan_failed" });
				} else if (apiKey === "no-scans-left") {
					reply(400, { detail: "No scans left.", code: "no_scans_left" });
				} else if (apiKey === "page-limit") {
					reply(402, { detail: "You've used this month's pages.", code: "page_limit" });
				} else if (isBlankPng(body)) {
					reply(200, { markdown: "", blank: true });
				} else {
					reply(200, { markdown: PAGE_MARKDOWN });
				}
			} else if (req.url === "/trial" && req.method === "POST") {
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

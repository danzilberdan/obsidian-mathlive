// A stand-in for the scanner's /predict/ endpoint. It records each request and answers by API key:
// "unauthorized" gets 401, "server-error" gets 500, "flaky" gets 503 on its first request only,
// "no-scans-left" and "no-math" get the cloud scanner's coded errors, "slow" gets LaTeX after 3 s,
// anything else gets LaTeX at once.
// It also stands in for the cloud scanner's account endpoints: trials, connecting a device
// (approve a challenge with `approve`), disconnecting and the account status.
// /pages/ answers a page as Markdown, and a blank page (a tiny PNG) as blank. "old-scanner" gets
// 404 there, like a scanner from before pages, and "pages-down" always gets 503. "two-pages-left"
// has a monthly plan with 2 pages left in /access-status, and "page-limit" is told 402 page_limit.
// /draw/sessions/... stands in for Draw formula's sessions like the Rust backend's draw.rs: the
// test plays the phone through `draw.phone(id)`. `draw.scansLeft` is what an insert can charge.
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";

export const SCANNED_LATEX = "\\sqrt[3]{x}";
export const DRAWN_LATEX = "\\frac{1}{2}";
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
	const draw = createDrawStub(port);
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
			if (req.url.startsWith("/draw/sessions")) {
				draw.handle(req, body, apiKey, reply);
			} else if (req.method === "GET" && req.url === "/access-status" && apiKey === "two-pages-left") {
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
			} else if (apiKey === "slow") {
				setTimeout(() => reply(200, SCANNED_LATEX), 3000);
			} else {
				reply(200, SCANNED_LATEX);
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve({ requests, account, draw, close: () =>
					new Promise((done) => {
						server.close(() => done());
						// Draw formula's long polls would keep it open.
						server.closeAllConnections();
					}) });
		});
	});
}

function createDrawStub(port) {
	const sessions = new Map();
	const base = `http://127.0.0.1:${port}`;
	const draw = {
		sessions,
		scansLeft: 10,
		charged: 0,
		reset() {
			sessions.clear();
			this.scansLeft = 10;
			this.charged = 0;
		},
		// The newest session, as the plugin opened it.
		latest() {
			return Array.from(sessions.values()).at(-1) ?? null;
		},
		// A stand-in for the phone page: claims the session from its link, then draws and inserts.
		async phone(session) {
			const call = async (path, init = {}, phoneKey) => {
				const response = await fetch(`${base}/draw/sessions/${session.id}${path}`, {
					...init,
					headers: { ...(init.headers ?? {}), ...(phoneKey ? { "Draw-Key": phoneKey } : {}) },
				});
				return { status: response.status, body: await response.json().catch(() => null) };
			};
			const token = new URL(session.phoneUrl).hash.replace("#t=", "");
			const claimed = await call("/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
			const phoneKey = claimed.body?.phoneKey;
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
			return {
				claimed,
				draw: () => call("/recognize?source=phone", { method: "POST", body: png }, phoneKey),
				insert: () => call("/insert", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, phoneKey),
				done: () => call("/close", { method: "POST" }, phoneKey),
			};
		},
		handle(req, body, apiKey, reply) {
			const url = new URL(req.url, base);
			const [, , , id, action] = url.pathname.split("/");
			if (!id) {
				if (apiKey === "no-scans-left") {
					reply(400, { detail: "No scans left.", code: "no_scans_left" });
					return;
				}
				const session = {
					id: crypto.randomUUID().replaceAll("-", ""),
					token: crypto.randomUUID().replaceAll("-", ""),
					apiKey,
					phoneKey: null,
					latex: null,
					closed: false,
					events: [],
					waiters: [],
					recognized: [],
				};
				session.phoneUrl = `https://phone.test/draw/${session.id}#t=${session.token}`;
				sessions.set(session.id, session);
				reply(200, { id: session.id, phoneUrl: session.phoneUrl, idleSeconds: 600, previews: 30 });
				return;
			}
			const session = sessions.get(id);
			if (!session) {
				reply(410, { detail: "This drawing link has ended.", code: "draw_session_gone" });
				return;
			}
			const push = (event) => {
				session.events.push(event);
				for (const wake of session.waiters.splice(0)) wake();
			};
			const close = () => {
				if (!session.closed) {
					session.closed = true;
					push({ type: "closed" });
				}
			};
			if (action === "claim") {
				const { token } = JSON.parse(body.toString() || "{}");
				if (token !== session.token || session.closed) {
					reply(410, { detail: "This drawing link has ended.", code: "draw_session_gone" });
				} else if (session.phoneKey) {
					reply(409, { detail: "This link was already used.", code: "draw_link_used" });
				} else {
					session.phoneKey = crypto.randomUUID();
					push({ type: "phone_connected" });
					reply(200, { phoneKey: session.phoneKey, previews: 30 });
				}
				return;
			}
			const phone = req.headers["draw-key"] === session.phoneKey && session.phoneKey !== null;
			if (!phone && apiKey !== session.apiKey) {
				reply(403, { detail: "This drawing belongs to another device.", code: "draw_not_allowed" });
				return;
			}
			if (action === "wait") {
				const after = Number(url.searchParams.get("after") ?? 0);
				const answer = () =>
					reply(200, {
						events: session.events.slice(after).map((event, index) => ({ ...event, seq: after + index + 1 })),
						next: Math.max(after, session.events.length),
						closed: session.closed,
					});
				if (session.events.length > after || session.closed) {
					answer();
				} else {
					const timer = setTimeout(answer, 2000);
					session.waiters.push(() => {
						clearTimeout(timer);
						answer();
					});
				}
				return;
			}
			if (action === "close") {
				close();
				reply(204, {});
				return;
			}
			if (session.closed) {
				reply(410, { detail: "This drawing link has ended.", code: "draw_session_gone" });
				return;
			}
			if (action === "recognize") {
				const source = phone ? "phone" : "pad";
				session.recognized.push({ source, pngSize: pngSize(body) });
				session.latex = DRAWN_LATEX;
				if (phone) push({ type: "preview", latex: DRAWN_LATEX, source });
				reply(200, { latex: DRAWN_LATEX });
				return;
			}
			if (action === "insert") {
				const latex = JSON.parse(body.toString() || "{}").latex || session.latex;
				if (!session.latex) {
					reply(400, { detail: "Draw a formula first.", code: "nothing_to_insert" });
					return;
				}
				if (draw.scansLeft <= 0) {
					if (phone) push({ type: "out_of_scans" });
					reply(400, { detail: "No scans left.", code: "no_scans_left" });
					return;
				}
				draw.scansLeft--;
				draw.charged++;
				const source = phone ? "phone" : "pad";
				session.latex = null;
				push({ type: "inserted", latex, source });
				if (!phone) close();
				reply(200, { latex });
				return;
			}
			reply(404, { detail: "Not found" });
		},
	};
	return draw;
}

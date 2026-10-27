// A stand-in for the MathLive scanner while recording, so every take shows the same results.
// Scenes say what the next scan returns; pages of the demo lecture come back in the order they're
// asked for. It also plays the account side of connecting: a free trial, then a device that
// connects once the scene approves it.
import http from "node:http";

export function startDemoScanner({ pages, port = 8502 }) {
	const state = {
		latex: [],
		pageIndex: 0,
		scanDelayMs: 1800,
		pageDelayMs: 1200,
		trialScansLeft: 3,
		approvePending: false,
	};
	const control = {
		// The LaTeX the next scan returns.
		nextScan(latex) {
			state.latex.push(latex);
		},
		resetPages() {
			state.pageIndex = 0;
		},
		trialUsedUp() {
			state.trialScansLeft = 0;
		},
		// Lets the waiting device connect, as if its owner signed in on the website.
		approve() {
			state.approvePending = true;
		},
		state,
	};

	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const apiKey = req.headers["api-key"] ?? null;
			const reply = (status, payload, delay = 0) =>
				setTimeout(() => {
					res.writeHead(status, { "Content-Type": "application/json" });
					res.end(JSON.stringify(payload));
				}, delay);
			const url = req.url.split("?")[0];

			if (req.method === "POST" && url === "/predict/") {
				if (apiKey === "trial-key" && state.trialScansLeft <= 0) {
					return reply(400, { detail: "No scans left.", code: "no_scans_left" });
				}
				if (apiKey === "trial-key") {
					state.trialScansLeft--;
				}
				return reply(200, state.latex.shift() ?? "x", state.scanDelayMs);
			}
			if (req.method === "POST" && url === "/pages/") {
				const page = pages[state.pageIndex++ % pages.length];
				return reply(200, { markdown: page }, state.pageDelayMs * (0.8 + Math.random() * 0.4));
			}
			if (req.method === "POST" && url === "/trial") {
				return reply(200, { apikey: "trial-key", scans: 3 });
			}
			if (req.method === "POST" && url === "/connect/claim") {
				if (state.approvePending) {
					state.approvePending = false;
					return reply(200, { apikey: "device-key", email: "ada@example.com", device: "Obsidian on Linux" });
				}
				return reply(202, { status: "pending" });
			}
			if (req.method === "POST" && url === "/connect/forget") {
				res.writeHead(204);
				return res.end();
			}
			if (url === "/access-status") {
				if (apiKey === "trial-key") {
					return reply(200, { hasUnlimitedAccess: false, scansLeft: state.trialScansLeft, trial: true, email: "", device: "Trial" });
				}
				if (apiKey === "device-key") {
					return reply(200, { hasUnlimitedAccess: false, scansLeft: 10, trial: false, email: "ada@example.com", device: "Obsidian on Linux" });
				}
				return reply(200, { hasUnlimitedAccess: true });
			}
			reply(404, { detail: "Not found" });
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => resolve({ ...control, close: () => new Promise((done) => server.close(() => done())) }));
	});
}

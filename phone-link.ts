import { Notice, requestUrl } from "obsidian";
import {
	afterCloudScan,
	askForAccount,
	errorCode,
	scannerAddress,
	scannerHeaders,
	type ScanTarget,
} from "./mathlive-shared";
import type { PluginSettings } from "./settings";

// A phone or tablet paired for Draw formula. The phone scans a QR code once; from then on, what it
// inserts goes into the formula open in Obsidian (or at the note's cursor), whenever Obsidian is
// open, until either side unpairs. The pairing is saved in the settings and listened to with a long
// poll (requestUrl, no timers that tick): the server only charges a phone's insert while this
// listens, so a formula is never lost to a closed Obsidian.

// After a network error, wait this long, doubling up to a minute, before listening again.
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60_000;

export interface Pairing {
	id: string;
	// The phone's short name, such as "iPhone", when the server could tell.
	device: string | null;
}

interface PhoneEvent {
	type: string;
	latex?: string;
	source?: "pad" | "phone" | "photo";
}

interface WaitReply {
	events: PhoneEvent[];
	next: number;
	closed: boolean;
	device?: string | null;
}

// The Draw formula window, while open: it shows the phone's previews and takes its formulas.
export interface PhoneWindow {
	phonePreview(latex: string): void;
	phoneInserted(latex: string): void;
}

export interface PhoneLinkHost {
	getSettings(): PluginSettings;
	saveSettings(): Promise<void>;
	// Where a formula from the phone goes when no Draw window is open: the formula being edited,
	// or the cursor in the note in use. Null when there's neither.
	phoneTarget(): ScanTarget | null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class PhoneLink {
	// The pairing listened to, and a QR code waiting to be scanned (it becomes the pairing then).
	private listeningTo = new Set<string>();
	private pending: { id: string; phoneUrl: string; until: number } | null = null;
	private stopped = false;
	// Set when the plugin unloads: nothing starts listening again after that.
	private disposed = false;
	private listeners = new Set<() => void>();
	window: PhoneWindow | null = null;

	constructor(private readonly host: PhoneLinkHost) {}

	private get settings() {
		return this.host.getSettings();
	}

	get pairing(): Pairing | null {
		return this.settings.useLocalInference ? null : this.settings.drawPairing;
	}

	// A QR code that pairs a phone, still waiting to be scanned.
	get pendingCode(): { id: string; phoneUrl: string } | null {
		if (this.pending && Date.now() >= this.pending.until) {
			this.listeningTo.delete(this.pending.id);
			this.pending = null;
		}
		return this.pending;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed() {
		for (const listener of Array.from(this.listeners)) {
			listener();
		}
	}

	// Always MathLive's scanner: a self-hosted one can't pair phones.
	private get cloudSettings(): PluginSettings {
		return { ...this.settings, useLocalInference: false };
	}

	private url(path: string) {
		return scannerAddress(this.cloudSettings) + path;
	}

	private get headers() {
		return scannerHeaders(this.cloudSettings, "drawing");
	}

	// Starts listening to the saved pairing, such as when the plugin loads or the settings change.
	// Does nothing while it's listened to already.
	start() {
		if (this.disposed) {
			return;
		}
		this.stopped = false;
		const pairing = this.pairing;
		if (pairing && this.settings.apiKey) {
			void this.listen(pairing.id);
		}
	}

	// Stops listening and forgets a code waiting to be scanned. The pairing stays saved.
	stop() {
		this.stopped = true;
		this.listeningTo.clear();
		this.pending = null;
	}

	// For good, when the plugin unloads. The paired phone hears straight away that Obsidian closed.
	dispose() {
		const pairing = this.pairing;
		if (pairing && !this.disposed) {
			void requestUrl({
				url: this.url(`/draw/sessions/${pairing.id}/away`),
				method: "POST",
				headers: this.headers,
				throw: false,
			}).catch(() => null);
		}
		this.disposed = true;
		this.stop();
		this.window = null;
		this.listeners.clear();
	}

	// Makes a QR code that pairs a phone. Reuses one still waiting.
	async newCode(): Promise<{ id: string; phoneUrl: string }> {
		const waiting = this.pendingCode;
		if (waiting) {
			return waiting;
		}
		const res = await requestUrl({ url: this.url("/draw/pairings"), method: "POST", headers: this.headers, throw: false });
		const code = errorCode(res);
		if (code === "no_scans_left" || code === "invalid_api_key" || code === "missing_api_key") {
			askForAccount(this.settings, code === "no_scans_left" ? "no_scans_left" : "auth", () => this.changed());
			throw new Error("Connect your MathLive account to pair a phone.");
		}
		const reply = res.status === 200 ? (res.json as { id?: unknown; phoneUrl?: unknown; claimSeconds?: unknown }) : null;
		if (!reply || typeof reply.id !== "string" || typeof reply.phoneUrl !== "string") {
			throw new Error(
				res.status === 404 ? "This scanner can't pair a phone yet." : "Couldn't make a code. Try again in a minute."
			);
		}
		const seconds = typeof reply.claimSeconds === "number" ? reply.claimSeconds : 600;
		if (this.disposed) {
			throw new Error("MathLive was turned off.");
		}
		this.pending = { id: reply.id, phoneUrl: reply.phoneUrl, until: Date.now() + seconds * 1000 };
		this.stopped = false;
		void this.listen(reply.id);
		return this.pending;
	}

	// Unpairs: the phone hears about it and its page stops working.
	async unpair() {
		const pairing = this.settings.drawPairing;
		if (!pairing) {
			return;
		}
		this.listeningTo.delete(pairing.id);
		this.settings.drawPairing = null;
		await this.host.saveSettings();
		this.changed();
		await requestUrl({
			url: this.url(`/draw/sessions/${pairing.id}/close`),
			method: "POST",
			headers: this.headers,
			throw: false,
		}).catch(() => null);
	}

	private async ended(id: string, reason: "unpaired" | "gone") {
		this.listeningTo.delete(id);
		if (this.pending?.id === id) {
			this.pending = null;
			this.changed();
		}
		// While a new code waits, the phone before was most likely replaced by scanning it.
		const replaced = this.pending !== null;
		if (this.settings.drawPairing?.id === id) {
			this.settings.drawPairing = null;
			await this.host.saveSettings();
			this.changed();
			if (replaced) {
				return;
			}
			new Notice(
				reason === "unpaired"
					? "Your phone was unpaired from MathLive. Scan the code in Draw formula to pair it again."
					: "Your phone's drawing link ended. Scan the code in Draw formula to pair it again."
			);
		}
	}

	private async paired(id: string, device: string | null) {
		if (this.pending?.id === id) {
			this.pending = null;
		}
		const before = this.settings.drawPairing;
		if (before && before.id !== id) {
			// The server ended the phone paired before.
			this.listeningTo.delete(before.id);
		}
		this.settings.drawPairing = { id, device };
		await this.host.saveSettings();
		this.changed();
		if (!this.window) {
			new Notice("Phone paired. Draw on it any time: formulas go into the one you have open.");
		}
	}

	private async listen(id: string) {
		if (this.listeningTo.has(id)) {
			return;
		}
		this.listeningTo.add(id);
		let after = 0;
		let retry = RETRY_FIRST_MS;
		while (!this.stopped && this.listeningTo.has(id)) {
			if (this.settings.useLocalInference) {
				// Self-hosted scanner on: the pairing is kept, and listened to again once it's off.
				this.listeningTo.delete(id);
				return;
			}
			if (this.pending?.id === id && Date.now() >= this.pending.until) {
				// Nobody scanned the code in time.
				this.listeningTo.delete(id);
				this.pending = null;
				this.changed();
				return;
			}
			let res;
			try {
				res = await requestUrl({
					url: this.url(`/draw/sessions/${id}/wait?after=${after}`),
					headers: this.headers,
					throw: false,
				});
			} catch {
				// Offline, or the computer slept: try again, less often the longer it lasts.
				await sleep(retry);
				retry = Math.min(retry * 2, RETRY_MAX_MS);
				continue;
			}
			if (this.stopped || !this.listeningTo.has(id)) {
				return;
			}
			if (res.status === 410 || res.status === 403) {
				// Unpaired elsewhere, or this Obsidian's key changed, such as after disconnecting.
				await this.ended(id, "gone");
				return;
			}
			if (res.status !== 200) {
				await sleep(retry);
				retry = Math.min(retry * 2, RETRY_MAX_MS);
				continue;
			}
			retry = RETRY_FIRST_MS;
			const reply = res.json as WaitReply;
			after = reply.next;
			for (const event of reply.events) {
				await this.onEvent(id, event, reply.device ?? null);
			}
			if (reply.closed) {
				await this.ended(id, "unpaired");
				return;
			}
		}
	}

	private async onEvent(id: string, event: PhoneEvent, device: string | null) {
		switch (event.type) {
			case "phone_connected":
				await this.paired(id, device);
				break;
			case "preview":
				if (event.latex) {
					this.window?.phonePreview(event.latex);
				}
				break;
			case "inserted":
				if (event.source !== "pad" && event.latex) {
					afterCloudScan(this.settings);
					this.insert(event.latex);
				}
				break;
			case "out_of_scans":
				askForAccount(this.settings, "no_scans_left", () => {});
				break;
		}
	}

	// A formula from the phone: into the Draw window, else the formula being edited, else a new
	// formula at the note's cursor. With nowhere to go, it's copied so it isn't lost.
	private insert(latex: string) {
		if (this.window) {
			this.window.phoneInserted(latex);
			return;
		}
		const target = this.host.phoneTarget();
		if (target?.isOpen()) {
			target.insert(latex);
			new Notice("Formula from your phone added.");
			return;
		}
		void navigator.clipboard.writeText(latex).catch(() => null);
		new Notice("Formula from your phone copied. Open a note and paste it, or open a formula before you insert.", 8000);
	}
}

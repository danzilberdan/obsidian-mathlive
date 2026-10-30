import { App, Modal, Notice, Platform, requestUrl, Setting } from "obsidian";
import { noticeWithButton } from "./mathlive-shared";
import type { PluginSettings } from "./settings";
import { loadPrices, UpgradeModal, type UpgradePlan } from "./upgrade";

// The plugin's link to a MathLive account, for cloud scans. Connecting opens the website, where
// the user signs in and clicks Connect; the plugin then picks up a key of its own, so nothing is
// copied by hand. Before connecting, the first scans run on a free trial key.

export interface AccountStatus {
	hasUnlimitedAccess: boolean;
	// Missing from scanners older than one-click connect.
	scansLeft?: number;
	trial?: boolean;
	email?: string;
	device?: string | null;
}

interface AccountHost {
	app: App;
	settings: PluginSettings;
	saveSettings(): Promise<void>;
}

// While the user approves in the browser, the plugin asks for its key this often...
const CLAIM_EVERY_MS = 2000;
// ...until the approval would have expired on the server anyway.
const CONNECT_GIVES_UP_MS = 10 * 60 * 1000;
// The account status is fetched again when Obsidian regains focus after this long, so a plan
// bought in the browser shows up without restarting Obsidian.
const STATUS_FRESH_MS = 30 * 1000;
// A free account hears that it is running low at this many scans left, at most twice a day.
const LOW_SCANS = 3;
const LOW_SCANS_QUIET_MS = 12 * 60 * 60 * 1000;
const FREE_ACCOUNT_SCANS = "Free accounts get 10 scans, then 5 more every month.";

function toHex(bytes: ArrayBuffer | Uint8Array): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

interface ClaimReply {
	apikey?: unknown;
	email?: unknown;
}

interface TrialReply {
	apikey?: unknown;
	scans?: unknown;
}

interface Connection {
	verifier: string;
	challenge: string;
	started: number;
	timer: number | null;
	claiming: boolean;
}

export class CloudAccount {
	status: AccountStatus | null = null;
	private statusAt = 0;
	private statusRequest: Promise<AccountStatus | null> | null = null;
	private connection: Connection | null = null;
	private afterConnect: Array<() => void> = [];
	private listeners = new Set<() => void>();
	private lowScansWarnedAt = 0;

	constructor(private readonly host: AccountHost) {}

	private get settings() {
		return this.host.settings;
	}

	private scannerUrl(path: string) {
		return this.settings.cloudScannerUrl.replace(/\/+$/, "") + path;
	}

	siteUrl(path: string) {
		return this.settings.websiteUrl.replace(/\/+$/, "") + path;
	}

	// The pricing page, labelled with the button that led there. The site counts which upgrade
	// buttons get used; the plugin itself sends nothing.
	pricingUrl(src: string) {
		return this.siteUrl(`/pricing?src=${src}`);
	}

	// A link straight to Polar's checkout for this account, signed by the scanner, so there's no
	// sign-in on the way. Falls back to the website's checkout page when the scanner can't make one.
	async checkoutUrl(plan: UpgradePlan, src: string): Promise<string> {
		const fallback = this.siteUrl(`/checkout?plan=${plan}&src=${src}`);
		const key = this.settings.apiKey?.trim();
		if (!this.usesCloud() || !key) {
			return fallback;
		}
		try {
			const response = await requestUrl({
				url: this.scannerUrl("/checkout-link"),
				method: "POST",
				headers: { "Api-Key": key },
				contentType: "application/json",
				body: JSON.stringify({ plan, src }),
				throw: false,
			});
			const url = response.status === 200 ? (response.json as { url?: unknown }).url : null;
			return typeof url === "string" && url.startsWith("https://") ? url : fallback;
		} catch (error) {
			console.warn("MathLive: couldn't make a checkout link.", error);
			return fallback;
		}
	}

	usesCloud() {
		return !this.settings.useLocalInference;
	}

	hasKey() {
		return Boolean(this.settings.apiKey?.trim());
	}

	isTrial() {
		return this.hasKey() && this.settings.apiKeySource === "trial";
	}

	isConnected() {
		return this.hasKey() && !this.isTrial();
	}

	isConnecting() {
		return this.connection !== null;
	}

	// Called whenever the connection or status changes, so open views can redraw.
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed() {
		for (const listener of Array.from(this.listeners)) {
			listener();
		}
	}

	// How the device shows on the account page, so the user can tell their computers apart.
	deviceName(): string {
		const system = Platform.isIosApp
			? Platform.isTablet ? "iPad" : "iPhone"
			: Platform.isAndroidApp
				? "Android"
				: Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "desktop";
		return `${this.host.app.vault.getName()} on ${system}`.slice(0, 60);
	}

	// Opens the website to approve this device. `then` runs once connected, such as a scan that
	// was waiting for an account.
	async connect(then?: () => void) {
		if (then) {
			this.afterConnect.push(then);
		}
		if (!this.connection) {
			const verifier = toHex(crypto.getRandomValues(new Uint8Array(32)));
			this.connection = {
				verifier,
				challenge: await sha256Hex(verifier),
				started: Date.now(),
				timer: null,
				claiming: false,
			};
			this.changed();
		}
		window.open(this.connectUrl());
		this.scheduleClaim();
	}

	connectUrl(): string {
		const challenge = this.connection?.challenge ?? "";
		return this.siteUrl(`/connect?state=${challenge}&device=${encodeURIComponent(this.deviceName())}`);
	}

	cancelConnect() {
		if (this.connection?.timer) {
			window.clearTimeout(this.connection.timer);
		}
		this.connection = null;
		this.afterConnect = [];
		this.changed();
	}

	// The website sends the browser to obsidian://mathlive-auth?state=… once the user approved.
	async handleReturn(params: Record<string, string>) {
		if (this.connection && params.state === this.connection.challenge) {
			await this.claim();
		}
	}

	private scheduleClaim() {
		const connection = this.connection;
		if (!connection) {
			return;
		}
		if (connection.timer) {
			window.clearTimeout(connection.timer);
		}
		connection.timer = window.setTimeout(() => void this.claim(), CLAIM_EVERY_MS);
	}

	private async claim() {
		const connection = this.connection;
		if (!connection || connection.claiming) {
			return;
		}
		if (Date.now() - connection.started > CONNECT_GIVES_UP_MS) {
			this.cancelConnect();
			new Notice("Connecting MathLive took too long. Try again from the MathLive settings.", 10000);
			return;
		}

		connection.claiming = true;
		let claimed: ClaimReply | null = null;
		try {
			const response = await requestUrl({
				url: this.scannerUrl("/connect/claim"),
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ verifier: connection.verifier }),
				throw: false,
			});
			if (response.status === 200) {
				claimed = response.json as ClaimReply;
			}
		} catch (error) {
			// Offline for a moment: keep asking until the approval expires.
			console.warn("MathLive: couldn't check the connection yet.", error);
		} finally {
			connection.claiming = false;
		}
		if (this.connection !== connection) {
			return;
		}
		if (typeof claimed?.apikey !== "string") {
			this.scheduleClaim();
			return;
		}

		if (connection.timer) {
			window.clearTimeout(connection.timer);
		}
		this.connection = null;
		await this.useKey(claimed.apikey, "device");
		const email = typeof claimed.email === "string" && claimed.email ? ` to ${claimed.email}` : "";
		new Notice(`MathLive is connected${email}.`);
		const waiting = this.afterConnect;
		this.afterConnect = [];
		this.changed();
		for (const run of waiting) {
			run();
		}
	}

	private async useKey(key: string, source: "device" | "trial") {
		const previous = { key: this.settings.apiKey, source: this.settings.apiKeySource };
		this.settings.apiKey = key;
		this.settings.apiKeySource = source;
		await this.host.saveSettings();
		if (previous.key && previous.source !== null && previous.key !== key) {
			// The trial key has done its job, and a device that connects again keeps one key.
			void this.forgetKey(previous.key);
		}
		this.invalidateStatus();
		void this.refreshStatus();
	}

	// Signs this device out. Its own key is deleted on the server too; a pasted key isn't, as it
	// may be in use somewhere else.
	async disconnect() {
		const key = this.settings.apiKey?.trim();
		const ownKey = this.settings.apiKeySource !== null;
		this.settings.apiKey = null;
		this.settings.apiKeySource = null;
		await this.host.saveSettings();
		this.invalidateStatus();
		this.changed();
		if (key && ownKey) {
			await this.forgetKey(key);
		}
	}

	// The user typed or pasted a key in Advanced.
	async setPastedKey(key: string | null) {
		this.settings.apiKey = key;
		this.settings.apiKeySource = null;
		await this.host.saveSettings();
		this.invalidateStatus();
		this.changed();
		void this.refreshStatus();
	}

	private async forgetKey(key: string) {
		try {
			await requestUrl({
				url: this.scannerUrl("/connect/forget"),
				method: "POST",
				headers: { "Api-Key": key },
				throw: false,
			});
		} catch (error) {
			console.warn("MathLive: couldn't remove the old key from the server.", error);
		}
	}

	// Before a cloud scan: makes sure there is a key, starting the free trial on the very first
	// scan. When this network has no trial left, asks the user to connect and runs `resume` after.
	async ensureKey(resume: () => void): Promise<boolean> {
		if (!this.usesCloud() || this.hasKey()) {
			return true;
		}

		let trial: TrialReply | null = null;
		try {
			const response = await requestUrl({ url: this.scannerUrl("/trial"), method: "POST", throw: false });
			if (response.status === 200) {
				trial = response.json as TrialReply;
			}
		} catch (error) {
			console.warn("MathLive: couldn't start a trial.", error);
			new Notice("Couldn't reach MathLive. Check your connection and try again.", 10000);
			return false;
		}
		if (typeof trial?.apikey === "string") {
			await this.useKey(trial.apikey, "trial");
			const scans =
				typeof trial.scans === "number" ? `${trial.scans} ${trial.scans === 1 ? "scan" : "scans"}` : "a few scans";
			new Notice(`Scanning with a free trial: ${scans}, no account needed.`, 8000);
			return true;
		}

		new ConnectModal(this.host.app, this, "trial_unavailable", resume).open();
		return false;
	}

	// The scanner refused a scan: the key is gone, or there are no scans left.
	needsAccount(reason: "auth" | "no_scans_left", resume: () => void) {
		this.invalidateStatus();
		if (reason === "no_scans_left" && this.isTrial()) {
			new ConnectModal(this.host.app, this, "trial_used", resume).open();
			return;
		}
		if (reason === "no_scans_left") {
			new UpgradeModal(this.host.app, this, resume).open();
			return;
		}
		if (this.settings.apiKeySource === null && this.hasKey()) {
			noticeWithButton(
				"Your API key doesn't work anymore. Connect your account, or paste a new key under Settings → MathLive → Advanced.",
				"Connect",
				() => void this.connect(resume),
				15000
			);
			return;
		}
		// The device was disconnected on the website.
		this.settings.apiKey = null;
		this.settings.apiKeySource = null;
		void this.host.saveSettings();
		this.changed();
		new ConnectModal(this.host.app, this, "disconnected", resume).open();
	}

	// After a successful cloud scan: count it, and say so when scans are running low.
	afterScan() {
		this.invalidateStatus();
		void this.refreshStatus().then(async (status) => {
			if (!status || status.hasUnlimitedAccess || typeof status.scansLeft !== "number") {
				return;
			}
			const left = status.scansLeft;
			const recently = Date.now() - this.lowScansWarnedAt < LOW_SCANS_QUIET_MS;
			if (status.trial) {
				if (left === 1) {
					noticeWithButton(
						`1 trial scan left. ${FREE_ACCOUNT_SCANS}`,
						"Connect",
						() => void this.connect(),
						10000
					);
				}
				return;
			}
			if (left > 0 && left <= LOW_SCANS && !recently) {
				this.lowScansWarnedAt = Date.now();
				const prices = await loadPrices(this.siteUrl("/prices.json"));
				const yearly = prices.annualUsd === null ? "" : ` Unlimited is $${prices.annualUsd} a year.`;
				noticeWithButton(
					`${left} free ${left === 1 ? "scan" : "scans"} left this month.${yearly}`,
					"Go unlimited",
					() => window.open(this.pricingUrl("plugin_low")),
					10000
				);
			}
		});
	}

	invalidateStatus() {
		this.statusAt = 0;
		this.statusRequest = null;
	}

	// Fetches the status again when it is old, such as when Obsidian regains focus after the user
	// bought a plan in the browser.
	refreshIfStale() {
		if (this.usesCloud() && this.hasKey() && Date.now() - this.statusAt > STATUS_FRESH_MS) {
			void this.refreshStatus();
		}
	}

	async getStatus(): Promise<AccountStatus | null> {
		if (this.statusAt && this.status) {
			return this.status;
		}
		return await this.refreshStatus();
	}

	refreshStatus(): Promise<AccountStatus | null> {
		const key = this.settings.apiKey?.trim();
		if (!this.usesCloud() || !key) {
			this.status = null;
			return Promise.resolve(null);
		}
		if (!this.statusRequest) {
			const request = requestUrl({
				url: this.scannerUrl("/access-status"),
				headers: { "Api-Key": key },
				throw: false,
			})
				.then((response) => {
					if (response.status >= 400) {
						throw new Error(`Access status request failed with status ${response.status}.`);
					}
					const status = response.json as AccountStatus;
					return { ...status, hasUnlimitedAccess: status.hasUnlimitedAccess === true };
				})
				.catch((error) => {
					console.warn("MathLive: couldn't load the account status.", error);
					return null;
				})
				.then((status) => {
					if (this.statusRequest === request) {
						this.status = status;
						this.statusAt = Date.now();
						this.statusRequest = null;
						this.changed();
					}
					return status;
				});
			this.statusRequest = request;
		}
		return this.statusRequest;
	}

	// The account entry in formula menus: Connect until the account is connected.
	menuAction(): { title: string; run: () => void } | undefined {
		if (!this.usesCloud() || this.isConnected()) {
			return undefined;
		}
		return { title: "Connect", run: () => void this.connect() };
	}

	// A few words on the scans left, for the editor window: "7 free scans left".
	planLine(): string {
		if (!this.usesCloud()) {
			return "Self-hosted scanner";
		}
		const left = this.status?.scansLeft;
		const count = (kind: string) =>
			typeof left === "number" ? `${left} ${kind}${left === 1 ? "scan" : "scans"} left` : "";
		if (this.isTrial()) {
			return count("trial ") || "Trial scans";
		}
		if (!this.hasKey()) {
			return "First scans free, no account needed";
		}
		if (this.status?.hasUnlimitedAccess) {
			return "Unlimited scans";
		}
		return count("free ") || "Free plan";
	}

	// The plan in a sentence or two, for the guide.
	planDetail(): string {
		if (!this.usesCloud()) {
			return "Scans go to your self-hosted scanner, so they're free and unlimited.";
		}
		if (this.status?.hasUnlimitedAccess && this.isConnected()) {
			return "You have unlimited scans. Thank you for supporting MathLive!";
		}
		const now = this.isConnected() || this.isTrial() ? `${this.planLine()}. ` : "Your first scans need no account. ";
		return `${now}${FREE_ACCOUNT_SCANS} Upgrade for unlimited scans and more PDF pages each month, monthly or once for life.`;
	}

	// What to do next about the plan: connect for more free scans, or upgrade. `src` says where
	// the button is, for the upgrade link.
	planAction(src: "plugin_editor" | "plugin_guide"): { title: string; run: () => void } | undefined {
		if (!this.usesCloud() || this.isConnecting()) {
			return undefined;
		}
		if (!this.isConnected()) {
			return { title: "Get 10 free scans", run: () => void this.connect() };
		}
		if (this.status && !this.status.hasUnlimitedAccess) {
			return { title: "Upgrade", run: () => window.open(this.pricingUrl(src)) };
		}
		return undefined;
	}

	// One line about the account for the settings tab.
	describe(): string {
		if (this.isConnecting()) {
			return "Finish in your browser: sign in and approve this device. This updates by itself.";
		}
		const status = this.status;
		if (this.isTrial()) {
			const n = status?.scansLeft;
			const left = typeof n === "number" ? `${n} trial ${n === 1 ? "scan" : "scans"} left. ` : "";
			return `${left}Connect a free account to keep scanning. ${FREE_ACCOUNT_SCANS}`;
		}
		if (!this.hasKey()) {
			return `Your first scans need no account. After that, connect one: sign in with Google in your browser and Obsidian connects by itself. ${FREE_ACCOUNT_SCANS}`;
		}
		if (!status) {
			return this.settings.apiKeySource === "device" ? "Connected." : "Using the API key below.";
		}
		const who = status.email ? `Connected as ${status.email}` : "Connected";
		const scans = status.hasUnlimitedAccess
			? "unlimited scans"
			: typeof status.scansLeft === "number"
				? `${status.scansLeft} ${status.scansLeft === 1 ? "scan" : "scans"} left`
				: "";
		return scans ? `${who} · ${scans}.` : `${who}.`;
	}
}

type ConnectReason = "trial_used" | "trial_unavailable" | "disconnected";

const CONNECT_TITLES: Record<ConnectReason, string> = {
	trial_used: "Your trial scans are used up",
	trial_unavailable: "Connect MathLive to scan",
	disconnected: "Connect MathLive again",
};

const CONNECT_REASONS: Record<ConnectReason, string> = {
	trial_used: "Keep scanning with a free MathLive account.",
	trial_unavailable: "Scanning needs a free MathLive account.",
	disconnected: "This device was disconnected from your MathLive account.",
};

// Asks the user to connect at the moment a scan needs an account, then runs the scan once
// connected.
export class ConnectModal extends Modal {
	private stopListening: (() => void) | null = null;

	constructor(
		app: App,
		private readonly account: CloudAccount,
		private readonly reason: ConnectReason,
		private readonly resume?: () => void
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-connect-modal");
		this.setTitle(CONNECT_TITLES[this.reason]);
		this.stopListening = this.account.onChange(() => {
			if (this.account.isConnected()) {
				this.close();
			} else {
				this.render();
			}
		});
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.account.isConnecting()) {
			contentEl.createEl("p", { text: "Finish in your browser: sign in and approve this device. This window closes by itself." });
			new Setting(contentEl)
				.addButton((button) =>
					button.setButtonText("Open the page again").onClick(() => window.open(this.account.connectUrl()))
				)
				.addButton((button) =>
					button.setButtonText("Cancel").onClick(() => {
						this.account.cancelConnect();
						this.close();
					})
				);
			return;
		}

		contentEl.createEl("p", { text: CONNECT_REASONS[this.reason] });
		contentEl.createEl("p", {
			cls: "mathlive-connect-detail",
			text: `Sign in with Google in your browser and Obsidian connects by itself, with no key to copy. ${FREE_ACCOUNT_SCANS}`,
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Not now").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(() => void this.account.connect(this.resume))
			);
	}

	onClose() {
		this.stopListening?.();
		this.contentEl.empty();
	}
}

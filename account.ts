import { App, Modal, Notice, Platform, requestUrl, Setting } from "obsidian";
import { noticeWithButton, type CreditAction } from "./mathlive-shared";
import type { PluginSettings } from "./settings";
import { loadPrices, UpgradeModal, type UpgradePlan, type UpgradeSource } from "./upgrade";

// The plugin's link to a MathLive account, for the cloud's AI actions. Connecting opens the
// website, where the user signs in and clicks Connect; the plugin then picks up a key of its own,
// so nothing is copied by hand. Before connecting, the first scans run on a free trial key.
//
// Every AI action (a scan, a drawn formula, a magic edit, a formula written with AI, a PDF page on
// the free plan) uses credits from one balance, charged by the server when it runs.

export interface AccountStatus {
	hasUnlimitedAccess: boolean;
	// Missing from scanners older than one-click connect. Servers before credits only send
	// `scansLeft`, the same number; `creditsLeft()` reads either.
	creditsLeft?: number;
	scansLeft?: number;
	// What each action costs in credits, from servers with credits.
	costs?: Partial<Record<"scan" | "page" | "drawing" | "edit" | "write", number>>;
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
// A free account hears that it is running low at this many credits left, at most twice a day.
const LOW_CREDITS = 3;
const LOW_CREDITS_QUIET_MS = 12 * 60 * 60 * 1000;
const FREE_ACCOUNT_CREDITS =
	"Free accounts get 10 credits, then a top-up to 5 every month. Each scan, drawn formula or magic edit uses one.";

// The credits left in a status, from servers with credits or older ones.
export function creditsLeft(status: AccountStatus | null | undefined): number | undefined {
	const left = status?.creditsLeft ?? status?.scansLeft;
	return typeof left === "number" ? left : undefined;
}

function credits(n: number): string {
	return `${n} ${n === 1 ? "credit" : "credits"}`;
}

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
	credits?: unknown;
	// What servers before credits call it.
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
	async checkoutUrl(plan: UpgradePlan | "pages", src: string): Promise<string> {
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
			const n = typeof trial.credits === "number" ? trial.credits : trial.scans;
			const amount = typeof n === "number" ? credits(n) : "a few credits";
			new Notice(`Scanning with a free trial: ${amount}, no account needed.`, 8000);
			return true;
		}

		new ConnectModal(this.host.app, this, "trial_unavailable", resume).open();
		return false;
	}

	// The server refused an action: the key is gone, or there are no credits left.
	needsAccount(reason: "auth" | "no_credits", resume: () => void) {
		this.invalidateStatus();
		if (reason === "no_credits" && this.isTrial()) {
			new ConnectModal(this.host.app, this, "trial_used", resume).open();
			return;
		}
		if (reason === "no_credits") {
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

	// After a charged cloud action: count it, and say so when credits are running low.
	afterScan() {
		this.invalidateStatus();
		void this.refreshStatus().then(async (status) => {
			const left = creditsLeft(status);
			if (!status || status.hasUnlimitedAccess || left === undefined) {
				return;
			}
			const recently = Date.now() - this.lowScansWarnedAt < LOW_CREDITS_QUIET_MS;
			if (status.trial) {
				if (left === 1) {
					noticeWithButton(
						`1 trial credit left. ${FREE_ACCOUNT_CREDITS}`,
						"Connect",
						() => void this.connect(),
						10000
					);
				}
				return;
			}
			if (left > 0 && left <= LOW_CREDITS && !recently) {
				this.lowScansWarnedAt = Date.now();
				const prices = await loadPrices(this.siteUrl("/prices.json"));
				const yearly = prices.annualUsd === null ? "" : ` Unlimited is $${prices.annualUsd} a year.`;
				noticeWithButton(
					`${left} free ${left === 1 ? "credit" : "credits"} left this month.${yearly}`,
					"Go unlimited",
					() => this.upgrade("plugin_low"),
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

	// What an action costs this account, like "1 credit", or "" when it costs nothing here: on an
	// unlimited plan, with the self-hosted scanner, or before the status is known.
	costOf(action: CreditAction): string {
		if (!this.usesCloud() || !this.status || this.status.hasUnlimitedAccess) {
			return "";
		}
		const cost = this.status.costs?.[action] ?? 1;
		return cost > 0 ? credits(cost) : "";
	}

	// A few words on the credits left, for the editor window: "7 free credits left".
	planLine(): string {
		if (!this.usesCloud()) {
			return "Self-hosted scanner";
		}
		const left = creditsLeft(this.status);
		const count = (kind: string) =>
			left !== undefined ? `${left} ${kind}${left === 1 ? "credit" : "credits"} left` : "";
		if (this.isTrial()) {
			return count("trial ") || "Trial credits";
		}
		if (!this.hasKey()) {
			return "First tries free, no account needed";
		}
		if (this.status?.hasUnlimitedAccess) {
			return "Unlimited";
		}
		return count("free ") || "Free plan";
	}

	// The plan in a sentence or two, for the guide.
	planDetail(): string {
		if (!this.usesCloud()) {
			return "Scans go to your self-hosted scanner, so they're free and unlimited.";
		}
		if (this.status?.hasUnlimitedAccess && this.isConnected()) {
			return "You have unlimited scans, drawings and magic edits. Thank you for supporting MathLive!";
		}
		const now = this.isConnected() || this.isTrial() ? `${this.planLine()}. ` : "Your first scans need no account. ";
		return `${now}${FREE_ACCOUNT_CREDITS} Upgrade for unlimited use and more PDF pages each month, monthly or once for life.`;
	}

	// The plans, in the plugin, with one-click checkout: no website sign-in on the way to paying.
	// Without a connected account there's nothing to charge, so it's the pricing page.
	upgrade(src: UpgradeSource, reason: "upgrade" | "pages" = "upgrade") {
		if (!this.usesCloud() || !this.isConnected()) {
			window.open(this.pricingUrl(src));
			return;
		}
		new UpgradeModal(this.host.app, this, undefined, reason, src).open();
	}

	// "Get more pages" in PDF to notes. A free account pays pages with credits, so a plan is
	// what gets it pages; a plan that includes pages buys a pack straight away.
	morePages(planIncludesPages: boolean) {
		if (planIncludesPages) {
			void this.checkoutUrl("pages", "plugin_pdf").then((url) => window.open(url));
			return;
		}
		this.upgrade("plugin_pdf", "pages");
	}

	// What to do next about the plan: connect for more free credits, or upgrade. `src` says where
	// the button is, for the upgrade link.
	planAction(src: "plugin_editor" | "plugin_guide"): { title: string; run: () => void } | undefined {
		if (!this.usesCloud() || this.isConnecting()) {
			return undefined;
		}
		if (!this.isConnected()) {
			return { title: "Get 10 free credits", run: () => void this.connect() };
		}
		if (this.status && !this.status.hasUnlimitedAccess) {
			return { title: "Upgrade", run: () => this.upgrade(src) };
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
			const n = creditsLeft(status);
			const left = n !== undefined ? `${n} trial ${n === 1 ? "credit" : "credits"} left. ` : "";
			return `${left}Connect a free account to keep scanning. ${FREE_ACCOUNT_CREDITS}`;
		}
		if (!this.hasKey()) {
			return `Your first scans need no account. After that, connect one: sign in with Google in your browser and Obsidian connects by itself. ${FREE_ACCOUNT_CREDITS}`;
		}
		if (!status) {
			return this.settings.apiKeySource === "device" ? "Connected." : "Using the API key below.";
		}
		const who = status.email ? `Connected as ${status.email}` : "Connected";
		const left = creditsLeft(status);
		const balance = status.hasUnlimitedAccess ? "unlimited" : left !== undefined ? `${credits(left)} left` : "";
		return balance ? `${who} · ${balance}.` : `${who}.`;
	}
}

type ConnectReason = "trial_used" | "trial_unavailable" | "disconnected";

const CONNECT_TITLES: Record<ConnectReason, string> = {
	trial_used: "Your trial credits are used up",
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
			text: `Sign in with Google in your browser and Obsidian connects by itself, with no key to copy. ${FREE_ACCOUNT_CREDITS}`,
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

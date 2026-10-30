import { App, Modal, requestUrl, Setting } from "obsidian";
import type { CloudAccount } from "./account";

// The window shown when a scan is refused because the free scans ran out. It offers the plans
// with one click each, and once the account is unlimited (bought in the browser), it closes and
// the refused scan runs by itself.

export type UpgradePlan = "annual" | "lifetime" | "monthly";

export interface Prices {
	lifetimeUsd: number;
	annualUsd: number | null;
	monthlyUsd: number | null;
	monthlyFreeScans: number;
	lifetimePages: number;
}

// Used when the website can't be reached for its live prices.
const FALLBACK_PRICES: Prices = {
	lifetimeUsd: 69,
	annualUsd: 39,
	monthlyUsd: 6,
	monthlyFreeScans: 5,
	lifetimePages: 300,
};

// After a checkout opens, the plan is checked this often until it is active...
const CHECK_EVERY_MS = 5000;
// ...for this long, in case the user pays without coming back to Obsidian first.
const CHECK_FOR_MS = 15 * 60 * 1000;

let cachedPrices: { prices: Prices; at: number } | null = null;
const PRICES_FRESH_MS = 60 * 60 * 1000;

function usd(amount: number) {
	return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

// Free scans come back on the 1st of each month (UTC).
export function nextTopUp(now = new Date()): string {
	const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	return next.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export async function loadPrices(siteUrl: string): Promise<Prices> {
	if (cachedPrices && Date.now() - cachedPrices.at < PRICES_FRESH_MS) {
		return cachedPrices.prices;
	}
	try {
		const response = await requestUrl({ url: siteUrl, throw: false });
		if (response.status === 200) {
			const live = response.json as Partial<Prices>;
			const number = (value: unknown, fallback: number | null) => (typeof value === "number" ? value : fallback);
			const prices: Prices = {
				lifetimeUsd: number(live.lifetimeUsd, FALLBACK_PRICES.lifetimeUsd) ?? FALLBACK_PRICES.lifetimeUsd,
				annualUsd: number(live.annualUsd, null),
				monthlyUsd: number(live.monthlyUsd, null),
				monthlyFreeScans: number(live.monthlyFreeScans, FALLBACK_PRICES.monthlyFreeScans) ?? 5,
				lifetimePages: number(live.lifetimePages, FALLBACK_PRICES.lifetimePages) ?? 300,
			};
			cachedPrices = { prices, at: Date.now() };
			return prices;
		}
	} catch (error) {
		console.warn("MathLive: couldn't load the prices.", error);
	}
	return FALLBACK_PRICES;
}

export class UpgradeModal extends Modal {
	private stopListening: (() => void) | null = null;
	private prices: Prices | null = null;
	private opened: UpgradePlan | null = null;
	private checking: number | null = null;
	private resumed = false;
	private period: UpgradePlan = "annual";

	constructor(
		app: App,
		private readonly account: CloudAccount,
		private readonly resume?: () => void
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-upgrade-modal");
		this.setTitle("You're out of free scans");
		this.stopListening = this.account.onChange(() => {
			if (this.account.status?.hasUnlimitedAccess) {
				this.finish();
			}
		});
		this.render();
		void loadPrices(this.account.siteUrl("/prices.json")).then((prices) => {
			this.prices = prices;
			this.render();
		});
	}

	// The plan is active: close, and run the scan that was refused.
	private finish() {
		if (this.resumed) {
			return;
		}
		this.resumed = true;
		this.close();
		this.resume?.();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const prices = this.prices ?? FALLBACK_PRICES;
		const date = nextTopUp();

		if (this.opened) {
			contentEl.createEl("p", {
				text: this.resume
					? "Finish paying in your browser. This window closes and your scan finishes as soon as your plan is active."
					: "Finish paying in your browser. This window closes as soon as your plan is active.",
			});
			new Setting(contentEl)
				.addButton((button) =>
					button.setButtonText("Open checkout again").onClick(() => void this.checkout(this.opened ?? "annual"))
				)
				.addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
			return;
		}

		contentEl.createEl("p", {
			text: `You've used all your free scans. Your next ${prices.monthlyFreeScans} arrive on ${date}.`,
		});
		contentEl.createEl("p", {
			text: this.resume
				? "Go unlimited and this scan finishes as soon as you're back:"
				: "Go unlimited and never count scans again:",
		});
		const list = contentEl.createEl("ul", { cls: "mathlive-upgrade-list" });
		list.createEl("li", { text: "Unlimited scans, drawings and magic edits" });
		list.createEl("li", { text: `${prices.lifetimePages} PDF pages a month turned into notes` });
		list.createEl("li", { text: "Cancel a subscription anytime, or pay once for life" });

		// One Unlimited card, yearly unless switched to monthly, and Lifetime beside it.
		const plans = contentEl.createDiv({ cls: "mathlive-upgrade-plans" });
		const periods: { id: UpgradePlan; label: string; usd: number }[] = [];
		if (prices.annualUsd !== null) {
			periods.push({ id: "annual", label: "Yearly", usd: prices.annualUsd });
		}
		if (prices.monthlyUsd !== null) {
			periods.push({ id: "monthly", label: "Monthly", usd: prices.monthlyUsd });
		}
		const period = periods.find((option) => option.id === this.period) ?? periods[0];
		if (period) {
			const card = plans.createDiv({ cls: "mathlive-upgrade-plan is-featured" });
			card.createSpan({ cls: "mathlive-upgrade-plan-title", text: "Unlimited" });
			if (periods.length > 1) {
				const toggle = card.createDiv({ cls: "mathlive-upgrade-period", attr: { role: "group" } });
				for (const option of periods) {
					const choice = toggle.createEl("button", {
						text: option.label,
						attr: { type: "button", "aria-pressed": String(option === period) },
					});
					choice.toggleClass("is-active", option === period);
					choice.addEventListener("click", () => {
						this.period = option.id;
						this.render();
					});
				}
			}
			const yearly = period.id === "annual";
			card.createSpan({ cls: "mathlive-upgrade-plan-price", text: `${usd(period.usd)}${yearly ? "/yr" : "/mo"}` });
			card.createSpan({
				cls: "mathlive-upgrade-plan-note",
				text: yearly ? `${usd(Math.round((period.usd / 12) * 100) / 100)} a month, billed yearly` : "Billed monthly, cancel anytime",
			});
			card.createEl("button", { cls: "mod-cta", text: "Go unlimited" })
				.addEventListener("click", () => void this.checkout(period.id));
		}
		const lifetime = plans.createDiv({ cls: period ? "mathlive-upgrade-plan" : "mathlive-upgrade-plan is-featured" });
		lifetime.createSpan({ cls: "mathlive-upgrade-plan-title", text: "Lifetime" });
		lifetime.createSpan({ cls: "mathlive-upgrade-plan-price", text: usd(prices.lifetimeUsd) });
		lifetime.createSpan({ cls: "mathlive-upgrade-plan-note", text: "One payment, yours for life" });
		lifetime.createEl("button", { cls: period ? "" : "mod-cta", text: "Pay once" })
			.addEventListener("click", () => void this.checkout("lifetime"));

		new Setting(contentEl).addButton((button) =>
			button.setButtonText(`Wait until ${date}`).onClick(() => this.close())
		);
	}

	private async checkout(plan: UpgradePlan) {
		this.opened = plan;
		this.render();
		window.open(await this.account.checkoutUrl(plan, "plugin_out"));
		this.watch();
	}

	// Obsidian also checks the plan when it regains focus; this covers paying in another window.
	private watch() {
		if (this.checking !== null) {
			return;
		}
		const started = Date.now();
		this.checking = window.setInterval(() => {
			if (Date.now() - started > CHECK_FOR_MS) {
				this.stopWatching();
				return;
			}
			this.account.invalidateStatus();
			void this.account.refreshStatus();
		}, CHECK_EVERY_MS);
	}

	private stopWatching() {
		if (this.checking !== null) {
			window.clearInterval(this.checking);
			this.checking = null;
		}
	}

	onClose() {
		this.stopWatching();
		this.stopListening?.();
		this.contentEl.empty();
	}
}

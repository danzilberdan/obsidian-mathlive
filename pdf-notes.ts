import {
	type App,
	type ButtonComponent,
	FuzzySuggestModal,
	loadPdfJs,
	Modal,
	Notice,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";
import {
	buildMultipartBody,
	ensureCanScan,
	errorCode,
	NO_SCANS_LEFT_NOTICE,
	scannerAddress,
	scannerHeaders,
} from "./mathlive-shared";
import { DEFAULT_SETTINGS, type PluginSettings } from "./settings";

// Where the pack of extra pages is sold.
function buyPagesUrl(settings: PluginSettings) {
	return (settings.websiteUrl || DEFAULT_SETTINGS.websiteUrl).replace(/\/+$/, "") + "/checkout?plan=pages";
}

// The scanner reads pages up to 2048 px on the longest side, so render them at that size.
const PAGE_SIDE = 2048;
// The scanner gives up on a page after 150 seconds.
const PAGE_TIMEOUT_MS = 170_000;
// Two pages at a time keeps a long PDF moving without tripping the scanner's rate limit.
const PARALLEL_PAGES = 2;
const RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3;

// A slip of the range shouldn't send a whole archive to the scanner.
const MAX_PAGES_PER_CONVERSION = 1000;

const PAGE_LIMIT_NOTICE = "You've used this month's pages.";

const UNSUPPORTED_NOTICE =
	"Your self-hosted scanner can't read whole pages. Turn off Self-hosted scanner in MathLive's settings to use the MathLive scanner.";

// The parts of pdf.js that Obsidian bundles and this file uses.
interface PdfJs {
	getDocument(source: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}
interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}
interface PdfPage {
	getViewport(options: { scale: number }): { width: number; height: number };
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
	cleanup(): void;
}

type PageFailure =
	| "auth"
	| "no_scans_left"
	| "page_limit"
	| "unsupported"
	| "rate_limited"
	| "bad_page"
	| "unavailable";

class PageError extends Error {
	constructor(readonly failure: PageFailure, message: string) {
		super(message);
	}
}

// These stop the whole conversion: every other page would fail the same way.
function isFatal(failure: PageFailure): boolean {
	return failure === "auth" || failure === "no_scans_left" || failure === "page_limit" || failure === "unsupported";
}

function pageFailure(status: number, code: string | null): PageFailure {
	switch (code) {
		case "missing_api_key":
		case "invalid_api_key":
			return "auth";
		case "no_scans_left":
			return "no_scans_left";
		case "page_limit":
			return "page_limit";
		case "pages_unavailable":
			return "unsupported";
		case "rate_limited":
			return "rate_limited";
		case "no_image":
		case "not_an_image":
		case "image_too_small":
			return "bad_page";
	}
	if (status === 404 || status === 405 || status === 501) {
		// A scanner from before pages, such as a self-hosted pix2tex.
		return "unsupported";
	}
	if (status === 429) {
		return "rate_limited";
	}
	return status < 500 ? "auth" : "unavailable";
}

// Where the account stands on pages this month, from the scanner's /access-status.
export interface PageQuota {
	// free, monthly or lifetime
	plan: string;
	// Pages a month the plan includes; null on the free plan, which pays for pages with scans.
	included: number | null;
	// Pages that can be read now.
	left: number;
	// When the plan's pages start again, as an ISO date.
	resetsAt: string | null;
}

// The account's page quota, or null when the scanner doesn't say (a self-hosted pix2tex, an
// older scanner, or no connection). Only used to quote a PDF: the scanner checks every page.
export async function fetchPageQuota(settings: PluginSettings): Promise<PageQuota | null> {
	try {
		const res = await requestUrl({
			url: scannerAddress(settings) + "/access-status",
			headers: { "Api-Key": settings.apiKey ?? "" },
			throw: false,
		});
		if (res.status >= 400) {
			return null;
		}
		const pages = (res.json as { pages?: Record<string, unknown> } | null)?.pages;
		if (!pages || typeof pages.left !== "number" || typeof pages.plan !== "string") {
			return null;
		}
		return {
			plan: pages.plan,
			included: typeof pages.included === "number" ? pages.included : null,
			left: Math.max(0, pages.left),
			resetsAt: typeof pages.resetsAt === "string" ? pages.resetsAt : null,
		};
	} catch {
		return null;
	}
}

function resetDate(quota: PageQuota): string | null {
	const date = quota.resetsAt ? new Date(quota.resetsAt) : null;
	if (!date || Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function requestPage(settings: PluginSettings, image: Blob): Promise<string> {
	const { body, contentType } = await buildMultipartBody("file", image);
	let timer = 0;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new PageError("unavailable", "Page timed out.")), PAGE_TIMEOUT_MS);
	});
	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url: scannerAddress(settings) + "/pages/",
				method: "POST",
				contentType,
				headers: scannerHeaders(settings),
				body,
				throw: false,
			}),
			timeout,
		]);
	} catch (error) {
		if (error instanceof PageError) {
			throw error;
		}
		throw new PageError("unavailable", error instanceof Error ? error.message : String(error));
	} finally {
		window.clearTimeout(timer);
	}

	if (res.status >= 400) {
		throw new PageError(pageFailure(res.status, errorCode(res)), `Page request failed with status ${res.status}.`);
	}
	let reply: unknown;
	try {
		reply = res.json;
	} catch {
		reply = null;
	}
	const markdown = (reply as { markdown?: unknown } | null)?.markdown;
	if (typeof markdown !== "string") {
		throw new PageError("unavailable", "The scanner's answer had no page.");
	}
	return markdown;
}

// Retries what a moment's wait can fix: a dropped connection or the rate limit.
async function readPage(settings: PluginSettings, image: Blob, stopped: () => boolean): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await requestPage(settings, image);
		} catch (error) {
			const failure = error instanceof PageError ? error.failure : "unavailable";
			if (isFatal(failure) || failure === "bad_page" || attempt >= MAX_ATTEMPTS || stopped()) {
				throw error;
			}
			await sleep(failure === "rate_limited" ? RATE_LIMIT_WAIT_MS : 2000 * attempt);
		}
	}
}

async function renderPage(pdf: PdfDocument, pageNumber: number): Promise<Blob> {
	const page = await pdf.getPage(pageNumber);
	try {
		const size = page.getViewport({ scale: 1 });
		const scale = Math.min(PAGE_SIDE / Math.max(size.width, size.height), 4);
		const viewport = page.getViewport({ scale });
		const canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.floor(viewport.width));
		canvas.height = Math.max(1, Math.floor(viewport.height));
		const context = canvas.getContext("2d");
		if (!context) {
			throw new PageError("bad_page", "No canvas to draw the page on.");
		}
		// PDF pages can be transparent; models expect paper.
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: context, viewport }).promise;
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new PageError("bad_page", "Couldn't draw the page."))), "image/png");
		});
	} finally {
		page.cleanup();
	}
}

export async function openPdf(app: App, file: TFile): Promise<PdfDocument> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const data = new Uint8Array(await app.vault.readBinary(file));
	return await pdfjs.getDocument({ data }).promise;
}

// A free path next to the PDF: "Lecture 3.md", else "Lecture 3 1.md" and so on.
function notePathFor(app: App, pdf: TFile): string {
	const folder = pdf.parent && !pdf.parent.isRoot() ? pdf.parent.path + "/" : "";
	for (let n = 0; ; n++) {
		const path = normalizePath(`${folder}${pdf.basename}${n ? ` ${n}` : ""}.md`);
		if (!app.vault.getAbstractFileByPath(path)) {
			return path;
		}
	}
}

type PageState = "pending" | "done" | "blank" | "failed";

// Turns pages of a PDF into one note. Pages are read two at a time and written in order as they
// finish, so the note fills in from the top and nothing read is lost if the conversion stops.
export class PdfConversion {
	readonly pages = new Map<number, PageState>();
	note: TFile | null = null;
	stopReason: PageFailure | null = null;
	private stopRequested = false;

	constructor(
		private readonly app: App,
		private readonly settings: PluginSettings,
		readonly pdfFile: TFile,
		readonly from: number,
		readonly to: number,
		private readonly onProgress: () => void
	) {
		for (let n = from; n <= to; n++) {
			this.pages.set(n, "pending");
		}
	}

	get total(): number {
		return this.to - this.from + 1;
	}

	count(state: PageState): number {
		return [...this.pages.values()].filter((value) => value === state).length;
	}

	get finished(): number {
		return this.total - this.count("pending");
	}

	stop() {
		this.stopRequested = true;
	}

	get stopping(): boolean {
		return this.stopRequested;
	}

	private placeholder(pageNumber: number): string {
		return `> [!warning] MathLive couldn't read page ${pageNumber}\n> Run "Retry failed pages" in the PDF to notes window, or see the page in ${this.pageLink(pageNumber)}.\n`;
	}

	private pageLink(pageNumber: number): string {
		const notePath = this.note?.path ?? "";
		const link = this.app.metadataCache.fileToLinktext(this.pdfFile, notePath, false);
		return `[[${link}#page=${pageNumber}|Page ${pageNumber}]]`;
	}

	private section(pageNumber: number, markdown: string): string {
		return `${this.pageLink(pageNumber)}\n\n${markdown.trim()}\n`;
	}

	private async ensureNote(): Promise<TFile> {
		if (this.note && this.app.vault.getAbstractFileByPath(this.note.path) === this.note) {
			return this.note;
		}
		if (this.note) {
			throw new Error("The note was deleted during the conversion.");
		}
		const path = notePathFor(this.app, this.pdfFile);
		const link = this.app.metadataCache.fileToLinktext(this.pdfFile, path, false);
		this.note = await this.app.vault.create(path, `---\nsource: "[[${link}]]"\n---\n`);
		return this.note;
	}

	private async append(text: string) {
		const note = await this.ensureNote();
		await this.app.vault.process(note, (content) => `${content.replace(/\n*$/, "\n")}\n${text}`);
	}

	// Writes a page in place of its failure note, from a retry.
	private async replace(pageNumber: number, text: string) {
		const note = await this.ensureNote();
		const placeholder = this.placeholder(pageNumber);
		let found = false;
		await this.app.vault.process(note, (content) => {
			if (!content.includes(placeholder)) {
				return content;
			}
			found = true;
			return content.replace(placeholder, text);
		});
		if (!found) {
			// The user removed the failure note, so put the page at the end.
			await this.append(text);
		}
	}

	// Reads every page that is pending or failed. Call again to retry or continue.
	async run(): Promise<void> {
		this.stopRequested = false;
		this.stopReason = null;
		const queue = [...this.pages.entries()]
			.filter(([, state]) => state === "pending" || state === "failed")
			.map(([pageNumber]) => pageNumber);
		if (queue.length === 0) {
			return;
		}
		const retrying = new Set(queue.filter((n) => this.pages.get(n) === "failed"));
		for (const n of retrying) {
			this.pages.set(n, "pending");
		}

		let pdf: PdfDocument;
		try {
			pdf = await openPdf(this.app, this.pdfFile);
		} catch (error) {
			console.error("MathLive: couldn't open the PDF:", error);
			for (const n of queue) {
				this.pages.set(n, "failed");
			}
			throw new Error("MathLive couldn't open this PDF.");
		}

		// Answers wait here until every page before them is written.
		const results = new Map<number, { markdown: string | null; failed: boolean }>();
		const order = queue.filter((n) => !retrying.has(n));
		let nextToWrite = 0;
		let writing = Promise.resolve();
		const flush = () => {
			writing = writing.then(async () => {
				while (nextToWrite < order.length && results.has(order[nextToWrite])) {
					const pageNumber = order[nextToWrite];
					const result = results.get(pageNumber);
					nextToWrite++;
					if (!result || result.markdown === "") {
						continue;
					}
					await this.append(result.failed ? this.placeholder(pageNumber) : this.section(pageNumber, result.markdown ?? ""));
				}
			});
			return writing;
		};

		const settle = async (pageNumber: number, markdown: string | null) => {
			const failed = markdown === null;
			this.pages.set(pageNumber, failed ? "failed" : markdown === "" ? "blank" : "done");
			if (retrying.has(pageNumber)) {
				if (!failed && markdown !== "") {
					await this.replace(pageNumber, this.section(pageNumber, markdown));
				} else if (markdown === "") {
					await this.replace(pageNumber, "");
				}
			} else {
				results.set(pageNumber, { markdown, failed });
				await flush();
			}
			this.onProgress();
		};

		const pending = [...queue];
		const worker = async () => {
			while (pending.length > 0 && !this.stopRequested) {
				const pageNumber = pending.shift() as number;
				let markdown: string | null;
				try {
					const image = await renderPage(pdf, pageNumber);
					markdown = await readPage(this.settings, image, () => this.stopRequested);
				} catch (error) {
					console.error(`MathLive: couldn't read page ${pageNumber}:`, error);
					const failure = error instanceof PageError ? error.failure : "unavailable";
					if (isFatal(failure)) {
						this.stopReason = failure;
						this.stopRequested = true;
						// This page wasn't read, so it is still to do.
						this.pages.set(pageNumber, "pending");
						this.onProgress();
						continue;
					}
					markdown = null;
				}
				await settle(pageNumber, markdown);
			}
		};

		try {
			await Promise.all(Array.from({ length: PARALLEL_PAGES }, worker));
			// A page put back after a stop can sit between pages that were read. It gets a failure
			// note, so the note keeps page order and a retry fills it in.
			const lastRead = Math.max(-1, ...order.map((n, index) => (results.has(n) ? index : -1)));
			for (const pageNumber of order.slice(nextToWrite, lastRead + 1)) {
				if (!results.has(pageNumber)) {
					this.pages.set(pageNumber, "failed");
					results.set(pageNumber, { markdown: null, failed: true });
				}
			}
			await flush();
			this.onProgress();
		} finally {
			await pdf.destroy();
		}
	}
}

export class PdfToNotesModal extends Modal {
	private conversion: PdfConversion | null = null;
	private running = false;
	private statusEl: HTMLElement | null = null;
	private progressEl: HTMLProgressElement | null = null;
	private buttonsEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly settings: PluginSettings,
		private readonly pdfFile: TFile,
		private readonly pageCount: number
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("mathlive-pdf-modal");
		this.titleEl.setText("Convert PDF to notes");
		this.renderSetup();
	}

	onClose() {
		if (this.running && this.conversion) {
			new Notice(`MathLive keeps converting ${this.pdfFile.name} and will tell you when it's done.`);
		}
	}

	private renderSetup() {
		const { contentEl } = this;
		contentEl.empty();
		let from = 1;
		let to = this.pageCount;
		let quota: PageQuota | null = null;
		let convertButton: ButtonComponent | null = null;
		let moreButton: ButtonComponent | null = null;

		contentEl.createEl("p", {
			text: `${this.pdfFile.name} has ${this.pageCount} ${this.pageCount === 1 ? "page" : "pages"}. MathLive reads each page into a new note next to the PDF, with formulas you can edit.`,
		});
		const cost = contentEl.createEl("p", { cls: "mathlive-pdf-cost" });
		// How many of the chosen pages can be read now; all of them when the scanner doesn't say.
		const covered = () => {
			const pages = Math.max(0, to - from + 1);
			return quota ? Math.min(pages, quota.left) : pages;
		};
		const updateCost = () => {
			const pages = Math.max(0, to - from + 1);
			if (!quota) {
				cost.setText(
					this.settings.useLocalInference
						? `Reads ${plural(pages, "page", "pages")} with your self-hosted scanner.`
						: `Uses up to ${plural(pages, "scan", "scans")}, one per page. Blank pages are free.`
				);
			} else {
				const free = quota.included === null;
				const left = free
					? `You have ${plural(quota.left, "scan", "scans")} left.`
					: `You have ${plural(quota.left, "page", "pages")} left this month.`;
				const resets = resetDate(quota);
				if (pages <= quota.left) {
					cost.setText(
						free
							? `Uses up to ${plural(pages, "scan", "scans")}, one per page. Blank pages are free. ${left}`
							: `Reads ${plural(pages, "page", "pages")}. Blank pages are free. ${left}`
					);
				} else {
					cost.setText(
						`These are ${plural(pages, "page", "pages")}. ${left}` +
							(!free && resets ? ` Your pages start again on ${resets}.` : "")
					);
				}
			}
			const short = quota !== null && pages > quota.left;
			convertButton?.setButtonText(short && covered() > 0 ? `Convert the first ${covered()}` : "Convert");
			if (convertButton) {
				convertButton.buttonEl.disabled = covered() === 0;
			}
			moreButton?.buttonEl.toggle(short);
		};

		const clamp = (value: string, fallback: number) => {
			const n = Math.round(Number(value));
			return Number.isFinite(n) && n >= 1 ? Math.min(n, this.pageCount) : fallback;
		};
		new Setting(contentEl)
			.setName("Pages")
			.setDesc("The first and last page to convert.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.addClass("mathlive-pdf-page-input");
				text.inputEl.setAttr("aria-label", "First page");
				text.setValue(String(from)).onChange((value) => {
					from = clamp(value, 1);
					updateCost();
				});
			})
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.addClass("mathlive-pdf-page-input");
				text.inputEl.setAttr("aria-label", "Last page");
				text.setValue(String(to)).onChange((value) => {
					to = clamp(value, this.pageCount);
					updateCost();
				});
			});
		updateCost();

		new Setting(contentEl)
			.addButton((button) => {
				convertButton = button;
				button
					.setButtonText("Convert")
					.setCta()
					.onClick(() => {
						if (to < from) {
							new Notice("The last page must come after the first.");
							return;
						}
						const last = from + covered() - 1;
						if (last - from + 1 > MAX_PAGES_PER_CONVERSION) {
							new Notice(`Convert at most ${MAX_PAGES_PER_CONVERSION} pages at a time.`);
							return;
						}
						this.conversion = new PdfConversion(this.app, this.settings, this.pdfFile, from, last, () =>
							this.renderProgress()
						);
						void this.start();
					});
			})
			.addButton((button) => {
				moreButton = button;
				button.setButtonText("Get more pages").onClick(() => window.open(buyPagesUrl(this.settings)));
			})
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
		updateCost();

		void fetchPageQuota(this.settings).then((found) => {
			quota = found;
			updateCost();
		});
	}

	private renderRunning() {
		const { contentEl } = this;
		contentEl.empty();
		this.statusEl = contentEl.createEl("p", { cls: "mathlive-pdf-status" });
		this.progressEl = contentEl.createEl("progress", { cls: "mathlive-pdf-progress" });
		this.buttonsEl = contentEl.createDiv({ cls: "mathlive-pdf-buttons" });
		this.renderProgress();
	}

	private renderProgress() {
		const conversion = this.conversion;
		if (!conversion || !this.statusEl || !this.progressEl || !this.buttonsEl) {
			return;
		}
		this.progressEl.max = conversion.total;
		this.progressEl.value = conversion.finished;

		const failed = conversion.count("failed");
		const pending = conversion.count("pending");
		const read = conversion.count("done");
		if (this.running) {
			this.statusEl.setText(
				conversion.stopping
					? `Stopping after the pages being read… ${conversion.finished} of ${conversion.total} done.`
					: `Reading page ${Math.min(conversion.finished + 1, conversion.total)} of ${conversion.total}…`
			);
		} else if (conversion.stopReason === "no_scans_left") {
			this.statusEl.setText(`${NO_SCANS_LEFT_NOTICE} ${pending} ${pending === 1 ? "page is" : "pages are"} still to do.`);
		} else if (conversion.stopReason === "page_limit") {
			this.statusEl.setText(
				`${PAGE_LIMIT_NOTICE} ${pending} ${pending === 1 ? "page is" : "pages are"} still to do. Get more pages, or continue when your pages start again.`
			);
		} else if (conversion.stopReason === "unsupported") {
			this.statusEl.setText(UNSUPPORTED_NOTICE);
		} else if (conversion.stopReason === "auth") {
			this.statusEl.setText("The scanner didn't accept your API key. Check it in MathLive's settings, then continue.");
		} else {
			const parts = [`Read ${read} of ${conversion.total} ${conversion.total === 1 ? "page" : "pages"}.`];
			if (conversion.count("blank") > 0) {
				parts.push(`${conversion.count("blank")} blank, not charged.`);
			}
			if (failed > 0) {
				parts.push(`${failed} couldn't be read and ${failed === 1 ? "is" : "are"} marked in the note.`);
			}
			if (pending > 0) {
				parts.push(`${pending} not started.`);
			}
			this.statusEl.setText(parts.join(" "));
		}

		const buttons = this.buttonsEl;
		buttons.empty();
		const setting = new Setting(buttons);
		if (this.running) {
			setting.addButton((button) => {
				button.setButtonText("Stop").onClick(() => {
					conversion.stop();
					this.renderProgress();
				});
				button.buttonEl.disabled = conversion.stopping;
			});
		} else if (failed + pending > 0) {
			setting.addButton((button) =>
				button
					.setButtonText(pending > 0 ? "Continue" : "Retry failed pages")
					.setCta()
					.onClick(() => void this.start())
			);
			if (conversion.stopReason === "page_limit") {
				setting.addButton((button) =>
					button.setButtonText("Get more pages").onClick(() => window.open(buyPagesUrl(this.settings)))
				);
			}
		}
		if (conversion.note) {
			const note = conversion.note;
			setting.addButton((button) =>
				button.setButtonText("Open note").onClick(() => {
					this.close();
					void this.app.workspace.getLeaf("tab").openFile(note);
				})
			);
		}
	}

	private async start() {
		const conversion = this.conversion;
		if (!conversion || this.running) {
			return;
		}
		this.running = true;
		this.renderRunning();
		try {
			await conversion.run();
		} catch (error) {
			console.error("MathLive: PDF conversion failed:", error);
			new Notice(error instanceof Error ? error.message : "MathLive couldn't convert this PDF.");
		} finally {
			this.running = false;
		}
		this.renderProgress();
		if (!this.contentEl.isConnected) {
			this.noticeWhenClosed(conversion);
		}
	}

	private noticeWhenClosed(conversion: PdfConversion) {
		const failed = conversion.count("failed") + conversion.count("pending");
		const message =
			conversion.stopReason === "no_scans_left"
				? NO_SCANS_LEFT_NOTICE
				: conversion.stopReason === "page_limit"
					? `${PAGE_LIMIT_NOTICE} ${failed} ${failed === 1 ? "page" : "pages"} of ${this.pdfFile.name} ${failed === 1 ? "is" : "are"} still to do.`
					: failed > 0
					? `MathLive converted ${this.pdfFile.name}, but ${failed} ${failed === 1 ? "page" : "pages"} couldn't be read.`
					: `MathLive converted ${this.pdfFile.name}.`;
		const note = conversion.note;
		new Notice(
			createFragment((frag) => {
				frag.appendText(message + " ");
				if (note) {
					const button = frag.createEl("button", { cls: "mathlive-notice-retry", text: "Open note" });
					button.addEventListener("click", () => void this.app.workspace.getLeaf("tab").openFile(note));
				}
			}),
			15000
		);
	}
}

class PdfPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Pick a PDF to convert to notes");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === "pdf");
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile) {
		this.onPick(file);
	}
}

export function isPdf(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

// Opens the conversion window for a PDF, or asks for one first.
export async function convertPdfToNotes(app: App, settings: PluginSettings, file?: TFile) {
	if (!file) {
		new PdfPickerModal(app, (picked) => void convertPdfToNotes(app, settings, picked)).open();
		return;
	}
	// Without a key this gets a trial or asks to connect, then starts over.
	if (!(await ensureCanScan(settings, () => void convertPdfToNotes(app, settings, file)))) {
		return;
	}
	let pageCount: number;
	try {
		const pdf = await openPdf(app, file);
		pageCount = pdf.numPages;
		await pdf.destroy();
	} catch (error) {
		console.error("MathLive: couldn't open the PDF:", error);
		new Notice("MathLive couldn't open this PDF.");
		return;
	}
	new PdfToNotesModal(app, settings, file, pageCount).open();
}

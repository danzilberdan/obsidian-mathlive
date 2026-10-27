// The new website: the home page, then the plans.
export async function setup(ctx) {
	ctx.tab = await ctx.openBrowser(ctx.manifest.scenes.find((scene) => scene.id === "website").url);
	await ctx.tab.mouse.move(800, 450);
}

async function smoothScroll(tab, by, ms) {
	await tab.evaluate(
		({ by, ms }) =>
			new Promise((done) => {
				const start = window.scrollY;
				const began = performance.now();
				const step = (now) => {
					const t = Math.min(1, (now - began) / ms);
					window.scrollTo(0, start + by * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
					if (t < 1) requestAnimationFrame(step);
					else done();
				};
				requestAnimationFrame(step);
			}),
		{ by, ms }
	);
}

export async function run({ tab, say, click, sleep, pointAt, lineDone }) {
	await say("website-1");
	await sleep(1200);
	await smoothScroll(tab, 700, 2200);
	await sleep(900);
	await smoothScroll(tab, 800, 2200);
	await sleep(600);
	await smoothScroll(tab, -1500, 1200);
	await click(tab.getByRole("navigation").getByRole("link", { name: "Pricing" }).first());
	await tab.waitForLoadState("networkidle");
	await say("website-2");
	await sleep(1500);
	await pointAt(tab.getByText("$0", { exact: true }).first(), { steps: 30 });
	await sleep(1500);
	await pointAt(tab.getByText("$4", { exact: true }).first(), { steps: 30 });
	await sleep(1500);
	await pointAt(tab.getByText("$49", { exact: true }).first(), { steps: 30 });
	await lineDone();
}

export async function teardown({ closeBrowser }) {
	await closeBrowser();
}

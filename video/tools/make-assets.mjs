// Makes the demo material the scenes use, from the content in assets/demo.json:
// the formula picture that goes on the clipboard and the lecture PDF. Formulas are drawn with
// MathLive's own renderer, so they look like real math. Run it again after changing demo.json.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ASSETS, launchChromium, ROOT, readJson, writeJson } from "./lib.mjs";

const demo = readJson(path.join(ASSETS, "demo.json"));
const mathlive = pathToFileURL(path.join(ROOT, "node_modules/mathlive/mathlive.min.js")).href;
const fonts = pathToFileURL(path.join(ROOT, "node_modules/mathlive/fonts")).href;

const page = (body, css = "") => `<!doctype html><meta charset="utf-8">
<style>
body { margin: 0; font-family: Inter, "DejaVu Sans", sans-serif; color: #1d1d2b; background: #fff; }
${css}
</style>
<body>${body}</body>
<script src="${mathlive}"></script>
<script>
MathLive.renderMathInDocument({ fontsDirectory: ${JSON.stringify(fonts)}, TeX: { delimiters: { display: [["$$", "$$"]], inline: [["\\\\(", "\\\\)"]] } } });
document.fonts.ready.then(() => setTimeout(() => (document.body.dataset.ready = "1"), 300));
</script>`;

const browser = await launchChromium();
const context = await browser.newContext({ deviceScaleFactor: 2 });
const tab = await context.newPage();
const render = async (html, file) => {
	const htmlFile = path.join(ASSETS, ".render.html");
	fs.writeFileSync(htmlFile, html);
	await tab.goto(pathToFileURL(htmlFile).href);
	await tab.waitForSelector("body[data-ready]");
	return htmlFile;
};

// The clipboard picture: a formula cropped tight, like a screenshot from a textbook.
await render(page(`<div id="f" style="display:inline-block;padding:18px 28px;font-size:30px">$$${demo.clipboard.latex}$$</div>`));
await tab.locator("#f").screenshot({ path: path.join(ASSETS, "clipboard-formula.png") });

// The lecture: one landscape slide per page.
const slides = demo.lecture.pages
	.map(
		(slide, n) => `<section>
	<header>${demo.lecture.course} · ${n + 1}</header>
	<h1>${slide.title}</h1>
	${slide.blocks.map((block) => (block.latex ? `<div class="math"${block.target ? ' id="target"' : ""}>$$${block.latex}$$</div>` : `<p>${block.text}</p>`)).join("\n")}
</section>`
	)
	.join("\n");
const css = `
@page { size: 297mm 167mm; margin: 0; }
section { width: 297mm; height: 167mm; box-sizing: border-box; padding: 14mm 20mm; page-break-after: always; position: relative; }
header { color: #7a6ff0; font-size: 11pt; letter-spacing: .04em; text-transform: uppercase; }
h1 { font-size: 26pt; margin: 6mm 0 6mm; }
p { font-size: 15pt; line-height: 1.45; margin: 0 0 5mm; max-width: 220mm; }
.math { font-size: 19pt; margin: 4mm 0 6mm; }`;
const htmlFile = await render(page(slides, css));
await tab.pdf({ path: path.join(ASSETS, "lecture.pdf"), preferCSSPageSize: true, printBackground: true });

// Where the formula the screen-scan scene boxes sits on its page, as fractions of the page.
const target = await tab.evaluate(() => {
	const box = (document.querySelector("#target .ML__latex") ?? document.querySelector("#target")).getBoundingClientRect();
	const slide = document.querySelector("#target").closest("section");
	const page = slide.getBoundingClientRect();
	const index = [...document.querySelectorAll("section")].indexOf(slide);
	return { page: index + 1, x: (box.left - page.left) / page.width, y: (box.top - page.top) / page.height, width: box.width / page.width, height: box.height / page.height };
});
writeJson(path.join(ASSETS, "lecture-target.json"), target);
fs.rmSync(htmlFile);
await browser.close();
console.log("Made clipboard-formula.png, lecture.pdf and lecture-target.json.", target);

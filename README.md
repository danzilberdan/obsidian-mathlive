<div align="center">

<img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/logo.png" alt="MathLive logo" width="128">

<h1>MathLive</h1>

**Write math in Obsidian visually, and turn screenshots of formulas into LaTeX.**

[![Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&logoColor=white&color=7c3aed&label=downloads&query=%24%5B%22mathlive%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2FHEAD%2Fcommunity-plugin-stats.json)](https://community.obsidian.md/plugins/mathlive)
[![GitHub stars](https://img.shields.io/github/stars/danzilberdan/obsidian-mathlive?style=flat&logo=github&color=f5c518)](https://github.com/danzilberdan/obsidian-mathlive/stargazers)
[![Latest release](https://img.shields.io/github/v/release/danzilberdan/obsidian-mathlive?color=10b981&label=release)](https://github.com/danzilberdan/obsidian-mathlive/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/danzilberdan/obsidian-mathlive/ci.yml?branch=master&label=tests)](https://github.com/danzilberdan/obsidian-mathlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/danzilberdan/obsidian-mathlive?color=blue)](LICENSE)

[**Install in Obsidian**](https://obsidian.md/plugins?id=mathlive) · [Website](https://mathlive.danz.blog) · [Report a bug](https://github.com/danzilberdan/obsidian-mathlive/issues/new/choose)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/note-dark.png">
    <img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/note-light.png" alt="A note with inline and block formulas edited in place by MathLive" width="820">
  </picture>
</p>

MathLive replaces the LaTeX in your notes with a visual math editor. Click a formula to edit it like you would in a word processor, open a larger editor window with an on-screen math keyboard, or draw a box around a formula in a PDF or slide and scan it straight into your note.

## Features

- **Edit formulas where they are.** Inline `$...$` and block `$$...$$` math turn into live editors in Live Preview. Inline formulas stay at text height, so your paragraphs don't jump around.
- **Editor window.** A focused editor for longer expressions, with `Ctrl/Cmd + Enter` to insert into the note.
- **Math keyboard.** An on-screen keyboard for fractions, roots, integrals, Greek letters and symbols.
- **Scan formulas into LaTeX.** Draw a box around a formula anywhere in Obsidian, such as a PDF you have open, or scan a screenshot from your clipboard. Uses the MathLive cloud scanner or your own self-hosted one.
- **Find a formula.** Search thousands of formulas from every science by name, by what they do, in your language, or by a bit of LaTeX, and insert one in a click. Free, no account needed. If the library doesn't have it, **Write it with AI** writes it for one scan.
- **Draw a formula.** Write it by hand on a drawing pad, or scan the QR code and draw it on your phone or tablet. You see the formula as you draw, and it goes into your note when you click Insert. Uses the MathLive cloud scanner.
- **Turn PDFs into notes.** Convert lecture slides, papers or scanned handwritten notes into a Markdown note, with every formula as editable LaTeX. Uses the MathLive cloud scanner.
- **Magic edit.** Pick Magic edit in ✨ AI fill, next to a formula or in the editor window, and type or say what to change, like "square the denominator" or "make it a cube root". An AI rewrites the formula, and Undo puts it back. Uses the MathLive cloud scanner.
- **Stays out of the way.** Each formula has two small buttons: ✨ AI fill (with Magic edit) and ⤢ Expand. Everything is still plain LaTeX in your Markdown files.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/menu-dark.png">
    <img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/menu-light.png" alt="The ✨ menu of a formula: scan clipboard image, scan from screen" width="820">
  </picture>
</p>

## Installation

1. In Obsidian, open **Settings → Community plugins** and turn on community plugins if you haven't yet.
2. Click **Browse**, search for **MathLive**, then click **Install** and **Enable**.

Or open [MathLive in Obsidian](https://obsidian.md/plugins?id=mathlive) directly. MathLive works in Obsidian 1.1.0 or newer on desktop.

## Getting started

**Edit a formula in your note.** Write `$x^2$` or a `$$` block in Live Preview and click it. Type to edit, use the arrow keys to move in and out of the formula, click ✨ to fill it in from a screenshot, or ⤢ to expand it into the editor window. ✨ also opens the guide, which shows everything MathLive can do.

**Use the editor window.** Open the command palette (`Ctrl/Cmd + P`) and run **MathLive: Add inline math** or **MathLive: Add full-line math**. If you selected a formula first, the editor window opens with it. Click **Insert** or press `Ctrl/Cmd + Enter` to put it in your note.

**Set a hotkey.** If you write math often, assign hotkeys to the commands in **Settings → Hotkeys**.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/editor-window-dark.png">
    <img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/editor-window-light.png" alt="The MathLive editor window with the math keyboard open" width="820">
  </picture>
</p>

## Scanning formulas

**From the screen.** Open the PDF, slide or image next to your note, put the cursor where the formula should go, and click ✨ in the left ribbon and pick **Scan formula from screen** (or run **MathLive: Scan formula from screen**, which you can give a hotkey). Obsidian steps aside and you drag a box around the formula anywhere on your screen, in Obsidian or in another app such as your browser or slides. Its LaTeX goes into the note at the cursor: as a math block on an empty line, or as inline math in a line of text. Press `Esc` to cancel. The editor window and a formula's ✨ menu have **Scan from screen** too, which adds the scan to that formula. On macOS, scanning other apps needs Screen Recording access for Obsidian; until then scans stay inside Obsidian's window and MathLive shows you where to turn it on. To always scan inside Obsidian only, turn off **Scan other apps** in the settings.

**From the clipboard.** Copy a screenshot of a formula, for example from another app or handwritten notes, then choose **Scan clipboard image** from ✨ AI fill in the editor window or next to a formula.

Check the result and fix anything the scanner got wrong.

## Finding a formula

Put the cursor where the formula should go and run **MathLive: Find a formula** (or right-click in the note, or choose **Find a formula** from ✨ in the left ribbon, a formula's ✨ menu or the editor window). Type its name ("ideal gas law"), what it does ("energy of a moving object"), its name in your language ("Satz des Pythagoras"), or part of it in LaTeX (`E=mc^2`). Press `Enter` to insert the highlighted formula: as a math block on an empty line, as inline math in a line of text, or into the formula you opened it from. If you selected some words first, the search starts with them.

Searching is free and needs no account. The library comes from [Wikidata](https://www.wikidata.org)'s formulas, with clean LaTeX, names, variables and descriptions written and checked with AI, and it grows from the searches that find nothing. When nothing fits, the last choice is **✨ Write it with AI**: Claude writes the formula for one scan, charged only when it comes back as valid LaTeX (free on paid plans).

## Drawing a formula

Put the cursor where the formula should go, click ✨ in the left ribbon and pick **Draw formula** (or run **MathLive: Draw formula**). The editor window and a formula's ✨ menu have **Draw formula** too, which adds the drawing to that formula. Write the formula on the pad with your mouse, pen or finger; a moment after you lift the pen, the formula appears under the pad, where you can still fix it. **Insert** puts it in the note and uses one scan. Reading the drawing while you draw is free.

To draw on a phone or tablet instead, scan the QR code beside the pad with its camera. A drawing page opens in its browser, with nothing to install and no sign-in. The formula shows on both screens as you draw, and **Insert** on the phone puts it in your note on the computer. The phone can then draw the next formula, until you tap **Done** or stop drawing for 10 minutes. Only the first browser to open a code can use it. With **Self-hosted scanner** on, the pad is read by your scanner and there is no QR code.

## Converting a PDF to notes

Open a PDF and click **Convert to notes** at its top right. You can also click ✨ in the left ribbon and pick **Convert a PDF to notes**, or right-click a PDF in the file list. Pick the pages you want and click **Convert**. MathLive reads the pages one by one into a new note next to the PDF: text as Markdown, formulas as `$...$` and `$$...$$` you can edit, and a link back to each page of the PDF. The note fills in as pages finish. You can close the window; MathLive tells you when it's done.

On the free plan each page uses one scan. Paid plans include a number of pages each month (500 on Monthly, 300 on Lifetime), and you can buy more pages when you need them. Blank pages and pages that can't be read are free. Before converting, MathLive shows how many pages you have left; if the PDF is longer, it converts the first pages that fit and you can get more pages for the rest. A page that can't be read gets a warning in the note, and **Retry failed pages** fills it in later. Your self-hosted scanner can do this too if it answers `/pages/` the way the MathLive scanner does.

You can scan with either of these:

| | Cloud scanner | Self-hosted scanner |
| --- | --- | --- |
| Setup | None for your first 3 scans. Then click **Connect** in **Settings → MathLive** (or when a scan asks), sign in with Google in your browser, and Obsidian connects by itself | Run a compatible server such as [LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR), then turn on **Self-hosted scanner** |
| Cost | 3 trial scans, then 10 free scans per account and 5 more each month, or a paid plan for unlimited scans | Free |
| Best for | Most people | People already comfortable running local services |

The self-hosted scanner uses `http://localhost:8502` unless you set another address in **Self-hosted scanner address**.

## Settings

| Setting | What it does |
| --- | --- |
| Account | Connect or disconnect your MathLive account, see who you're connected as and how many scans are left |
| API key (Advanced) | Paste a key from your account page instead of connecting |
| Self-hosted scanner, Self-hosted scanner address (Advanced) | Send scans to your own server instead |
| Enable inline editor mode | Turn formulas in the note into editors |
| Enable inline / block math widgets | Choose which formulas get an editor |
| Hide rendered inline / block math | Show only the editor, without Obsidian's rendered math next to it |
| Update inline widgets immediately | Write changes into the note as you type, or when the formula loses focus |
| Arrow key navigation between editor and widgets | Move the cursor into and out of formulas with the arrow keys |
| Edit only the formula at the cursor | Keep formulas drawn like the rest of the note, and show the editor only for the formula with the cursor in it |

## Disclosures

Obsidian asks plugins to state the following up front.

- **Payment.** The visual editor and formula search are free. Cloud scanning includes 3 trial scans, then 10 free scans per account and 5 more each month; unlimited scanning requires a paid plan from [mathlive.danz.blog](https://mathlive.danz.blog). Self-hosted scanning is free.
- **Account.** After 3 trial scans, cloud scanning requires a MathLive account (sign-in with Google). The editor and self-hosted scanning need no account.
- **Network use.** The plugin only connects to the internet for cloud scanning and finding formulas, and only after you start a scan, search for a formula or click Connect:
  - `https://mathlive.danz.blog/ocr/trial` gives a trial key on your first cloud scan when you have none.
  - `https://mathlive.danz.blog/ocr/predict/` receives the image you chose to scan, with your key, and returns LaTeX.
  - `https://mathlive.danz.blog/ocr/edit` receives a formula you chose to Magic edit with your typed instruction or your voice recording, with your key, and returns the new formula.
  - `https://mathlive.danz.blog/ocr/pages/` receives a picture of each PDF page you chose to convert, with your key, and returns the page as Markdown.
  - Draw formula opens a drawing session at `https://mathlive.danz.blog/ocr/draw/sessions` with your key, sends each drawing there to be read, and while the window is open (or a phone you connected is still drawing) waits there for the phone's drawings. The QR code is made on your computer and links the phone to `https://mathlive.danz.blog/draw/...`.
  - `https://mathlive.danz.blog/ocr/formulas/search` receives what you type in **Find a formula**, without your key, and returns matching formulas. It always goes to MathLive's server, also with **Self-hosted scanner** on. The server keeps the text of searches that found nothing (without your key or address) for 180 days, to add the missing formulas.
  - `https://mathlive.danz.blog/ocr/formulas/write` receives your search text, with your key, when you choose **Write it with AI**, and returns the formula. Claude by Anthropic writes it.
  - `https://mathlive.danz.blog/ocr/access-status` is checked with your key to show your account, scans left, and pages left before converting a PDF.
  - Connecting opens `https://mathlive.danz.blog/connect` in your browser with this device's name (your vault's name and operating system). While you approve, the plugin asks `https://mathlive.danz.blog/ocr/connect/claim` every 2 seconds for up to 10 minutes. Disconnecting tells `https://mathlive.danz.blog/ocr/connect/forget` to delete this device's key.
  - With `Self-hosted scanner` on, scans go to the address you set (by default `http://localhost:8502`) instead of MathLive's servers.
- **Clipboard.** The plugin reads your clipboard only when you click a scan button, to get the image you copied.
- **Microphone.** The plugin uses the microphone only while you record a Magic edit, from clicking the mic until you click it again (at most a minute). A recording that stays silent is not sent. The server turns the recording into text, then forgets it.
- **Screen.** Scanning from the screen takes a picture only when you start it: of the Obsidian window, or of the whole screen when you scan from another app. Only the box you draw is sent to the scanner; the rest of the picture never leaves your computer.
- **Data.** The scan server turns the image (or drawing) into LaTeX (or a PDF page into Markdown) and does not keep the image; Magic edit's formula, instruction and recording aren't kept either. Your account stores your email, your keys (with each connected device's name), your scan count and when a key was last used. A trial stores only a key and a one-way fingerprint of your IP address, to limit trials per network. Server logs record requests and errors to keep the service running.
- **No telemetry or ads.** The plugin does not track how you use it and shows no ads. A welcome window shows once after installing.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report a bug or build the plugin locally, and [SECURITY.md](SECURITY.md) to report a security issue privately. Every change runs an automated test suite in a real Obsidian app.

If MathLive saves you time, a ⭐ on this repository helps other people find it, and you can [buy me a coffee](https://www.buymeacoffee.com/danzilberdan).

## Acknowledgements

- [MathLive](https://github.com/arnog/mathlive) by Arno Gourdol, the math editor this plugin is built on
- [LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR) by Lukas Blecher, for self-hosted scanning
- [QR Code Generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT), for Draw formula's QR code

## License

[MIT](LICENSE) © Dan Zilberman

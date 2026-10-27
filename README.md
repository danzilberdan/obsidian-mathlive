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

MathLive replaces the LaTeX in your notes with a visual math editor. Click a formula to edit it like you would in a word processor, open a larger editor window with an on-screen math keyboard, or copy a formula from a PDF or slide and scan it straight into your note.

## Features

- **Edit formulas where they are.** Inline `$...$` and block `$$...$$` math turn into live editors in Live Preview. Inline formulas stay at text height, so your paragraphs don't jump around.
- **Editor window.** A focused editor for longer expressions, with `Ctrl/Cmd + Enter` to insert into the note.
- **Math keyboard.** An on-screen keyboard for fractions, roots, integrals, Greek letters and symbols.
- **Scan formula images.** Copy a screenshot of a formula and turn it into editable LaTeX, using the MathLive cloud scanner or your own self-hosted one.
- **Stays out of the way.** Each formula has one small ⋮ menu. Everything is still plain LaTeX in your Markdown files.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/menu-dark.png">
    <img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/menu-light.png" alt="The ⋮ menu of an inline formula: scan clipboard image, open in editor window, show math keyboard" width="820">
  </picture>
</p>

## Installation

1. In Obsidian, open **Settings → Community plugins** and turn on community plugins if you haven't yet.
2. Click **Browse**, search for **MathLive**, then click **Install** and **Enable**.

Or open [MathLive in Obsidian](https://obsidian.md/plugins?id=mathlive) directly. MathLive works in Obsidian 1.1.0 or newer on desktop.

## Getting started

**Edit a formula in your note.** Write `$x^2$` or a `$$` block in Live Preview and click it. Type to edit, use the arrow keys to move in and out of the formula, and open the ⋮ menu for more options.

**Use the editor window.** Open the command palette (`Ctrl/Cmd + P`) and run **MathLive: Add inline math** or **MathLive: Add full-line math**. If you selected a formula first, the editor window opens with it. Click **Insert into note** or press `Ctrl/Cmd + Enter` to put it in your note.

**Set a hotkey.** If you write math often, assign hotkeys to both commands in **Settings → Hotkeys**.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/editor-window-dark.png">
    <img src="https://raw.githubusercontent.com/danzilberdan/obsidian-mathlive/master/docs/images/editor-window-light.png" alt="The MathLive editor window with the math keyboard open" width="820">
  </picture>
</p>

## Scanning formula images

1. Copy an image of a formula to your clipboard, for example a screenshot from a PDF, a slide or handwritten notes.
2. Click **Scan clipboard image** in the editor window, or choose it from a formula's ⋮ menu.
3. The recognized LaTeX is added to the formula. Check it and fix anything the scanner got wrong.

You can scan with either of these:

| | Cloud scanner | Self-hosted scanner |
| --- | --- | --- |
| Setup | Create an account and API key at [mathlive.danz.blog](https://mathlive.danz.blog), then paste the key into **Settings → MathLive → API key** | Run a compatible server such as [LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR), then turn on **Self-hosted scanner** |
| Cost | 10 free scans per account, then a paid plan for unlimited scans | Free |
| Best for | Most people | People already comfortable running local services |

The self-hosted scanner uses `http://localhost:8502` unless you set another address in **Self-hosted scanner address**.

## Settings

| Setting | What it does |
| --- | --- |
| API key | Your key for the cloud scanner |
| Self-hosted scanner, Self-hosted scanner address | Send scans to your own server instead |
| Enable inline editor mode | Turn formulas in the note into editors |
| Enable inline / block math widgets | Choose which formulas get an editor |
| Hide rendered inline / block math | Show only the editor, without Obsidian's rendered math next to it |
| Update inline widgets immediately | Write changes into the note as you type, or when the formula loses focus |
| Arrow key navigation between editor and widgets | Move the cursor into and out of formulas with the arrow keys |

## Disclosures

Obsidian asks plugins to state the following up front.

- **Payment.** The visual editor is free. Cloud scanning includes 10 free scans per account; unlimited scanning requires a paid plan from [mathlive.danz.blog](https://mathlive.danz.blog). Self-hosted scanning is free.
- **Account.** Cloud scanning requires a MathLive account (sign-in with Google) and an API key. The editor and self-hosted scanning need no account.
- **Network use.** The plugin only connects to the internet for cloud scanning:
  - `https://mathlive.danz.blog/ocr/predict/` receives the image you chose to scan, with your API key, and returns LaTeX.
  - `https://mathlive.danz.blog/ocr/access-status` is checked with your API key to show whether your account has unlimited scans.
  - With `Self-hosted scanner` on, scans go to the address you set (by default `http://localhost:8502`) instead of MathLive's servers.
- **Clipboard.** The plugin reads your clipboard only when you click a scan button, to get the image you copied.
- **Data.** The scan server turns the image into LaTeX and does not keep the image. Your account stores your email, your API keys, your scan count and when a key was last used. Server logs record requests and errors to keep the service running.
- **No telemetry, ads or pop-ups.** The plugin does not track how you use it and shows no ads.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report a bug or build the plugin locally, and [SECURITY.md](SECURITY.md) to report a security issue privately. Every change runs an automated test suite in a real Obsidian app.

If MathLive saves you time, a ⭐ on this repository helps other people find it, and you can [buy me a coffee](https://www.buymeacoffee.com/danzilberdan).

## Acknowledgements

- [MathLive](https://github.com/arnog/mathlive) by Arno Gourdol, the math editor this plugin is built on
- [LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR) by Lukas Blecher, for self-hosted scanning

## License

[MIT](LICENSE) © Dan Zilberman

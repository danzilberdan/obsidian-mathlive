# MathLive 2.0 showcase: brief for the script writer

`tools/write-script.mjs` sends this file, together with the scenes in `scenes.yaml`, to a model on OpenRouter and asks it to write the narration. Edit this file to change what the video says or how it sounds, then run the script writer again.

## The product

MathLive is an Obsidian plugin. You click any `$…$` or `$$…$$` formula in a note and edit it visually: fractions, roots and matrices appear as you type, and the note keeps plain LaTeX. Editing is free and works offline.

## What is new in 2.0

- **AI fill (✨).** Every formula has a ✨ button. It scans a formula instead of you typing it: from a screenshot on the clipboard, or by drawing a box around a formula anywhere on the screen (a PDF, a website, a video, another app). The LaTeX lands in the formula, ready to edit. A progress notice shows the scan working.
- **Scan from screen.** The screen freezes, you drag a box around the formula, and it is read straight into your note. Works on other apps, not just Obsidian.
- **PDF to notes.** Right-click a PDF (lecture slides, papers, handwritten pages) and choose "Convert to notes with MathLive". Every page becomes Markdown with editable LaTeX, linked back to the page it came from. Blank pages are skipped and not charged.
- **Start scanning in one click.** The first 3 scans need no account at all. After that, one click connects the plugin: sign in with Google on the website and Obsidian connects itself. No API keys to copy.
- **More reliable scanning.** Scans run on hosted vision models with automatic failover to a second provider, and you are only charged for a scan that returns a result.
- **A new website and account page** at mathlive.danz.blog: see your plan, scans left, and connected devices.
- **Simple plans.** Free (10 scans to start, then topped back up to 5 every month), Monthly ($4/month) and Lifetime ($49 once). Typing and editing formulas stay free forever.

## Audience and tone

Students, researchers and engineers who take math-heavy notes in Obsidian. Friendly, confident and concrete, like a maker showing their own tool. Short sentences that are easy to say out loud. No hype words ("revolutionary", "game-changer", "seamless"), no rhetorical questions in a row, no emoji.

## Rules for the narration

- Each line is spoken while the screen shows what the scene's `on_screen` describes. Say what the viewer is seeing, at that moment.
- Keep each line close to its `words` target. A line of 12 words is about 4 seconds.
- Write numbers and symbols the way they should be spoken ("forty-nine dollars", "LaTeX" is said "lay-tek" but stays written as LaTeX).
- Don't promise anything not listed above.

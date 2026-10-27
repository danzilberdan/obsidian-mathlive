# MathLive 2.0 showcase video

Everything that makes the 2.0 showcase video, kept as files so it can be changed one piece at a time:

| Path | What it is |
| --- | --- |
| `brief.md` | What the video should say and how it should sound. The script writer reads it. |
| `scenes.yaml` | The scenes in order, and each narration line's text. **Edit this to change the words.** |
| `voice/` | One voice clip per line (`<line id>.m4a`), plus `index.json` recording what each was made from. |
| `takes/` | Your own recorded lines (`<line id>.webm`), when you narrate it yourself. |
| `scenes/<id>.mjs` | The recording script for each screen scene. Title cards need no script. |
| `assets/` | Demo material: the note, the formula picture and the lecture PDF (`demo.json` is the source). |
| `tools/` | The commands below. |
| `spend.jsonl` | Every OpenRouter call and what it cost. |
| `out/` | Recordings and the rendered video (not in git). |

## Commands

Run `npm install` once in this folder and `npm run build` once in the repository root (the recordings use the plugin's build). The voice and script steps need `OPENROUTER_API_KEY`.

```sh
node tools/write-script.mjs [--only <scene or line ids>] [--note "what to change"]   # narration via OpenRouter
node tools/voice.mjs [--only <ids>] [--force]   # voice clips via OpenRouter (ElevenLabs)
node tools/make-assets.mjs                      # formula picture + lecture PDF from assets/demo.json
node tools/record.mjs [--only <scene ids>]      # screen recordings in a real Obsidian on a virtual screen
node tools/build.mjs                            # the final video + subtitles in out/
```

## Narrating it yourself

`voice.engine` is `takes`: the video uses your own voice, one recording per line.

1. `cd video && npm install` (once), then `node tools/prompter.mjs` and open http://localhost:4700.
2. For each line: press Space, wait for the 3-2-1, read the line, press Space. Play it back with P, keep it with Enter (it moves on), or redo with R. The bar shows a comfortable pace for the line; you don't have to hit it exactly, because the video is timed to your recording. Kept lines turn green at the bottom; a line turns amber if its text changed after you recorded it.
3. `node tools/voice.mjs` turns the takes into clips (cutting the silence at both ends and steady background noise), then `node tools/record.mjs` and `node tools/build.mjs` as usual.

To redo one line later, open the prompter, click the line at the bottom and record it again; only that clip and its scene are redone. Lines without a take keep their previous clip, so a half-recorded set still builds.

## Fixing one thing

- **A line's wording:** edit its `text` in `scenes.yaml`, then `node tools/voice.mjs` (only that clip is remade, a few tenths of a cent), `node tools/record.mjs --only <scene>` (the scene is re-timed to the new clip; free), `node tools/build.mjs`.
- **A line rewritten by the model:** `node tools/write-script.mjs --only connect-2 --note "mention it's free"`, then as above.
- **What happens on screen:** edit `scenes/<scene>.mjs`, record that scene again, build.
- **The voice:** change `voice.openrouter` in `scenes.yaml` (model, voice, speed). Every clip is remade on the next `voice.mjs` run, about $0.18 for the whole video with ElevenLabs v4.

The build warns when a clip's length no longer matches the recording it was timed against.

## How timing works

A scene script calls `say("line id")` where a line starts. `say()` waits until the previous line's clip has finished playing (plus `voice.gap`), notes the time, and returns, so the actions after it happen while the line is spoken. The start times are saved in `out/recordings/<scene>.json`, and the build places each clip exactly there. Changing a clip's length therefore means recording its scene again, which is automatic and free.

## What's real and what's staged

The recordings run the plugin's real build in a real Obsidian (1.14.5) under Xvfb, and the website scenes show https://mathlive-staging.danz.blog. Scanning goes to a local stand-in (`tools/demo-scanner.mjs`) so every take shows the same results: it answers with the LaTeX the scene asks for, plays the 3-scan trial, and approves the device connection the moment the scene "signs in" (the video shows the real sign-in page but doesn't sign in). The mouse pointer is drawn into the page (`tools/cursor.mjs`), since Playwright doesn't move the real one.

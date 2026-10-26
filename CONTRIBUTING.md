# Contributing to MathLive

Thanks for helping improve MathLive. Bug reports, feature ideas and pull requests are all welcome.

## Report a bug

Open an issue with the **Bug report** template. Include your Obsidian version, the MathLive version, your operating system, the steps that cause the problem, and what you expected to happen. A screenshot or the formula you were editing helps a lot.

## Suggest a feature

Open an issue with the **Feature request** template and describe the problem you want solved, not only the solution.

## Send a pull request

1. Follow [DEVELOPMENT.md](DEVELOPMENT.md) to build the plugin and load it in a test vault.
2. Keep the change focused on one fix or feature.
3. Run `npm run lint` and `npm run build`. Both must pass with no warnings, because every release is checked by Obsidian's automated review.
4. Describe what you changed and how you tested it in the pull request.

Code follows [Obsidian's plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines). In particular: use `activeDocument` and Obsidian's element helpers (`createEl`, `createDiv`) instead of `document`, use `requestUrl` for network calls, put styles in `styles.css`, and never add telemetry to the plugin.

## Response times

New issues get a first reply within two working days.
